import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { managedAgentEnvironment, BRIDGE_AGENT_ID } from '../src/managed-agent.js';

async function availablePort() {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitUntilHealthy(url, headers, child) {
  for (let i = 0; i < 110; i++) {
    if (child.exitCode !== null) throw new Error('OpenCode exited before readiness: ' + child.exitCode);
    try {
      const response = await fetch(url + '/global/health', {
        headers, signal: AbortSignal.timeout(2500),
      });
      if (response.ok && (await response.json()).healthy) return;
    } catch { /* Cold start is expected. */ }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('OpenCode did not become healthy');
}

function mockProvider() {
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    if (request.url?.includes('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ object: 'list',
        data: [{ id: 'mock', object: 'model', owned_by: 'dsh-local' }] }));
      return;
    }
    if (!request.url?.endsWith('/chat/completions')) {
      response.writeHead(404); response.end(); return;
    }
    const parts = [];
    for await (const fragment of request) parts.push(fragment);
    let payload;
    try { payload = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { response.writeHead(400); response.end(); return; }
    requests.push({ tools: payload.tools?.map(t => t.function?.name).filter(Boolean) ?? [],
      messages: payload.messages?.length ?? 0, stream: payload.stream });
    response.setHeader('content-type', 'text/event-stream');
    response.setHeader('cache-control', 'no-cache');
    const write = (delta, finish_reason = null, usage) => {
      response.write('data: ' + JSON.stringify({
        id: 'chatcmpl-local', object: 'chat.completion.chunk',
        created: 1760000000, model: 'mock',
        choices: [{ index: 0, delta, finish_reason }],
        ...(usage ? { usage } : {}),
      }) + '\n\n');
    };
    if (requests.length === 1) {
      write({ role: 'assistant', tool_calls: [{
        index: 0, id: 'call-local-1', type: 'function',
        function: { name: 'read', arguments: JSON.stringify({
          filePath: '/dsh-not-a-real-file.txt',
        }) },
      }] });
      write({}, 'tool_calls', { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 });
    } else {
      write({ role: 'assistant', content: 'Completed by local mock.' });
      write({}, 'stop', { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 });
    }
    response.end('data: [DONE]\n\n');
  });
  return { server, requests };
}

test('official OpenCode 1.19.3 completes a guarded native tool through a mocked model', {
  timeout: 125_000,
}, async () => {
  const binary = process.env.OPENCODE_TEST_EXE;
  assert.ok(binary, 'OPENCODE_TEST_EXE must identify the pinned official binary');
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-mock-native-'));
  const mock = mockProvider();
  let child;
  let output = '';
  try {
    mock.server.listen(0, '127.0.0.1');
    await once(mock.server, 'listening');
    const modelPort = mock.server.address().port;
    const port = await availablePort();
    const nonce = randomBytes(32).toString('hex');
    const password = randomBytes(32).toString('hex');
    const marker = path.join(root, 'guard.ready');
    const audit = path.join(root, 'guard-audit.jsonl');
    const origin = 'http://127.0.0.1:' + port;
    const env = managedAgentEnvironment({ ...process.env,
      OPENCODE_CONFIG_CONTENT: undefined,
    }, BRIDGE_AGENT_ID, root, { guardedRead: true });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    config.provider = {
      'dsh-local': {
        npm: '@ai-sdk/openai-compatible', name: 'DSH local mock (CI only)',
        options: { baseURL: 'http://127.0.0.1:' + modelPort + '/v1', apiKey: 'dsh-ci-local' },
        models: { mock: { name: 'mock', limit: { context: 8192, output: 512 } } },
      },
    };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    env.OPENCODE_SERVER_PASSWORD = password;
    env.OPENCODE_SERVER_USERNAME = 'opencode';
    env.DSH_OPENCODE_GUARD_NONCE = nonce;
    env.DSH_OPENCODE_GUARD_MARKER = marker;
    env.DSH_OPENCODE_GUARD_AUDIT = audit;
    for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      env[key] = env[key] || path.join(root, key);
      await mkdir(env[key], { recursive: true });
    }
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    child = spawn(path.resolve(binary), ['serve', '--hostname', '127.0.0.1',
      '--port', String(port)], { env, cwd: workspace, windowsHide: true });
    child.stdout.on('data', x => { output += String(x).slice(0, 4000); });
    child.stderr.on('data', x => { output += String(x).slice(0, 4000); });
    const headers = { authorization: 'Basic ' +
      Buffer.from('opencode:' + password).toString('base64'),
      'content-type': 'application/json' };
    await waitUntilHealthy(origin, headers, child);
    assert.equal(await readFile(marker, 'utf8'), nonce);
    const sessionResponse = await fetch(origin + '/session', {
      method: 'POST', headers, body: JSON.stringify({ title: 'native tool CI' }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    const messageResponse = await fetch(origin + '/session/' + encodeURIComponent(session.id) + '/message', {
      method: 'POST', headers,
      body: JSON.stringify({
        model: { providerID: 'dsh-local', modelID: 'mock' }, agent: BRIDGE_AGENT_ID,
        system: 'Call the read tool to find the mock test path. Do not use another tool.',
        parts: [{ type: 'text', text: 'Call read for /dsh-not-a-real-file.txt.' }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const message = await messageResponse.json();
    const historyResponse = await fetch(origin + '/session/' +
      encodeURIComponent(session.id) + '/message', {
      headers, signal: AbortSignal.timeout(10000),
    });
    const history = await historyResponse.json();
    const native = history.flatMap(item => item.parts ?? []).filter(p => p.type === 'tool');
    const evidence = await readFile(audit, 'utf8').catch(() => '');
    // The diagnostic deliberately contains only tool names/statuses and
    // whether the guard wrote an audit proof, never file args or user text.
    const summary = {
      providerRequests: mock.requests, httpStatus: messageResponse.status,
      messageInfo: { role: message.info?.role, finish: message.info?.finish,
        error: Boolean(message.info?.error) },
      toolParts: native.map(p => ({ type: p.type, id: p.id, messageID: p.messageID,
        callID: p.callID, tool: p.tool, status: p.state?.status,
        errorClass: typeof p.state?.error === 'string'
          ? p.state.error.includes('DSH_OPENCODE_NATIVE_TOOL_BLOCKED') ? 'guard-denied' : 'other'
          : 'none',
        providerExecuted: p.metadata?.providerExecuted === true })),
      audited: evidence.split('\n').filter(Boolean).length,
    };
    console.info('OFFICIAL_NATIVE_EVENT_DIAGNOSTIC ' + JSON.stringify(summary));
    assert.equal(messageResponse.status, 200);
    assert.ok(mock.requests.some(x => x.tools.includes('read')),
      'mock model must be offered a native read tool');
    assert.ok(native.length, 'the mock tool-call must produce an OpenCode native tool part');
    assert.ok(evidence.includes(nonce), 'the pre-execution native guard must record the tool call');
    assert.ok(native.every(p => p.state?.status !== 'completed'),
      'the real OpenCode native read executor must never run');
  } catch (error) {
    console.error('OpenCode mocked native test failed: ' + error.message);
    console.error('OpenCode process output (truncated): ' + output.slice(0, 1500));
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit').catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 1500))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await new Promise(resolve => mock.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
