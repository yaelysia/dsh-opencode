import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAdapter } from '../src/bridge.js';
import { decodeSse } from '../src/opencode-events.js';

const model = 'deepseek-v4.1-flash-free';
const sessionID = 'sess-stream';
const assistantID = 'msg-stream';
const partID = 'part-stream';
const textPart = text => ({
  id: partID, sessionID, messageID: assistantID, type: 'text', text,
});
const assistant = { id: assistantID, role: 'assistant', sessionID };
const tools = [{ name: 'read_file', description: 'Read only a test file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}];

function fixture({ responseText = 'Hello world', plan = () => {}, mode = 'events', envelope = false } = {}) {
  const paths = [];
  const encoder = new TextEncoder();
  let streamController;
  let finishReply;
  let notifyPosted;
  const posted = new Promise(resolve => { notifyPosted = resolve; });
  let canceled = false;
  function send(type, properties = {}) {
    if (!streamController) throw new Error('SSE connection missing');
    const payload = { type, properties };
    const body = envelope ? { payload } : payload;
    const bytes = encoder.encode('data: ' + JSON.stringify(body) + '\r\n\r\n');
    streamController.enqueue(bytes.subarray(0, 7));
    streamController.enqueue(bytes.subarray(7));
  }
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/session') return Response.json({ id: sessionID });
    if (path === '/event') {
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.accept, 'text/event-stream');
      if (mode === 'unavailable') return Response.json({ error: 'not found' }, { status: 404 });
      return new Response(new ReadableStream({
        start(controller) {
          streamController = controller;
          send('server.connected');
        },
        cancel() { canceled = true; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/message')) {
      assert.ok(streamController || mode === 'unavailable', 'subscribe before prompt');
      if (mode === 'events') {
        send('message.updated', { sessionID, info: assistant });
        plan({ send, sessionID, assistantID, partID, textPart });
      }
      const reply = new Promise((resolve, reject) => {
        finishReply = () => resolve(Response.json({
          info: { modelID: model, finish: 'stop', tokens: { input: 7, output: 3 } },
          parts: [{ type: 'text', text: responseText }],
        }));
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      notifyPosted();
      return reply;
    }
    if (path.endsWith('/abort')) return Response.json(true);
    throw Error('Unexpected endpoint: ' + path);
  };
  return { fetch, paths, posted, send, finish() {
    assert.equal(typeof finishReply, 'function');
    finishReply();
  }, wasCanceled: () => canceled };
}

function start(adapter, opts = {}) {
  return adapter.prepareCall('opencode-serve', model).then(prepared =>
    prepared.stream({ provider: 'opencode-serve', model,
      sessionId: 'stream-test', messages: [{ role: 'user', content: 'Hi' }],
      ...opts,
    })[Symbol.asyncIterator]());
}

async function consume(iterator) {
  const chunks = [];
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) chunks.push(chunk);
  return chunks;
}

test('SSE parser handles split UTF-8, multiline frames, comments and CRLF', async () => {
  const encoder = new TextEncoder();
  const data = 'data: {"type":"server.connected",\r\n' +
    'data: "properties":{"message":"你好"}}\r\n\r\n: heartbeat\r\n\r\n';
  const raw = encoder.encode(data);
  const body = new ReadableStream({
    start(controller) {
      for (let n = 0; n < raw.length; n += 3) controller.enqueue(raw.subarray(n, n + 3));
      controller.close();
    },
  });
  const events = [];
  for await (const event of decodeSse(body)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].properties.message, '你好');
});

test('text deltas arrive before the authoritative /message response', { timeout: 5000 }, async () => {
  const upstream = fixture({ plan({ send }) {
    send('message.part.updated', { sessionID, part: textPart('') });
    send('message.part.delta', { sessionID, messageID: assistantID,
      partID, field: 'text', delta: 'Hel' });
    send('message.part.delta', { sessionID, messageID: assistantID,
      partID, field: 'text', delta: 'lo' });
    send('message.part.updated', { sessionID, part: textPart('Hello') });
  } });
  const iterator = await start(createAdapter({}, upstream.fetch));
  const started = await iterator.next();
  const first = await iterator.next();
  const second = await iterator.next();
  assert.deepEqual([started.value.type, first.value.text, second.value.text],
    ['block-start', 'Hel', 'lo']);
  await upstream.posted;
  assert.deepEqual(upstream.paths, ['/session', '/event', '/session/' + sessionID + '/message']);
  upstream.finish();
  const rest = await consume(iterator);
  assert.deepEqual(rest.map(x => x.type),
    ['text-delta', 'block-end', 'usage', 'finish']);
  assert.equal(rest[0].text, ' world');
  assert.equal(rest[1].block.text, 'Hello world');
  assert.equal(rest.at(-1).reason.kind, 'stop');
  assert.equal(upstream.wasCanceled(), true);
});

test('SSE event wrapper and text snapshots produce one consistent completion', async () => {
  const upstream = fixture({ envelope: true, responseText: '你好世界',
    plan({ send }) {
      send('message.part.updated', { sessionID, part: textPart('你好') });
      send('message.part.updated', { sessionID, part: textPart('你好世界') });
    },
  });
  const iterator = await start(createAdapter({}, upstream.fetch));
  const chunksPromise = consume(iterator);
  await upstream.posted;
  await sleep(20);
  upstream.finish();
  const chunks = await chunksPromise;
  assert.equal(chunks.filter(x => x.type === 'text-delta').map(x => x.text).join(''), '你好世界');
  assert.equal(chunks.filter(x => x.type === 'block-start').length, 1);
});

test('no SSE support falls back to the complete reply without fabricating chunks', async () => {
  const upstream = fixture({ mode: 'unavailable', responseText: 'Fallback' });
  const chunksPromise = consume(await start(createAdapter({ logger: { warn() {} } }, upstream.fetch)));
  await upstream.posted;
  upstream.finish();
  const chunks = await chunksPromise;
  assert.deepEqual(chunks.map(c => c.type),
    ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  assert.equal(chunks[1].text, 'Fallback');
});

test('no SSE text events falls back to authoritative response', async () => {
  const upstream = fixture({ responseText: 'Only final' });
  const warnings = [];
  const chunksPromise = consume(await start(createAdapter({
    logger: { warn: message => warnings.push(message) },
  }, upstream.fetch)));
  await upstream.posted;
  upstream.finish();
  const chunks = await chunksPromise;
  assert.deepEqual(chunks.filter(c => c.type === 'text-delta').map(c => c.text), ['Only final']);
  assert.ok(warnings.some(message => message.includes('no assistant text')));
});

test('tool envelope is never leaked as text and is emitted only after final validation', { timeout: 5000 }, async () => {
  const payload = 'DSH_TOOL_CALL_V1:{"name":"read_file","arguments":{"path":"safe.txt"}}';
  const upstream = fixture({ responseText: payload, plan({ send }) {
    send('message.part.delta', { sessionID, messageID: assistantID,
      partID, field: 'text', delta: 'DSH_' });
    send('message.part.delta', { sessionID, messageID: assistantID,
      partID, field: 'text', delta: payload.slice(4) });
  } });
  const iterator = await start(createAdapter({}, upstream.fetch), { tools });
  const received = [];
  const job = (async () => {
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) received.push(chunk);
  })();
  await upstream.posted;
  await sleep(40);
  assert.equal(received.length, 0, 'do not expose a partial tool JSON envelope');
  upstream.finish();
  await job;
  assert.deepEqual(received.map(x => x.type),
    ['block-start', 'tool-call-delta', 'block-end', 'usage', 'finish']);
  assert.equal(received[1].name, 'read_file');
  assert.equal(received.at(-1).reason.kind, 'tool-calls');
});

test('partial tool marker completed as normal language is released as text', async () => {
  const upstream = fixture({ responseText: 'DSH is the host.', plan({ send }) {
    send('message.part.delta', { sessionID, messageID: assistantID,
      partID, field: 'text', delta: 'D' });
    send('message.part.delta', { sessionID, messageID: assistantID,
      partID, field: 'text', delta: 'SH is the host.' });
  } });
  const promise = consume(await start(createAdapter({}, upstream.fetch), { tools }));
  await upstream.posted;
  upstream.finish();
  const chunks = await promise;
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'DSH is the host.');
});

test('foreign sessions and user message echoes never reach the DSH text stream', async () => {
  const upstream = fixture({ responseText: 'SAFE', plan({ send }) {
    send('message.updated', { sessionID: 'foreign', info: {
      id: 'foreign-msg', role: 'assistant', sessionID: 'foreign',
    } });
    send('message.part.delta', { sessionID: 'foreign',
      messageID: 'foreign-msg', partID: 'foreign-part', field: 'text', delta: 'WRONG' });
    send('message.part.updated', { sessionID, part: {
      id: 'user-part', sessionID, messageID: 'user-1', type: 'text', text: 'secret',
    } });
    send('message.part.delta', { sessionID, messageID: assistantID,
      partID, field: 'text', delta: 'SAFE' });
  } });
  const promise = consume(await start(createAdapter({}, upstream.fetch)));
  await upstream.posted;
  upstream.finish();
  const chunks = await promise;
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'SAFE');
});

test('stream mismatch is a failure, not a silently stitched answer', async () => {
  const upstream = fixture({ responseText: 'final', plan({ send }) {
    send('message.part.updated', { sessionID, part: textPart('stale') });
  } });
  const p = assert.rejects(async () => {
    await consume(await start(createAdapter({}, upstream.fetch)));
  }, e => e.code === 'STREAM_MISMATCH');
  await upstream.posted;
  await sleep(20);
  upstream.finish();
  await p;
});

test('OpenCode native tool events observed via SSE fail closed even if omitted by final text', async () => {
  const upstream = fixture({ responseText: 'pretend success', plan({ send }) {
    send('message.part.updated', { sessionID, part: {
      type: 'tool', id: 'part-native', sessionID, messageID: assistantID,
      tool: 'bash', state: { status: 'completed' },
    } });
  } });
  const p = assert.rejects(async () => {
    await consume(await start(createAdapter({}, upstream.fetch), { tools }));
  }, e => e.code === 'OPENCODE_TOOL_BOUNDARY');
  await upstream.posted;
  await sleep(20);
  upstream.finish();
  await p;
});

test('cancelling a partial tool JSON never yields an executable call', { timeout: 5000 }, async () => {
  const upstream = fixture({ responseText: 'unused', plan({ send }) {
    send('message.part.delta', { sessionID, messageID: assistantID,
      partID, field: 'text', delta: 'DSH_TOOL_CALL_V1:{"name":"read_file"' });
  } });
  const controller = new AbortController();
  const output = [];
  const iterator = await start(createAdapter({}, upstream.fetch),
    { tools, signal: controller.signal });
  const task = (async () => {
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) output.push(chunk);
  })();
  await upstream.posted;
  await sleep(25);
  controller.abort();
  await assert.rejects(task, error => error.code === 'ABORTED');
  assert.deepEqual(output, [], 'no text, tool-call or finish for an interrupted JSON envelope');
});
