import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createStructuredAdapter } from '../src/structured-adapter.js';
import { StructuredToolBroker } from '../src/structured-broker.js';
import { StructuredEventFeed, StructuredBlocks } from '../src/structured-events.js';

const model = 'deepseek-v4.1-flash-free', provider = 'opencode-serve';
const tools = [{ name: 'read', description: 'DSH read', parameters: {
  type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'],
} }];
const user = { role: 'user', content: [{ type: 'text', text: 'Read a file' }] };
const consume = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks; };
const waitFor = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await sleep(5); assert.ok(predicate()); };
function headers(broker) { return { authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' }; }
function post(broker, body, extra = {}) { return fetch(broker.environment().DSH_STRUCTURED_URL + '/call', {
  method: 'POST', headers: { ...headers(broker), ...extra }, body: JSON.stringify(body),
}); }
function request(sessionID = 'server1', callID = 'native1') { return { sessionID, callID,
  messageID: 'message1', name: 'read', arguments: { file_path: 'text.txt' } }; }

async function fixture(config = {}, plan = async ({ call }) => { await call(); return 'Done'; }) {
  const broker = new StructuredToolBroker();
  let sessions = 0, posts = 0, aborts = 0;
  const jobs = [];
  const mock = async (url, init) => {
    if (url.endsWith('/session')) return Response.json({ id: 'server' + ++sessions });
    if (url.endsWith('/abort')) { aborts++; return Response.json(true); }
    if (!url.endsWith('/message')) throw Error('Unexpected endpoint ' + url);
    posts++;
    const sessionID = url.match(/session\/([^/]+)\/message/)[1];
    const call = async (number = 1) => {
      const result = await fetch(broker.environment().DSH_STRUCTURED_URL + '/call', {
        method: 'POST', headers: headers(broker), signal: init.signal,
        body: JSON.stringify(request(sessionID, 'native' + number)),
      });
      return result.json();
    };
    const work = plan({ call, sessionID, signal: init.signal }).then(text => Response.json({
      info: { modelID: model }, parts: [{ id: 'final-' + sessionID, type: 'text', text }],
    }));
    jobs.push(work.catch(() => {}));
    return work;
  };
  const adapter = createStructuredAdapter({ timeoutMs: 2000, structuredHandoffTimeoutMs: 2000, ...config }, broker, mock);
  const invoke = async (sessionId, messages = [user], extra = {}) => {
    const prepared = await adapter.prepareCall(provider, model);
    return consume(prepared.stream({ provider, model, sessionId, messages, tools, ...extra }));
  };
  return { broker, adapter, invoke, get posts() { return posts; }, get aborts() { return aborts; },
    async close() { await adapter.runtime.dispose(); await Promise.allSettled(jobs); } };
}

function result(call, isError = false) { return { role: 'tool', source: { callId: call.id },
  isError, content: [{ type: 'text', text: isError ? 'Denied by DSH' : 'ok' }] }; }

test('structured callbacks yield to DSH immediately and resume one OpenCode POST', async () => {
  const f = await fixture({}, async ({ call }) => {
    const one = await call(1); assert.equal(one.content[0].text, 'ok');
    const two = await call(2); assert.equal(two.isError, true); return 'Refused';
  });
  try {
    const first = await f.invoke('dsh1');
    assert.equal(first.at(-1).reason.kind, 'tool-calls');
    assert.equal(f.posts, 1); assert.equal(f.broker.calls.size, 1);
    const one = first.find(c => c.type === 'tool-call-delta');
    const second = await f.invoke('dsh1', [user, result(one)]);
    const two = second.find(c => c.type === 'tool-call-delta');
    assert.notEqual(one.id, two.id);
    const third = await f.invoke('dsh1', [user, result(one), result(two, true)]);
    assert.equal(third.at(-1).reason.kind, 'stop');
    assert.equal(third.find(c => c.type === 'block-end').block.text, 'Refused');
    assert.equal(f.posts, 1); assert.equal(f.broker.calls.size, 0);
    assert.equal(f.adapter.runtime.turns.size, 0);
  } finally { await f.close(); }
});

test('two DSH sessions cannot consume each other\'s pending results', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([f.invoke('A'), f.invoke('B')]);
    const one = a.find(c => c.type === 'tool-call-delta'), two = b.find(c => c.type === 'tool-call-delta');
    assert.notEqual(one.id, two.id);
    await assert.rejects(f.invoke('A', [user, result(two)]), e => e.code === 'TOOL_RESULT_REQUIRED');
    const answer = await f.invoke('B', [user, result(two)]);
    assert.equal(answer.at(-1).reason.kind, 'stop');
    assert.equal(f.posts, 2);
  } finally { await f.close(); }
});

test('cancellation during approval cancels the retained request and never replays tools', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const chunks = await f.invoke('cancel', [user], { signal: controller.signal });
    const call = chunks.find(c => c.type === 'tool-call-delta');
    controller.abort();
    await waitFor(() => f.broker.calls.size === 0);
    await assert.rejects(f.invoke('cancel', [user, result(call)]), e => e.code === 'TOOL_RESULT_MISMATCH');
    assert.equal(f.posts, 1); assert.equal(f.adapter.runtime.turns.size, 0);
  } finally { await f.close(); }
});

test('model timeout is paused during approval, handoff timeout remains bounded', async () => {
  const f = await fixture({ timeoutMs: 60, structuredHandoffTimeoutMs: 400 });
  try {
    const chunks = await f.invoke('wait'); await sleep(95);
    const call = chunks.find(c => c.type === 'tool-call-delta');
    const final = await f.invoke('wait', [user, result(call)]);
    assert.equal(final.at(-1).reason.kind, 'stop');
    await f.invoke('expire'); await waitFor(() => f.adapter.runtime.turns.size === 0);
    assert.equal(f.broker.calls.size, 0);
  } finally { await f.close(); }
});

test('no session identity or disabled DSH tools reject before provider traffic', async () => {
  const f = await fixture({ toolBridgeEnabled: false });
  try {
    await assert.rejects(f.invoke(''), e => e.code === 'SESSION_ID_REQUIRED');
    await assert.rejects(f.invoke('blocked'), e => e.code === 'DSH_TOOLS_DISABLED');
    assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test('concurrent consumers on one session do not start duplicate model requests', async () => {
  const f = await fixture();
  try {
    const running = f.invoke('same');
    await assert.rejects(f.invoke('same'), e => e.code === 'CONCURRENT_STREAM');
    const first = await running;
    const second = await f.invoke('same', [user, result(first.find(c => c.type === 'tool-call-delta'))]);
    assert.equal(second.at(-1).reason.kind, 'stop'); assert.equal(f.posts, 1);
  } finally { await f.close(); }
});

test('broker is loopback-authenticated, rejects duplicate/unknown calls and has no HTTP settle action', async () => {
  const broker = new StructuredToolBroker(); await broker.start();
  const published = [];
  broker.register('server1', { tools, onCall: call => published.push(call) });
  let response;
  try {
    assert.equal((await post(broker, request(), { authorization: 'Bearer forged' })).status, 401);
    assert.equal((await post(broker, request(), { origin: 'https://untrusted' })).status, 401);
    assert.equal((await post(broker, { ...request(), name: 'write' })).status, 422);
    assert.equal((await post(broker, { ...request(), sessionID: 'unknown' })).status, 404);
    assert.equal((await fetch(broker.environment().DSH_STRUCTURED_URL + '/settle', {
      method: 'POST', headers: headers(broker), body: '{}' })).status, 404);
    response = post(broker, request()); await waitFor(() => published.length === 1);
    assert.equal((await post(broker, request())).status, 409);
    assert.throws(() => broker.settle('other-session', published[0].id,
      { isError: false, content: [] }), e => e.code === 'TOOL_RESULT_MISMATCH');
    broker.settle('server1', published[0].id, { isError: true, content: 'Rejected' });
    assert.deepEqual(await (await response).json(), { isError: true, content: 'Rejected' });
    assert.throws(() => broker.settle('server1', published[0].id,
      { isError: false, content: [] }), e => e.code === 'TOOL_RESULT_MISMATCH');
    assert.equal(published.length, 1);
  } finally { await broker.dispose(); await response; }
});

test('broker snapshots catalogs and releases pending callbacks on disposal', async () => {
  const broker = new StructuredToolBroker({ maxSessions: 1 }); await broker.start();
  const owned = structuredClone(tools), calls = [];
  broker.register('server1', { tools: owned, onCall: c => calls.push(c) });
  owned[0].name = 'pwsh';
  assert.throws(() => broker.register('server2', { tools, onCall() {} }), e => e.code === 'BRIDGE_SESSION_LIMIT');
  const pending = post(broker, request());
  await waitFor(() => calls.length === 1);
  await broker.dispose();
  assert.equal((await pending).status, 410);
  assert.equal(broker.calls.size, 0); assert.equal(broker.sessions.size, 0);
  await assert.rejects(broker.start(), e => e.code === 'BRIDGE_CLOSED');
});

test('reasoning and text remain distinct typed blocks, including streaming tool handoffs', () => {
  const parts = [], executed = [];
  const feed = new StructuredEventFeed('s', p => parts.push(p), () => executed.push(true));
  const emit = (type, properties) => feed.accept({ type, properties });
  emit('message.updated', { info: { role: 'assistant', id: 'a', sessionID: 's' } });
  emit('message.part.updated', { part: { id: 'r', messageID: 'a', sessionID: 's', type: 'reasoning', text: '' } });
  emit('message.part.delta', { sessionID: 's', messageID: 'a', partID: 'r', field: 'text', delta: 'English reasoning' });
  emit('message.part.updated', { part: { id: 't', messageID: 'a', sessionID: 's', type: 'text', text: '中文答复' } });
  emit('message.part.updated', { part: { id: 'foreign', sessionID: 'other', messageID: 'x', type: 'text', text: 'secret' } });
  const delivered = new Map(), blocks = new StructuredBlocks(delivered), chunks = [];
  for (const part of parts) chunks.push(...blocks.part(part)); chunks.push(...blocks.end());
  assert.equal(chunks.find(c => c.type === 'reasoning-delta').text, 'English reasoning');
  assert.equal(chunks.find(c => c.type === 'text-delta').text, '中文答复');
  assert.equal(chunks.filter(c => c.type === 'block-end').length, 2);
  const resumed = new StructuredBlocks(delivered);
  assert.deepEqual([...resumed.part(parts.at(-1))], []);
  assert.equal(executed.length, 0);
  emit('message.part.updated', { part: { sessionID: 's', type: 'tool', tool: 'read', state: { status: 'completed' } } });
  assert.equal(executed.length, 1);
});

test('the single-plugin composition owns all backend pieces and preserves legacy defaults', async () => {
  const { createPluginRuntime } = await import('../src/runtime.js');
  const legacy = createPluginRuntime({ autoStart: false });
  assert.equal(legacy.adapter.runtime, undefined);
  await legacy.dispose();
  const structured = createPluginRuntime({ structuredToolsEnabled: true, autoStart: false,
    strictOwnedServer: false, guardedReadCompatibility: false });
  try {
    assert.ok(structured.adapter.runtime);
    assert.equal(structured.supervisor.config.autoStart, true);
    assert.equal(structured.supervisor.config.strictOwnedServer, true);
    assert.equal(structured.supervisor.broker, structured.adapter.runtime.broker);
    assert.equal(structured.supervisor.owned, null, 'construction does not launch an unrequested model call');
  } finally { await structured.dispose(); }
});

test('service recovery cancels pending dsh_call and never replays the consumed tool result', async () => {
  const f = await fixture();
  try {
    const first = await f.invoke('recover', [user]);
    const call = first.find(chunk => chunk.type === 'tool-call-delta');
    assert.ok(call);
    assert.equal(f.broker.calls.size, 1);
    f.adapter.runtime.onServiceRestart();
    assert.equal(f.adapter.runtime.turns.size, 0);
    assert.equal(f.broker.calls.size, 0);
    assert.equal(f.adapter.runtime.sessions.entries.size, 0);
    await assert.rejects(f.invoke('recover', [user, result(call)]),
      error => error.code === 'TOOL_CONTINUATION_FAILED');
    assert.equal(f.posts, 1, 'the same DSH tool result must never launch a new OpenCode POST');
  } finally { await f.close(); }
});

test('structured Session idle TTL follows the configured hours without disabling count-based LRU', async () => {
  const broker = new StructuredToolBroker();
  const config = { sessionIdleHours: 72, timeoutMs: 1000 };
  const adapter = createStructuredAdapter(config, broker, async () => {
    throw Error('No network traffic should occur');
  });
  try {
    assert.equal(adapter.runtime.sessions.idleTtlMs, 72 * 3_600_000);
    assert.equal(adapter.runtime.sessions.maxIdle, 32);
  } finally { await adapter.runtime.dispose(); }
});
