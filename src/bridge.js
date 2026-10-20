import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { failure, providerFailure } from './errors.js';
import { localSessionTitle } from './title.js';
import { BRIDGE_AGENT_ID, requireBridgeAgent } from './managed-agent.js';
import { openSessionEvents, SessionEventAccumulator } from './opencode-events.js';
import {
  TOOL_CALL_PREFIX, toolInstructions, parseToolRequest, inspectNativeToolParts,
  translateGuardedTool, nativeToolPart, renderConversationMessage,
} from './tool-boundary.js';

export const DEFAULT_MODELS = Object.freeze([
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
]);
const BLOCKED_CODES = new Set(['NETWORK_BLOCKED', 'CLIENT_RESTRICTED']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part
    : part?.type === 'text' ? part.text ?? '' : '').filter(Boolean).join('\n');
}

export function renderMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const rows = messages.map(message => renderConversationMessage(message, textOf))
    .filter(Boolean);
  return rows.length === 1 && rows[0].startsWith('user:\n') ? rows[0].slice(6) : rows.join('\n\n');
}

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
}

function fingerprint(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

export class OpenCodeServeClient {
  constructor(config = {}, fetchImpl = globalThis.fetch) {
    const origin = new URL(config.endpoint || 'http://127.0.0.1:4096');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.search || origin.hash) throw new TypeError('endpoint must be an http(s) URL without credentials, query or fragment');
    this.origin = origin.toString().replace(/\/+$/, '');
    this.backendProviderId = config.backendProviderId || 'opencode';
    this.agent = requireBridgeAgent(config.agent || BRIDGE_AGENT_ID);
    this.passwordEnv = config.passwordEnv || 'OPENCODE_SERVER_PASSWORD';
    this.passwordProvider = config.passwordProvider;
    this.username = config.username || process.env.OPENCODE_SERVER_USERNAME || 'opencode';
    this.timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? Math.min(2147483647, Math.max(1, Math.floor(config.timeoutMs))) : 120_000;
    this.fetchImpl = fetchImpl;
    this.attributionHeaders = config.attributionHeaders ?? {};
    this.logger = config.logger;
    this.ensureService = config.ensureService;
    this.toolBridgeEnabled = config.toolBridgeEnabled !== false;
    this.guardedReadCompatibility = config.guardedReadCompatibility === true;
    // Explicit opt-in: ignore prior persisted streamingEnabled=true defaults.
    this.streamingEnabled = config.ssePreviewEnabled === true;
    this.sessions = new Map();
    this.pending = Promise.resolve();
    this.blocked = null;
    this.sseNoDeltaWarned = false;
  }

  headers() {
    const headers = { ...this.attributionHeaders, 'content-type': 'application/json', accept: 'application/json' };
    const password = this.passwordProvider?.() || process.env[this.passwordEnv];
    if (password) headers.authorization = 'Basic ' + Buffer.from(this.username + ':' + password).toString('base64');
    return headers;
  }

  async request(path, payload, signal, method = 'POST') {
    if (signal?.aborted) throw failure('OpenCode request cancelled', 'ABORTED');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(this.origin + path, {
        method, headers: this.headers(), redirect: 'error', signal: combined,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!response.ok) throw providerFailure(await response.text(), response.status);
      try { return await response.json(); }
      catch (error) {
        if (combined.aborted) throw error;
        throw failure('Invalid JSON from opencode serve', 'INVALID_RESPONSE', response.status);
      }
    } catch (error) {
      if (signal?.aborted) throw failure('OpenCode request cancelled', 'ABORTED');
      if (timeout.aborted) throw failure('OpenCode request timed out', 'TIMEOUT');
      if (error?.failure) throw error;
      throw failure('Cannot reach opencode serve: ' + (error?.message ?? error), 'TRANSPORT');
    }
  }

  async createSession(signal) {
    const response = await this.request('/session', { title: 'DSH bridge' }, signal);
    if (typeof response?.id !== 'string' || !response.id) throw failure('OpenCode did not return a session id', 'INVALID_RESPONSE');
    return response.id;
  }

  // Serialize model requests, including auxiliary calls, instead of racing session creation.
  complete(options, onSnapshot) {
    const task = this.pending.then(() => this.completeOnce(options, onSnapshot));
    this.pending = task.catch(() => {});
    const signal = options?.signal;
    if (!signal) return task;
    return new Promise((resolve, reject) => {
      const abort = () => reject(failure('OpenCode request cancelled', 'ABORTED'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  // Ordered SSE snapshots with an authoritative final response.
  async *streamResponse(options) {
    const own = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([own.signal, options.signal]) : own.signal;
    const items = [];
    let queuedText = '';
    let done = false;
    let response;
    let error;
    let notify;
    const wake = () => { const fn = notify; notify = null; fn?.(); };
    const task = this.complete({ ...options, signal }, this.streamingEnabled
      ? snapshot => {
        if (done || !snapshot.startsWith(queuedText)) return;
        const delta = snapshot.slice(queuedText.length);
        queuedText = snapshot;
        if (delta) { items.push({ kind: 'delta', text: delta }); wake(); }
      }
      : undefined);
    task.then(result => { response = result; done = true; wake(); },
      reason => { error = reason; done = true; wake(); });
    try {
      while (true) {
        if (items.length) {
          yield items.shift();
          continue;
        }
        if (done) {
          if (error) throw error;
          yield { kind: 'response', response };
          return;
        }
        await new Promise(resolve => { notify = resolve; });
      }
    } finally {
      own.abort();
      void task.catch(() => {});
    }
  }

  async completeOnce(options, onSnapshot) {
    if (options?.signal?.aborted) throw failure('OpenCode request cancelled', 'ABORTED');
    if (this.blocked && Date.now() < this.blocked.until) throw this.blocked.error;
    const tools = Array.isArray(options?.tools) ? options.tools : [];
    if (tools.length && !this.toolBridgeEnabled) {
      throw failure('DSH tools were provided but the model bridge is disabled', 'DSH_TOOLS_DISABLED');
    }
    const toolGuide = toolInstructions(tools) + (this.guardedReadCompatibility && tools.length
      ? '\nAny built-in OpenCode tools advertised for gateway compatibility are GUARDED '
        + 'and will always fail; request DSH tools only, using DSH_TOOL_CALL_V1.'
      : '');
    // Require the isolated, plugin-owned OpenCode process for tool-bearing requests.
    await this.ensureService?.({ requireManaged: tools.length > 0 });
    if (options?.signal?.aborted) throw failure('OpenCode request cancelled', 'ABORTED');
    const messages = Array.isArray(options?.messages) ? options.messages : [];
    const key = options?.sessionId ? JSON.stringify([
      options.sessionId, options.model, options.purpose ?? 'chat', options.system ?? '',
    ]) : null;
    let session = key ? this.sessions.get(key) : null;
    if (session && (session.count >= messages.length
      || session.fingerprint !== fingerprint(messages.slice(0, session.count)))) session = null;
    const unseen = messages.slice(session?.count ?? 0);
    const toSend = (session ? unseen.filter(message => message.role !== 'assistant') : messages)
      .filter(message => message.role !== 'system');
    const prompt = renderMessages(toSend);
    if (!prompt.trim()) throw failure('No text message to send to OpenCode', 'INVALID_REQUEST');
    const system = [options?.system,
      ...messages.filter(m => m.role === 'system').map(m => textOf(m.content)),
      toolGuide,
    ].filter(Boolean).join('\n\n');
    const payload = {
      model: { providerID: this.backendProviderId, modelID: options.model },
      agent: this.agent, ...(system ? { system } : {}),
      parts: [{ type: 'text', text: prompt }],
    };
    let events;
    let eventPump;
    let collector;
    try {
      if (!session) session = { id: await this.createSession(options?.signal), count: 0 };
      if (onSnapshot) {
        events = await openSessionEvents({
          origin: this.origin, headers: this.headers(), fetchImpl: this.fetchImpl,
          signal: options?.signal, logger: this.logger,
        });
        if (events) {
          collector = new SessionEventAccumulator(session.id, onSnapshot);
          eventPump = events.pump(event => collector.accept(event));
        }
      }
      const response = await this.request('/session/' + encodeURIComponent(session.id) + '/message', payload, options?.signal);
      if (collector && !collector.text && !this.sseNoDeltaWarned) {
        this.sseNoDeltaWarned = true;
        this.logger?.warn?.('dsh-opencode: SSE connected but delivered no assistant text; ' +
          'this OpenCode server may not publish incremental events. Using final response.');
      }
      if (response?.info?.error) throw providerFailure(response.info.error);
      if (!Array.isArray(response?.parts)) throw failure('OpenCode returned no message parts', 'INVALID_RESPONSE');
      if (response.info?.modelID && response.info.modelID !== options.model) throw failure('OpenCode returned a different model', 'MODEL_MISMATCH');
      // Verify ALL tool parts, including SSE-only events. Only the exact
      // terminal denial from our confirmed native guard can carry intent into
      // DSH. Provider-executed, unknown or successful tool events still fail.
      const native = new Map();
      for (const part of collector?.nativeToolParts.values() ?? []) {
        native.set(part.id, part);
      }
      for (const part of response.parts.filter(nativeToolPart)) {
        native.set(part.id ?? part.callID ?? Symbol(), part);
      }
      const guardedCalls = inspectNativeToolParts([...native.values()],
        { guarded: this.guardedReadCompatibility });
      const text = response.parts.filter(p => p?.type === 'text').map(p => p.text ?? '').join('');
      let dshToolCall = parseToolRequest(text, tools);
      if (guardedCalls.length && !dshToolCall) {
        // OpenCode may attempt multiple tools in one generation. The native
        // guard denied ALL of them; submit only the FIRST eligible intent to
        // DSH so the agent can sequence the rest after seeing its real result.
        // A batch never directly executes or silently authorizes later calls.
        dshToolCall = translateGuardedTool(guardedCalls[0], tools);
        if (!dshToolCall) {
          throw failure('The first blocked OpenCode tool has no matching declared DSH tool '
            + 'or compatible argument schema', 'GUARDED_TOOL_UNMAPPED');
        }
        if (guardedCalls.length > 1) {
          this.logger?.warn?.('dsh-opencode: ' + guardedCalls.length
            + ' guarded native tool intents; forwarding only the first to DSH');
        }
      }
      if (!text.trim() && !dshToolCall) {
        const kinds = response.parts.map(p => p?.type || '?').join(', ') || 'none';
        throw failure('OpenCode returned no visible text (part types: ' + kinds + ')', 'EMPTY_RESPONSE');
      }
      // A truncated tool request must never be dispatched, even if its JSON parsed.
      if (dshToolCall && response.info?.finish === 'length') {
        throw failure('Truncated model output cannot authorize a DSH tool call',
          'INCOMPLETE_TOOL_CALL');
      }
      if (key) {
        this.sessions.delete(key);
        this.sessions.set(key, { id: session.id, count: messages.length, fingerprint: fingerprint(messages) });
        if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value);
      }
      this.blocked = null;
      return { ...response, dshToolCall };
    } catch (error) {
      if (key) this.sessions.delete(key); // A failed turn may already be in OpenCode's history.
      if (BLOCKED_CODES.has(error.code)) this.blocked = { error, until: Date.now() + 60_000 };
      if (session && ['ABORTED', 'TIMEOUT'].includes(error.code)) {
        try { await this.request('/session/' + encodeURIComponent(session.id) + '/abort', {}, AbortSignal.timeout(3000)); }
        catch { /* Best effort; preserve the original cancellation/timeout. */ }
      }
      this.logger?.warn?.('dsh-opencode: [' + (error.code || 'UNKNOWN') + '] ' + error.message);
      throw error;
    } finally {
      events?.close();
      await eventPump;
    }
  }
}

export function createAdapter(config = {}, fetchImpl) {
  const provider = config.providerId || 'opencode-serve';
  const models = [...new Set((Array.isArray(config.models) ? config.models : DEFAULT_MODELS)
    .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  const client = new OpenCodeServeClient(config, fetchImpl);
  const entry = id => ({ provider, id, name: id, inputModalities: ['text'] });
  return {
    providerInfo: () => ({ id: provider, name: 'OpenCode (official serve)' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: p => p === provider ? models.map(entry) : [],
    resolveModel(p, id) {
      if (p !== provider || !models.includes(id)) throw failure('Unsupported OpenCode model: ' + id, 'MODEL_NOT_FOUND');
      return entry(id);
    },
    async prepareCall(p, id) {
      const model = this.resolveModel(p, id);
      return { model, async *stream(options) {
        // A title is a local label, not another cloud inference or a fallback model.
        if (config.localTitles !== false && options?.purpose === 'session-title') {
          if (options.signal?.aborted) throw failure('Title request cancelled', 'ABORTED');
          const first = options.messages?.find(m => m.role === 'user');
          const title = localSessionTitle(textOf(first?.content));
          config.logger?.info?.('dsh-opencode: session title generated locally; no model request');
          yield* textChunks(title);
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        let streamed = '';
        let lastSnapshot = '';
        let textStarted = false;
        for await (const item of client.streamResponse({ ...options, model: id })) {
          if (item.kind === 'delta') {
            // Queue only unseen bytes instead of a growing copy of the full
            // response per token (which would use quadratic queue memory).
            lastSnapshot += item.text;
            const snapshot = lastSnapshot;
            // A partial tool envelope must never be visible or dispatched.
            const candidate = snapshot.trimStart();
            if (!candidate || TOOL_CALL_PREFIX.startsWith(candidate)
              || candidate.startsWith(TOOL_CALL_PREFIX)) continue;
            if (!snapshot.startsWith(streamed)) continue;
            if (!textStarted) {
              yield { type: 'block-start', index: 0, blockType: 'text' };
              textStarted = true;
            }
            const delta = snapshot.slice(streamed.length);
            if (delta) {
              yield { type: 'text-delta', index: 0, text: delta };
              streamed = snapshot;
            }
            continue;
          }
          const response = item.response;
          const tool = response.dshToolCall;
          if (tool) {
            // A model may have streamed commentary before its native tool
            // attempt. Keep that text as one block and still dispatch the
            // guarded, validated DSH tool as the next block.
            if (textStarted) {
              yield { type: 'block-end', index: 0,
                block: { type: 'text', text: streamed } };
            }
            const index = textStarted ? 1 : 0;
            yield { type: 'block-start', index, blockType: 'tool-call' };
            yield { type: 'tool-call-delta', index, id: tool.id, name: tool.name,
              argumentsDelta: tool.arguments };
            yield { type: 'block-end', index, block: { type: 'tool-call', ...tool } };
          } else {
            const content = response.parts.filter(part => part?.type === 'text')
              .map(part => part.text || '').join('');
            if (!textStarted) {
              yield { type: 'block-start', index: 0, blockType: 'text' };
            }
            if (content.startsWith(streamed)) {
              const tail = content.slice(streamed.length);
              if (tail) yield { type: 'text-delta', index: 0, text: tail };
            } else {
              // OpenCode's SSE stream is provisional; message parts can be
              // revised or originate from an intermediate assistant step.
              // DSH's block-end is authoritative and replaces partial text.
              config.logger?.warn?.('dsh-opencode: SSE/final text divergence '
                + '(partial chars=' + streamed.length + ', final chars=' + content.length
                + '); using authoritative final message');
            }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: content } };
          }
          const usage = response.info?.tokens;
          if (usage) yield { type: 'usage', usage: { inputTokens: Number(usage.input) || 0,
            outputTokens: Number(usage.output) || 0 } };
          yield { type: 'finish', reason: { kind: tool ? 'tool-calls'
            : response.info?.finish === 'length' ? 'max-tokens' : 'stop' } };
        }
      } };
    },
  };
}
