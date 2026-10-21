import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { StructuredToolBroker } from '../src/structured-broker.js';
import { StructuredOpenCodeService } from '../src/structured-service.js';
import { createStructuredAdapter } from '../src/structured-adapter.js';

const provider = 'opencode-serve', model = 'local-structured';
const dsh = process.env.DSH_VALIDATE_ASSEMBLER === '1' ? await import('@deepseek-ai/dsh-llm') : null;
const tools = [
  { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'edit', parameters: { type: 'object', properties: {
    file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
  }, required: ['file_path', 'old_string', 'new_string'] } },
];
const consume = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks; };

function mockModel() {
  const records = [];
  const server = createServer(async (req, res) => {
    try {
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
      let raw = ''; for await (const data of req) raw += data;
      const body = JSON.parse(raw);
      const results = body.messages.filter(m => m.role === 'tool');
      const system = body.messages.filter(m => m.role === 'system').map(m => m.content);
      const ptc = body.messages.some(m => m.role === 'user'
        && JSON.stringify(m.content).includes('PTC_INTEGRATION_CASE'));
      const nativeProbe = body.messages.some(m => m.role === 'user'
        && JSON.stringify(m.content).includes('DSH_NATIVE_SHELL_PROBE'));
      records.push({ advertised: body.tools.map(t => t.function.name), count: results.length,
        results: results.map(m => m.content), system, ptc, nativeProbe,
        userPrompts: body.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
        id: 'chat-local', object: 'chat.completion.chunk', created: 1760000000, model,
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n');
      frame({ role: 'assistant' });
      if (nativeProbe) {
        if (results.length) {
          frame({ content: 'The native shell call was rejected by the DSH tool guard.' });
          frame({}, 'stop');
        } else {
          frame({ tool_calls: [{ index: 0, id: 'call_mock_native_probe', type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({
              command: 'echo DSH_NATIVE_SHELL_PROBE_EXECUTED',
              description: 'Guard-only native shell probe',
            }) } }] });
          frame({}, 'tool_calls');
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      if (ptc) {
        if (results.length) {
          frame({ content: 'PTC handoff completed through DSH.' });
          frame({}, 'stop');
        } else {
          frame({ tool_calls: [{ index: 0, id: 'call_mock_ptc', type: 'function',
            function: { name: 'dsh_call', arguments: JSON.stringify({
              name: 'run_code', arguments: {
                description: 'Find matching text files using the SDK',
                code: 'return await tools.glob({pattern:"*.txt"})',
              },
            }) } }] });
          frame({}, 'tool_calls');
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      const denied = results.some(m => JSON.stringify(m.content).includes('User denied the tool request'));
      if (results.length >= 3 || denied) {
        frame({ content: denied ? '用户拒绝，未修改文件。' : '已完成，由 DSH 修改。' });
        frame({}, 'stop');
      } else {
        const calls = [
          { name: 'glob', arguments: { pattern: '*.txt' } },
          { name: 'read', arguments: { file_path: 'text.txt' } },
          { name: 'edit', arguments: { file_path: 'text.txt', old_string: 'ok', new_string: 'ok\nhello world' } },
        ];
        frame({ content: ['先查找文件。', '读取文件。', '请求修改。'][results.length] });
        frame({ tool_calls: [{ index: 0, id: 'call_mock_' + results.length, type: 'function',
          function: { name: 'dsh_call', arguments: JSON.stringify(calls[results.length]) } }] });
        frame({}, 'tool_calls');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  return { server, records };
}

// These tests make real OpenCode plugin calls but NEVER contact a cloud model.
// The DSH side is a deterministic approval/execution harness, not Desktop UI.
test('official OpenCode structured tool handoff, resume, refusal and cancellation', {
  timeout: process.platform === 'win32' ? 240000 : 160000,
}, async t => {
  assert.ok(process.env.OPENCODE_TEST_EXE, 'Set OPENCODE_TEST_EXE to official OpenCode 1.19.3');
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-structured-poc-'));
  const workspace = path.join(root, 'text.txt');
  const mock = mockModel();
  mock.server.listen(0, '127.0.0.1'); await once(mock.server, 'listening');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const broker = new StructuredToolBroker();
  const config = { endpoint: 'http://127.0.0.1:' + port, backendProviderId: 'local', models: [model],
    opencodeExecutable: path.resolve(process.env.OPENCODE_TEST_EXE), runtimeRoot: path.join(root, 'runtime'),
    autoStartTimeoutMs: process.platform === 'win32' ? 120000 : 60000,
    timeoutMs: 20000, structuredHandoffTimeoutMs: 10000, ssePreviewEnabled: true,
  };
  const service = new StructuredOpenCodeService(config, { broker, logger: { info() {}, warn() {} },
    spawnImpl(exe, args, options) {
      const env = { ...options.env, OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        npm_config_offline: 'true', npm_config_fetch_retries: '0' }, value = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      // Verify the production managed-agent permission policy, rather than
      // mutating the policy only for this test fixture.
      assert.equal(value.agent['dsh-bridge'].permission.bash, 'ask');
      assert.equal(value.agent['dsh-bridge'].permission.dsh_call, 'allow');
      assert.equal(value.permission['*'], 'deny');
      value.provider = { local: { npm: '@ai-sdk/openai-compatible', name: 'Local test only',
        options: { baseURL: 'http://127.0.0.1:' + mock.server.address().port + '/v1', apiKey: 'local-test' },
        models: { [model]: { name: model, limit: { context: 32000, output: 1024 } } } } };
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(value);
      return spawn(exe, args, { ...options, env });
    },
  });
  const adapter = createStructuredAdapter({ ...config, ensureService: () => service.ready(),
    passwordProvider: () => service.passwordForClient(), logger: { info() {}, warn() {} },
  }, broker);
  let messagePosts = 0;
  const originalFetch = adapter.runtime.client.fetchImpl;
  adapter.runtime.client.fetchImpl = (url, options) => {
    if (options?.method === 'POST' && url.endsWith('/message')) messagePosts++;
    return originalFetch(url, options);
  };
  const invoke = async (sessionId, messages, signal, extra = {}) => {
    const prepared = await adapter.prepareCall(provider, model);
    return consume(prepared.stream({ provider, model, sessionId, tools, messages, signal, ...extra }));
  };
  const user = { role: 'user', content: [{ type: 'text', text: 'Find, read and append to text.txt in the DSH workspace.' }] };
  try {
    await service.ready();
    let completedHistory, completedReply;
    await t.test('glob → read → edit resumes one POST and only the DSH harness touches files', async () => {
      await writeFile(workspace, 'ok');
      const history = [user], dispatched = [], before = messagePosts;
      for (let step = 0; step < 4; step++) {
        const chunks = await invoke('success', history);
        const assembled = dsh ? new dsh.BlockAssembler() : null;
        for (const chunk of chunks) assembled?.push(chunk);
        const assistant = assembled?.message({ provider, model });
        const call = assistant ? assistant.content.find(c => c.type === 'tool-call')
          : chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')?.block;
        if (!call) {
          assert.equal(step, 3); assert.equal(chunks.at(-1).reason.kind, 'stop');
          completedHistory = [...history];
          completedReply = chunks.findLast(c => c.type === 'block-end' && c.block.type === 'text')?.block.text;
          break;
        }
        assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
        assert.equal(await readFile(workspace, 'utf8'), 'ok', 'OpenCode must never write the file');
        dispatched.push(call.name);
        const args = JSON.parse(call.arguments);
        let result;
        if (call.name === 'glob') result = await readdir(root);
        else if (call.name === 'read') result = await readFile(workspace, 'utf8');
        else { assert.equal(call.name, 'edit'); await writeFile(workspace, args.new_string); result = 'Edited'; }
        const content = [{ type: 'text', text: JSON.stringify(result) }];
        history.push(assistant ?? { role: 'assistant', content: [call] },
          dsh ? dsh.createToolResultMessage({ callId: call.id, isError: false, content })
            : { role: 'tool', source: { callId: call.id }, isError: false, content });
      }
      assert.deepEqual(dispatched, ['glob', 'read', 'edit']);
      assert.equal(await readFile(workspace, 'utf8'), 'ok\nhello world');
      assert.equal(messagePosts - before, 1, 'resume the existing HTTP model cycle, do not replay it');
      assert.equal(broker.calls.size, 0); assert.equal(adapter.runtime.turns.size, 0);
    });
    await t.test('real OpenCode reuses a completed Session for the next human turn', async () => {
      const key = JSON.stringify(['success', model, 'chat']);
      const previous = adapter.runtime.sessions.entries.get(key);
      assert.equal(previous?.state, 'idle');
      const beforePosts = messagePosts, beforeMock = mock.records.length;
      const next = await invoke('success', [...completedHistory,
        { role: 'assistant', content: [{ type: 'text', text: completedReply }] },
        { role: 'user', content: [{ type: 'text', text: 'Summarize what changed.' }] },
      ]);
      assert.equal(next.at(-1).reason.kind, 'stop');
      assert.equal(messagePosts - beforePosts, 1, 'a new human turn needs exactly one POST');
      assert.equal(adapter.runtime.sessions.entries.get(key)?.id, previous.id,
        'the next human turn must reuse the actual OpenCode Session ID');
      const latest = mock.records.slice(beforeMock).at(-1);
      assert.equal(latest.count, 3, 'prior tool results must remain in native OpenCode history');
      assert.equal(latest.userPrompts.filter(x => x.includes('Find, read and append')).length, 1,
        'previous user input must not be submitted a second time');
      assert.equal(latest.userPrompts.filter(x => x.includes('Summarize what changed.')).length, 1);
    });
    await t.test('write refusal is returned to OpenCode, no forced edit', async () => {
      await writeFile(workspace, 'ok');
      const history = [user];
      for (let step = 0; step < 3; step++) {
        const chunks = await invoke('refusal', history);
        const call = chunks.find(c => c.type === 'tool-call-delta');
        assert.equal(call.name, ['glob', 'read', 'edit'][step]);
        history.push({ role: 'tool', toolCallId: call.id, isError: step === 2,
          content: [{ type: 'text', text: step === 2 ? 'User denied the tool request' : 'ok' }] });
      }
      const answer = await invoke('refusal', history);
      assert.equal(answer.at(-1).reason.kind, 'stop');
      assert.equal(answer.filter(c => c.type === 'tool-call-delta').length, 0);
      assert.equal(await readFile(workspace, 'utf8'), 'ok');
    });
    await t.test('cancel while DSH is waiting for approval clears the retained cycle', async () => {
      const controller = new AbortController();
      const chunks = await invoke('cancel', [user], controller.signal);
      assert.ok(chunks.some(c => c.type === 'tool-call-delta'));
      controller.abort(); await sleep(100);
      assert.equal(adapter.runtime.turns.size, 0); assert.equal(broker.calls.size, 0);
      assert.equal(await readFile(workspace, 'utf8'), 'ok');
    });
    await t.test('two active sessions with reused native call IDs stay isolated', async () => {
      const [left, right] = await Promise.all([invoke('left', [user]), invoke('right', [user])]);
      const a = left.find(c => c.type === 'tool-call-delta'), b = right.find(c => c.type === 'tool-call-delta');
      assert.notEqual(a.id, b.id);
      await Promise.all([['left', a], ['right', b]].map(([id, call]) => invoke(id, [user, {
        role: 'tool', toolCallId: call.id, isError: true,
        content: [{ type: 'text', text: 'User denied the tool request' }],
      }])));
      assert.equal(broker.calls.size, 0); assert.equal(adapter.runtime.turns.size, 0);
    });
    await t.test('advertised ask-only bash still fails closed before execution', async () => {
      const before = mock.records.length;
      const prompt = { role: 'user', content: [
        { type: 'text', text: 'DSH_NATIVE_SHELL_PROBE: deliberately request a native shell action.' },
      ] };
      const chunks = await invoke('guard-probe', [prompt]);
      assert.equal(chunks.at(-1).reason.kind, 'stop');
      assert.equal(chunks.some(c => c.type === 'tool-call-delta'), false,
        'a native bash attempt must not be forwarded to DSH as an approved tool call');
      const records = mock.records.slice(before).filter(r => r.nativeProbe);
      assert.ok(records.length >= 2, 'the native tool error must return to the mock model');
      assert.ok(records[0].advertised.includes('bash'),
        'bash must remain advertised when its permission is ask');
      assert.ok(records[0].advertised.includes('dsh_call'),
        'the DSH-only proxy remains advertised');
      assert.ok(records.some(r => r.results.some(text =>
        String(text).includes('DSH_STRUCTURED_NATIVE_TOOL_BLOCKED'))),
      'the plugin must block bash before the OpenCode shell executes');
    });
    await t.test('PTC system SDK is sent once and run_code crosses the real OpenCode plugin', async () => {
      const ptcTools = [{ name: 'run_code', parameters: {
        type: 'object', properties: {
          description: { type: 'string' }, code: { type: 'string' },
        }, required: ['description', 'code'],
      } }];
      const ptcPrompt = 'PTC_SDK_SENTINEL: within run_code use await tools.glob(args).';
      const options = { tools: ptcTools, system: ptcPrompt };
      const ptcUser = { role: 'user', content: [
        { type: 'text', text: 'PTC_INTEGRATION_CASE: list .txt files' },
      ] };
      const before = mock.records.length;
      const first = await invoke('ptc', [ptcUser], undefined, options);
      const call = first.find(c => c.type === 'tool-call-delta');
      assert.equal(first.at(-1).reason.kind, 'tool-calls');
      assert.equal(call.name, 'run_code');
      const args = JSON.parse(call.argumentsDelta);
      assert.match(args.code, /await tools.glob/);
      const second = await invoke('ptc', [ptcUser, {
        role: 'tool', toolCallId: call.id, isError: false,
        content: [{ type: 'text', text: '["text.txt"]' }],
      }], undefined, options);
      assert.equal(second.at(-1).reason.kind, 'stop');
      const afterHandoff = await invoke('ptc', [ptcUser,
        { role: 'tool', toolCallId: call.id, isError: false,
          content: [{ type: 'text', text: '["text.txt"]' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'PTC handoff completed through DSH.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Any final observations?' }] },
      ], undefined, options);
      assert.equal(afterHandoff.at(-1).reason.kind, 'stop');
      assert.equal(afterHandoff.some(c => c.type === 'tool-call-delta'), false);
      assert.equal(adapter.runtime.sessions.entries.get(JSON.stringify(['ptc', model, 'chat']))?.state, 'idle');
      const requests = mock.records.slice(before).filter(r => r.ptc);
      assert.ok(requests.length >= 2);
      for (const request of requests) {
        assert.deepEqual(request.advertised.filter(name => name === 'dsh_call'), ['dsh_call']);
        assert.equal(request.system.length, 1, 'one system message for compatible gateways');
        assert.equal(request.system[0].split('PTC_SDK_SENTINEL').length - 1, 1,
          'do not repeat the generated DSH PTC SDK through the plugin hook');
        assert.match(request.system[0], /DSH PTC mode is active/);
      }
    });
    assert.ok(mock.records.length >= 7);
    assert.ok(mock.records.every(r => r.system.length === 1),
      'managed OpenCode may not generate extra system-role messages');
    assert.ok(mock.records.every(r => r.advertised.includes('dsh_call')));
    console.info('STRUCTURED_POC_SUMMARY ' + JSON.stringify({
      officialOpenCode: '1.19.3', cloudRequests: 0, sequence: ['glob', 'read', 'edit'],
      refusal: 'passed', cancellation: 'passed', textEnvelopes: 0, publishedDshAssembler: Boolean(dsh),
    }));
  } finally {
    await adapter.runtime.dispose(); await service.dispose();
    mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve));
    await rm(root, { force: true, recursive: true });
  }
});
