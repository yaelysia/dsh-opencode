import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdapter, OpenCodeServeClient } from '../src/bridge.js';
import {
  TOOL_CALL_PREFIX, toolInstructions, parseToolRequest, assertNoOpenCodeToolParts,
  renderConversationMessage,
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
  const adapter = createAdapter({}, server.fetch);
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
