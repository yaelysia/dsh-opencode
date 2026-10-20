import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmAdapter, BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { apply, Config, name } from '../index.js';
import { createAdapter } from '../src/bridge.js';

test('real DSH packages load the plugin, register its adapter, and run a local title', async () => {
  assert.equal(name, 'opencode-serve');
  assert.ok(Config);
  let adapter, registration, cleanup;
  const ctx = {
    logger: { info() {}, warn() {} },
    fiber: { entry: { options: { id: 'test-entrypoint' } } },
    llm: {
      registerAdapter(providers, instance) {
        assert.deepEqual(providers, ['opencode-serve']);
        adapter = instance;
      },
      registerConfigurableProviders(items) { registration = items; },
    },
    effect(fn) { cleanup = fn(); },
  };
  apply(ctx, { autoStart: false, localTitles: true });
  try {
    assert.ok(adapter instanceof LlmAdapter);
    assert.equal(registration[0].settingsNs, 'test-entrypoint');
    const [model] = adapter.listModels('opencode-serve');
    const prepared = await adapter.prepareCall('opencode-serve', model.id);
    const chunks = [];
    for await (const chunk of prepared.stream({
      provider: 'opencode-serve', model: model.id, purpose: 'session-title',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Local title smoke' }] }],
    })) chunks.push(chunk);
    assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, 'Local title smoke');
    assert.equal(chunks.at(-1)?.reason.kind, 'stop');
  } finally {
    await cleanup?.();
  }
});

test('real DSH BlockAssembler accepts the tool request and subsequent result', async () => {
  const model = 'deepseek-v4.1-flash-free';
  const providers = 'opencode-serve';
  const tools = [{ name: 'read_file', description: 'Read an approved file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const requests = [];
  const server = async (url, req) => {
    requests.push({ url, body: JSON.parse(req.body) });
    if (url.endsWith('/session')) return Response.json({ id: 'real-contract' });
    const answer = requests.length === 2
      ? 'DSH_TOOL_CALL_V1:{"name":"read_file","arguments":{"path":"safe.txt"}}'
      : 'The requested tool returned a result.';
    return Response.json({ info: { modelID: model }, parts: [{ type: 'text', text: answer }] });
  };
  const adapter = createAdapter({}, server);
  const prepared = await adapter.prepareCall(providers, model);
  const user = { role: 'user', content: [{ type: 'text', text: 'Read safe.txt' }] };
  const first = new BlockAssembler();
  for await (const chunk of prepared.stream({ provider: providers, model, tools,
    messages: [user], sessionId: 'integration-case' })) first.push(chunk);
  assert.equal(first.finish.kind, 'tool-calls');
  const assistant = first.message({ provider: providers, model });
  assert.equal(assistant.content.length, 1);
  assert.equal(assistant.content[0].type, 'tool-call');
  assert.equal(assistant.content[0].name, 'read_file');
  const callId = assistant.content[0].id;
  const result = createToolResultMessage({ callId, content: [{ type: 'text', text: 'HELLO' }],
    isError: false });

  const second = new BlockAssembler();
  for await (const chunk of prepared.stream({ provider: providers, model, tools,
    messages: [user, assistant, result], sessionId: 'integration-case' })) second.push(chunk);
  assert.equal(second.finish.kind, 'stop');
  assert.equal(second.message({ provider: providers, model }).content[0].text,
    'The requested tool returned a result.');
  assert.equal(requests.length, 3, 'same session reused, not recreated');
  assert.match(requests[2].body.parts[0].text, /HELLO/);
  assert.match(requests[2].body.parts[0].text, new RegExp(callId));
});
