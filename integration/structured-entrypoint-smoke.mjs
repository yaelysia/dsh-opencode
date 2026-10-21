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


test('published DSH assembler hands a PTC run_code request through the dsh_call bridge', async () => {
  const provider = 'opencode-serve', model = 'deepseek-v4.1-flash-free';
  const broker = new StructuredToolBroker();
  const code = 'const files = await tools.glob({pattern:"*.txt"}); return files;';
  const args = { code, description: 'List text files through the DSH SDK' };
  const tools = [{ name: 'run_code', description: 'DSH PTC transport',
    parameters: { type: 'object', properties: {
      code: { type: 'string' }, description: { type: 'string' },
    }, required: ['code', 'description'] },
  }];
  let modelRequests = 0, returned;
  const mock = async (url, init) => {
    const endpoint = new URL(url).pathname;
    if (endpoint === '/session') return Response.json({ id: 'ptc-transport' });
    if (endpoint.endsWith('/abort')) return Response.json(true);
    if (endpoint.endsWith('/message')) {
      modelRequests++;
      const { DSH_STRUCTURED_URL, DSH_STRUCTURED_TOKEN } = broker.environment();
      const response = await fetch(DSH_STRUCTURED_URL + '/call', {
        method: 'POST', headers: {
          authorization: 'Bearer ' + DSH_STRUCTURED_TOKEN, 'content-type': 'application/json',
        }, body: JSON.stringify({ sessionID: 'ptc-transport',
          messageID: 'assistant-one', callID: 'proxy-one',
          name: 'run_code', arguments: args }),
      });
      assert.equal(response.status, 200);
      returned = await response.json();
      return Response.json({ info: { modelID: model },
        parts: [{ type: 'text', text: 'PTC result received.' }] });
    }
    throw Error('Unexpected route ' + endpoint);
  };
  const adapter = createStructuredAdapter({
    ssePreviewEnabled: false, timeoutMs: 10000, endpoint: 'http://127.0.0.1:4096',
  }, broker, mock);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Summarize TXT files' }] }];
  const prepared = await adapter.prepareCall(provider, model);
  const stream = list => prepared.stream({
    provider, model, tools, messages: list, sessionId: 'host-ptc',
  });
  try {
    const first = new BlockAssembler();
    for await (const item of stream(messages)) first.push(item);
    assert.equal(first.finish.kind, 'tool-calls');
    const assistant = first.message({ provider, model });
    const requested = assistant.content.find(block => block.type === 'tool-call');
    assert.equal(requested.name, 'run_code');
    assert.deepEqual(JSON.parse(requested.arguments), args);
    const result = createToolResultMessage({ callId: requested.id,
      isError: false, content: [{ type: 'text', text: 'text.txt' }] });
    const second = new BlockAssembler();
    for await (const item of stream([...messages, assistant, result])) second.push(item);
    assert.equal(second.finish.kind, 'stop');
    assert.equal(second.message({ provider, model }).content[0].text, 'PTC result received.');
    assert.deepEqual(returned, { isError: false,
      content: [{ type: 'text', text: 'text.txt' }] });
    assert.equal(modelRequests, 1, 'PTC transport must continue the existing OpenCode POST');
  } finally { await adapter.runtime.dispose(); }
});
