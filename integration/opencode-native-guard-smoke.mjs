import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeService } from '../src/service.js';

// Windows GitHub runners sometimes spend >45 s initializing the official
// OpenCode binary before its /agent route becomes responsive. Keep production
// readiness timeouts unchanged; only give this smoke test a cold-start budget.
const windows = process.platform === 'win32';
test('official OpenCode 1.19.3 registers the DSH guard before accepting model traffic', { timeout: windows ? 180000 : 90000 }, async () => {
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
    autoStartTimeoutMs: windows ? 120000 : 45000,
    autoStartDirect: true,
  }, { logger: { info() {}, warn() {} } });
  try {
    await manager.ready({ requireManaged: true });
    assert.equal(manager.readyOwned, true);
    assert.equal(manager.guardVerified, true);
    assert.equal(manager.owned.exitCode, null);
    // Verify the actual v1.19.3 read-only message history endpoint used
    // to reconcile provisional SSE events. No model inference is requested.
    const base = 'http://127.0.0.1:' + port;
    const headers = {
      authorization: 'Basic ' + Buffer.from('opencode:' + manager.ownedPassword).toString('base64'),
      'content-type': 'application/json',
    };
    const created = await fetch(base + '/session', {
      method: 'POST', headers, body: JSON.stringify({ title: 'DSH history smoke' }),
      signal: AbortSignal.timeout(12000),
    });
    assert.equal(created.status, 200, 'official OpenCode should create a test session');
    const { id } = await created.json();
    assert.equal(typeof id, 'string');
    const history = await fetch(base + '/session/' + encodeURIComponent(id) + '/message?limit=80', {
      headers, signal: AbortSignal.timeout(12000),
    });
    assert.equal(history.status, 200, 'native tool history endpoint must be readable');
    assert.deepEqual(await history.json(), []);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
