import { createAdapter, OpenCodeServeClient, renderMessages } from './bridge.js';
import { failure, providerFailure } from './errors.js';
import { openSessionEvents } from './opencode-events.js';
import { StructuredEventFeed, StructuredBlocks } from './structured-events.js';
import { StructuredSessionRegistry } from './structured-session.js';
import { ContextBudget, consumedTokens } from './context-budget.js';
import { SessionJournal } from './session-journal.js';
import path from 'node:path';

function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter(p => p?.type === 'text')
    .map(p => p.text ?? '').join('\n');
}
const resultId = message => message?.toolCallId ?? message?.source?.callId ?? message?.callId;
// DSH may retry provider errors before a tool has been handed off, but once a
// DSH tool was emitted its result cannot safely restart a lost OpenCode POST.
const RETRYABLE_PROVIDER_ERRORS = new Set([
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
]);
const MAX_TERMINAL_FAILURES = 64;
function afterToolFailure(error, handedOff) {
  const source = error?.failure ?? error;
  if (!handedOff || !RETRYABLE_PROVIDER_ERRORS.has(source?.code)) return error;
  const reason = source?.message ?? error?.message ?? 'provider failure';
  const code = source.code;
  const status = source.status;
  return failure('OpenCode model continuation failed after a DSH tool handoff '
    + '(original ' + code + (status ? ' HTTP ' + status : '') + '): '
    + reason + '. The completed DSH tool result cannot be safely replayed.',
    'TOOL_CONTINUATION_FAILED', status);
}
function instructions(options) {
  const privileged = (options.messages ?? []).filter(m => ['system', 'developer'].includes(m.role));
  const workspace = (options.messages ?? []).filter(m => m.role === 'user'
    && m.source?.kind === 'agent-instructions' && m.source?.form === 'instructions');
  return [options.system, ...privileged.map(m => textOf(m.content)),
    ...workspace.map(m => 'User workspace instructions (below system/developer priority):\n' + textOf(m.content)),
  ].filter(Boolean).join('\n\n');
}

/** A retained OpenCode POST yields control to DSH before the POST completes.
 * The next DSH model step supplies its actual result, releases the plugin RPC,
 * and resumes that SAME request. It is never replayed as another model prompt. */
export class StructuredAdapterRuntime {
  constructor(config, broker, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.broker = broker;
    this.client = new OpenCodeServeClient(config, fetchImpl);
    this.turns = new Map();
    this.cleanup = new Set();
    this.journal = new SessionJournal({
      directory: config.sessionJournalRoot ? path.join(config.sessionJournalRoot, 'dsh-opencode-sessions') : null,
      removeSession: id => this.deleteOwnedSession(id), logger: config.logger,
    });
    this.sessions = new StructuredSessionRegistry({
      onRetire: id => this.reclaim(id),
      maxIdle: 32,
      idleTtlMs: 30 * 60_000,
    });
    this.contextBudget = new ContextBudget(this.client, { logger: config.logger });
    this.sweeper = setInterval(() => this.sessions.sweep(), 60_000);
    this.sweeper.unref?.();
    this.terminalFailures = new Map();
    this.busy = new Set();
    this.disposed = false;
    this.handoffTimeoutMs = config.structuredHandoffTimeoutMs ?? 600000;
    this.compactionTimeoutMs = config.compactionTimeoutMs ?? 120000;
  }

  key(options) { return JSON.stringify([options.sessionId ?? '', options.model, options.purpose ?? 'chat']); }

  async deleteOwnedSession(id) {
    try {
      await this.client.request('/session/' + encodeURIComponent(id), undefined,
        AbortSignal.timeout(3500), 'DELETE');
    } catch (error) {
      if (error.failure?.status !== 404) throw error;
    }
  }

  reclaim(id) {
    const task = this.journal.retire(id);
    this.cleanup.add(task);
    void task.finally(() => this.cleanup.delete(task));
    return task;
  }

  async compact(id, model, signal) {
    // The compaction agent may need to render system instructions through the
    // OpenCode plugin hook. Give it an explicit EMPTY DSH tool catalog, never
    // inherited workspace grants. The broker still cannot execute any tools.
    this.broker.register(id, { tools: [], instructions: '', onCall() {
      throw failure('Compaction must not request DSH tools', 'COMPACTION_TOOL_BLOCKED');
    } });
    try {
      const result = await this.client.request(
        '/session/' + encodeURIComponent(id) + '/summarize',
        { providerID: this.client.backendProviderId, modelID: model, auto: false },
        signal ? AbortSignal.any([signal, AbortSignal.timeout(this.compactionTimeoutMs)])
          : AbortSignal.timeout(this.compactionTimeoutMs));
      if (result !== true) throw failure('OpenCode did not confirm compaction', 'CONTEXT_COMPACTION_FAILED');
    } catch (error) {
      if (signal?.aborted) throw failure('Context compaction cancelled', 'ABORTED');
      throw failure('OpenCode could not compact its Session (' +
        (error.code || error.failure?.code || 'MODEL_ERROR') + '); DSH history is unchanged',
      'CONTEXT_COMPACTION_FAILED', error.failure?.status);
    } finally {
      this.broker.unregister(id);
    }
  }

  publish(turn, event) {
    if (turn.closed) return;
    const previous = turn.queue.at(-1);
    if (event.kind === 'part' && previous?.kind === 'part' && previous.part.id === event.part.id) {
      turn.queue[turn.queue.length - 1] = event;
    } else turn.queue.push(event);
    if (turn.queue.length > 4096) {
      this.fail(turn, failure('Structured event queue exceeded its limit', 'STREAM_QUEUE_LIMIT')); return;
    }
    turn.wake?.(); turn.wake = null;
  }

  arm(turn, ms, code) {
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => this.fail(turn, failure(code === 'TOOL_RESULT_TIMEOUT'
      ? 'DSH tool result wait expired' : 'OpenCode model request timed out', code)), ms);
    turn.timer.unref?.();
  }

  bindSignal(turn, signal) {
    turn.unbind?.();
    const abort = () => this.fail(turn, failure('DSH request cancelled', 'ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    turn.unbind = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
  }

  fail(turn, error) {
    if (turn.closed) return;
    const terminal = afterToolFailure(error, turn.handedOff);
    turn.error = terminal;
    if (turn.lastCallId && terminal?.code === 'TOOL_CONTINUATION_FAILED') {
      // Keep the original failure for a stale retry of THIS exact tool result.
      this.terminalFailures.delete(turn.key);
      this.terminalFailures.set(turn.key, { callId: turn.lastCallId, error: terminal });
      if (this.terminalFailures.size > MAX_TERMINAL_FAILURES) {
        this.terminalFailures.delete(this.terminalFailures.keys().next().value);
      }
    }
    turn.queue = [{ kind: 'error', error: terminal }]; // Never emit queued tools after cancellation.
    turn.wake?.(); turn.wake = null;
    this.close(turn);
  }

  close(turn) {
    if (turn.closed) return;
    turn.closed = true;
    clearTimeout(turn.timer);
    turn.unbind?.();
    this.broker.unregister(turn.id);
    turn.controller.abort();
    turn.events?.close();
    if (turn.dshSessionId) {
      if (turn.completed && turn.finished && !turn.error) {
        this.sessions.complete(turn.key, turn.id, turn.dshMessages, turn.system,
          turn.reply, turn.lastUsage);
      } else {
        this.sessions.invalidate(turn.key, turn.id);
      }
    }
    if (this.turns.get(turn.key) === turn) this.turns.delete(turn.key);
    if (!turn.finished) {
      // A failed/aborted turn may still be executing. Delete only after the
      // owned server acknowledges abort; otherwise keep the journal for recovery.
      const stop = this.client.request('/session/' + encodeURIComponent(turn.id) + '/abort', {},
        AbortSignal.timeout(2000)).then(() => this.reclaim(turn.id)).catch(() => {})
        .finally(() => this.cleanup.delete(stop));
      this.cleanup.add(stop);
    } else if (!turn.completed || turn.error || !turn.dshSessionId) {
      // Anonymous requests have no DSH identity to bind across turns.
      this.reclaim(turn.id);
    }
  }

  async begin(options) {
    if (this.disposed) throw failure('Structured runtime is disposed', 'BRIDGE_CLOSED');
    await this.client.ensureService?.({ requireManaged: true });
    await this.broker.start();
    if (this.disposed || options.signal?.aborted) throw failure('Structured startup cancelled', 'ABORTED');
    const key = this.key(options);
    const system = instructions(options);
    await this.journal.init();
    const reusable = options.sessionId ? this.sessions.plan(key, options.messages ?? [], system) : null;
    let id = reusable?.id;
    let turn;
    try {
      const prompt = renderMessages((reusable?.messages ?? options.messages ?? [])
        .filter(m => !['system', 'developer'].includes(m.role)));
      if (!prompt.trim()) throw failure('No message for OpenCode', 'INVALID_REQUEST');
      const window = await this.contextBudget.limit(options.model, options.signal);
      const budget = this.contextBudget.check({
        window, prompt, system, tools: options.tools, reused: Boolean(reusable),
        priorTokens: reusable?.lastUsage,
      });
      if (budget.action === 'reject') {
        throw failure('OpenCode input exceeds its safe model budget (estimated ' +
          budget.incoming + ' / ' + budget.usable +
          ' tokens). DSH history was not truncated.', 'CONTEXT_LIMIT_EXCEEDED');
      }
      if (budget.action === 'compact') {
        try { await this.compact(id, options.model, options.signal); }
        catch (error) {
          // An interrupted compaction may have changed internal OpenCode state.
          // Never silently reuse that uncertain Session.
          this.sessions.release(key, id);
          this.sessions.invalidate(key, id);
          throw error;
        }
      }
      if (!id) {
        id = await this.client.createSession(options.signal);
        await this.journal.track(id);
      }
      turn = { id, key, queue: [], wake: null, dshSessionId: options.sessionId,
        dshMessages: options.messages ?? [], system, reply: '', completed: false, lastUsage: null,
        controller: new AbortController(), timer: null, waiting: null, streaming: false,
        closed: false, finished: false, error: null, delivered: new Map(),
        handedOff: false, lastCallId: null };
      if (options.sessionId) this.sessions.active(key, id);
      this.turns.set(key, turn);
      this.bindSignal(turn, options.signal);
      if (this.disposed || turn.closed) throw failure('Structured startup cancelled', 'ABORTED');
      this.broker.register(id, {
        tools: options.tools ?? [], instructions: system,
        onCall: call => {
          this.arm(turn, this.handoffTimeoutMs, 'TOOL_RESULT_TIMEOUT');
          this.publish(turn, { kind: 'call', call });
        },
        onDisconnect: () => this.fail(turn,
          failure('OpenCode disconnected while awaiting a DSH tool', 'TOOL_TRANSPORT_CLOSED')),
      });
      const payload = {
        agent: this.client.agent, model: { providerID: this.client.backendProviderId, modelID: options.model },
        system, parts: [{ type: 'text', text: prompt }],
      };
      if (this.config.ssePreviewEnabled) {
        const feed = new StructuredEventFeed(id, part => this.publish(turn, { kind: 'part', part }),
          () => this.fail(turn, failure('Unexpected native OpenCode execution event', 'OPENCODE_TOOL_BOUNDARY')));
        turn.events = await openSessionEvents({ origin: this.client.origin, headers: this.client.headers(),
          fetchImpl: this.client.fetchImpl, signal: turn.controller.signal, logger: this.config.logger });
        turn.eventPump = turn.events?.pump(event => feed.accept(event));
      }
      if (turn.closed) throw turn.error;
      this.arm(turn, this.client.timeoutMs, 'TIMEOUT');
      // No fixed fetch timeout: the model budget is paused during DSH approval.
      // The turn controller and separate handoff deadline bound the whole cycle.
      turn.request = this.client.fetchImpl(this.client.origin + '/session/' + encodeURIComponent(id) + '/message', {
        method: 'POST', headers: this.client.headers(), redirect: 'error',
        signal: turn.controller.signal, body: JSON.stringify(payload),
      }).then(async response => {
        if (!response.ok) throw providerFailure(await response.text(), response.status);
        const body = await response.json();
        if (body.info?.error) throw providerFailure(body.info.error);
        if (!Array.isArray(body.parts)) throw failure('OpenCode returned no parts', 'INVALID_RESPONSE');
        if (body.info?.modelID && body.info.modelID !== options.model) {
          throw failure('OpenCode returned another model', 'MODEL_MISMATCH');
        }
        if (body.info?.summary === true || body.info?.mode === 'compaction') {
          throw failure('Internal OpenCode compaction cannot become the DSH reply',
            'COMPACTION_RESPONSE_MISMATCH');
        }
        if (this.broker.sessions.get(turn.id)?.pending.size) {
          throw failure('OpenCode completed before DSH supplied its tool result', 'EARLY_OPENCODE_FINISH');
        }
        if (body.parts.some(p => p?.type === 'tool'
          && (p.metadata?.providerExecuted || p.state?.metadata?.providerExecuted
            || (p.tool !== 'dsh_call' && p.state?.status === 'completed')))) {
          throw failure('Unexpected native OpenCode execution', 'OPENCODE_TOOL_BOUNDARY');
        }
        turn.finished = true;
        clearTimeout(turn.timer);
        this.publish(turn, { kind: 'done', body });
      }).catch(error => {
        if (!turn.closed) this.fail(turn, error?.failure ? error
          : failure('Structured OpenCode request failed', 'TRANSPORT'));
      });
      return turn;
    } catch (error) {
      if (turn) this.close(turn);
      else if (reusable) this.sessions.release(key, reusable.id);
      else if (id) this.reclaim(id);
      throw error;
    }
  }

  async *stream(options) {
    const key = this.key(options);
    if (this.busy.has(key)) throw failure('Overlapping DSH streams for one session', 'CONCURRENT_STREAM');
    this.busy.add(key);
    try { yield* this.streamOnce(options); }
    finally { this.busy.delete(key); }
  }

  async *streamOnce(options) {
    if (this.disposed) throw failure('Structured runtime is disposed', 'BRIDGE_CLOSED');
    if (options.signal?.aborted) {
      const active = this.turns.get(this.key(options));
      if (active) this.fail(active, failure('Request cancelled', 'ABORTED'));
      throw failure('Request cancelled', 'ABORTED');
    }
    if (options.tools?.length && !options.sessionId) {
      throw failure('Structured tools require an explicit DSH session ID', 'SESSION_ID_REQUIRED');
    }
    if (options.tools?.length && this.config.toolBridgeEnabled === false) {
      throw failure('DSH tools are disabled', 'DSH_TOOLS_DISABLED');
    }
    const key = this.key(options);
    let turn = this.turns.get(key);
    if (turn) {
      if (!turn.waiting) throw failure('OpenCode is already generating for this session', 'CONCURRENT_STREAM');
      const result = [...(options.messages ?? [])].reverse()
        .find(m => m.role === 'tool' && resultId(m) === turn.waiting.id);
      if (!result) {
        this.close(turn);
        throw failure('The pending DSH tool result is missing', 'TOOL_RESULT_REQUIRED');
      }
      this.bindSignal(turn, options.signal);
      if (turn.closed) throw turn.error;
      try {
        this.broker.update(turn.id, options.tools ?? [], instructions(options));
        this.broker.settle(turn.id, turn.waiting.id, {
          isError: result.isError === true, content: result.content ?? [],
        });
        turn.dshMessages = options.messages ?? [];
        turn.waiting = null;
        this.arm(turn, this.client.timeoutMs, 'TIMEOUT');
      } catch (error) {
        this.close(turn);
        throw error;
      }
    } else {
      if (options.messages?.at(-1)?.role === 'tool') {
        const prior = this.terminalFailures.get(key);
        if (prior && prior.callId === resultId(options.messages.at(-1))) {
          // A DSH retry may not revive a lost POST or repeat a finished tool.
          throw prior.error;
        }
        throw failure('No pending OpenCode request for this DSH tool result', 'TOOL_RESULT_MISMATCH');
      }
      this.terminalFailures.delete(key); // New human turn can start fresh.
      turn = await this.begin(options);
    }
    turn.streaming = true;
    let handoff = false;
    const blocks = new StructuredBlocks(turn.delivered);
    try {
      while (true) {
        if (turn.error) throw turn.error;
        if (!turn.queue.length) {
          if (turn.closed) throw failure('Structured session was closed', 'BRIDGE_CLOSED');
          await new Promise(resolve => { turn.wake = resolve; });
          continue;
        }
        const event = turn.queue.shift();
        if (event.kind === 'error') throw event.error;
        if (event.kind === 'part') { yield* blocks.part(event.part); continue; }
        if (event.kind === 'call') {
          // Revalidate a queued parallel intent against THIS DSH step's catalog.
          if (!options.tools?.some(tool => tool.name === event.call.name)) {
            this.broker.settle(turn.id, event.call.id, { isError: true,
              content: [{ type: 'text', text: 'Tool removed from the current DSH catalog' }] });
            continue;
          }
          turn.waiting = event.call;
          if (turn.dshSessionId) this.sessions.waiting(turn.key, turn.id);
          turn.lastCallId = event.call.id;
          turn.handedOff = true;
          this.arm(turn, this.handoffTimeoutMs, 'TOOL_RESULT_TIMEOUT');
          yield* blocks.end();
          const index = blocks.nextIndex;
          const call = event.call;
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments };
          yield { type: 'block-end', index, block: { type: 'tool-call', ...call } };
          handoff = true;
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (event.kind === 'done') {
          const body = event.body;
          if (!textOf(body.parts).trim()) throw failure('OpenCode returned no final text', 'EMPTY_RESPONSE');
          for (const [i, part] of body.parts.entries()) {
            yield* blocks.part({ ...part, id: part.id ?? 'final-' + i });
          }
          yield* blocks.end();
          turn.reply = textOf(body.parts);
          turn.lastUsage = consumedTokens(body.info?.tokens);
          if (body.info?.tokens) yield { type: 'usage', usage: {
            inputTokens: Number(body.info.tokens.input) || 0, outputTokens: Number(body.info.tokens.output) || 0,
          } };
          turn.completed = true;
          yield { type: 'finish', reason: { kind: body.info?.finish === 'length' ? 'max-tokens' : 'stop' } };
          return;
        }
      }
    } finally {
      turn.streaming = false;
      // Keep its cancellation listener through approval; do NOT interpret a
      // normal end-of-LLM-step as cancellation of the retained OpenCode POST.
      if (!handoff) this.close(turn);
    }
  }

  async dispose() {
    this.disposed = true;
    clearInterval(this.sweeper);
    for (const turn of this.turns.values()) this.fail(turn, failure('DSH plugin stopped', 'BRIDGE_CLOSED'));
    for (const [key, entry] of this.sessions.entries) {
      if (entry.state === 'idle') this.sessions.retire(key);
    }
    await this.broker.dispose();
    this.sessions.clear();
    this.terminalFailures.clear();
    await Promise.allSettled([...this.cleanup]);
    await this.journal.drain();
  }
}

export function createStructuredAdapter(config, broker, fetchImpl = globalThis.fetch) {
  const base = createAdapter(config, fetchImpl);
  const runtime = new StructuredAdapterRuntime(config, broker, fetchImpl);
  return { ...base, runtime,
    async prepareCall(provider, modelId) {
      const original = await base.prepareCall(provider, modelId);
      return { model: original.model, async *stream(options) {
        if (config.localTitles !== false && options.purpose === 'session-title') {
          yield* original.stream(options); return;
        }
        yield* runtime.stream({ ...options, model: modelId });
      } };
    },
  };
}
