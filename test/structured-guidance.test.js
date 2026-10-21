import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DshStructuredTools, structuredToolGuidance } from '../src/opencode-dsh-tools.mjs';
import { STRUCTURED_AGENT_PROMPT } from '../src/structured-service.js';
import { StructuredToolBroker } from '../src/structured-broker.js';

const native = [{ name: 'glob', parameters: { type: 'object', properties: {
  pattern: { type: 'string' },
} } }, { name: 'edit', parameters: { type: 'object', properties: {
  file_path: { type: 'string' },
} } }];
const ptc = [{ name: 'run_code', parameters: { type: 'object', properties: {
  code: { type: 'string' }, description: { type: 'string' },
}, required: ['code', 'description'] } }];

test('the managed OpenCode agent delegates environmental operations only via dsh_call', () => {
  assert.match(STRUCTURED_AGENT_PROMPT, /registered.*dsh_call plugin tool/);
  assert.match(STRUCTURED_AGENT_PROMPT, /NEVER invoke them/);
  assert.match(STRUCTURED_AGENT_PROMPT, /text-only requests.*answer normally/);
  assert.match(STRUCTURED_AGENT_PROMPT, /response language/);
  assert.doesNotMatch(STRUCTURED_AGENT_PROMPT, /must always call tools/i);
});

test('DSH-native instructions prohibit calling built-in read/glob before the proxy', () => {
  const guidance = structuredToolGuidance(native);
  assert.match(guidance, /ONLY permitted tool gateway.*dsh_call/);
  assert.match(guidance, /Never try a native OpenCode tool first/);
  assert.match(guidance, /select an appropriate name/i);
  assert.match(guidance, /DSH native tool presentation/);
  assert.match(guidance, /Wait for the DSH tool result/);
  assert.doesNotMatch(guidance, /PTC mode is active/);
});

test('DSH PTC is explicitly run_code through dsh_call, not native OpenCode code', () => {
  const guidance = structuredToolGuidance(ptc);
  assert.match(guidance, /DSH PTC mode is active/);
  assert.match(guidance, /ONLY DSH tool.*run_code/);
  assert.match(guidance, /dsh_call with name="run_code"/);
  assert.match(guidance, /code and description/);
  assert.match(guidance, /await tools\.name\(args\)/);
  assert.match(guidance, /Do not call SDK tools directly as OpenCode tools/);
  assert.doesNotMatch(guidance, /DSH native tool presentation is active/);
});

test('missing DSH tools never forces a tool call for a normal answer', () => {
  const guidance = structuredToolGuidance([]);
  assert.match(guidance, /No DSH tools are available now/);
  assert.match(guidance, /Do not call dsh_call or native OpenCode tools/);
  assert.equal(structuredToolGuidance(null).includes('No DSH tools'), true);
});

test('actual plugin injects the catalog-specific prompt and keeps native tool guard', async () => {
  const broker = new StructuredToolBroker();
  await broker.start();
  const keyNames = [
    'DSH_STRUCTURED_URL', 'DSH_STRUCTURED_TOKEN',
    'DSH_OPENCODE_GUARD_MARKER', 'DSH_OPENCODE_GUARD_NONCE',
  ];
  const oldEnv = Object.fromEntries(keyNames.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      ...broker.environment(),
      DSH_OPENCODE_GUARD_MARKER: 'test-only-guard-marker',
      DSH_OPENCODE_GUARD_NONCE: 'a'.repeat(64),
    });
    broker.register('session-ptc', {
      tools: ptc, instructions: 'User language: 简体中文。Use DSH tools only.',
      onCall() {},
    });
    const hooks = await DshStructuredTools();
    const output = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID: 'session-ptc' }, output);
    assert.equal(output.system.length, 1);
    assert.match(output.system[0], /User language: 简体中文/);
    assert.match(output.system[0], /"name":"run_code"/);
    assert.match(output.system[0], /PTC mode is active/);
    assert.match(output.system[0], /dsh_call with name="run_code"/);
    assert.equal(typeof hooks.tool.dsh_call.execute, 'function');
    await assert.rejects(hooks['tool.execute.before']({ tool: 'read' }),
      /DSH_STRUCTURED_NATIVE_TOOL_BLOCKED/);
    await assert.rejects(hooks['experimental.chat.system.transform']({
      sessionID: 'missing-session',
    }, { system: [] }), /No active DSH context/);
    broker.update('session-ptc', native, 'Use the DSH native presentation.');
    const nativeOutput = { system: [] };
    await hooks['experimental.chat.system.transform']({
      sessionID: 'session-ptc',
    }, nativeOutput);
    assert.match(nativeOutput.system[0], /DSH native tool presentation is active/);
    assert.doesNotMatch(nativeOutput.system[0], /PTC mode is active/);
    assert.match(nativeOutput.system[0], /"name":"glob"/);
  } finally {
    for (const [key, old] of Object.entries(oldEnv)) {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
    await broker.dispose();
  }
});
