import { createAdapter, OpenCodeServeClient, renderMessages } from './bridge.js';
import { failure, providerFailure } from './errors.js';
import { openSessionEvents } from './opencode-events.js';
import { StructuredEventFeed, StructuredBlocks } from './structured-events.js';

function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter(p => p?.type === 'text')
    .map(p => p.text ?? '').join('\n');
}
const resultId = message => message?.toolCallId ?? message?.source?.callId ?? message?.callId;
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
    this.busy = new Set();
    this.cleanup = new Set();
    this.disposed = false;
    this.handoffTimeoutMs = config.structuredHandoffTimeoutMs ?? 600000;
  }

  key(options) { return JSON.stringify([options.sessionId ?? '', options.model, options.purpose ?? 'chat']); }

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
    turn.error = error;
    turn.queue = [{ kind: 'error', error }]; // Never emit queued tools after cancellation.
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
    if (this.turns.get(turn.key) === turn) this.turns.delete(turn.key);
    if (!turn.finished) {
      const stop = this.client.request('/session/' + encodeURIComponent(turn.id) + '/abort', {},
        AbortSignal.timeout(2000)).catch(() => {}).finally(() => this.cleanup.delete(stop));
      this.cleanup.add(stop);
    }
  }

  async begin(options) {
    if (this.disposed) throw failure('Structured runtime is disposed', 'BRIDGE_CLOSED');
    await this.client.ensureService?.({ requireManaged: true });
    await this.broker.start();
    if (this.disposed || options.signal?.aborted) throw failure('Structured startup cancelled', 'ABORTED');
    const id = await this.client.createSession(options.signal);
    const turn = { id, key: this.key(options), queue: [], wake: null,
      controller: new AbortController(), timer: null, waiting: null, streaming: false,
      closed: false, finished: false, error: null, delivered: new Map() };
    this.turns.set(turn.key, turn);
    this.bindSignal(turn, options.signal);
    try {
      if (this.disposed || turn.closed) throw failure('Structured startup cancelled', 'ABORTED');
      this.broker.register(id, {
        tools: options.tools ?? [], instructions: instructions(options),
        onCall: call => {
          this.arm(turn, this.handoffTimeoutMs, 'TOOL_RESULT_TIMEOUT');
          this.publish(turn, { kind: 'call', call });
        },
        onDisconnect: () => this.fail(turn,
          failure('OpenCode disconnected while awaiting a DSH tool', 'TOOL_TRANSPORT_CLOSED')),
      });
      const prompt = renderMessages((options.messages ?? []).filter(m => !['system', 'developer'].includes(m.role)));
      if (!prompt.trim()) throw failure('No message for OpenCode', 'INVALID_REQUEST');
      const payload = {
        agent: this.client.agent, model: { providerID: this.client.backendProviderId, modelID: options.model },
        system: instructions(options), parts: [{ type: 'text', text: prompt }],
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
      this.close(turn); throw error;
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
      this.broker.update(turn.id, options.tools ?? [], instructions(options));
      this.broker.settle(turn.id, turn.waiting.id, {
        isError: result.isError === true, content: result.content ?? [],
      });
      turn.waiting = null;
      this.arm(turn, this.client.timeoutMs, 'TIMEOUT');
    } else {
      if (options.messages?.at(-1)?.role === 'tool') {
        throw failure('No pending OpenCode request for this DSH tool result', 'TOOL_RESULT_MISMATCH');
      }
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
          if (body.info?.tokens) yield { type: 'usage', usage: {
            inputTokens: Number(body.info.tokens.input) || 0, outputTokens: Number(body.info.tokens.output) || 0,
          } };
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
    for (const turn of this.turns.values()) this.fail(turn, failure('DSH plugin stopped', 'BRIDGE_CLOSED'));
    await this.broker.dispose();
    await Promise.allSettled([...this.cleanup]);
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
