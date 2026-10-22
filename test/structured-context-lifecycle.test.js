import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStructuredAdapter } from '../src/structured-adapter.js';
import { StructuredToolBroker } from '../src/structured-broker.js';
import { StructuredEventFeed } from '../src/structured-events.js';

const provider = 'opencode-serve', model = 'deepseek-v4.1-flash-free';
const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }] });
const consume = async stream => { const chunks = []; for await (const item of stream) chunks.push(item); return chunks; };
const answer = chunks => chunks.findLast(item => item.type === 'block-end'
  && item.block.type === 'text')?.block.text;

async function fixture({ compactResponse = true, summaryHistory,
  diagnostics, limits = { context: 8192, input: 7000, output: 512 } } = {}) {
  const broker = new StructuredToolBroker();
  const actions = [];
  let sessionIndex = 0, messageIndex = 0;
  const modelFetch = async (url, options) => {
    const route = new URL(url).pathname;
    const method = options.method || 'POST';
    if (route === '/provider') return Response.json({
      all: [{ id: 'opencode', models: { [model]: { limit: limits } } }],
    });
    if (route === '/session' && method === 'POST') {
      const id = 'oc-' + ++sessionIndex;
      actions.push({ type: 'create', id });
      return Response.json({ id });
    }
    const id = route.split('/')[2];
    if (route.endsWith('/abort')) return Response.json(true);
    if (method === 'DELETE') {
      actions.push({ type: 'delete', id });
      return Response.json(true);
    }
    if (route.endsWith('/summarize')) {
      assert.equal(broker.sessions.get(id)?.tools.size, 0,
        'native compaction must have no DSH tool grant');
      actions.push({ type: 'compact', id, payload: JSON.parse(options.body) });
      return Response.json(compactResponse);
    }
    if (route.endsWith('/message') && method === 'GET') {
      return Response.json(summaryHistory ?? [
        { info: { role: 'user' }, parts: [{ type: 'compaction' }] },
        { info: { role: 'assistant', summary: true, finish: 'stop' },
          parts: [{ type: 'text', text: 'Verified mock summary' }] },
      ]);
    }
    if (route.endsWith('/message')) {
      const payload = JSON.parse(options.body);
      actions.push({ type: 'message', id, text: payload.parts[0].text });
      const index = ++messageIndex;
      return Response.json({ info: { modelID: model,
        tokens: { input: 6000, output: 10, cache: { read: 0, write: 0 } } },
      parts: [{ id: 'text-' + index, type: 'text', text: 'answer-' + index }] });
    }
    throw Error('Unknown URL ' + url);
  };
  const adapter = createStructuredAdapter({
    timeoutMs: 1000, structuredHandoffTimeoutMs: 1000,
    diagnosticEvent: (category, code, details) => diagnostics?.events.push({ category, code, details }),
    diagnosticContext: (sessionId, context) => diagnostics?.contexts.push({ sessionId, ...context }),
  }, broker, modelFetch);
  const invoke = async (sessionId, messages, extra = {}) => {
    const prepared = await adapter.prepareCall(provider, model);
    return consume(prepared.stream({ provider, model, sessionId, messages, tools: [], ...extra }));
  };
  return { adapter, broker, actions, invoke,
    async close() { await adapter.runtime.dispose(); } };
}

test('near-limit completed Session is compacted natively before the next human turn', async () => {
  const f = await fixture();
  try {
    const initial = [user('first turn')];
    assert.equal(answer(await f.invoke('s', initial)), 'answer-1');
    const next = await f.invoke('s', [...initial, assistant('answer-1'), user('second turn')]);
    assert.equal(answer(next), 'answer-2');
    assert.deepEqual(f.actions.map(a => a.type), ['create', 'message', 'compact', 'message']);
    const creates = f.actions.filter(a => a.type === 'create');
    const messages = f.actions.filter(a => a.type === 'message');
    const compact = f.actions.find(a => a.type === 'compact');
    assert.equal(creates.length, 1);
    assert.equal(compact.id, creates[0].id);
    assert.equal(compact.payload.modelID, model);
    assert.equal(compact.payload.auto, false);
    assert.equal(messages[1].text, 'second turn');
    assert.equal(messages[1].id, messages[0].id);
  } finally { await f.close(); }
});

test('failed compaction surfaces an error and never sends a model prompt or erases DSH history', async () => {
  const f = await fixture({ compactResponse: false });
  try {
    const first = [user('first')];
    await f.invoke('s', first);
    await assert.rejects(f.invoke('s', [...first, assistant('answer-1'), user('second')]),
      error => error.code === 'CONTEXT_COMPACTION_FAILED');
    assert.deepEqual(f.actions.filter(a => a.type === 'message').map(a => a.text), ['first']);
    await f.adapter.runtime.journal.drain();
    assert.equal(f.actions.filter(a => a.type === 'delete').length, 1,
      'uncertain compacted Session must be retired');
    assert.equal(f.adapter.runtime.sessions.entries.size, 0);
    const retry = await f.invoke('s', [...first, assistant('answer-1'), user('second')]);
    assert.equal(answer(retry), 'answer-2');
    assert.equal(f.actions.filter(a => a.type === 'create').length, 2);
  } finally { await f.close(); }
});

test('an HTTP 200 compaction without a finished summary is rejected and retired', async () => {
  const f = await fixture({ summaryHistory: [
    { info: { role: 'user' }, parts: [{ type: 'compaction' }] },
    { info: { role: 'assistant', summary: true, error: { message: 'upstream denied' },
      finish: 'error' }, parts: [] },
  ] });
  try {
    const initial = [user('first')];
    await f.invoke('bad-summary', initial);
    await assert.rejects(f.invoke('bad-summary', [...initial, assistant('answer-1'),
      user('next')]), e => e.code === 'CONTEXT_COMPACTION_FAILED');
    await f.adapter.runtime.journal.drain();
    assert.deepEqual(f.actions.filter(a => a.type === 'message').map(a => a.text), ['first']);
    assert.deepEqual(f.actions.filter(a => a.type === 'delete').map(a => a.id), ['oc-1']);
  } finally { await f.close(); }
});

test('overlarge fresh request is rejected before OpenCode Session creation', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.invoke('too-large', [user('x'.repeat(70_000))]),
      error => error.code === 'CONTEXT_LIMIT_EXCEEDED');
    assert.equal(f.actions.filter(a => a.type === 'create').length, 0);
  } finally { await f.close(); }
});

test('idle completed Session expires and is deleted using its exact owned ID', async () => {
  const f = await fixture({ limits: { context: 150000, input: 130000, output: 10000 } });
  try {
    await f.invoke('idle', [user('one')]);
    const registry = f.adapter.runtime.sessions;
    const key = JSON.stringify(['idle', model, 'chat']);
    registry.entries.get(key).lastActiveAt -= 8 * 24 * 60 * 60_000;
    registry.sweep();
    await f.adapter.runtime.journal.drain();
    assert.equal(registry.entries.has(key), false);
    assert.deepEqual(f.actions.filter(a => a.type === 'delete').map(a => a.id), ['oc-1']);
  } finally { await f.close(); }
});

test('anonymous requests are reclaimed as soon as their response completes', async () => {
  const f = await fixture({ limits: { context: 150000, input: 130000, output: 10000 } });
  try {
    await f.invoke(undefined, [user('no DSH identity')]);
    await f.adapter.runtime.journal.drain();
    assert.equal(f.actions.filter(a => a.type === 'delete').length, 1);
  } finally { await f.close(); }
});

test('internal compaction assistant events are not user-visible reasoning/text', () => {
  const parts = [], dangerous = [];
  const feed = new StructuredEventFeed('sess', p => parts.push(p),
    () => dangerous.push(true));
  const emit = (type, properties) => feed.accept({ type, properties });
  emit('message.updated', { info: { id: 'compact', role: 'assistant',
    sessionID: 'sess', summary: true, mode: 'compaction' } });
  emit('message.part.updated', { part: { id: 'summary', messageID: 'compact',
    type: 'reasoning', sessionID: 'sess', text: 'INTERNAL SUMMARY' } });
  emit('message.updated', { info: { id: 'answer', role: 'assistant',
    sessionID: 'sess', mode: 'dsh-bridge' } });
  emit('message.part.updated', { part: { id: 'visible', messageID: 'answer',
    type: 'text', sessionID: 'sess', text: 'Visible' } });
  assert.deepEqual(parts.map(p => p.text), ['Visible']);
  assert.equal(dangerous.length, 0);
});

test('diagnostics reflect model context, Session reuse and actual compaction lifecycle', async () => {
  const diagnostics = { events: [], contexts: [] };
  const f = await fixture({ diagnostics });
  try {
    const first = [user('first')];
    await f.invoke('dsh-diagnostic-case', first);
    assert.ok(diagnostics.events.some(e => e.category === 'session' && e.code === 'created'));
    assert.ok(diagnostics.events.some(e => e.category === 'context' && e.code === 'usage.updated'
      && e.details.used === 6010 && e.details.limit === 8192));
    const second = [...first, assistant('answer-1'), user('next')];
    await f.invoke('dsh-diagnostic-case', second);
    assert.ok(diagnostics.events.some(e => e.category === 'session' && e.code === 'reused'));
    assert.ok(diagnostics.events.some(e => e.category === 'compaction' && e.code === 'started'));
    assert.ok(diagnostics.events.some(e => e.category === 'compaction' && e.code === 'finished'));
    assert.ok(diagnostics.contexts.some(c => c.phase === 'compacting'));
    assert.deepEqual(diagnostics.contexts.at(-1),
      { sessionId: 'dsh-diagnostic-case', used: 6010, limit: 8192,
        phase: 'ready', estimate: true });
    const texts = JSON.stringify(diagnostics.events);
    assert.doesNotMatch(texts, /first|next|answer-1/,
      'diagnostic trace cannot include user questions or complete model answers');
  } finally { await f.close(); }
});
