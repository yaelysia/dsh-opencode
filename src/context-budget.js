import { failure } from './errors.js';

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.floor(Number(value)) : 0;

/** OpenCode/provider reports its own model limits. Unknown limits remain unknown;
 * do not silently assume that all -free models accept 256K tokens. */
export function modelWindow(catalog, providerID, modelID) {
  const provider = (catalog?.all ?? catalog?.providers ?? [])
    .find(item => item?.id === providerID);
  const models = provider?.models;
  const model = Array.isArray(models) ? models.find(item => item?.id === modelID)
    : models?.[modelID];
  const context = positive(model?.limit?.context);
  const output = positive(model?.limit?.output);
  const input = positive(model?.limit?.input);
  if (!context) return null;
  return { context, input, output };
}

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  // Conservative approximate fallback, not a tokenizer. Multibyte text and
  // JSON/tool data cost considerably more than natural English prose.
  const ascii = (text.match(/[\x00-\x7f]/g) ?? []).length;
  return Math.ceil(ascii / 3 + (Buffer.byteLength(text, 'utf8') - ascii) / 2);
}

export function consumedTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const total = positive(tokens.total);
  if (total) return total;
  const cache = tokens.cache ?? {};
  const sum = positive(tokens.input) + positive(tokens.output)
    + positive(cache.read) + positive(cache.write);
  return sum || null;
}

/** Only a preflight advisor: OpenCode remains the owner of actual compaction.
 * No DSH history is rewritten or dropped by this component. */
export class ContextBudget {
  constructor(client, { threshold = 0.78, ttlMs = 600000, logger } = {}) {
    this.client = client;
    this.threshold = threshold;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.cached = null;
    this.expiresAt = 0;
    this.loading = null;
    this.warned = false;
  }

  async limit(modelID, signal) {
    if (Date.now() >= this.expiresAt) {
      if (!this.loading) {
        this.loading = this.client.request('/provider', undefined,
          AbortSignal.timeout(5000), 'GET').then(value => {
          this.cached = value;
          this.warned = false;
        }).catch(error => {
          this.cached = null;
          if (!this.warned) this.logger?.warn?.(
            'dsh-opencode: model limits unavailable; use upstream OpenCode overflow handling (' +
            (error.code || 'TRANSPORT') + ')');
          this.warned = true;
        }).finally(() => {
          this.expiresAt = Date.now() + this.ttlMs;
          this.loading = null;
        });
      }
      await this.loading;
    }
    if (signal?.aborted) throw failure('Context budget cancelled', 'ABORTED');
    return modelWindow(this.cached, this.client.backendProviderId, modelID);
  }

  check({ window, prompt, system, tools, priorTokens, reused }) {
    if (!window) return { action: 'allow', reason: 'limit-unavailable' };
    const maxInput = window.input ? Math.min(window.input, window.context) : window.context;
    const outputReserve = window.output || Math.min(8192, Math.floor(maxInput * 0.1));
    const reserve = Math.max(1024, Math.ceil(maxInput * 0.05)) + outputReserve;
    const usable = Math.max(0, maxInput - reserve);
    // Tool catalog is added by the OpenCode plugin, not by the DSH /message.
    const incoming = estimateTokens(prompt) + estimateTokens(system)
      + estimateTokens(tools ?? []) + 256;
    if (!usable || (!reused && incoming >= usable)) {
      return { action: 'reject', incoming, usable, reason: 'single-input-too-large' };
    }
    if (reused && positive(priorTokens)) {
      const projected = positive(priorTokens) + incoming;
      if (projected >= Math.floor(usable * this.threshold)) {
        return { action: 'compact', incoming, usable, projected };
      }
      return { action: 'allow', incoming, usable, projected };
    }
    // A reused session with no trustworthy model usage cannot be estimated
    // from the latest delta alone. OpenCode's own auto-compact remains active.
    if (incoming >= usable) {
      return { action: 'reject', incoming, usable, reason: 'single-input-too-large' };
    }
    return { action: 'allow', incoming, usable, reason: 'prior-usage-unknown' };
  }
}
