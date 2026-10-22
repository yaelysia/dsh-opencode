import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { bundledExecutable, PINNED_OPENCODE_VERSION } from '../src/opencode-binary.js';

/** Match the DSH Desktop installation mechanism (pnpm add git+https://...).
 * Pin the PR's actual pushed head SHA so the Git smoke is reproducible. */
test('DSH-style pnpm add from Git works with default lifecycle scripts', {
  timeout: 300_000,
}, async t => {
  const ref = process.env.DSH_TEST_GIT_REF;
  if (!/^[a-f0-9]{40}$/.test(ref ?? '')) {
    t.skip('DSH_TEST_GIT_REF must be a pushed 40-character commit SHA');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-opencode-git-pnpm-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'dsh-git-install-test', version: '1.0.0', private: true,
  }));
  const win = process.platform === 'win32';
  const gitSpec = 'git+https://github.com/yaelysia/dsh-opencode.git#' + ref;
  const install = spawnSync(win ? 'pnpm.cmd' : 'pnpm',
    ['add', gitSpec, '--config.auto-install-peers=false'], {
      cwd: root, encoding: 'utf8', shell: win, windowsHide: true, timeout: 240_000,
      env: { ...process.env, CI: 'true' },
    });
  assert.equal(install.status, 0, 'DSH-style Git pnpm add failed: '
    + (install.error?.message || install.stderr || install.stdout));
  const consumer = createRequire(path.join(root, 'entry.cjs'));
  const fromPlugin = createRequire(consumer.resolve('dsh-opencode'));
  assert.throws(() => fromPlugin.resolve('opencode-ai/package.json'),
    error => error.code === 'MODULE_NOT_FOUND', 'the wrapper postinstall must not be installed');
  const executable = bundledExecutable({ requireFrom: fromPlugin });
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  }).trim();
  assert.equal(version, PINNED_OPENCODE_VERSION);
  console.info('PNPM_GIT_OPENCODE ' + JSON.stringify({
    sha: ref, os: process.platform, version, wrapperPostinstall: false,
  }));
});
