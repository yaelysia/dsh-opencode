import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeService } from '../src/service.js';

async function fixture(t, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-health-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  const script = path.join(root, 'service.mjs');
  await writeFile(script, [
    "import { createServer } from 'node:http';",
    "const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);",
    "if (cfg.plugin?.length) {",
    "  const imported = await import(cfg.plugin[0]);",
    "  const plugin = await imported.DshNativeToolGuard();",
    "  await plugin.config();",
    "}",
    "createServer((req,res) => {",
    "  res.setHeader('content-type','application/json');",
    "  res.end(JSON.stringify(req.url==='/agent'?[{name:'dsh-bridge'}]:",
    "    {healthy:true,version:'1.19.3'}));",
    "}).listen(Number(process.argv[2]),'127.0.0.1');",
  ].join('\n'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const warnings = [], events = [];
  const manager = new OpenCodeService({
    endpoint: 'http://127.0.0.1:' + port,
    runtimeRoot: root, opencodeExecutable: process.execPath,
    guardedReadCompatibility: true, healthIntervalMs: 600_000,
    ...config,
  }, { argsImpl: n => [script, String(n)],
    logger: { info() {}, warn(message) { warnings.push(message); } },
    onBeforeRestart() { events.push('invalidate'); },
  });
  t.after(async () => { await manager.dispose(); });
  await manager.ready({ requireManaged: true });
  return { manager, warnings, events };
}

test('false-positive local health probe does not restart a guarded child', async t => {
  const { manager, events } = await fixture(t);
  const child = manager.owned, probe = manager.health.bind(manager);
  let attempts = 0;
  manager.health = async () => ++attempts === 1 ? false : probe();
  manager.lastHealthAt = 0;
  await manager.ready({ requireManaged: true });
  assert.equal(attempts, 2);
  assert.equal(manager.owned, child);
  assert.equal(manager.generation, 1);
  assert.deepEqual(events, []);
});

test('two failed local HTTP probes invalidate sessions and restart only the owned child', async t => {
  const { manager, events } = await fixture(t);
  const first = manager.owned, proof = manager.guardProof.nonce;
  const realHealth = manager.health.bind(manager);
  let bad = 0;
  manager.health = async () => {
    if (manager.owned === first && manager.readyOwned) { bad++; return false; }
    return realHealth();
  };
  manager.lastHealthAt = 0;
  await Promise.all([manager.ready({ requireManaged: true }),
    manager.ready({ requireManaged: true }), manager.ready({ requireManaged: true })]);
  assert.equal(bad, 2, 'one serialized restart, not three competing ones');
  assert.deepEqual(events, ['invalidate']);
  assert.notEqual(manager.owned, first);
  assert.equal(manager.generation, 2);
  assert.equal(manager.readyOwned, true);
  assert.equal(manager.guardVerified, true);
  assert.notEqual(manager.guardProof.nonce, proof, 'guard registration is freshly verified');
});

test('a dead owned child invalidates sessions before starting its replacement', async t => {
  const { manager, events } = await fixture(t);
  const first = manager.owned;
  const exited = once(first, 'exit');
  first.kill();
  await exited;
  await manager.ready({ requireManaged: true });
  assert.equal(manager.generation, 2);
  assert.notEqual(manager.owned, first);
  assert.deepEqual(events, ['invalidate']);
  assert.equal(manager.guardVerified, true);
});

test('restart cooldown fails closed rather than repeatedly killing a failing process', async t => {
  const { manager, events } = await fixture(t);
  const first = manager.owned;
  manager.restartTimes = [Date.now() - 500, Date.now()];
  manager.health = async () => false;
  manager.lastHealthAt = 0;
  await assert.rejects(manager.ready({ requireManaged: true }),
    error => error.code === 'SERVER_RECOVERY_COOLDOWN');
  assert.equal(manager.owned, first);
  assert.deepEqual(events, []);
});

test('local transport failure requests a health probe, but a healthy server stays up', async t => {
  const { manager, events } = await fixture(t);
  const first = manager.owned;
  manager.reportLocalFailure();
  if (manager.starting) await manager.starting;
  assert.equal(manager.owned, first);
  assert.equal(manager.generation, 1);
  assert.deepEqual(events, []);
});

test('watchdog detects a live but unresponsive PID without a new model request', {
  timeout: 20000,
}, async t => {
  const { manager, events } = await fixture(t, { healthIntervalMs: 100 });
  const first = manager.owned;
  const original = manager.health.bind(manager);
  manager.health = async () => manager.owned === first && manager.readyOwned
    ? false : original();
  const until = Date.now() + 12000;
  while (manager.generation < 2 && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(manager.generation, 2, 'watchdog must recover without a new DSH stream');
  assert.deepEqual(events, ['invalidate']);
  assert.equal(manager.guardVerified, true);
});
