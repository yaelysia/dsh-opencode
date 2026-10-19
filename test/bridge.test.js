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
