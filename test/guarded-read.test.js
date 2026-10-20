import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DshNativeToolGuard } from '../src/opencode-native-tool-guard.mjs';
import { BRIDGE_AGENT_ID, managedAgentEnvironment, managedAgentDefinition } from '../src/managed-agent.js';

test('default strict mode never permits native OpenCode reads', () => {
  assert.deepEqual(managedAgentDefinition().permission, { '*': 'deny' });
  const env = managedAgentEnvironment({}, BRIDGE_AGENT_ID, '/isolated');
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.plugin, []);
  assert.equal(cfg.agent[BRIDGE_AGENT_ID].permission.read, undefined);
});

test('guarded-read mode exposes only the read declaration and an isolated guard plugin', () => {
  const env = managedAgentEnvironment({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      agent: { test: { mode: 'primary' } }, plugin: ['npm:untrusted-plugin'], mcp: { dangerous: {} },
    }),
  }, BRIDGE_AGENT_ID, '/isolated', { guardedRead: true });
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.permission, { '*': 'deny' });
  assert.deepEqual(cfg.agent[BRIDGE_AGENT_ID].permission,
    { '*': 'deny', read: 'allow', external_directory: 'deny' });
  assert.equal(cfg.plugin.length, 1);
  assert.match(cfg.plugin[0], /^file:\/\//);
  assert.match(cfg.plugin[0], /opencode-native-tool-guard\.mjs$/);
  assert.deepEqual(cfg.mcp, {});
  assert.deepEqual(Object.keys(cfg.agent), [BRIDGE_AGENT_ID]);
  assert.throws(() => managedAgentEnvironment({}, BRIDGE_AGENT_ID, undefined, { guardedRead: true }),
    error => error.code === 'GUARD_REQUIRED');
});

test('guard cannot be initialized without a one-time managed startup proof', async () => {
  const previousMarker = process.env.DSH_OPENCODE_GUARD_MARKER;
  const previousNonce = process.env.DSH_OPENCODE_GUARD_NONCE;
  try {
    delete process.env.DSH_OPENCODE_GUARD_MARKER;
    delete process.env.DSH_OPENCODE_GUARD_NONCE;
    await assert.rejects(DshNativeToolGuard(), /authenticated managed startup/);
  } finally {
    if (previousMarker === undefined) delete process.env.DSH_OPENCODE_GUARD_MARKER;
    else process.env.DSH_OPENCODE_GUARD_MARKER = previousMarker;
    if (previousNonce === undefined) delete process.env.DSH_OPENCODE_GUARD_NONCE;
    else process.env.DSH_OPENCODE_GUARD_NONCE = previousNonce;
  }
});

test('registered guard writes a nonce proof and denies all native tool invocation', async () => {
  const marker = path.join(os.tmpdir(), 'dsh-guard-unit-' + randomBytes(12).toString('hex'));
  const nonce = randomBytes(32).toString('hex');
  const previousMarker = process.env.DSH_OPENCODE_GUARD_MARKER;
  const previousNonce = process.env.DSH_OPENCODE_GUARD_NONCE;
  try {
    process.env.DSH_OPENCODE_GUARD_MARKER = marker;
    process.env.DSH_OPENCODE_GUARD_NONCE = nonce;
    const hooks = await DshNativeToolGuard();
    assert.equal(typeof hooks['tool.execute.before'], 'function');
    await hooks.config();
    assert.equal(await readFile(marker, 'utf8'), nonce);
    for (const tool of ['read', 'shell', 'write', 'edit', 'task']) {
      await assert.rejects(hooks['tool.execute.before']({ tool }, { args: {} }),
        /DSH_OPENCODE_NATIVE_TOOL_BLOCKED/);
    }
  } finally {
    if (previousMarker === undefined) delete process.env.DSH_OPENCODE_GUARD_MARKER;
    else process.env.DSH_OPENCODE_GUARD_MARKER = previousMarker;
    if (previousNonce === undefined) delete process.env.DSH_OPENCODE_GUARD_NONCE;
    else process.env.DSH_OPENCODE_GUARD_NONCE = previousNonce;
    await rm(marker, { force: true });
  }
});
