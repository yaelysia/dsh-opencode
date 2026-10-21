import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStructuredAdapter } from '../src/structured-adapter.js';
import { StructuredSessionRegistry } from '../src/structured-session.js';
import { StructuredToolBroker } from '../src/structured-broker.js';

const model = 'deepseek-v4.1-flash-free';
const provider = 'opencode-serve';
const tools = [{ name: 'read', description: 'Read a file', parameters: {
  type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'],
} }];
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }] });
const consume = async iterable => { const chunks = []; for await (const item of iterable) chunks.push(item); return chunks; };
const answer = chunks => chunks.findLast(item => item.type === 'block-end' && item.block.type === 'text')?.block.text;
const headers = broker => ({ authorization: 'Bearer ' + broker.token, 'content-type': 'application/json' });

async function fixture(onPrompt = ({ post }) => 'reply-' + post) {
  const broker = new StructuredToolBroker();
  const requests = [];
  let creates = 0;
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/session') return Response.json({ id: 'oc-' + ++creates });
    if (pathname.endsWith('/abort')) return Response.json(true);
    if (!pathname.endsWith('/message')) throw Error('Unexpected URL: ' + url);
    const sessionID = pathname.split('/')[2];
    const payload = JSON.parse(init.body);
    const request = { sessionID, payload, post: requests.length + 1, signal: init.signal };
    requests.push(request);
    const result = await onPrompt({ ...request, broker });
    return Response.json({ info: { modelID: payload.model.modelID },
      parts: [{ id: 'answer-' + request.post, type: 'text', text: result }] });
  };
  const adapter = createStructuredAdapter({ timeoutMs: 2000, structuredHandoffTimeoutMs: 2000 }, broker, fetchImpl);
  async function invoke(sessionId, messages, extra = {}) {
    const prepared = await adapter.prepareCall(provider, extra.model ?? model);
    return consume(prepared.stream({ model, provider, sessionId, messages, tools,
      ...extra }));
  }
  return { adapter, broker, requests, invoke, get creates() { return creates; },
    async close() { await adapter.runtime.dispose(); } };
}

test('session registry records lifecycle states and never replays a completed input', () => {
  const registry = new StructuredSessionRegistry({ maxIdle: 1 });
  registry.active('a', 'oc-a');
  assert.equal(registry.entries.get('a').state, 'running');
  registry.waiting('a', 'oc-a');
  assert.equal(registry.entries.get('a').state, 'waiting-tool');
  registry.complete('a', 'oc-a', [user('one')], 'system', 'answer-one');
  assert.equal(registry.entries.get('a').state, 'idle');
  assert.deepEqual(registry.plan('a', [user('one'), assistant('answer-one'), user('two')], 'system'),
    { id: 'oc-a', messages: [user('two')] });
  assert.throws(() => registry.plan('a', [user('one'), assistant('answer-one')], 'system'),
    error => error.code === 'STALE_DSH_TURN');
  registry.active('b', 'oc-b');
  registry.complete('b', 'oc-b', [user('other')], 'system', 'other answer');
  assert.equal(registry.entries.has('a'), false, 'only the oldest idle mapping is evicted');
  registry.clear();
  assert.equal(registry.entries.size, 0);
});

test('completed structured turns reuse the OpenCode session and send only the new user message', async () => {
  const f = await fixture();
  try {
    const first = await f.invoke('dsh-A', [user('First question')]);
    assert.equal(answer(first), 'reply-1');
    assert.equal(f.adapter.runtime.sessions.entries.get(JSON.stringify(['dsh-A', model, 'chat'])).state, 'idle');
    const second = await f.invoke('dsh-A', [user('First question'), assistant('reply-1'), user('Second question')]);
    assert.equal(answer(second), 'reply-2');
    assert.equal(f.creates, 1);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].sessionID, f.requests[1].sessionID);
    assert.deepEqual(f.requests.map(x => x.payload.parts[0].text), ['First question', 'Second question']);
  } finally { await f.close(); }
});

test('native dsh_call continuation stays on one POST, later human turn reuses without replaying tools', async () => {
  const f = await fixture(async ({ payload, sessionID, signal, broker, post }) => {
    if (post === 1) {
      assert.equal(payload.parts[0].text, 'Read sample.txt');
      const callback = await fetch(broker.environment().DSH_STRUCTURED_URL + '/call', {
        method: 'POST', headers: headers(broker), signal,
        body: JSON.stringify({ sessionID, messageID: 'assistant-1', callID: 'native-1',
          name: 'read', arguments: { file_path: 'sample.txt' } }),
      });
      assert.equal(callback.status, 200);
      assert.equal((await callback.json()).content[0].text, 'file text');
      return 'Read complete';
    }
    return 'Second turn complete';
  });
  try {
    const firstInput = [user('Read sample.txt')];
    const initial = await f.invoke('dsh-tools', firstInput);
    const call = initial.find(x => x.type === 'tool-call-delta');
    assert.ok(call);
    assert.equal(f.requests.length, 1);
    const continuation = [...firstInput,
      { role: 'assistant', content: [{ type: 'tool-call', id: call.id,
        name: call.name, arguments: call.argumentsDelta }] },
      { role: 'tool', toolCallId: call.id, isError: false, content: [{ type: 'text', text: 'file text' }] },
    ];
    const resumed = await f.invoke('dsh-tools', continuation);
    assert.equal(answer(resumed), 'Read complete');
    assert.equal(f.requests.length, 1, 'tool continuation does not send a new POST');
    const next = await f.invoke('dsh-tools', [...continuation, assistant('Read complete'), user('Now summarize')]);
    assert.equal(answer(next), 'Second turn complete');
    assert.equal(f.creates, 1);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].payload.parts[0].text, 'Now summarize');
  } finally { await f.close(); }
});

test('edits to DSH history or the assistant echo invalidate reuse without duplicating a tool request', async () => {
  const f = await fixture();
  try {
    await f.invoke('changed', [user('original')]);
    await f.invoke('changed', [user('edited'), assistant('reply-1'), user('new')]);
    assert.equal(f.creates, 2);
    await f.invoke('changed', [user('edited'), assistant('forged response'), user('another')]);
    assert.equal(f.creates, 3);
    assert.match(f.requests[1].payload.parts[0].text, /edited/);
    assert.match(f.requests[2].payload.parts[0].text, /forged response/);
  } finally { await f.close(); }
});

test('a modified final assistant echo is never skipped during Session reuse', async () => {
  const f = await fixture();
  try {
    await f.invoke('echo-edited', [user('Original request')]);
    const next = await f.invoke('echo-edited',
      [user('Original request'), assistant('Altered reply'), user('Follow-up')]);
    assert.equal(answer(next), 'reply-2');
    assert.equal(f.creates, 2);
    assert.match(f.requests[1].payload.parts[0].text, /Altered reply/);
    assert.match(f.requests[1].payload.parts[0].text, /Follow-up/);
  } finally { await f.close(); }
});

test('changes to system instructions and model identity never reuse an incompatible session', async () => {
  const f = await fixture();
  try {
    await f.invoke('configured', [user('one')], { system: 'initial' });
    await f.invoke('configured', [user('one'), assistant('reply-1'), user('two')], { system: 'modified' });
    assert.equal(f.creates, 2);
    // Same DSH identifier, but a different model is a different binding.
    const otherModel = 'glm-5.3-flash-free';
    await f.invoke('configured', [user('one')], { model: otherModel });
    assert.equal(f.creates, 3);
  } finally { await f.close(); }
});

test('missing DSH session identities do not share OpenCode session state', async () => {
  const f = await fixture();
  try {
    await f.invoke(undefined, [user('one')], { tools: [] });
    await f.invoke(undefined, [user('one'), assistant('reply-1'), user('two')], { tools: [] });
    assert.equal(f.creates, 2);
  } finally { await f.close(); }
});

test('repeating a finished DSH input does not create another OpenCode request', async () => {
  const f = await fixture();
  try {
    await f.invoke('retry', [user('once')]);
    await assert.rejects(f.invoke('retry', [user('once')]), error => error.code === 'STALE_DSH_TURN');
    assert.equal(f.creates, 1);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('cancellation invalidates a reused session before a subsequent fresh attempt', async () => {
  let started;
  const blocking = new Promise(resolve => { started = resolve; });
  const f = await fixture(async ({ post, signal }) => {
    if (post !== 2) return 'reply-' + post;
    started();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  });
  try {
    await f.invoke('cancel', [user('one')]);
    const abort = new AbortController();
    const second = f.invoke('cancel', [user('one'), assistant('reply-1'), user('two')],
      { signal: abort.signal });
    await blocking;
    abort.abort();
    await assert.rejects(second);
    assert.equal(f.adapter.runtime.sessions.entries.size, 0);
    const third = await f.invoke('cancel', [user('one'), assistant('reply-1'), user('next')]);
    assert.equal(answer(third), 'reply-3');
    assert.equal(f.creates, 2, 'the cancelled, possibly dirty session must not be reused');
  } finally { await f.close(); }
});
