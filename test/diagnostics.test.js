import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Script } from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { DiagnosticHub, sessionKey } from '../src/diagnostics.js';
import { badgePage, logsPage } from '../src/diagnostics-pages.js';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('context badge and Sidebar scripts are syntactically valid without loading external code', () => {
  for (const page of [badgePage, logsPage]) {
    assert.match(page, /<html/);
    assert.match(page, /<script>/);
    const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Script(script));
    assert.doesNotMatch(page, /dsh_call|Bearer\s+[a-z]/i);
  }
});

test('diagnostics expose only bounded redacted metadata and prevent cross-origin API reads', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-diagnostics-'));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const hub = new DiagnosticHub({ root, port: await freePort(), maxEntries: 5,
    logger: { warn() {} } });
  t.after(() => hub.dispose());
  assert.equal(await hub.start(), true);
  const sessionId = 'secret-dsh-session';
  hub.record('tool', 'requested', {
    sessionId, tool: 'read', arguments: { secret: 'do not store' },
    rawPrompt: 'Please reveal secrets', token: 'secret', errorCode: 'NONE',
  });
  hub.record('context', 'usage.updated', { sessionId, model: 'deepseek-v4.1-flash-free',
    used: 14520, limit: 200000 });
  hub.context(sessionId, { used: 14520, limit: 200000, phase: 'ready', estimate: true });
  hub.record('service', 'process.ready', { generation: 3 });
  hub.sessionCount({ idle: 1, running: 2 });
  const origin = 'http://127.0.0.1:' + hub.port;
  const common = { 'X-DSH-Diagnostic': '1' };
  const snapshot = await fetch(origin + '/v1/snapshot?sid=' + encodeURIComponent(sessionId),
    { headers: common }).then(res => res.json());
  assert.equal(snapshot.context.used, 14520);
  assert.equal(snapshot.context.limit, 200000);
  assert.equal(snapshot.sessions.idle, 1);
  assert.equal(snapshot.service.status, 'healthy');
  assert.equal(snapshot.session, sessionKey(sessionId));
  const events = await fetch(origin + '/v1/events', { headers: common })
    .then(res => res.json());
  assert.equal(events.items.length, 3);
  assert.ok(events.items.some(e => e.session === sessionKey(sessionId)));
  const text = JSON.stringify(events);
  assert.doesNotMatch(text, /secret-dsh-session|do not store|Please reveal|Bearer/i);
  assert.equal((await fetch(origin + '/v1/events')).status, 403);
  assert.equal((await fetch(origin + '/v1/events', { headers: {
    ...common, Origin: 'https://attacker.example',
  } })).status, 403);
  assert.equal((await fetch(origin + '/v1/events', { headers: {
    ...common, Host: 'evil.example',
  } })).status, 403);
  assert.equal((await fetch(origin + '/v1/badge?sid=s')).status, 200);
  assert.equal((await fetch(origin + '/v1/page?sid=s')).status, 200);
  await hub.writeChain;
  const saved = await readFile(path.join(root, 'dsh-opencode-diagnostics.jsonl'), 'utf8');
  assert.doesNotMatch(saved, /secret-dsh-session|Please reveal|do not store/);
});

test('bounded event memory, context state and disk rotation do not depend on chat content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-diagnostics-rotate-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const hub = new DiagnosticHub({ root, port: await freePort(), maxEntries: 4,
    maxFileBytes: 420, logger: { warn() {} } });
  t.after(() => hub.dispose());
  await hub.start();
  for (let i = 0; i < 13; i++) hub.record('session', 'created', {
    sessionId: 's' + i, model: 'test-model', count: i,
  });
  await hub.writeChain;
  assert.equal(hub.events().length, 4);
  assert.ok((await readFile(path.join(root, 'dsh-opencode-diagnostics.jsonl'), 'utf8')).length > 0);
  assert.ok((await readFile(path.join(root, 'dsh-opencode-diagnostics.jsonl.1'), 'utf8')).length > 0);
  assert.equal(hub.snapshot('unknown').context.used, null);
  hub.context('s3', { used: 500, limit: 8000, phase: 'compacting' });
  assert.equal(hub.snapshot('s3').context.phase, 'compacting');
  hub.context('s3', { phase: 'ready' });
  assert.equal(hub.snapshot('s3').context.phase, 'ready');
});

test('diagnostic bind failure cannot break plugin startup or release another process port', async t => {
  const server = createServer((_req, res) => res.end('occupied'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const hub = new DiagnosticHub({ port: server.address().port, logger: { warn() {} } });
  t.after(() => hub.dispose());
  assert.equal(await hub.start(), false);
  assert.equal((await fetch('http://127.0.0.1:' + server.address().port)).status, 200);
});
