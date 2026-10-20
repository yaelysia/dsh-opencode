import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeService } from '../src/service.js';

test('official OpenCode 1.19.3 registers the DSH guard before accepting model traffic', { timeout: 90000 }, async () => {
  const executable = process.env.OPENCODE_TEST_EXE;
  assert.ok(executable, 'OPENCODE_TEST_EXE is required');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-native-guard-'));
  const manager = new OpenCodeService({
    endpoint: 'http://127.0.0.1:' + port,
    opencodeExecutable: path.resolve(executable),
    runtimeRoot: root,
    guardedReadCompatibility: true,
    autoStartTimeoutMs: 45000,
    autoStartDirect: true,
  }, { logger: { info() {}, warn() {} } });
  try {
    await manager.ready({ requireManaged: true });
    assert.equal(manager.readyOwned, true);
    assert.equal(manager.guardVerified, true);
    assert.equal(manager.owned.exitCode, null);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
