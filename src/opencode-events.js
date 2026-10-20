import { failure } from './errors.js';

const MAX_FRAME_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 2500;

// SSE is a side channel, not the authority for completion. The synchronous
// message endpoint remains responsible for the final text and any errors.
export async function* decodeSse(body, signal) {
  const reader = body.getReader();
  const stopReading = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', stopReading, { once: true });
  if (signal?.aborted) stopReading();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let dataSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        throw failure('OpenCode event frame exceeds size limit', 'SSE_FRAME_TOO_LARGE');
      }
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) {
            try { yield JSON.parse(data.join('\n')); }
            catch { /* Ignore malformed external notifications. */ }
          }
          data = [];
          dataSize = 0;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).trimStart();
          dataSize += Buffer.byteLength(value, 'utf8');
          if (dataSize > MAX_FRAME_BYTES) {
            throw failure('OpenCode event frame exceeds size limit', 'SSE_FRAME_TOO_LARGE');
          }
          data.push(value);
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', stopReading);
    reader.releaseLock();
  }
}

function unwrap(raw) {
  const event = raw?.payload ?? raw;
  if (!event || typeof event !== 'object') return null;
  const properties = event.properties ?? event.data;
  if (typeof event.type !== 'string' || !properties || typeof properties !== 'object') return null;
  return { type: event.type, properties };
}

/** Accept only assistant text for the current session, never user echoes or other sessions. */
export class SessionEventAccumulator {
  constructor(sessionId, onText) {
    this.sessionId = sessionId;
    this.onText = onText;
    this.assistantId = null;
    this.parts = new Map();
    this.text = '';
    this.nativeToolSeen = false;
    this.nativeToolParts = new Map();
  }

  accept(raw) {
    const event = unwrap(raw);
    if (!event) return;
    const { type, properties: p } = event;
    const sessionId = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (sessionId !== this.sessionId) return;
    if (type === 'message.updated') {
      if (p.info?.role === 'assistant' && typeof p.info.id === 'string' && !this.assistantId) {
        this.assistantId = p.info.id;
      }
      return;
    }
    if (type !== 'message.part.updated' && type !== 'message.part.delta') return;
    const part = p.part;
    const messageId = p.messageID ?? part?.messageID;
    // One OpenCode /message request can produce multiple assistant steps.
    // Track guarded native attempts across ALL steps in this session;
    // limiting them to the first assistant would miss later tool events.
    if (type === 'message.part.updated' && part?.type === 'tool') {
      this.nativeToolSeen = true;
      if (typeof part.id === 'string') this.nativeToolParts.set(part.id, part);
      return;
    }
    if (!this.assistantId || messageId !== this.assistantId) return;
    if (this.nativeToolSeen) return;
    const partId = p.partID ?? part?.id;
    if (typeof partId !== 'string') return;
    let next;
    const prior = this.parts.get(partId) ?? '';
    if (type === 'message.part.updated') {
      if (part?.type !== 'text' || typeof part.text !== 'string') return;
      next = part.text;
    } else {
      if (p.field !== 'text' || typeof p.delta !== 'string') return;
      next = prior + p.delta;
    }
    if (!next.startsWith(prior) || next === prior) return;
    this.parts.set(partId, next);
    const full = [...this.parts.values()].join('');
    if (!full.startsWith(this.text) || full === this.text) return;
    this.text = full;
    this.onText(full);
  }
}

/** Subscribe before sending a model request; fail open to synchronous completion. */
export async function openSessionEvents({ origin, headers, fetchImpl, signal, logger }) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(origin + '/event', {
      method: 'GET', headers: { ...headers, accept: 'text/event-stream' },
      redirect: 'error', signal: combined,
    });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw failure('OpenCode SSE endpoint is unavailable', 'SSE_UNAVAILABLE');
    }
    const iterator = decodeSse(response.body, combined);
    let connected = false;
    for (let i = 0; i < 8; i++) {
      const item = await iterator.next();
      if (item.done) break;
      if ((item.value?.payload ?? item.value)?.type === 'server.connected') {
        connected = true;
        break;
      }
    }
    if (!connected) throw failure('OpenCode SSE handshake was not received', 'SSE_UNAVAILABLE');
    clearTimeout(timer);
    return {
      async pump(accept) {
        try {
          for await (const event of iterator) accept(event);
        } catch (error) {
          if (!combined.aborted) logger?.warn?.('dsh-opencode: event feed stopped: ' + (error.code || 'TRANSPORT'));
        }
      },
      close() { controller.abort(); },
    };
  } catch (error) {
    clearTimeout(timer);
    controller.abort();
    if (signal?.aborted) throw failure('OpenCode request cancelled', 'ABORTED');
    logger?.warn?.('dsh-opencode: SSE unavailable; waiting for complete response (' +
      (error.code || 'TRANSPORT') + ')');
    return null;
  }
}
