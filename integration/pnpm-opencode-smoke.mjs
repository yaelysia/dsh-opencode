import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { bundledExecutable, PINNED_OPENCODE_VERSION } from '../src/opencode-binary.js';

test('pnpm installs the packed plugin and its pinned CLI without lifecycle scripts',
  { timeout: 300_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-opencode-pnpm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
  const win = process.platform === 'win32';
  const npm = spawnSync(win ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: pluginRoot, encoding: 'utf8', shell: win,
      windowsHide: true, timeout: 60_000,
    });
  assert.equal(npm.status, 0, 'npm pack failed: ' + (npm.error?.message || npm.stderr));
  const tarball = path.join(root, JSON.parse(npm.stdout)[0].filename);
  const consumer = path.join(root, 'consumer');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'dsh-opencode-pnpm-test', private: true,
    dependencies: { 'dsh-opencode': 'file:' + tarball.split(path.sep).join('/') },
  }));
  const install = spawnSync(win ? 'pnpm.cmd' : 'pnpm',
    ['install', '--ignore-scripts', '--no-frozen-lockfile', '--config.auto-install-peers=false'], {
      cwd: consumer, encoding: 'utf8', shell: win, windowsHide: true, timeout: 240_000,
      env: { ...process.env, CI: 'true' },
    });
  assert.equal(install.status, 0,
    'pnpm install failed: ' + (install.error?.message || install.stderr || install.stdout));
  const fromConsumer = createRequire(path.join(consumer, 'entry.cjs'));
  const pluginEntry = fromConsumer.resolve('dsh-opencode');
  const requireFromPlugin = createRequire(pluginEntry);
  const executable = bundledExecutable({ requireFrom: requireFromPlugin });
  assert.equal(path.basename(executable), win ? 'opencode.exe' : 'opencode');
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  }).trim();
  assert.equal(version, PINNED_OPENCODE_VERSION);
  console.info('PNPM_PINNED_OPENCODE ' + JSON.stringify({
    version, os: process.platform, directBinary: true, nestedDependency: true,
  }));
});
