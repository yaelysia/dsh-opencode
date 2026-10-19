import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeServeClient, createAdapter } from '../src/bridge.js';

test('translates official OpenCode session response into DSH stream', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, data: JSON.parse(init.body) });
    if (url.endsWith('/session')) return Response.json({ id: 'sess-a' });
    return Response.json({
      info: { tokens: { input: 5, output: 2 } },
      parts: [{ type: 'text', text: 'test reply' }],
    });
  };
  const adapter = createAdapter({}, fetch);
  const request = await adapter.prepareCall('opencode-serve', 'deepseek-v4.1-flash-free');
  const result = [];
  for await (const chunk of request.stream({
    model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: 'hello' }],
  })) result.push(chunk);
  assert.deepEqual(result.map(x => x.type),
    ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  assert.equal(result[1].text, 'test reply');
  assert.equal(calls[1].data.model.modelID, 'deepseek-v4.1-flash-free');
  assert.deepEqual(calls.map(x => new URL(x.url).pathname),
    ['/session', '/session/sess-a/message']);
});

test('keeps session history without re-sending past user turns', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) });
    return Response.json(url.endsWith('/session')
      ? { id: 'sess-a' } : { info: {}, parts: [{ type: 'text', text: 'ok' }] });
  };
  const client = new OpenCodeServeClient({}, fetch);
  const user = { role: 'user', content: 'First' };
  await client.complete({ sessionId: 'conversation-a', model: 'glm-5.3-flash-free', messages: [user] });
  await client.complete({ sessionId: 'conversation-a', model: 'glm-5.3-flash-free',
    messages: [user, { role: 'assistant', content: 'Reply' }, { role: 'user', content: 'Next' }] });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].payload.parts[0].text, 'First');
  assert.equal(calls[2].payload.parts[0].text, 'Next');
});

test('embedded model errors in HTTP 200 are reported, not treated as empty success', async () => {
  const fetch = async (url) => {
    if (url.endsWith('/session')) return Response.json({ id: 'sess-a' });
    return Response.json({
      info: { role: 'assistant', error: {
        name: 'APIError', data: { statusCode: 403, message: 'Free model is restricted' },
      }},
      parts: [],
    });
  };
  const client = new OpenCodeServeClient({}, fetch);
  await assert.rejects(
    client.complete({ model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => error.code === 'FORBIDDEN'
      && error.failure.status === 403 && /restricted/.test(error.message),
  );
});

test('empty assistant output is reported as an error', async () => {
  const fetch = async (url) => {
    if (url.endsWith('/session')) return Response.json({ id: 'sess-a' });
    return Response.json({ info: { role: 'assistant' }, parts: [
      { type: 'step-start' }, { type: 'step-finish' },
    ]});
  };
  const client = new OpenCodeServeClient({}, fetch);
  await assert.rejects(
    client.complete({ model: 'glm-5.3-flash-free',
      messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => error.code === 'EMPTY_RESPONSE'
      && /step-start/.test(error.message),
  );
});

test('passes DSH attribution to the OpenCode server', async () => {
  const fetch = async (url, init) => {
    assert.equal(init.headers['user-agent'], 'deepseek-harness/test (+https://example.org)');
    return Response.json(url.endsWith('/session')
      ? { id: 'sess-a' } : { info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'ok' }] });
  };
  const client = new OpenCodeServeClient({
    attributionHeaders: { 'user-agent': 'deepseek-harness/test (+https://example.org)' },
  }, fetch);
  const output = await client.complete({ model: 'glm-5.3-flash-free',
    messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(output.parts[0].text, 'ok');
});


test('normal calls wait for automatic startup; local title calls do not launch a service', async () => {
  let readyCalls = 0;
  const fetch = async (url) => Response.json(url.endsWith('/session')
    ? { id: 'session-local' }
    : { info: { modelID: 'deepseek-v4.1-flash-free' }, parts: [{ type: 'text', text: '1' }] });
  const adapter = createAdapter({
    ensureService: async () => { readyCalls++; },
  }, fetch);
  const prepared = await adapter.prepareCall('opencode-serve', 'deepseek-v4.1-flash-free');
  const chunks = [];
  for await (const chunk of prepared.stream({
    model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: [{ type: 'text', text: '1' }] }],
  })) chunks.push(chunk);
  assert.equal(readyCalls, 1);
  assert.equal(chunks.find(c => c.type === 'text-delta').text, '1');

  const titleChunks = [];
  for await (const chunk of prepared.stream({
    model: 'deepseek-v4.1-flash-free',
    purpose: 'session-title',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Title' }] }],
  })) titleChunks.push(chunk);
  assert.equal(titleChunks.at(-2).block?.text, 'Title');
  assert.equal(readyCalls, 1, 'local titles never start or probe OpenCode');
});
