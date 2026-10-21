import { createHash } from 'node:crypto';
import { failure } from './errors.js';

const digest = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
const visibleText = content => typeof content === 'string' ? content
  : (Array.isArray(content) ? content : []).filter(part => typeof part === 'string' || part?.type === 'text')
    .map(part => typeof part === 'string' ? part : part.text ?? '').join('\n');
const hasToolCall = message => Array.isArray(message?.content)
  && message.content.some(part => part?.type === 'tool-call');

/** Only a completed DSH turn can be reused. The DSH history is authoritative;
 * OpenCode's own assistant/tool messages must never be sent to it a second time.
 * This in-memory registry deliberately does not persist or delete sessions:
 * durable cleanup and context compaction have separate lifecycles. */
export class StructuredSessionRegistry {
  constructor({ maxIdle = 32 } = {}) {
    this.maxIdle = maxIdle;
    this.entries = new Map();
  }

  /** Return one incremental human turn, or invalidate and request a full rebuild.
   * A DSH retry with no new human turn must not silently repeat model actions. */
  plan(key, messages, system) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.state !== 'idle' || !Array.isArray(messages) || entry.system !== system
      || messages.length < entry.count
      || digest(messages.slice(0, entry.count)) !== entry.checkpoint) {
      this.invalidate(key);
      return null;
    }
    const suffix = messages.slice(entry.count);
    let offset = 0;
    if (suffix[0]?.role === 'assistant') {
      // The host can echo our completed answer, but it must not invent a tool
      // call or replace that answer without invalidating the OpenCode context.
      if (hasToolCall(suffix[0]) || visibleText(suffix[0].content) !== entry.reply) {
        this.invalidate(key);
        return null;
      }
      offset = 1;
    }
    if (suffix.length === offset) {
      throw failure('No new DSH user turn after the completed OpenCode response', 'STALE_DSH_TURN');
    }
    const newMessages = suffix.slice(offset);
    if (newMessages.length !== 1 || newMessages[0]?.role !== 'user'
      || newMessages[0]?.source?.kind === 'agent-instructions') {
      this.invalidate(key);
      return null;
    }
    return { id: entry.id, messages: newMessages };
  }

  active(key, id) {
    this.entries.delete(key);
    this.entries.set(key, { id, state: 'running', lastActiveAt: Date.now() });
  }

  waiting(key, id) {
    const entry = this.entries.get(key);
    if (entry?.id === id) entry.state = 'waiting-tool';
  }

  complete(key, id, messages, system, reply) {
    const entry = this.entries.get(key);
    if (entry?.id !== id || !Array.isArray(messages) || typeof reply !== 'string') return;
    Object.assign(entry, { state: 'idle', count: messages.length, checkpoint: digest(messages),
      system, reply, lastActiveAt: Date.now() });
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Bound in-memory metadata, but never delete on-disk OpenCode sessions here.
    let idle = [...this.entries].filter(([, value]) => value.state === 'idle').length;
    for (const [oldKey, value] of this.entries) {
      if (idle <= this.maxIdle) break;
      if (value.state !== 'idle') continue;
      this.entries.delete(oldKey);
      idle--;
    }
  }

  invalidate(key, id) {
    if (id === undefined || this.entries.get(key)?.id === id) this.entries.delete(key);
  }

  clear() { this.entries.clear(); }
}
