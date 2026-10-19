import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdapter, DEFAULT_MODELS } from '../src/bridge.js';

// Request framing verified against DSH dsh-v0.2.1-rc.2:
// packages/session/session-title-first-prompt-llm/src/index.ts (frameMessages)
// packages/experimental/session-title-all-prompts-llm/src/index.ts (frameMessages)
// packages/session/session-title-llm/src/index.ts (executeSessionTitleLlm)
// Human entries use { seq, text }, not { role, content }.
const generate = messages => 'Generate the session title from this JSON array of human messages:\n' + JSON.stringify(messages);
const update = (currentTitle, messages) => 'Update the session title from this JSON object:\n' + JSON.stringify({ currentTitle, messages });
const request = input => ({
  system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.',
  sessionId: 'title-regression', purpose: 'session-title', maxTokens: 128,
  messages: [{ role: 'user', source: { kind: 'dsh-session-title-llm' }, content: [{ type: 'text', text: input }] }],
});

async function local(input, extra = {}, model = DEFAULT_MODELS[0]) {
  let requests = 0;
  const adapter = createAdapter({}, () => { requests++; throw new Error('Local title must not call OpenCode'); });
  const prepared = await adapter.prepareCall('opencode-serve', model);
  const chunks = [];
  try {
    for await (const chunk of prepared.stream({ ...request(input), ...extra })) chunks.push(chunk);
  } finally { assert.equal(requests, 0); }
  assert.deepEqual(chunks.map(c => c.type), ['block-start', 'text-delta', 'block-end', 'finish']);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks[1].text, chunks[2].block.text);
  return chunks[2].block.text;
}

for (const model of DEFAULT_MODELS) test('DSH 0.2.1-rc.2 first-prompt title unwraps human text: ' + model, async () => {
  assert.equal(await local(generate([{ seq: 7, text: '只回复数字1，不使用工具。' }]), {}, model), '只回复数字1，不使用工具。');
});

test('initial all-prompts title uses the first non-empty human text, never seq or instructions', async () => {
  assert.equal(await local(generate([{ seq: 1, text: '  ' }, { seq: 3, text: '修复表单校验' }, { seq: 9, text: '继续' }])), '修复表单校验');
});

test('title updates keep a valid existing title stable', async () => {
  assert.equal(await local(update('排查缓存权限错误', [{ seq: 3, text: '权限错误' }, { seq: 8, text: '继续' }])), '排查缓存权限错误');
});

test('title updates recover the exact polluted title produced by 0.1.2', async () => {
  const polluted = Array.from(generate([{ seq: 1, text: 'hello' }])).slice(0, 40).join('');
  assert.equal(polluted, 'Generate the session title from this JSO');
  assert.equal(await local(update(polluted, [{ seq: 1, text: 'hello' }])), 'hello');
});

test('blank and update-instruction titles are replaced with human text', async () => {
  for (const currentTitle of ['', '  ', 'Update the session title from this JSON o']) {
    assert.equal(await local(update(currentTitle, [{ seq: 1, text: '修复数据库连接' }])), '修复数据库连接');
  }
});

test('JSON escaping, newlines and delimiters inside human text stay data', async () => {
  const text = '修复 "JSON"：数组 [1,2]\\路径\n第二行';
  assert.equal(await local(generate([{ seq: 1, text }])), '修复 "JSON"：数组 [1,2]\\路径 第二行');
});

test('frame prefixes inside the actual human text are not parsed recursively', async () => {
  const text = generate([{ seq: 99, text: 'inner' }]);
  assert.equal(await local(generate([{ seq: 1, text }])), Array.from(text.replace(/\s+/gu, ' ')).slice(0, 40).join(''));
});

test('CRLF and outer whitespace are accepted', async () => {
  const input = '\ufeff  ' + generate([{ seq: 1, text: '修复连接' }]).replace('\n', '\r\n') + '\r\n';
  assert.equal(await local(input), '修复连接');
});

test('plain legacy title input still works', async () => {
  assert.equal(await local('  Fix\n  parser   handling  '), 'Fix parser handling');
});

test('title content may be a string or multiple text blocks; system and non-text blocks are ignored', async () => {
  const input = generate([{ seq: 1, text: '检查模型回复' }]);
  assert.equal(await local(input, { messages: [{ role: 'system', content: 'Not the title' }, { role: 'user', content: input }] }), '检查模型回复');
  const boundary = input.indexOf('\n');
  assert.equal(await local(input, { messages: [{ role: 'user', content: [
    { type: 'text', text: input.slice(0, boundary) }, { type: 'reasoning', text: 'Not the title' }, { type: 'text', text: input.slice(boundary + 1) },
  ] }] }), '检查模型回复');
});

test('malformed and wrong-shape frames fail without returning framework instructions', async () => {
  for (const input of [
    'Generate the session title from this JSON array of human messages:\n[{"seq":1,"text":"truncated',
    'Generate the session title from this JSON array of human messages:\n{}',
    generate([null]), generate([{ seq: 1, content: 'wrong field' }]), generate([{ text: 123 }]),
    'Update the session title from this JSON object:\n{"currentTitle":"old","messages":null}',
    update(123, [{ seq: 1, text: 'hello' }]),
    'Generate the session title from an unsupported frame',
  ]) await assert.rejects(local(input), e => e.code === 'INVALID_TITLE_INPUT');
});

test('empty human messages use a neutral local title instead of a framing string', async () => {
  assert.equal(await local(generate([])), 'New conversation');
  assert.equal(await local(generate([{ seq: 1, text: '\n\t' }])), 'New conversation');
});

test('excerpt limit does not split Unicode code points', async () => {
  const title = await local(generate([{ seq: 1, text: '😀'.repeat(41) }]));
  assert.equal(title, '😀'.repeat(40));
  assert.equal(title.isWellFormed(), true);
});

test('cancelled local title requests return ABORTED without network traffic', async () => {
  await assert.rejects(local(generate([{ seq: 1, text: 'hello' }]), { signal: AbortSignal.abort() }), e => e.code === 'ABORTED');
});

test('ordinary chat is not parsed as a title even if its content matches a title frame', async () => {
  const input = generate([{ seq: 1, text: 'literal input for chat' }]);
  const calls = [];
  const adapter = createAdapter({}, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json(url.endsWith('/session') ? { id: 'chat' }
      : { info: { modelID: DEFAULT_MODELS[0] }, parts: [{ type: 'text', text: 'Model reply' }] });
  });
  const prepared = await adapter.prepareCall('opencode-serve', DEFAULT_MODELS[0]);
  const chunks = [];
  for await (const chunk of prepared.stream({ ...request(input), purpose: undefined })) chunks.push(chunk);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.parts[0].text, input);
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'Model reply');
});

test('localTitles false retains the explicit cloud title path', async () => {
  const input = generate([{ seq: 1, text: 'Cloud summary input' }]);
  const calls = [];
  const adapter = createAdapter({ localTitles: false }, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json(url.endsWith('/session') ? { id: 'cloud-title' }
      : { info: { modelID: DEFAULT_MODELS[0] }, parts: [{ type: 'text', text: 'Cloud title' }] });
  });
  const prepared = await adapter.prepareCall('opencode-serve', DEFAULT_MODELS[0]);
  const chunks = [];
  for await (const chunk of prepared.stream(request(input))) chunks.push(chunk);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.system, request(input).system);
  assert.equal(calls[1].body.parts[0].text, input);
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'Cloud title');
});
