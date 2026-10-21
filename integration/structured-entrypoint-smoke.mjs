import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, configSnapshot } from '../index.js';
import { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { StructuredToolBroker } from '../src/structured-broker.js';
import { createStructuredAdapter } from '../src/structured-adapter.js';


test('new structured mode is an editable, opt-in DSH setting without changing legacy defaults', () => {
  const defaults = configSnapshot(Config({}));
  assert.equal(defaults.structuredToolsEnabled, false);
  assert.equal(configSnapshot(Config({ structuredToolsEnabled: true })).structuredToolsEnabled, true);
});


test('published DSH tool result does not retry a failed retained OpenCode request', async () => {
  const provider = 'opencode-serve';
  const model = 'deepseek-v4.1-flash-free';
  const tools = [{ name: 'glob', description: 'DSH workspace search', parameters: {
    type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'],
  } }];
  const broker = new StructuredToolBroker();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/session') return Response.json({ id: 'open-cycle-test' });
    if (pathname.endsWith('/abort')) return Response.json(true);
    if (pathname.endsWith('/message')) {
      posts++;
      const { DSH_STRUCTURED_URL, DSH_STRUCTURED_TOKEN } = broker.environment();
      const reply = await fetch(DSH_STRUCTURED_URL + '/call', {
        method: 'POST', headers: {
          authorization: 'Bearer ' + DSH_STRUCTURED_TOKEN, 'content-type': 'application/json',
        }, body: JSON.stringify({ sessionID: 'open-cycle-test', messageID: 'assistant-1',
          callID: 'glob-1', name: 'glob', arguments: { pattern: '*.txt' } }),
      });
      assert.equal(reply.status, 200, 'OpenCode must wait for the actual DSH result');
      return Response.json({ info: { error: { name: 'APIError', data: {
        statusCode: 429, message: 'Upstream request failed: Endpoint is unavailable.',
      } } }, parts: [] });
    }
    throw Error('Unexpected path: ' + pathname);
  };
  const adapter = createStructuredAdapter({
    endpoint: 'http://127.0.0.1:4096', ssePreviewEnabled: false, timeoutMs: 10000,
  }, broker, fetchImpl);
  const user = { role: 'user', content: [{ type: 'text', text: 'Find a text file' }] };
  const start = async messages => {
    const prepared = await adapter.prepareCall(provider, model);
    return prepared.stream({ provider, model, tools, messages,
      sessionId: 'dsh-retry-integration' });
  };
  try {
    const first = new BlockAssembler();
    for await (const chunk of await start([user])) first.push(chunk);
    assert.equal(first.finish.kind, 'tool-calls');
    const assistant = first.message({ provider, model });
    const call = assistant.content.find(x => x.type === 'tool-call');
    assert.equal(call.name, 'glob');
    const result = createToolResultMessage({ callId: call.id, isError: false,
      content: [{ type: 'text', text: 'text.txt' }] });
    const history = [user, assistant, result];
    const isSafeTerminal = error => {
      assert.equal(error.code, 'TOOL_CONTINUATION_FAILED');
      assert.equal(error.failure.status, 429);
      assert.match(error.message, /Endpoint is unavailable/);
      return true;
    };
    const consume = async () => {
      for await (const chunk of await start(history)) {
        if (chunk.type === 'tool-call-delta') assert.fail('No further host tool may be dispatched');
      }
    };
    await assert.rejects(consume, isSafeTerminal);
    await assert.rejects(consume, isSafeTerminal);
    assert.equal(posts, 1, 'never replay an already completed DSH tool');
  } finally { await adapter.runtime.dispose(); }
});
