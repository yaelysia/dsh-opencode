import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { failure, providerFailure } from './errors.js';
import { localSessionTitle } from './title.js';
import { BRIDGE_AGENT_ID } from './managed-agent.js';
import {
  toolInstructions, parseToolRequest, assertNoOpenCodeToolParts, renderConversationMessage,
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
    this.agent = config.agent || BRIDGE_AGENT_ID;
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
    this.sessions = new Map();
    this.pending = Promise.resolve();
    this.blocked = null;
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
  complete(options) {
    const task = this.pending.then(() => this.completeOnce(options));
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

  async completeOnce(options) {
    if (options?.signal?.aborted) throw failure('OpenCode request cancelled', 'ABORTED');
    if (this.blocked && Date.now() < this.blocked.until) throw this.blocked.error;
    const tools = Array.isArray(options?.tools) ? options.tools : [];
    if (tools.length && !this.toolBridgeEnabled) {
      throw failure('DSH tools were provided but the model bridge is disabled', 'DSH_TOOLS_DISABLED');
    }
    const toolGuide = toolInstructions(tools);
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
    try {
      if (!session) session = { id: await this.createSession(options?.signal), count: 0 };
      const response = await this.request('/session/' + encodeURIComponent(session.id) + '/message', payload, options?.signal);
      if (response?.info?.error) throw providerFailure(response.info.error);
      if (!Array.isArray(response?.parts)) throw failure('OpenCode returned no message parts', 'INVALID_RESPONSE');
      assertNoOpenCodeToolParts(response.parts);
      if (response.info?.modelID && response.info.modelID !== options.model) throw failure('OpenCode returned a different model', 'MODEL_MISMATCH');
      const text = response.parts.filter(p => p?.type === 'text').map(p => p.text ?? '').join('');
      if (!text.trim()) {
        const kinds = response.parts.map(p => p?.type || '?').join(', ') || 'none';
        throw failure('OpenCode returned no visible text (part types: ' + kinds + ')', 'EMPTY_RESPONSE');
      }
      const dshToolCall = parseToolRequest(text, tools);
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
        const response = await client.complete({ ...options, model: id });
        const tool = response.dshToolCall;
        if (tool) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: tool.id, name: tool.name,
            argumentsDelta: tool.arguments };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...tool } };
        } else {
          const content = response.parts.filter(part => part?.type === 'text')
            .map(part => part.text || '').join('');
          yield* textChunks(content);
        }
        const usage = response.info?.tokens;
        if (usage) yield { type: 'usage', usage: { inputTokens: Number(usage.input) || 0, outputTokens: Number(usage.output) || 0 } };
        yield { type: 'finish', reason: { kind: tool ? 'tool-calls'
          : response.info?.finish === 'length' ? 'max-tokens' : 'stop' } };
      } };
    },
  };
}
