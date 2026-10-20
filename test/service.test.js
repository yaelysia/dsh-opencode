import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { OpenCodeService, installedExecutable, localEndpoint } from '../src/service.js';
import { childEnvironment } from '../src/service-env.js';

async function externalServer(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { port, url: 'http://127.0.0.1:' + port,
    close: () => new Promise(resolve => server.close(resolve)) };
}

const healthy = (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/agent'
    ? [{ name: 'dsh-bridge' }, { name: 'plan' }]
    : { healthy: true, version: '1.19.3' }));
};

test('only loopback HTTP root is eligible for auto-management', () => {
  assert.equal(localEndpoint('http://127.0.0.1:4096').port, 4096);
  for (const url of ['http://192.168.1.1:4096', 'https://127.0.0.1:4096',
    'http://127.0.0.1:4096/custom', 'http://example.org:4096',
    'http://127.0.0.1:4096?token=123', 'http://localhost:4096']) {
    assert.equal(localEndpoint(url), null, url);
  }
});

test('changes only the child environment, and keeps existing XDG settings', () => {
  const original = { HTTP_PROXY: 'http://proxy', https_proxy: 'https://proxy',
    ALL_PROXY: 'socks5://proxy', NO_PROXY: 'some.host', XDG_CACHE_HOME: 'keep' };
  const env = childEnvironment(original, '/myroot', true);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(original.HTTP_PROXY, 'http://proxy');
  assert.equal(env.XDG_CACHE_HOME, 'keep');
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.ok(childEnvironment(original, '/myroot', false).HTTP_PROXY);
});

test('locates the standalone exe without using the broken npm shim', () => {
  assert.match(installedExecutable({}, { LOCALAPPDATA: 'C:\\Users\\Administrator\\AppData\\Local' }, 'win32'),
    /opencode\.exe$/);
});

test('reuses healthy external server and does not stop it', async () => {
  const external = await externalServer(healthy);
  try {
    const manager = new OpenCodeService({ endpoint: external.url },
      { spawnImpl: () => { throw Error('should not spawn'); }, logger: { info() {} } });
    await manager.ready();
    assert.equal(manager.owned, null);
    await manager.dispose();
    assert.equal((await fetch(external.url + '/global/health')).ok, true);
  } finally { await external.close(); }
});

test('occupied unhealthy port fails without killing other processes', async () => {
  const external = await externalServer((_req, res) => res.end('not OpenCode'));
  try {
    const manager = new OpenCodeService({ endpoint: external.url },
      { spawnImpl: () => { throw Error('should not spawn'); }, logger: { info() {} } });
    await assert.rejects(manager.ready(), error => error.code === 'SERVER_PORT_BUSY');
    await manager.dispose();
    assert.equal((await fetch(external.url)).status, 200);
  } finally { await external.close(); }
});

test('automatically starts real local child and stops only the owned process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-opencode-'));
  const fixture = path.join(root, 'fake-service.mjs');
  await writeFile(fixture, [
    "import { createServer } from 'node:http';",
    "createServer((req,res) => {",
    "const expected = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');",
    "if (req.headers.authorization !== expected) { res.statusCode = 401; res.end('unauthorized'); return; }",
    "res.setHeader('content-type','application/json');",
    "res.end(JSON.stringify(req.url==='/agent'?[{name:'dsh-bridge'}]:{healthy:true,version:'test'})); })",
    "  .listen(Number(process.argv[2]), '127.0.0.1');",
  ].join('\n'));
  const reservation = await externalServer(healthy);
  const port = reservation.port;
  await reservation.close();
  let manager;
  try {
    manager = new OpenCodeService({
      endpoint: 'http://127.0.0.1:' + port, runtimeRoot: root,
      opencodeExecutable: process.execPath, autoStartDirect: true,
      username: 'bridge-user', passwordEnv: 'CUSTOM_DSH_PASSWORD',
    }, { argsImpl: port => [fixture, String(port)], logger: { info() {} } });
    await Promise.all([manager.ready(), manager.ready(), manager.ready()]);
    assert.equal(manager.readyOwned, true);
    assert.match(manager.ownedPassword, /^[0-9a-f]{64}$/);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/global/health')).status, 401);
    const token = Buffer.from('bridge-user:' + manager.ownedPassword).toString('base64');
    assert.equal((await fetch('http://127.0.0.1:' + port + '/global/health',
      { headers: { authorization: 'Basic ' + token } })).ok, true);
    await manager.dispose();
    let stopped = false;
    for (let i = 0; i < 30; i++) {
      try { await fetch('http://127.0.0.1:' + port + '/global/health',
        { signal: AbortSignal.timeout(250) }); }
      catch { stopped = true; break; }
      await sleep(100);
    }
    assert.equal(stopped, true, 'auto-started child must stop on unload');
    await assert.rejects(manager.ready(), error => error.code === 'SERVER_STOPPED');
  } finally {
    await manager?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('missing binary reports exact installation failure', async () => {
  const reservation = await externalServer(healthy);
  const port = reservation.port;
  await reservation.close();
  const manager = new OpenCodeService({
    endpoint: 'http://127.0.0.1:' + port,
    opencodeExecutable: path.join(os.tmpdir(), 'missing-opencode-exe-01742'),
  });
  try { await assert.rejects(manager.ready(), error => error.code === 'SERVER_NOT_INSTALLED'); }
  finally { await manager.dispose(); }
});

test('autoStart=false preserves manual service mode', async () => {
  const manager = new OpenCodeService({ autoStart: false },
    { spawnImpl: () => { throw Error('unexpected spawn'); } });
  await manager.ready();
  await manager.dispose();
});


test('healthy external server without DSH agent fails instead of using Plan mode', async () => {
  const external = await externalServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/agent'
      ? [{ name: 'plan' }, { name: 'build' }]
      : { healthy: true, version: '1.19.3' }));
  });
  try {
    const manager = new OpenCodeService({ endpoint: external.url },
      { spawnImpl: () => { throw Error('must not spawn over existing service'); }, logger: { info() {} } });
    await assert.rejects(manager.ready(), error => error.code === 'SERVER_AGENT_MISSING');
    await manager.dispose();
    assert.equal((await fetch(external.url + '/global/health')).ok, true);
  } finally { await external.close(); }
});


test('tool-authorized requests refuse to reuse an unmanaged OpenCode service', async () => {
  const external = await externalServer(healthy);
  try {
    const manager = new OpenCodeService({ endpoint: external.url },
      { spawnImpl: () => { throw Error('must not spawn'); }, logger: { info() {} } });
    await assert.rejects(manager.ready({ requireManaged: true }),
      error => error.code === 'UNTRUSTED_OPENCODE_SERVER');
    assert.equal(manager.owned, null);
    await manager.dispose();
    assert.equal((await fetch(external.url + '/global/health')).ok, true);
  } finally { await external.close(); }
});

test('owned OpenCode service is accepted for DSH tool-authorized requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-tool-server-'));
  const fixture = path.join(root, 'fixture.mjs');
  await writeFile(fixture, [
    "import { createServer } from 'node:http';",
    "createServer((req,res) => { res.setHeader('content-type','application/json');",
    "res.end(JSON.stringify(req.url==='/agent'?[{name:'dsh-bridge'}]:{healthy:true,version:'test'})); })",
    "  .listen(Number(process.argv[2]), '127.0.0.1');",
  ].join('\n'));
  const reservation = await externalServer(healthy);
  const port = reservation.port;
  await reservation.close();
  const manager = new OpenCodeService({
    endpoint: 'http://127.0.0.1:' + port,
    runtimeRoot: root, opencodeExecutable: process.execPath,
  }, { argsImpl: port => [fixture, String(port)], logger: { info() {} } });
  try {
    await manager.ready({ requireManaged: true });
    assert.equal(manager.readyOwned, true);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('managed service rejects native agents before launch', () => {
  for (const agent of ['plan', 'build', 'custom-agent']) {
    assert.throws(() => new OpenCodeService({ agent, autoStart: false }),
      error => error.code === 'BRIDGE_AGENT_REQUIRED');
  }
});

test('owned Basic Auth credentials never reuse inherited host credentials', () => {
  const manager = new OpenCodeService({ autoStart: false }, {
    env: { OPENCODE_SERVER_PASSWORD: 'host-secret' },
  });
  try {
    assert.match(manager.ownedPassword, /^[0-9a-f]{64}$/);
    assert.notEqual(manager.ownedPassword, 'host-secret');
    assert.equal(manager.passwordForClient(), 'host-secret');
  } finally {
    void manager.dispose();
  }
});

test('guarded read refuses to run in an unmanaged OpenCode service', () => {
  for (const config of [
    { autoStart: false, guardedReadCompatibility: true },
    { endpoint: 'http://192.168.1.1:4096', guardedReadCompatibility: true },
  ]) {
    assert.throws(() => new OpenCodeService(config),
      error => error.code === 'GUARD_REQUIRES_MANAGED_SERVER');
  }
});

async function guardedFixture(root) {
  const target = path.join(root, 'guard-server.mjs');
  await writeFile(target, [
    "import { createServer } from 'node:http';",
    "if (process.argv[3] !== 'skip') {",
    "  const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);",
    "  const plugin = await import(cfg.plugin[0]);",
    "  const hooks = await plugin.DshNativeToolGuard();",
    "  await hooks.config();",
    "  try { await hooks['tool.execute.before']({ tool: 'read' }, { args: {} });",
    "    throw Error('native read unexpectedly allowed');",
    "  } catch (error) { if (!String(error.message).includes('DSH_OPENCODE_NATIVE_TOOL_BLOCKED')) throw error; }",
    "}",
    "createServer((req,res) => { res.setHeader('content-type','application/json');",
    "  res.end(JSON.stringify(req.url==='/agent'?[{name:'dsh-bridge'}]:{healthy:true,version:'test'})); })",
    "  .listen(Number(process.argv[2]), '127.0.0.1');",
  ].join('\n'));
  return target;
}

test('guarded-read managed service accepts only a loaded guard proof', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-guarded-read-'));
  const script = await guardedFixture(root);
  const reservation = await externalServer(healthy);
  const port = reservation.port;
  await reservation.close();
  const manager = new OpenCodeService({
    guardedReadCompatibility: true,
    endpoint: 'http://127.0.0.1:' + port,
    opencodeExecutable: process.execPath,
    runtimeRoot: root,
  }, { argsImpl: n => [script, String(n)], logger: { info() {} } });
  let marker;
  try {
    await manager.ready({ requireManaged: true });
    assert.equal(manager.readyOwned, true);
    assert.equal(manager.guardVerified, true);
    marker = manager.guardProof.marker;
    const nonce = await import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8'));
    assert.equal(nonce, manager.guardProof.nonce);
  } finally {
    await manager.dispose();
    if (marker) await assert.rejects(
      import('node:fs/promises').then(fs => fs.readFile(marker)), error => error.code === 'ENOENT');
    await rm(root, { recursive: true, force: true });
  }
});

test('guarded-read service fails closed if OpenCode omits the native-tool hook', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-no-guard-'));
  const script = await guardedFixture(root);
  const reservation = await externalServer(healthy);
  const port = reservation.port;
  await reservation.close();
  const manager = new OpenCodeService({
    guardedReadCompatibility: true,
    endpoint: 'http://127.0.0.1:' + port,
    opencodeExecutable: process.execPath,
    runtimeRoot: root,
    autoStartTimeoutMs: 900,
  }, { argsImpl: n => [script, String(n), 'skip'], logger: { info() {} } });
  try {
    await assert.rejects(manager.ready({ requireManaged: true }),
      error => error.code === 'SERVER_GUARD_NOT_READY');
    assert.equal(manager.readyOwned, false);
    assert.equal(manager.owned, null);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('transient agent lookup transport failure is retried before guard startup completes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-guard-retry-'));
  const script = await guardedFixture(root);
  const reservation = await externalServer(healthy);
  const port = reservation.port;
  await reservation.close();
  let lookups = 0;
  const manager = new OpenCodeService({
    guardedReadCompatibility: true,
    endpoint: 'http://127.0.0.1:' + port,
    opencodeExecutable: process.execPath,
    runtimeRoot: root,
    autoStartTimeoutMs: 10000,
  }, {
    argsImpl: n => [script, String(n)],
    logger: { info() {} },
    fetchImpl: (url, init) => {
      if (url.endsWith('/agent') && ++lookups === 1) {
        throw new Error('temporary agent startup timeout');
      }
      return fetch(url, init);
    },
  });
  try {
    await manager.ready({ requireManaged: true });
    assert.equal(manager.guardVerified, true);
    assert.ok(lookups >= 2);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('audit proof verifies only matching native invocation IDs, tools, sessions, and nonce', async () => {
  const manager = new OpenCodeService({ guardedReadCompatibility: true }, {
    readFileImpl: async () => [
      JSON.stringify({ nonce: 'a'.repeat(64), sessionID: 's1',
        callID: 'native-7', tool: 'edit' }),
      JSON.stringify({ nonce: 'other', sessionID: 's2',
        callID: 'native-8', tool: 'read' }),
    ].join('\n'),
  });
  manager.guardVerified = true;
  manager.guardProof = { nonce: 'a'.repeat(64), marker: 'unused', audit: 'audit' };
  const parts = [
    { id: 'p1', type: 'tool', sessionID: 's1', callID: 'native-7', tool: 'edit',
      state: { status: 'error', input: {} } },
    { id: 'p2', type: 'tool', sessionID: 's2', callID: 'native-8', tool: 'read',
      state: { status: 'error', input: {} } },
  ];
  try {
    const verified = await manager.verifiedNativeDenials(parts);
    assert.deepEqual([...verified], ['p1']);
  } finally {
    manager.guardProof = null;
    await manager.dispose();
  }
});
