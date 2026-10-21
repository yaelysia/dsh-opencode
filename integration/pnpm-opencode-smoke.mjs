import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { bundledExecutable, PINNED_OPENCODE_VERSION } from '../src/opencode-binary.js';

test('pnpm installs the pinned official OpenCode binary with scripts disabled',
  { timeout: 300_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-opencode-pnpm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'dsh-opencode-pnpm-test', private: true,
    dependencies: { 'opencode-ai': PINNED_OPENCODE_VERSION },
  }));
  const win = process.platform === 'win32';
  const install = spawnSync(win ? 'pnpm.cmd' : 'pnpm',
    ['install', '--ignore-scripts', '--no-frozen-lockfile'], {
      cwd: root, encoding: 'utf8', shell: win, windowsHide: true, timeout: 240_000,
      env: { ...process.env, CI: 'true' },
    });
  assert.equal(install.status, 0,
    'pnpm install failed: ' + (install.error?.message || install.stderr || install.stdout));
  const requireFrom = createRequire(path.join(root, 'entry.cjs'));
  const executable = bundledExecutable({ requireFrom });
  assert.equal(path.basename(executable), win ? 'opencode.exe' : 'opencode');
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  }).trim();
  assert.equal(version, PINNED_OPENCODE_VERSION);
  console.info('PNPM_PINNED_OPENCODE ' + JSON.stringify({
    version, os: process.platform, directBinary: true,
  }));
});
