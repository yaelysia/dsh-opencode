import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { failure } from './errors.js';

const MAX_BYTES = 512 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const toolName = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
function reply(res, status, data) {
  if (typeof res?.writeHead === 'function' && !res.destroyed && !res.writableEnded) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }
}

/** Private rendezvous, not a tool executor. Only the owning DSH adapter can
 * settle results in process; no HTTP endpoint approves or executes tools. */
export class StructuredToolBroker {
  constructor({ maxSessions = 16 } = {}) {
    this.maxSessions = maxSessions;
    this.token = randomBytes(32).toString('hex');
    this.sessions = new Map();
    this.calls = new Map();
    this.server = null;
    this.starting = null;
    this.closed = false;
    this.diagnosticEvent = undefined;
  }

  trace(code, details = {}, level = 'warn') {
    this.diagnosticEvent?.('tool', code, details, level);
  }

  async start() {
    if (this.closed) throw failure('Structured bridge is closed', 'BRIDGE_CLOSED');
    if (this.server?.listening) return this.environment();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch(() => reply(res, 400, { error: 'Invalid bridge request' }));
      });
      this.server = server;
      server.headersTimeout = 10000;
      server.requestTimeout = 15000; // Request body only, not the user's approval wait.
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      if (this.closed) throw failure('Structured bridge stopped during startup', 'BRIDGE_CLOSED');
      return this.environment();
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  environment() {
    if (!this.server?.listening) throw failure('Bridge listener is not ready', 'BRIDGE_NOT_READY');
    return { DSH_STRUCTURED_URL: 'http://127.0.0.1:' + this.server.address().port,
      DSH_STRUCTURED_TOKEN: this.token };
  }

  register(sessionID, { tools, instructions = '', onCall, onDisconnect, dshSessionId }) {
    if (this.closed || !identity(sessionID) || this.sessions.has(sessionID)
      || this.sessions.size >= this.maxSessions || typeof onCall !== 'function') {
      throw failure('Cannot register structured OpenCode session', 'BRIDGE_SESSION_LIMIT');
    }
    this.sessions.set(sessionID, { tools: new Map(), instructions: '', onCall, onDisconnect,
      dshSessionId, seen: new Set(), pending: new Set() });
    try { this.update(sessionID, tools, instructions); }
    catch (error) { this.sessions.delete(sessionID); throw error; }
  }

  update(sessionID, tools, instructions = '') {
    const session = this.sessions.get(sessionID);
    if (!session) throw failure('Unknown structured session', 'BRIDGE_SESSION_MISSING');
    if (!Array.isArray(tools ?? []) || typeof instructions !== 'string') {
      throw failure('Invalid DSH tool context', 'INVALID_DSH_CATALOG');
    }
    const catalog = new Map();
    for (const tool of tools ?? []) {
      if (!toolName(tool?.name) || catalog.has(tool.name) || !object(tool.parameters)) {
        throw failure('Invalid or duplicate DSH tool declaration', 'INVALID_DSH_CATALOG');
      }
      // Snapshot the catalog so later caller mutations cannot change a grant.
      catalog.set(tool.name, structuredClone(tool));
    }
    if (Buffer.byteLength(JSON.stringify([...catalog.values()])) > MAX_BYTES
      || Buffer.byteLength(instructions) > MAX_BYTES) {
      throw failure('DSH tool context is too large', 'INVALID_DSH_CATALOG');
    }
    session.tools = catalog;
    session.instructions = instructions;
  }

  async handle(req, res) {
    const expected = Buffer.from('Bearer ' + this.token);
    const supplied = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      this.trace('auth-rejected');
      reply(res, 401, { error: 'Unauthorized' }); return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/context' && req.method === 'GET') {
      const session = this.sessions.get(url.searchParams.get('sessionID'));
      if (!session) { reply(res, 404, { error: 'Inactive session' }); return; }
      reply(res, 200, { tools: [...session.tools.values()], instructions: session.instructions }); return;
    }
    if (url.pathname !== '/call' || req.method !== 'POST') {
      this.trace('route-rejected', {}, 'debug');
      reply(res, 404, { error: 'Not found' }); return;
    }
    const buffers = [];
    let bytes = 0;
    for await (const fragment of req) {
      bytes += fragment.length;
      if (bytes > MAX_BYTES) {
        this.trace('request-too-large');
        reply(res, 413, { error: 'Tool arguments too large' }); return;
      }
      buffers.push(fragment);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
    catch {
      this.trace('invalid-json');
      reply(res, 400, { error: 'Invalid JSON' }); return;
    }
    if (!object(input) || !identity(input.sessionID) || !identity(input.callID) || !identity(input.messageID)
      || !toolName(input.name) || !object(input.arguments)) {
      this.trace('invalid-envelope');
      reply(res, 400, { error: 'Invalid tool request envelope' }); return;
    }
    const session = this.sessions.get(input.sessionID);
    if (!session) {
      this.trace('inactive-session');
      reply(res, 404, { error: 'Inactive session' }); return;
    }
    if (!session.tools.has(input.name)) {
      this.trace('catalog-rejected', { sessionId: session.dshSessionId, tool: input.name });
      reply(res, 422, { error: 'Tool is not in the current DSH catalog; use a declared name' }); return;
    }
    const key = JSON.stringify([input.messageID, input.callID]);
    if (session.seen.has(key)) {
      this.trace('duplicate-blocked', { sessionId: session.dshSessionId, tool: input.name });
      reply(res, 409, { error: 'Duplicate tool request; never replay a call' }); return;
    }
    if (session.seen.size >= 128 || session.pending.size >= 8) {
      this.trace('call-limit', { sessionId: session.dshSessionId });
      reply(res, 429, { error: 'Too many tool calls' }); return;
    }
    const callId = 'call_' + randomUUID();
    const call = { id: callId, name: input.name, arguments: JSON.stringify(input.arguments) };
    session.seen.add(key);
    session.pending.add(callId);
    this.calls.set(callId, { sessionID: input.sessionID, res });
    res.on('close', () => {
      if (this.calls.delete(callId)) {
        session.pending.delete(callId);
        this.trace('callback-disconnected', { sessionId: session.dshSessionId });
        session.onDisconnect?.(callId);
      }
    });
    // Keep OpenCode's HTTP callback pending. The adapter yields to DSH NOW;
    // the next DSH model step releases it with the actual tool result/refusal.
    try { session.onCall(call); }
    catch {
      this.calls.delete(callId); session.pending.delete(callId);
      this.trace('handoff-unavailable', { sessionId: session.dshSessionId }, 'error');
      reply(res, 503, { error: 'DSH tool handoff is unavailable' });
    }
  }

  settle(sessionID, callId, result) {
    const pending = this.calls.get(callId);
    if (!pending || pending.sessionID !== sessionID) {
      this.trace('result-mismatch', {}, 'warn');
      throw failure('Tool result does not match a pending DSH call', 'TOOL_RESULT_MISMATCH');
    }
    if (!object(result) || typeof result.isError !== 'boolean'
      || !(Array.isArray(result.content) || typeof result.content === 'string')) {
      throw failure('DSH tool result is malformed', 'INVALID_TOOL_RESULT');
    }
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > 2 * MAX_BYTES) {
      this.trace('result-too-large', { sessionId: this.sessions.get(sessionID)?.dshSessionId });
      throw failure('Tool result is too large for structured transport', 'TOOL_RESULT_TOO_LARGE');
    }
    this.calls.delete(callId);
    this.sessions.get(sessionID)?.pending.delete(callId);
    reply(pending.res, 200, result);
  }

  unregister(sessionID) {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    this.sessions.delete(sessionID);
    if (session.pending.size) this.trace('pending-cancelled',
      { sessionId: session.dshSessionId, count: session.pending.size }, 'warn');
    for (const callId of session.pending) {
      const pending = this.calls.get(callId);
      this.calls.delete(callId);
      reply(pending?.res, 410, { error: 'DSH session cancelled or expired' });
    }
  }

  async dispose() {
    this.closed = true;
    for (const key of this.sessions.keys()) this.unregister(key);
    await this.starting?.catch(() => {});
    if (this.server?.listening) {
      const done = new Promise(resolve => this.server.close(resolve));
      this.server.closeAllConnections();
      await done;
    }
  }
}
