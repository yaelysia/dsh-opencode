import { createHash } from 'node:crypto';
import { failure } from './errors.js';

const digest = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
const visibleText = content => typeof content === 'string' ? content
  : (Array.isArray(content) ? content : []).filter(part => typeof part === 'string' || part?.type === 'text')
    .map(part => typeof part === 'string' ? part : part.text ?? '').join('\n');
const hasToolCall = message => Array.isArray(message?.content)
  && message.content.some(part => part?.type === 'tool-call');

/** Only the DSH history determines reusability. No tool results or assistant
 * replies are sent to OpenCode again after it has already consumed them.
 * The registry manages in-memory leases; SessionJournal owns disk deletion. */
export class StructuredSessionRegistry {
  constructor({ maxIdle = 32, idleTtlMs = 30 * 60_000, onRetire, onEvent, now = Date.now } = {}) {
    this.maxIdle = maxIdle;
    this.idleTtlMs = idleTtlMs;
    this.onRetire = onRetire;
    this.onEvent = onEvent;
    this.now = now;
    this.entries = new Map();
  }

  notify(code, key, entry, reason) {
    if (!this.onEvent) return;
    let sessionId;
    try { sessionId = JSON.parse(key)[0]; } catch { /* No user data. */ }
    this.onEvent(code, { sessionId, reason, status: entry?.state });
  }

  retire(key, reason = 'invalidated') {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.notify('retired', key, entry, reason);
    // Only a completed, idle Session may be deleted without coordinating an
    // active OpenCode POST or an outstanding DSH tool result.
    if (entry.state === 'idle') this.onRetire?.(entry.id);
  }

  sweep() {
    for (const [key, entry] of this.entries) {
      if (entry.state === 'idle' && this.now() - entry.lastActiveAt >= this.idleTtlMs) {
        this.retire(key, 'idle-ttl');
      }
    }
    let idle = [...this.entries].filter(([, entry]) => entry.state === 'idle').length;
    for (const [key, entry] of this.entries) {
      if (idle <= this.maxIdle) break;
      if (entry.state !== 'idle') continue;
      this.retire(key, 'idle-limit');
      idle--;
    }
  }

  plan(key, messages, system) {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.state !== 'idle' || !Array.isArray(messages) || entry.system !== system
      || messages.length < entry.count
      || digest(messages.slice(0, entry.count)) !== entry.checkpoint) {
      const reason = entry.state !== 'idle' ? 'not-idle' :
        entry.system !== system ? 'instructions-changed' :
          !Array.isArray(messages) || messages.length < entry.count
            ? 'history-truncated' : 'history-changed';
      this.retire(key, reason);
      return null;
    }
    const suffix = messages.slice(entry.count);
    let offset = 0;
    if (suffix[0]?.role === 'assistant') {
      if (hasToolCall(suffix[0]) || digest(visibleText(suffix[0].content)) !== entry.replyHash) {
        this.retire(key, 'assistant-echo-changed');
        return null;
      }
      offset = 1;
    }
    if (suffix.length === offset) {
      this.notify('stale-turn', key, entry, 'duplicate-completed-input');
      throw failure('No new DSH user turn after the completed OpenCode response', 'STALE_DSH_TURN');
    }
    const newMessages = suffix.slice(offset);
    if (newMessages.length !== 1 || newMessages[0]?.role !== 'user'
      || newMessages[0]?.source?.kind === 'agent-instructions') {
      this.retire(key, 'unsupported-dsh-delta');
      return null;
    }
    // Reserve synchronously before the first await; the TTL collector must not
    // delete a Session while context-budget lookup or compaction is running.
    entry.state = 'reserved';
    this.notify('reused', key, entry);
    return { id: entry.id, messages: newMessages, lastUsage: entry.lastUsage };
  }

  release(key, id) {
    const entry = this.entries.get(key);
    if (entry?.id === id && entry.state === 'reserved') entry.state = 'idle';
  }

  active(key, id) {
    const existing = this.entries.get(key);
    if (existing && existing.id !== id) this.retire(key);
    this.entries.delete(key);
    this.entries.set(key, { id, state: 'running', lastActiveAt: this.now() });
    this.notify('running', key, { state: 'running' });
  }

  waiting(key, id) {
    const entry = this.entries.get(key);
    if (entry?.id === id) {
      entry.state = 'waiting-tool';
      this.notify('waiting-tool', key, entry);
    }
  }

  complete(key, id, messages, system, reply, lastUsage = null) {
    const entry = this.entries.get(key);
    if (entry?.id !== id || !Array.isArray(messages) || typeof reply !== 'string') return;
    Object.assign(entry, { state: 'idle', count: messages.length, checkpoint: digest(messages),
      system, replyHash: digest(reply), lastUsage, lastActiveAt: this.now() });
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.notify('idle', key, entry);
    this.sweep();
  }

  invalidate(key, id) {
    if (id === undefined || this.entries.get(key)?.id === id) this.retire(key);
  }

  clear() { this.entries.clear(); }
}
