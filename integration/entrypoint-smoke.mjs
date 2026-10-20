import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmAdapter, BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { apply, Config, configSnapshot, name } from '../index.js';
import { createAdapter } from '../src/bridge.js';
import { setTimeout as sleep } from 'node:timers/promises';

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
  const adapter = createAdapter({ streamingEnabled: false }, server);
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
  assert.match(requests[2].body.parts[0].text, /assistant DSH tool request/);
  assert.match(requests[2].body.parts[0].text, /read_file/);
  assert.match(requests[2].body.parts[0].text, /HELLO/);
  assert.match(requests[2].body.parts[0].text, new RegExp(callId));
});

test('real DSH BlockAssembler accepts SSE deltas before the OpenCode reply settles', { timeout: 5000 }, async () => {
  const model = 'deepseek-v4.1-flash-free';
  const encoder = new TextEncoder();
  let controller, completeReply;
  const sessionID = 'sse-assembly';
  const emit = (type, properties = {}) => controller.enqueue(encoder.encode(
    'data: ' + JSON.stringify({ type, properties }) + '\n\n'));
  const mock = async (url, init) => {
    if (url.endsWith('/session')) return Response.json({ id: sessionID });
    if (url.endsWith('/event')) {
      return new Response(new ReadableStream({
        start(value) {
          controller = value;
          emit('server.connected');
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.endsWith('/message')) {
      emit('message.updated', {
        sessionID, info: { id: 'assistant-1', role: 'assistant', sessionID },
      });
      emit('message.part.delta', {
        sessionID, messageID: 'assistant-1', partID: 'part-1',
        field: 'text', delta: 'Before ',
      });
      return new Promise(resolve => {
        completeReply = () => resolve(Response.json({
          info: { modelID: model },
          parts: [{ type: 'text', text: 'Before completion' }],
        }));
      });
    }
    throw Error('Unexpected request ' + url);
  };
  const adapter = createAdapter({ ssePreviewEnabled: true }, mock);
  const prepared = await adapter.prepareCall('opencode-serve', model);
  const assembler = new BlockAssembler();
  const observed = [];
  const run = (async () => {
    for await (const chunk of prepared.stream({
      provider: 'opencode-serve', model, sessionId: 'sse-assembly',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Write two words' }] }],
    })) {
      assembler.push(chunk);
      observed.push(chunk);
    }
  })();
  for (let i = 0; i < 60 && !observed.some(x => x.type === 'text-delta'); i++) {
    await sleep(5);
  }
  assert.equal(observed.find(x => x.type === 'text-delta')?.text, 'Before ');
  assert.equal(observed.some(x => x.type === 'finish'), false,
    'the real DSH assembler must see the delta before completion');
  assert.equal(typeof completeReply, 'function');
  completeReply();
  await run;
  assert.equal(assembler.finish.kind, 'stop');
  assert.equal(assembler.message({ provider: 'opencode-serve', model }).content[0].text,
    'Before completion');
});

test('settings are exposed as DSH Volatile references and snapshotted for server lifetimes', () => {
  const config = Config({
    guardedReadCompatibility: true,
    ssePreviewEnabled: false,
    autoStart: true,
    endpoint: 'http://127.0.0.1:4096',
    models: ['deepseek-v4.1-flash-free'],
  });
  for (const key of [
    'guardedReadCompatibility', 'ssePreviewEnabled', 'autoStart', 'endpoint',
    'models', 'toolBridgeEnabled', 'localTitles', 'autoStartDirect', 'timeoutMs',
  ]) {
    assert.equal(typeof config[key].get, 'function',
      key + ' must be editable via DSH settings and have a live getter');
  }
  const options = configSnapshot(config);
  assert.equal(options.guardedReadCompatibility, true);
  assert.equal(options.ssePreviewEnabled, false);
  assert.equal(options.autoStart, true);
  assert.deepEqual(options.models, ['deepseek-v4.1-flash-free']);
  assert.equal(typeof options.endpoint, 'string');
  assert.equal(typeof options.timeoutMs, 'number');
  assert.equal(typeof options.providerId, 'string');
});

test('settings schema refuses invalid model and startup timeout values before persistence', () => {
  assert.throws(() => Config({ timeoutMs: -1 }));
  assert.throws(() => Config({ autoStartTimeoutMs: 0 }));
});

test('published DSH BlockAssembler accepts a guarded OpenCode write as a DSH write', async () => {
  const model = 'deepseek-v4.1-flash-free', provider = 'opencode-serve';
  const tools = [{ name: 'write', description: 'DSH-authorized file writing',
    parameters: { type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  }];
  let generation = 0;
  const server = async (url) => {
    if (url.endsWith('/session')) return Response.json({ id: 'guarded-dsh' });
    generation++;
    return Response.json({ info: { modelID: model }, parts: generation === 1 ? [
      { type: 'tool', tool: 'write', id: 'native-write', callID: 'local-native',
        state: { status: 'error', input: { filePath: 'text.txt', content: 'ok' },
          error: 'DSH_OPENCODE_NATIVE_TOOL_BLOCKED' } },
    ] : [{ type: 'text', text: 'DSH finished the write.' }] });
  };
  const adapter = createAdapter({ guardedReadCompatibility: true }, server);
  const prepared = await adapter.prepareCall(provider, model);
  const user = { role: 'user', content: [{ type: 'text', text: 'Create text.txt with ok' }] };
  const first = new BlockAssembler();
  for await (const chunk of prepared.stream({ provider, model, tools, messages: [user],
    sessionId: 'guarded-integration' })) first.push(chunk);
  const assistant = first.message({ provider, model });
  assert.equal(first.finish.kind, 'tool-calls');
  assert.equal(assistant.content[0].type, 'tool-call');
  assert.equal(assistant.content[0].name, 'write');
  assert.deepEqual(JSON.parse(assistant.content[0].arguments),
    { file_path: 'text.txt', content: 'ok' });
  const hostResult = createToolResultMessage({ callId: assistant.content[0].id,
    isError: false, content: [{ type: 'text', text: 'Created file text.txt' }] });
  const next = new BlockAssembler();
  for await (const chunk of prepared.stream({ provider, model, tools,
    messages: [user, assistant, hostResult], sessionId: 'guarded-integration' })) next.push(chunk);
  assert.equal(next.finish.kind, 'stop');
  assert.equal(next.message({ provider, model }).content[0].text, 'DSH finished the write.');
  assert.equal(generation, 2, 'the adapter must never execute the native write itself');
});

test('published DSH BlockAssembler prefers authoritative block-end after a divergent SSE preview', { timeout: 6000 }, async () => {
  const model = 'deepseek-v4.1-flash-free', provider = 'opencode-serve';
  const sessionID = 'final-authoritative';
  const encoder = new TextEncoder();
  let controller;
  const emit = (type, properties = {}) =>
    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type, properties }) + '\n\n'));
  const server = async url => {
    if (url.endsWith('/session')) return Response.json({ id: sessionID });
    if (url.endsWith('/event')) return new Response(new ReadableStream({
      start(ctl) { controller = ctl; emit('server.connected'); },
    }), { headers: { 'content-type': 'text/event-stream' } });
    if (url.endsWith('/message')) {
      emit('message.updated', { sessionID, info: { role: 'assistant', id: 'stream-assistant', sessionID } });
      emit('message.part.delta', { sessionID, messageID: 'stream-assistant',
        partID: 'stream-part', field: 'text', delta: 'Preview draft' });
      await sleep(30);
      return Response.json({ info: { modelID: model },
        parts: [{ type: 'text', text: 'Authoritative text' }] });
    }
    throw Error('Unexpected endpoint ' + url);
  };
  const adapter = createAdapter({ ssePreviewEnabled: true, logger: { warn() {} } }, server);
  const prepared = await adapter.prepareCall(provider, model);
  const assembled = new BlockAssembler(), recorded = [];
  for await (const chunk of prepared.stream({
    provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Answer' }] }],
  })) {
    assembled.push(chunk); recorded.push(chunk);
  }
  assert.equal(recorded.find(x => x.type === 'text-delta')?.text, 'Preview draft');
  assert.equal(assembled.message({ provider, model }).content[0].text, 'Authoritative text');
  assert.equal(assembled.finish.kind, 'stop');
});
