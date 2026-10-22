import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, appendFile, rename, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { badgePage, logsPage } from './diagnostics-pages.js';

const FIELDS = new Set([
  'model', 'tool', 'errorCode', 'httpStatus', 'reason', 'phase', 'status', 'source',
  'used', 'limit', 'estimated', 'projected', 'threshold', 'total', 'idle',
  'running', 'durationMs', 'generation', 'pid', 'count', 'attempt', 'port',
  'remaining', 'cached', 'inputTokens', 'outputTokens', 'contextSource',
  'authSource', 'proxyMode',
]);
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const TYPES = new Set(['service', 'session', 'context', 'compaction', 'tool',
  'stream', 'provider', 'journal']);
const SAFE_TEXT = /^[a-zA-Z0-9._:/$-]{1,96}$/;

function safeFields(input) {
  const result = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!FIELDS.has(key) || value === undefined || value === null) continue;
    if (typeof value === 'boolean') { result[key] = value; continue; }
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = Math.max(-1, Math.min(1e12, Math.round(value * 100) / 100)); continue;
    }
    if (typeof value === 'string' && SAFE_TEXT.test(value)) result[key] = value;
  }
  return result;
}

export function sessionKey(id) {
  return typeof id === 'string' && id ? createHash('sha256').update(id).digest('hex').slice(0, 16) : '';
}

const trim = (events, length) => events.length > length ? events.slice(-length) : events;
const state = () => ({ used: null, limit: null, phase: 'unknown', estimate: true, updatedAt: 0 });

/** Bounded, read-only diagnostic event bus. Never call it with message content,
 * tool arguments, filesystem paths, credentials, or raw provider error strings.
 * The wire projection enforces a strict metadata allowlist anyway. */
export class DiagnosticHub {
  constructor({ root, port = 4097, enabled = true, logger, maxEntries = 1600,
    maxFileBytes = 1_500_000 } = {}) {
    this.root = root || null;
    this.port = port;
    this.enabled = enabled !== false;
    this.logger = logger;
    this.maxEntries = maxEntries;
    this.maxFileBytes = maxFileBytes;
    this.instance = randomBytes(6).toString('hex');
    this.seq = 0;
    this.items = [];
    this.contexts = new Map();
    this.service = { status: 'starting', updatedAt: Date.now() };
    this.sessions = { idle: 0, running: 0 };
    this.writeChain = Promise.resolve();
    this.server = null;
    this.startPromise = null;
    this.closed = false;
    this.fileBytes = 0;
    this.persisting = false;
    this.file = this.root ? path.join(this.root, 'dsh-opencode-diagnostics.jsonl') : null;
  }

  record(category, code, details = {}, level = 'info') {
    if (!TYPES.has(category) || typeof code !== 'string' || !SAFE_TEXT.test(code)) {
      throw new TypeError('Invalid diagnostic event type');
    }
    const session = sessionKey(details.sessionId);
    const event = { instance: this.instance, seq: ++this.seq, time: Date.now(),
      level: LEVELS.has(level) ? level : 'info', category, code,
      ...(session ? { session } : {}), data: safeFields(details) };
    this.items.push(event);
    this.items = trim(this.items, this.maxEntries);
    if (category === 'service') {
      const changes = {
        'process.ready': 'healthy', 'restart.complete': 'healthy',
        'process.stop': 'stopped', 'restart.begin': 'restarting',
        'health.unresponsive': 'unresponsive', 'restart.cooldown': 'cooldown',
        'process.start-failed': 'failed',
      };
      if (changes[code]) this.service = { status: changes[code], updatedAt: Date.now() };
    }
    if (this.file && this.persisting) {
      const line = JSON.stringify(event) + '\n';
      this.writeChain = this.writeChain.then(async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        if (this.fileBytes + Buffer.byteLength(line) > this.maxFileBytes) {
          await rename(this.file, this.file + '.1').catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
          this.fileBytes = 0;
        }
        await appendFile(this.file, line, { mode: 0o600 });
        this.fileBytes += Buffer.byteLength(line);
      }).catch(error => {
        // Diagnostic writes must never fail a user model request.
        this.logger?.warn?.('dsh-opencode: diagnostics write failed [' +
          (error?.code || 'IO') + ']');
      });
    }
    return event;
  }

  context(sessionId, values) {
    const key = sessionKey(sessionId);
    if (!key) return;
    const previous = this.contexts.get(key) ?? state();
    const next = { ...previous };
    for (const field of ['used', 'limit', 'phase', 'estimate']) {
      if (!Object.hasOwn(values, field)) continue;
      const value = values[field];
      if ((field === 'used' || field === 'limit') &&
          !(value === null || Number.isFinite(value) && value >= 0)) continue;
      if (field === 'estimate' && typeof value !== 'boolean') continue;
      if (field === 'phase' && !['unknown', 'ready', 'compacting', 'failed'].includes(value)) continue;
      next[field] = value;
    }
    next.updatedAt = Date.now();
    this.contexts.delete(key);
    this.contexts.set(key, next);
    if (this.contexts.size > 160) this.contexts.delete(this.contexts.keys().next().value);
  }

  serviceState(status, details = {}) {
    this.service = { status, updatedAt: Date.now() };
    this.record('service', 'state.' + status, details, status === 'healthy' ? 'debug' : 'info');
  }

  sessionCount(counts) {
    this.sessions = { idle: Number(counts.idle) || 0, running: Number(counts.running) || 0 };
  }

  snapshot(sessionId) {
    return {
      session: sessionKey(sessionId), context: this.contexts.get(sessionKey(sessionId)) ?? state(),
      service: { ...this.service }, sessions: { ...this.sessions },
      recentEvents: this.items.length,
    };
  }

  events({ limit = 600 } = {}) {
    return this.items.slice(-Math.min(1600, Math.max(1, limit)));
  }

  async load() {
    if (!this.file) return;
    await this.writeChain;
    try {
      const info = await stat(this.file);
      this.fileBytes = info.size;
      if (info.size > this.maxFileBytes * 2) return;
      const content = await readFile(this.file, 'utf8');
      const old = content.split('\n').filter(Boolean).slice(-this.maxEntries)
        .flatMap(line => {
          try {
            const value = JSON.parse(line);
            return value && TYPES.has(value.category) && LEVELS.has(value.level)
              && typeof value.code === 'string'
              ? [{ instance: String(value.instance || '').slice(0, 12), seq: Number(value.seq) || 0,
                time: Number(value.time) || 0, category: value.category, code: value.code,
                level: value.level, ...(typeof value.session === 'string' &&
                  /^[a-f0-9]{16}$/.test(value.session) ? { session: value.session } : {}),
                data: safeFields(value.data) }] : [];
          } catch { return []; }
        });
      const keys = new Set();
      this.items = trim([...old, ...this.items].filter(ev => {
        const k = ev.instance + '/' + ev.seq;
        if (keys.has(k)) return false;
        keys.add(k);
        return true;
      }).sort((a, b) => a.time - b.time), this.maxEntries);
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn?.(
        'dsh-opencode: diagnostic history load failed [' + (error.code || 'IO') + ']');
    }
  }

  async start() {
    if (!this.enabled || this.closed) return false;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await this.load();
      this.persisting = true;
      const server = createServer((request, response) => this.handle(request, response));
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(this.port, '127.0.0.1', resolve);
        });
      } catch (error) {
        this.logger?.warn?.('dsh-opencode: diagnostic panel unavailable [' +
          (error.code || 'PORT') + '], model transport remains active');
        await new Promise(resolve => server.close(resolve)).catch(() => {});
        return false;
      }
      if (this.closed) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); return false; }
      this.server = server;
      this.record('service', 'diagnostics.ready', { port: this.port }, 'debug');
      return true;
    })();
    return this.startPromise;
  }

  handle(req, res) {
    const expected = '127.0.0.1:' + this.port;
    // DNS rebinding defense; the server is already bound to loopback only.
    if (req.headers.host !== expected && req.headers.host !== 'localhost:' + this.port) {
      res.writeHead(403).end(); return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1:' + this.port);
    const base = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer' };
    if (req.method !== 'GET') { res.writeHead(405, base).end(); return; }
    if (url.pathname === '/v1/badge' || url.pathname === '/v1/page') {
      // HTML contains no user/session data. JS fetches same-origin read-only
      // structured metadata with a non-simple header; no cross-origin CORS.
      res.writeHead(200, { ...base, 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'" });
      res.end(url.pathname === '/v1/badge' ? badgePage : logsPage); return;
    }
    if (req.headers['x-dsh-diagnostic'] !== '1'
        || (req.headers.origin && !['http://127.0.0.1:' + this.port,
          'http://localhost:' + this.port].includes(req.headers.origin))) {
      res.writeHead(403, base).end(); return;
    }
    if (url.pathname === '/v1/snapshot') {
      res.writeHead(200, { ...base, 'content-type': 'application/json' })
        .end(JSON.stringify(this.snapshot(url.searchParams.get('sid')))); return;
    }
    if (url.pathname === '/v1/events') {
      const limit = Number(url.searchParams.get('limit')) || 600;
      res.writeHead(200, { ...base, 'content-type': 'application/json' })
        .end(JSON.stringify({ items: this.events({ limit }), truncated: this.items.length > limit })); return;
    }
    res.writeHead(404, base).end();
  }

  async dispose() {
    this.closed = true;
    this.persisting = false;
    await this.startPromise?.catch(() => {});
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    await this.writeChain;
  }
}
