import { Buffer } from 'node:buffer';

export const DEFAULT_MODELS = Object.freeze([
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
]);

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4096';
const DEFAULT_AGENT = 'plan';

function failure(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.failure = {
    message,
    code,
    ...(status === undefined ? {} : { status }),
  };
  return error;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text ?? '';
    return '';
  }).filter(Boolean).join('\n');
}

export function renderMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const filtered = messages.map((message) => {
    const value = textOf(message?.content);
    if (!value) return '';
    const role = typeof message.role === 'string' ? message.role : 'user';
    return role + ':\n' + value;
  }).filter(Boolean);
  if (filtered.length === 1 && filtered[0].startsWith('user:\n')) {
    return filtered[0].slice(6);
  }
  return filtered.join('\n\n');
}

async function readError(response) {
  const raw = (await response.text().catch(() => '')).slice(0, 1200);
  try {
    const parsed = JSON.parse(raw);
    const nested = parsed.error;
    return String(nested?.message ?? parsed.message ?? raw);
  } catch {
    return raw || 'unknown upstream error';
  }
}

export class OpenCodeServeClient {
  constructor(config = {}, fetchImpl = globalThis.fetch) {
    const origin = new URL(config.endpoint || DEFAULT_ENDPOINT);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      throw new TypeError('endpoint must use http or https');
    }
    this.origin = origin.toString().replace(/\/+$/, '');
    this.backendProviderId = config.backendProviderId || 'opencode';
    this.agent = config.agent || DEFAULT_AGENT;
    this.passwordEnv = config.passwordEnv || 'OPENCODE_SERVER_PASSWORD';
    this.username = config.username || 'opencode';
    this.fetchImpl = fetchImpl;
    this.attributionHeaders = config.attributionHeaders ?? {};
    this.sessions = new Map();
  }

  headers() {
    const headers = { ...this.attributionHeaders, 'content-type': 'application/json', accept: 'application/json' };
    const password = process.env[this.passwordEnv];
    if (password) {
      headers.authorization = 'Basic ' + Buffer.from(this.username + ':' + password).toString('base64');
    }
    return headers;
  }

  async request(path, payload, signal) {
    let response;
    try {
      response = await this.fetchImpl(this.origin + path, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw failure('OpenCode request cancelled', 'ABORTED');
      throw failure('Cannot reach opencode serve: ' + (error?.message ?? String(error)), 'TRANSPORT');
    }
    if (!response.ok) {
      const message = await readError(response);
      throw failure('OpenCode serve HTTP ' + response.status + ': ' + message,
        response.status === 401 ? 'AUTH' : 'PROVIDER_HTTP_ERROR', response.status);
    }
    try {
      return await response.json();
    } catch {
      throw failure('Invalid JSON from opencode serve', 'INVALID_RESPONSE', response.status);
    }
  }

  async createSession(signal) {
    const response = await this.request('/session', {}, signal);
    if (!response || typeof response.id !== 'string' || !response.id) {
      throw failure('OpenCode did not return a session id', 'INVALID_RESPONSE');
    }
    return response.id;
  }

  async complete(options) {
    const messages = Array.isArray(options?.messages) ? options.messages : [];
    const key = typeof options?.sessionId === 'string' && options.sessionId
      ? options.sessionId : null;
    let session = key ? this.sessions.get(key) : null;
    if (session && session.count > messages.length) {
      this.sessions.delete(key);
      session = null;
    }
    if (!session) {
      session = { id: await this.createSession(options?.signal), count: 0 };
      if (key) this.sessions.set(key, session);
    }
    const unseen = messages.slice(session.count);
    const userMessages = unseen.filter((message) => message.role === 'user');
    const toSend = session.count > 0 && userMessages.length > 0 ? userMessages : (
      session.count === 0 ? messages : unseen
    );
    const prompt = renderMessages(toSend);
    if (!prompt) throw failure('No text message to send to OpenCode', 'INVALID_REQUEST');

    const payload = {
      model: { providerID: this.backendProviderId, modelID: options.model },
      agent: this.agent,
      parts: [{ type: 'text', text: prompt }],
    };
    let response;
    try {
      response = await this.request('/session/' + encodeURIComponent(session.id) + '/message',
        payload, options?.signal);
    } catch (error) {
      if (error.failure?.status === 404 && key) this.sessions.delete(key);
      throw error;
    }
    // OpenCode may answer HTTP 200 with a model failure in info.error
    // and no text parts. Never convert that into a successful DSH turn.
    if (response?.info?.error) {
      const upstreamError = response.info.error;
      const details = upstreamError.data ?? {};
      const status = Number(details.statusCode ?? details.status ?? upstreamError.statusCode);
      const code = Number.isInteger(status) && status >= 100 && status <= 599
        ? status : undefined;
      const message = details.message ?? upstreamError.message ??
        details.responseBody ?? 'model request failed';
      const kind = upstreamError.name ?? 'ModelError';
      throw failure('OpenCode ' + kind + ': ' + String(message).slice(0, 1200),
        code === 429 ? 'RATE_LIMIT' : code === 403 ? 'FORBIDDEN' : 'MODEL_ERROR', code);
    }
    if (!Array.isArray(response?.parts)) {
      throw failure('OpenCode returned no message parts', 'INVALID_RESPONSE');
    }
    const text = response.parts.filter((part) => part?.type === 'text')
      .map((part) => part.text ?? '').join('');
    if (!text.trim()) {
      const kinds = response.parts.map((part) => part?.type || '?').join(', ') || 'none';
      throw failure('OpenCode returned no visible text (part types: ' + kinds +
        '). Check the OpenCode server logs.', 'EMPTY_RESPONSE');
    }
    if (key) {
      session.count = messages.length;
      this.sessions.set(key, session);
      if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value);
    }
    return response;
  }
}

export function createAdapter(config = {}, fetchImpl) {
  const provider = config.providerId || 'opencode-serve';
  const models = [...new Set(
    (Array.isArray(config.models) ? config.models : DEFAULT_MODELS)
      .filter((id) => typeof id === 'string' && id.trim() !== ''),
  )];
  const client = new OpenCodeServeClient(config, fetchImpl);
  const entry = (id) => ({
    provider,
    id,
    name: id,
    inputModalities: ['text'],
  });
  return {
    providerInfo: () => ({ id: provider, name: 'OpenCode (official serve)' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: (p) => p === provider ? models.map(entry) : [],
    resolveModel: (p, id) => {
      if (p !== provider || !models.includes(id)) {
        throw failure('Unsupported OpenCode model: ' + id, 'MODEL_NOT_FOUND');
      }
      return entry(id);
    },
    async prepareCall(p, id) {
      const model = this.resolveModel(p, id);
      return {
        model,
        async *stream(options) {
          const response = await client.complete({ ...options, model: id });
          const content = response.parts.filter((part) => part?.type === 'text')
            .map((part) => part.text || '').join('');
          if (content) {
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: content };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: content } };
          }
          const usage = response.info?.tokens;
          if (usage) {
            yield { type: 'usage', usage: {
              inputTokens: Number(usage.input) || 0,
              outputTokens: Number(usage.output) || 0,
            }};
          }
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
}
