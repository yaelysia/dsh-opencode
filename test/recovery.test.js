import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenCodeServeClient, createAdapter, DEFAULT_MODELS } from '../src/bridge.js';
import { providerFailure, redact } from '../src/errors.js';
import { diagnose, proxySummary } from '../scripts/doctor.mjs';
import { childEnvironment, ensurePortFree } from '../scripts/start.mjs';
import { secureServerEnvironment } from '../src/service-env.js';

const model = DEFAULT_MODELS[0];
const call = (extras = {}) => ({ model, sessionId: 'a', messages: [{ role: 'user', content: 'Hello' }], ...extras });
const ok = () => ({ info: { modelID: model }, parts: [{ type: 'text', text: '1' }] });
const networkError = () => ({ info: { error: { name: 'APIError', data: {
  statusCode: 403, message: "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.",
} } }, parts: [] });
function transport(reply = ok) {
  const calls = [];
  let sessions = 0;
  return { calls, fetch: async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined, init });
    if (url.endsWith('/session')) return Response.json({ id: 'sess-' + ++sessions });
    return Response.json(await reply(url, init));
  } };
}

for (const [status, text, expected] of [
  [403, 'detected abusive traffic from this IP address', 'NETWORK_BLOCKED'],
  [403, 'free tier can only be used from within OpenCode', 'CLIENT_RESTRICTED'],
  [403, 'This model is not available in your country.', 'REGION_RESTRICTED'],
  [403, 'access denied', 'FORBIDDEN'], [401, 'bad credentials', 'AUTH'],
  [429, 'Rate limit exceeded', 'RATE_LIMIT'], [426, 'upgrade', 'UPGRADE_REQUIRED'],
]) test('classifies ' + expected + ' without conflating different restrictions', () => {
  const error = providerFailure({ error: { message: text } }, status);
  assert.equal(error.code, expected);
  assert.equal(error.failure.status, status);
});

test('redacts credentials in provider error text', () => {
  const output = redact('Bearer abcDEF123 https://user:pass@example.com?api_key=secret');
  assert.doesNotMatch(output, /abcDEF123|user:pass|secret/);
});

test('session titles make no upstream request and report no invented usage', async () => {
  const adapter = createAdapter({}, () => { throw new Error('Must not call cloud'); });
  const prepared = await adapter.prepareCall('opencode-serve', model);
  const chunks = [];
  for await (const chunk of prepared.stream(call({ purpose: 'session-title' }))) chunks.push(chunk);
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'Hello');
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks.some(c => c.type === 'usage'), false);
});

test('concurrent ordinary turns are serialized and share exactly one session', async () => {
  const tx = transport(async () => { await sleep(5); return ok(); });
  const client = new OpenCodeServeClient({}, tx.fetch);
  await Promise.all([client.complete(call()), client.complete(call({ messages: [
    ...call().messages, { role: 'assistant', content: '1' }, { role: 'user', content: 'Next' },
  ] }))]);
  assert.equal(tx.calls.filter(c => c.url.endsWith('/session')).length, 1);
  assert.equal(tx.calls.at(-1).body.parts[0].text, 'Next');
});

test('first IP rejection prevents queued requests from hitting the gateway again', async () => {
  const tx = transport(networkError);
  const client = new OpenCodeServeClient({}, tx.fetch);
  const results = await Promise.allSettled([client.complete(call()), client.complete(call({ sessionId: 'b' }))]);
  assert.deepEqual(results.map(r => r.reason.code), ['NETWORK_BLOCKED', 'NETWORK_BLOCKED']);
  assert.equal(tx.calls.filter(c => c.url.endsWith('/message')).length, 1);
});

test('failed model request invalidates its local session mapping', async () => {
  let n = 0;
  const tx = transport(() => ++n === 1
    ? { info: { error: { name: 'APIError', data: { statusCode: 503, message: 'unavailable' } } }, parts: [] } : ok());
  const client = new OpenCodeServeClient({}, tx.fetch);
  await assert.rejects(client.complete(call()));
  await client.complete(call());
  assert.equal(tx.calls.filter(c => c.url.endsWith('/session')).length, 2);
});

test('compaction and main requests use different sessions', async () => {
  const tx = transport();
  const client = new OpenCodeServeClient({}, tx.fetch);
  await client.complete(call());
  await client.complete(call({ purpose: 'compaction' }));
  assert.equal(tx.calls.filter(c => c.url.endsWith('/session')).length, 2);
});

test('edited history and model switches do not reuse stale contexts', async () => {
  const tx = transport((url, init) => ({ ...ok(), info: { modelID: JSON.parse(init.body).model.modelID } }));
  const client = new OpenCodeServeClient({}, tx.fetch);
  await client.complete(call());
  await client.complete(call({ messages: [{ role: 'user', content: 'Edited' }, { role: 'user', content: 'New' }] }));
  await client.complete(call({ model: DEFAULT_MODELS[1] }));
  assert.equal(tx.calls.filter(c => c.url.endsWith('/session')).length, 3);
});

test('system instructions use the documented system slot', async () => {
  const tx = transport();
  const client = new OpenCodeServeClient({}, tx.fetch);
  await client.complete(call({ system: 'Top', messages: [{ role: 'system', content: 'Rules' }, ...call().messages] }));
  assert.equal(tx.calls.at(-1).body.system, 'Top\n\nRules');
  assert.equal(tx.calls.at(-1).body.parts[0].text, 'Hello');
});

test('rejects unexpected model identity instead of hiding fallback', async () => {
  const tx = transport(() => ({ ...ok(), info: { modelID: 'different-free' } }));
  await assert.rejects(new OpenCodeServeClient({}, tx.fetch).complete(call()), e => e.code === 'MODEL_MISMATCH');
});

test('pre-aborted requests create no session', async () => {
  const tx = transport();
  await assert.rejects(new OpenCodeServeClient({}, tx.fetch).complete(call({ signal: AbortSignal.abort() })), e => e.code === 'ABORTED');
  assert.equal(tx.calls.length, 0);
});

test('timeout aborts only the session this request owns', async () => {
  const paths = [];
  const client = new OpenCodeServeClient({ timeoutMs: 15 }, async (url, init) => {
    paths.push(new URL(url).pathname);
    if (url.endsWith('/session')) return Response.json({ id: 'owned' });
    if (url.endsWith('/abort')) return Response.json(true);
    await sleep(50, undefined, { signal: init.signal });
    return Response.json(ok());
  });
  await assert.rejects(client.complete(call()), e => e.code === 'TIMEOUT');
  assert.deepEqual(paths, ['/session', '/session/owned/message', '/session/owned/abort']);
});

test('child direct mode does not mutate parent environment or unrelated settings', () => {
  const original = { HTTPS_PROXY: 'http://user:secret@proxy:8080', http_proxy: 'http://proxy', ALL_PROXY: 'socks5://proxy', NO_PROXY: 'corp.local', XDG_DATA_HOME: '/existing', KEEP: 'yes' };
  const result = childEnvironment(original, '/runtime', true);
  assert.equal(original.HTTPS_PROXY, 'http://user:secret@proxy:8080');
  assert.deepEqual(proxySummary(result), { HTTP_PROXY: false, HTTPS_PROXY: false, ALL_PROXY: false });
  assert.equal(result.XDG_DATA_HOME, '/existing');
  assert.equal(result.KEEP, 'yes');
  assert.match(result.NO_PROXY, /corp.local/);
  assert.match(result.NO_PROXY, /127\.0\.0\.1/);
  assert.equal(result.no_proxy, result.NO_PROXY);
});

test('normal launcher preserves selected proxy rather than silently changing routes', () => {
  const result = childEnvironment({ HTTPS_PROXY: 'http://proxy' }, '/runtime');
  assert.equal(result.HTTPS_PROXY, 'http://proxy');
});

function serverFixture(block = false, missing = false) {
  let probes = 0;
  const server = createServer(async (req, res) => {
    for await (const ignored of req) { /* consume request */ }
    const send = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
    if (req.url === '/global/health') return send({ healthy: true, version: 'test-only' });
    if (req.url === '/provider') return send({ all: [{ id: 'opencode', secret: 'must-not-appear', models: missing ? {} : Object.fromEntries(DEFAULT_MODELS.map(id => [id, { id }])) }] });
    if (req.url === '/agent') return send([{ name: 'dsh-bridge' }]);
    if (req.url === '/session') return send({ id: 'fixture' });
    if (req.url === '/session/fixture/message') { probes++; return send(block ? networkError() : ok()); }
    res.statusCode = 404; send({ error: { message: 'not found' } });
  });
  return { server, probes: () => probes };
}

for (const variant of ['read-only', 'success', 'network-block', 'missing-model']) {
  test('real localhost HTTP diagnostic: ' + variant, async () => {
    const fixture = serverFixture(variant === 'network-block', variant === 'missing-model');
    fixture.server.listen(0, '127.0.0.1');
    await once(fixture.server, 'listening');
    try {
      const endpoint = 'http://127.0.0.1:' + fixture.server.address().port;
      const report = await diagnose({ endpoint, probe: variant !== 'read-only' });
      assert.doesNotMatch(JSON.stringify(report), /must-not-appear/);
      assert.equal(fixture.probes(), ['success', 'network-block'].includes(variant) ? 1 : 0);
      assert.equal(report.ok, ['read-only', 'success'].includes(variant));
      if (variant === 'network-block') assert.equal(report.error.code, 'NETWORK_BLOCKED');
      if (variant === 'missing-model') assert.equal(report.error.code, 'MODEL_NOT_FOUND');
      if (variant === 'success') assert.equal(report.probe.reportedModel, model);
      await assert.rejects(ensurePortFree(fixture.server.address().port), /No process was killed/);
    } finally { await new Promise(resolve => fixture.server.close(resolve)); }
  });
}

test('cooldown expiry allows one explicitly requested recovery attempt', async () => {
  let n = 0;
  const tx = transport(() => ++n === 1 ? networkError() : ok());
  const client = new OpenCodeServeClient({}, tx.fetch);
  await assert.rejects(client.complete(call()));
  client.blocked.until = 0;
  const result = await client.complete(call());
  assert.equal(result.parts[0].text, '1');
  assert.equal(client.blocked, null);
  assert.equal(n, 2);
});

test('catalog fallback supports /config/providers only after a real 404', async () => {
  const paths = [];
  const report = await diagnose({ probe: false }, async (url, init) => {
    paths.push(new URL(url).pathname);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    if (url.endsWith('/global/health')) return Response.json({ healthy: true, version: 'test' });
    if (url.endsWith('/config/providers')) return Response.json({ providers: [{ id: 'opencode', models: { [model]: { id: model } } }] });
    if (url.endsWith('/provider')) return Response.json({ error: { message: 'not found' } }, { status: 404 });
    return Response.json([{ name: 'dsh-bridge' }]);
  });
  assert.equal(report.ok, true);
  assert.deepEqual(paths, ['/global/health', '/provider', '/config/providers', '/agent']);
});

test('doctor never falls back or probes after local auth failure', async () => {
  let requests = 0;
  const report = await diagnose({ probe: true }, async () => {
    requests++;
    return Response.json({ error: { message: 'Unauthorized' } }, { status: 401 });
  });
  assert.equal(report.error.code, 'AUTH');
  assert.equal(report.probe.attempted, false);
  assert.equal(requests, 1);
});

test('Basic auth uses configured secret but never echoes it in diagnostics', async () => {
  process.env.DSH_OC_TEST_SECRET = 'unit-test-password';
  try {
    const tx = transport();
    const client = new OpenCodeServeClient({ passwordEnv: 'DSH_OC_TEST_SECRET', username: 'tester' }, tx.fetch);
    await client.complete(call());
    assert.equal(tx.calls[0].init.headers.authorization, 'Basic ' + Buffer.from('tester:unit-test-password').toString('base64'));
    const error = providerFailure({ error: { message: tx.calls[0].init.headers.authorization } }, 401);
    assert.doesNotMatch(error.message, /dGVzdGVy/);
  } finally { delete process.env.DSH_OC_TEST_SECRET; }
});

test('a queued cancellation settles before the preceding request completes', { timeout: 1000 }, async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const tx = transport(async () => { await waiting; return ok(); });
  const client = new OpenCodeServeClient({}, tx.fetch);
  const first = client.complete(call());
  await sleep(0);
  const controller = new AbortController();
  const second = client.complete(call({ sessionId: 'b', signal: controller.signal }));
  controller.abort();
  try {
    await assert.rejects(second, e => e.code === 'ABORTED');
    assert.equal(tx.calls.length, 2);
  } finally { release(); await first; }
});

test('local diagnostics always launch with fresh canonical OpenCode credentials', () => {
  const inherited = { OPENCODE_SERVER_PASSWORD: 'stale-secret',
    OPENCODE_SERVER_USERNAME: 'inherited-user', CUSTOM_DSH_PASSWORD: 'another-secret' };
  const child = secureServerEnvironment(inherited, {
    password: 'a'.repeat(64), username: 'bridge-user', passwordEnv: 'CUSTOM_DSH_PASSWORD',
  });
  assert.equal(child.OPENCODE_SERVER_PASSWORD, 'a'.repeat(64));
  assert.equal(child.OPENCODE_SERVER_USERNAME, 'bridge-user');
  assert.equal(child.CUSTOM_DSH_PASSWORD, undefined);
  assert.equal(inherited.OPENCODE_SERVER_PASSWORD, 'stale-secret');
  assert.match(secureServerEnvironment(inherited).OPENCODE_SERVER_PASSWORD, /^[a-f0-9]{64}$/);
  assert.throws(() => secureServerEnvironment(inherited, { password: 'weak' }), /32-byte random/);
});

test('doctor can authenticate against independently launched managed diagnostics', async () => {
  const secret = 'f'.repeat(64);
  const report = await diagnose({
    passwordProvider: () => secret, username: 'diag-user', probe: false,
  }, async (url, init) => {
    assert.equal(init.headers.authorization,
      'Basic ' + Buffer.from('diag-user:' + secret).toString('base64'));
    if (url.endsWith('/global/health')) return Response.json({ healthy: true, version: 'test' });
    if (url.endsWith('/provider')) return Response.json({
      all: [{ id: 'opencode', models: { [model]: { id: model } } }],
    });
    return Response.json([{ name: 'dsh-bridge' }]);
  });
  assert.equal(report.ok, true);
});
