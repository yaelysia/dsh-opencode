import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdapter, OpenCodeServeClient } from '../src/bridge.js';
import {
  TOOL_CALL_PREFIX, toolInstructions, parseToolRequest, assertNoOpenCodeToolParts,
  inspectNativeToolParts, translateGuardedTool, NATIVE_GUARD_DENIAL, renderConversationMessage,
} from '../src/tool-boundary.js';

const model = 'deepseek-v4.1-flash-free';
const tools = [
  { name: 'read_file', description: 'Read an approved file', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  }},
  { name: 'run_command', description: 'Run a shell command (requires DSH approval)',
    parameters: { type: 'object', properties: { command: { type: 'string' } } }},
];
const callText = TOOL_CALL_PREFIX + JSON.stringify({
  name: 'read_file', arguments: { path: '/tmp/allowed' },
});
const user = { role: 'user', content: [{ type: 'text', text: 'Read the file' }] };
const getChunks = async (adapter, messages, active = tools) => {
  const prepared = await adapter.prepareCall('opencode-serve', model);
  const result = [];
  for await (const chunk of prepared.stream({ provider: 'opencode-serve', model, tools: active,
    messages, sessionId: 'case' })) result.push(chunk);
  return result;
};
const mockServer = (answers) => {
  const calls = [];
  const fetch = async (url, req) => {
    calls.push({ url, body: JSON.parse(req.body) });
    if (url.endsWith('/session')) return Response.json({ id: 'ses-dsh' });
    const answer = answers.shift();
    return Response.json({ info: { modelID: model }, parts: answer });
  };
  return { calls, fetch };
};

test('only DSH declared schemas are serialized, with exact tool protocol instructions', () => {
  const text = toolInstructions(tools);
  assert.match(text, /read_file/);
  assert.match(text, /run_command/);
  assert.match(text, /Only the DSH host can execute/);
  assert.equal(toolInstructions([]), '');
  assert.throws(() => toolInstructions([tools[0], tools[0]]),
    error => error.code === 'INVALID_TOOL_SCHEMA');
});

test('tool marker uses strict JSON envelope, never substring matching', () => {
  const matched = parseToolRequest(callText, tools);
  assert.equal(matched.name, 'read_file');
  assert.equal(JSON.parse(matched.arguments).path, '/tmp/allowed');
  assert.match(matched.id, /^call_/);
  assert.equal(parseToolRequest('ordinary answer', tools), null);
  assert.equal(parseToolRequest('quoted: ' + callText, tools), null);
  assert.throws(() => parseToolRequest(callText, []),
    error => error.code === 'UNDECLARED_TOOL_CALL');
  assert.throws(() => parseToolRequest(TOOL_CALL_PREFIX + '{"name":"hidden","arguments":{}}', tools),
    error => error.code === 'UNDECLARED_TOOL_CALL');
  assert.throws(() => parseToolRequest(TOOL_CALL_PREFIX + '{"name":"read_file","arguments":"payload"}', tools),
    error => error.code === 'INVALID_TOOL_CALL');
  assert.throws(() => parseToolRequest(TOOL_CALL_PREFIX + '{"name":"read_file","arguments":{},"debug":1}', tools),
    error => error.code === 'INVALID_TOOL_CALL');
});

test('OpenCode native tool parts cause fail-closed response', () => {
  assert.throws(() => assertNoOpenCodeToolParts([{ type: 'tool', name: 'read', state: 'completed' }]),
    error => error.code === 'OPENCODE_TOOL_BOUNDARY');
  assert.throws(() => assertNoOpenCodeToolParts([{ type: 'tool-call', name: 'bash' }]),
    error => error.code === 'OPENCODE_TOOL_BOUNDARY');
  assert.doesNotThrow(() => assertNoOpenCodeToolParts([{ type: 'text', text: '1' }]));
});

test('model tool decision becomes a DSH tool-call block, never executed by OpenCode', async () => {
  const server = mockServer([[{ type: 'text', text: callText }]]);
  const adapter = createAdapter({ streamingEnabled: false }, server.fetch);
  const chunks = await getChunks(adapter, [user]);
  assert.deepEqual(chunks.map(c => c.type),
    ['block-start', 'tool-call-delta', 'block-end', 'finish']);
  assert.equal(chunks[1].name, 'read_file');
  assert.equal(chunks[2].block.type, 'tool-call');
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.match(server.calls[1].body.system, /run_command/);
  assert.equal(server.calls[1].body.agent, 'dsh-bridge');
  assert.equal(server.calls.length, 2, 'only one session creation and one model request');
});

test('DSH tool result is reintroduced as data in same OpenCode session', async () => {
  const server = mockServer([
    [{ type: 'text', text: callText }],
    [{ type: 'text', text: 'The file contains hello.' }],
  ]);
  const client = new OpenCodeServeClient({}, server.fetch);
  const first = await client.complete({ model, tools, sessionId: 'tool-loop',
    messages: [user] });
  const generated = first.dshToolCall;
  const second = await client.complete({ model, tools, sessionId: 'tool-loop',
    messages: [
      user,
      { role: 'assistant', content: [{
        type: 'tool-call', id: generated.id, name: generated.name, arguments: generated.arguments,
      }] },
      { role: 'tool', toolCallId: generated.id, isError: false,
        content: [{ type: 'text', text: 'hello' }] },
    ] });
  assert.equal(second.dshToolCall, null);
  assert.equal(server.calls.filter(call => call.url.endsWith('/session')).length, 1);
  assert.match(server.calls[2].body.parts[0].text, /assistant DSH tool request/);
  assert.match(server.calls[2].body.parts[0].text, /read_file/);
  assert.match(server.calls[2].body.parts[0].text, /DSH tool result/);
  assert.match(server.calls[2].body.parts[0].text, /hello/);
});

test('bad upstream tool events are rejected even when mixed with text', async () => {
  const server = mockServer([[{ type: 'text', text: 'success' },
    { type: 'tool', name: 'bash', state: 'completed' }]]);
  const client = new OpenCodeServeClient({}, server.fetch);
  await assert.rejects(() => client.complete({ model, tools, messages: [user] }),
    error => error.code === 'OPENCODE_TOOL_BOUNDARY');
});

test('disabled DSH tool bridge refuses tool-bearing requests before cloud call', async () => {
  let calls = 0;
  const client = new OpenCodeServeClient({ toolBridgeEnabled: false },
    async () => { calls++; throw Error('unexpected'); });
  await assert.rejects(() => client.complete({ model, tools, messages: [user] }),
    error => error.code === 'DSH_TOOLS_DISABLED');
  assert.equal(calls, 0);
});

test('malformed model tool envelope cannot trigger host tools', async () => {
  const server = mockServer([[{ type: 'text', text:
    TOOL_CALL_PREFIX + '{"name":"read_file","arguments":{oops}}' }]]);
  const client = new OpenCodeServeClient({}, server.fetch);
  await assert.rejects(() => client.complete({ model, tools, messages: [user] }),
    error => error.code === 'INVALID_TOOL_CALL');
});

test('tool results explicitly retain DSH call IDs and error information', () => {
  const text = renderConversationMessage({ role: 'tool', toolCallId: 'call-42',
    isError: true, content: [{ type: 'text', text: 'denied' }] },
  parts => parts.filter(part => part.type === 'text').map(part => part.text).join(''));
  assert.match(text, /call-42/);
  assert.match(text, /error=true/);
  assert.match(text, /denied/);
});


test('max-token truncated model output never dispatches a tool call', async () => {
  const client = new OpenCodeServeClient({}, async url => Response.json(
    url.endsWith('/session') ? { id: 'ses-truncated' } : {
      info: { modelID: model, finish: 'length' }, parts: [{ type: 'text', text: callText }],
    }));
  await assert.rejects(
    () => client.complete({ model, tools, messages: [user] }),
    error => error.code === 'INCOMPLETE_TOOL_CALL',
  );
});

test('unmanaged service requirements are propagated before a tool request', async () => {
  let required = null;
  const server = mockServer([[{ type: 'text', text: '1' }]]);
  const client = new OpenCodeServeClient({
    ensureService: async options => { required = options; },
  }, server.fetch);
  await client.complete({ model, tools, messages: [user] });
  assert.equal(required.requireManaged, true);
});


test('DSH-denied tool call is returned as a tool error, not executed in OpenCode', async () => {
  const server = mockServer([
    [{ type: 'text', text: callText }],
    [{ type: 'text', text: 'The requested tool was denied by DSH.' }],
  ]);
  const client = new OpenCodeServeClient({}, server.fetch);
  const first = await client.complete({ model, tools, sessionId: 'denied',
    messages: [user] });
  const call = first.dshToolCall;
  assert.equal(call.name, 'read_file');
  const second = await client.complete({ model, tools, sessionId: 'denied',
    messages: [user, { role: 'assistant', content: [{ type: 'tool-call',
      id: call.id, name: call.name, arguments: call.arguments }] },
      { role: 'tool', toolCallId: call.id, isError: true,
        content: [{ type: 'text', text: 'permission denied' }] }] });
  assert.equal(second.dshToolCall, null);
  assert.match(server.calls[2].body.parts[0].text, /error=true/);
  assert.match(server.calls[2].body.parts[0].text, /permission denied/);
  assert.equal(server.calls.length, 3, 'no direct OpenCode tool execution requests');
});

const hostTools = [
  { name: 'read', description: 'Read one DSH-approved file', parameters: {
    type: 'object', properties: {
      file_path: { type: 'string', required: true }, offset: { type: 'integer' },
      limit: { type: 'integer' },
    }, required: ['file_path'],
  } },
  { name: 'write', description: 'Write a file via DSH only', parameters: {
    type: 'object', properties: {
      file_path: { type: 'string', required: true }, content: { type: 'string', required: true },
    }, required: ['file_path', 'content'],
  } },
  { name: 'edit', description: 'Edit a file via DSH only', parameters: {
    type: 'object', properties: {
      file_path: { type: 'string' }, old_string: { type: 'string' },
      new_string: { type: 'string' }, replace_all: { type: 'boolean' },
    }, required: ['file_path', 'old_string', 'new_string'],
  } },
  { name: 'glob', description: 'Discover files', parameters: {
    type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } },
    required: ['pattern'],
  } },
  { name: 'pwsh', description: 'DSH-managed Windows shell', parameters: {
    type: 'object', properties: { command: { type: 'string' } },
    required: ['command'],
  } },
];
const intercepted = (tool, input, overrides = {}) => ({
  id: 'native-id', callID: 'native-call', type: 'tool', tool,
  state: { status: 'error', input, error: 'Error: ' + NATIVE_GUARD_DENIAL },
  ...overrides,
});

test('verified guard failures map native read/write/edit/glob/shell to declared DSH schema', () => {
  const cases = [
    ['read', { filePath: 'test.txt', limit: 4 }, 'read', { file_path: 'test.txt', limit: 4 }],
    ['write', { filePath: 'text.txt', content: 'ok' }, 'write',
      { file_path: 'text.txt', content: 'ok' }],
    ['edit', { filePath: 'text.txt', oldString: 'ok', newString: 'okay' }, 'edit',
      { file_path: 'text.txt', old_string: 'ok', new_string: 'okay' }],
    ['glob', { pattern: '*' }, 'glob', { pattern: '*' }],
    ['shell', { command: 'dir' }, 'pwsh', { command: 'dir' }],
  ];
  for (const [nativeName, args, dshName, expected] of cases) {
    const part = intercepted(nativeName, args);
    assert.equal(inspectNativeToolParts([part], { guarded: true }).length, 1);
    const converted = translateGuardedTool(part, hostTools);
    assert.equal(converted.name, dshName);
    assert.deepEqual(JSON.parse(converted.arguments), expected);
  }
});

test('guarded native requests are rejected unless their full origin is a failed guard hook', () => {
  const good = intercepted('read', { filePath: 'safe.txt' });
  const suspicious = [
    { ...good, state: { ...good.state, status: 'completed', output: 'secret' } },
    { ...good, state: { ...good.state, status: 'running' } },
    { ...good, state: { ...good.state, error: 'Permission denied' } },
    { ...good, metadata: { providerExecuted: true } },
    { ...good, state: { ...good.state, metadata: { providerExecuted: true } } },
    { ...good, type: 'tool-call' },
  ];
  for (const part of suspicious) assert.throws(
    () => inspectNativeToolParts([part], { guarded: true }),
    error => error.code === 'OPENCODE_TOOL_BOUNDARY');
  assert.throws(() => inspectNativeToolParts([good], { guarded: false }),
    error => error.code === 'OPENCODE_TOOL_BOUNDARY');
});

test('native tool translation cannot bypass the DSH declaration whitelist or schema', () => {
  assert.equal(translateGuardedTool(intercepted('write', { filePath: 'a', content: 'ok' }),
    hostTools.filter(tool => tool.name !== 'write')), null);
  assert.equal(translateGuardedTool(intercepted('write', { filePath: 'a' }), hostTools), null);
  assert.equal(translateGuardedTool(intercepted('write', {
    filePath: 'a', content: 'ok', unapproved: 'hidden',
  }), hostTools), null);
  assert.equal(translateGuardedTool(intercepted('task', { prompt: 'bad' }), hostTools), null);
});

test('a blocked native OpenCode write becomes a DSH tool call without executing OpenCode', async () => {
  const blocked = intercepted('write', { filePath: 'text.txt', content: 'ok' });
  const server = mockServer([[blocked]]);
  const adapter = createAdapter({ guardedReadCompatibility: true }, server.fetch);
  const chunks = await getChunks(adapter, [user], hostTools);
  assert.deepEqual(chunks.map(x => x.type),
    ['block-start', 'tool-call-delta', 'block-end', 'finish']);
  assert.equal(chunks[1].name, 'write');
  assert.deepEqual(JSON.parse(chunks[1].argumentsDelta),
    { file_path: 'text.txt', content: 'ok' });
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.equal(server.calls.length, 2, 'no direct tool request is made by the bridge');
});

test('mixed successful and guarded native tool events fail closed', async () => {
  const server = mockServer([[
    intercepted('read', { filePath: 'safe.txt' }),
    { ...intercepted('write', { filePath: 'text.txt', content: 'bad' }),
      id: 'native-unsafe', state: { status: 'completed', input: {}, output: 'wrote' } },
  ]]);
  const client = new OpenCodeServeClient({ guardedReadCompatibility: true }, server.fetch);
  await assert.rejects(client.complete({ model, tools: hostTools, messages: [user] }),
    error => error.code === 'OPENCODE_TOOL_BOUNDARY');
});

test('a guarded OpenCode request with an undeclared target is not dispatched', async () => {
  const server = mockServer([[intercepted('write', { filePath: 'a', content: 'b' })]]);
  const client = new OpenCodeServeClient({ guardedReadCompatibility: true }, server.fetch);
  await assert.rejects(client.complete({ model, tools: hostTools.filter(t => t.name !== 'write'),
    messages: [user] }), error => error.code === 'GUARDED_TOOL_UNMAPPED');
});

test('several verified guarded native intents are sequenced one per DSH round', async () => {
  const native = [
    intercepted('glob', { pattern: '*' }),
    { ...intercepted('write', { filePath: 'text.txt', content: 'ok' }),
      id: 'native-second', callID: 'second-call' },
  ];
  const server = mockServer([native]);
  const logs = [];
  const client = new OpenCodeServeClient({
    guardedReadCompatibility: true, logger: { warn: message => logs.push(message) },
  }, server.fetch);
  const result = await client.complete({ model, tools: hostTools, messages: [user] });
  assert.equal(result.dshToolCall.name, 'glob');
  assert.deepEqual(JSON.parse(result.dshToolCall.arguments), { pattern: '*' });
  assert.ok(logs.some(message => message.includes('forwarding only the first')),
    'no other guarded intent was silently routed');
  assert.equal(server.calls.length, 2, 'no extra tool execution request');
});

test('native shell workdir is not propagated to the host shell', () => {
  const call = intercepted('shell', { command: 'pwd', workdir: '/isolated-runtime/workspace' });
  const mapped = translateGuardedTool(call, hostTools);
  assert.equal(mapped.name, 'pwsh');
  assert.deepEqual(JSON.parse(mapped.arguments), { command: 'pwd' });
});

test('bridge file-tool guidance takes priority over generic shell usage', () => {
  const guidance = toolInstructions(hostTools);
  assert.match(guidance, /glob\/grep\/read\/write\/edit tools instead of pwsh/);
  assert.match(guidance, /current DSH workspace/);
});

test('an authenticated hook audit may prove a native denial even if OpenCode rewrote error text', () => {
  const part = intercepted('edit', { filePath: 'text.txt',
    oldString: 'ok', newString: 'ok\nhello world' });
  part.state.error = 'OpenCode internal plugin execution failed';
  assert.throws(() => inspectNativeToolParts([part], { guarded: true }),
    error => error.code === 'OPENCODE_TOOL_BOUNDARY');
  assert.equal(inspectNativeToolParts([part], {
    guarded: true, verifiedDenials: new Set([part.id]),
  }).length, 1);
  assert.throws(() => inspectNativeToolParts([{
    ...part, state: { ...part.state, status: 'completed' },
  }], { guarded: true, verifiedDenials: new Set([part.id]) }),
  error => error.code === 'OPENCODE_TOOL_BOUNDARY');
});

test('unknown native-tool denial exposes safe classifications but no private arguments', () => {
  const part = { id: 'part-x', type: 'tool', tool: 'edit',
    state: { status: 'error',
      input: { filePath: 'secret-file-123', oldString: 'old', newString: 'private-content-456' },
      error: 'Provider rejected modification of secret-file-123' } };
  assert.throws(() => inspectNativeToolParts([part], { guarded: true }),
    error => error.code === 'OPENCODE_TOOL_BOUNDARY'
      && /tool=edit, status=error, guardDenial=false, auditVerified=false/.test(error.message)
      && !/secret-file-123|private-content-456/.test(error.message));
});

test('authenticated pre-execution guard proof accepts an error part without vendor error text', () => {
  const part = { id: 'part-guard-1', type: 'tool', tool: 'edit',
    sessionID: 'session-1', callID: 'native-1',
    state: { status: 'error', input: {
      filePath: 'notes.txt', oldString: 'a', newString: 'b',
    } } };
  const verifiedDenials = new Set(['part-guard-1']);
  assert.equal(inspectNativeToolParts([part], {
    guarded: true, verifiedDenials,
  }).length, 1);
  assert.throws(() => inspectNativeToolParts([part], {
    guarded: true, verifiedDenials: new Set(),
  }), error => error.code === 'OPENCODE_TOOL_BOUNDARY');
  assert.throws(() => inspectNativeToolParts([{ ...part,
    state: { ...part.state, status: 'completed' },
  }], { guarded: true, verifiedDenials }),
  error => error.code === 'OPENCODE_TOOL_BOUNDARY');
});
