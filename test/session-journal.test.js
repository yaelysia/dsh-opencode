import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionJournal } from '../src/session-journal.js';
import { StructuredSessionRegistry } from '../src/structured-session.js';

test('owned session journal stores IDs only and removes confirmed reclaimed sessions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-journal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const removed = [];
  const journal = new SessionJournal({ directory: dir, removeSession: async id => removed.push(id) });
  await journal.track('ses_owned1');
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{64}\.json$/);
  const raw = await readFile(path.join(dir, files[0]), 'utf8');
  assert.match(raw, /ses_owned1/);
  assert.doesNotMatch(raw, /history|assistant|content|prompt/);
  assert.equal(await journal.retire('ses_other'), false);
  assert.equal(await journal.retire('ses_owned1'), true);
  await journal.drain();
  assert.deepEqual(removed, ['ses_owned1']);
  assert.deepEqual(await readdir(dir), []);
});

test('startup cleans only dead-owner journal entries and leaves live instances untouched', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const owner = new SessionJournal({ directory: dir, removeSession: async () => {} });
  await owner.track('ses_leftover');
  const filename = (await readdir(dir))[0];
  const file = path.join(dir, filename);
  const old = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...old, pid: 99999999 }));
  const keep = new SessionJournal({ directory: dir, isAlive: () => true,
    removeSession: async () => { throw Error('Must not delete an active owner'); } });
  await keep.init();
  assert.deepEqual(await readdir(dir), [filename]);
  const removed = [];
  const sweep = new SessionJournal({ directory: dir, isAlive: () => false,
    removeSession: async id => { removed.push(id); } });
  await sweep.init();
  assert.deepEqual(removed, ['ses_leftover']);
  assert.deepEqual(await readdir(dir), []);
});

test('failed DELETE keeps owned session journal for crash recovery', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-delete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new SessionJournal({ directory: dir, removeSession: async () => {
    throw Error('OpenCode service unavailable');
  }, logger: { warn() {} } });
  await journal.track('ses_retry');
  assert.equal(await journal.retire('ses_retry'), false);
  assert.equal((await readdir(dir)).length, 1);
});

test('idle cache expires and never retires reserved or waiting-tool sessions', () => {
  let now = 1000;
  const retired = [];
  const registry = new StructuredSessionRegistry({ now: () => now, idleTtlMs: 100,
    maxIdle: 1, onRetire: id => retired.push(id) });
  const one = [{ role: 'user', content: 'first' }];
  registry.active('s1', 'oc1');
  registry.complete('s1', 'oc1', one, '', 'response');
  const planned = registry.plan('s1', [...one, { role: 'user', content: 'next' }], '');
  assert.equal(planned.id, 'oc1');
  now += 1000;
  registry.sweep();
  assert.ok(registry.entries.has('s1'), 'reserved context cannot expire mid-compaction');
  registry.release('s1', 'oc1');
  registry.sweep();
  assert.deepEqual(retired, ['oc1']);
  registry.active('s2', 'oc2');
  registry.waiting('s2', 'oc2');
  registry.sweep();
  assert.equal(registry.entries.get('s2').state, 'waiting-tool');
});
