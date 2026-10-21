import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundledExecutable, PINNED_OPENCODE_VERSION } from '../src/opencode-binary.js';
import { installedExecutable } from '../src/service.js';

async function fixture(t, version = PINNED_OPENCODE_VERSION) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-cli-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, 'node_modules');
  const main = path.join(modules, 'opencode-ai');
  await mkdir(main, { recursive: true });
  await writeFile(path.join(main, 'package.json'), JSON.stringify({ name: 'opencode-ai', version }));
  return {
    requireFrom: createRequire(path.join(root, 'entry.cjs')),
    async install(name, pkgVersion = PINNED_OPENCODE_VERSION) {
      const root = path.join(modules, name);
      await mkdir(path.join(root, 'bin'), { recursive: true });
      await writeFile(path.join(root, 'package.json'),
        JSON.stringify({ name, version: pkgVersion }));
      const executable = path.join(root, 'bin',
        name.includes('windows') ? 'opencode.exe' : 'opencode');
      await writeFile(executable, 'stub');
      return executable;
    },
  };
}

test('pins official OpenCode as a normal dependency without plugin install scripts', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dependencies['opencode-ai'], PINNED_OPENCODE_VERSION);
  assert.equal(pkg.scripts.prepare, undefined);
  assert.equal(pkg.scripts.postinstall, undefined);
});

test('Windows selects the plugin-pinned baseline rather than global or Desktop CLI', async t => {
  const f = await fixture(t);
  await f.install('opencode-windows-x64');
  const expected = await f.install('opencode-windows-x64-baseline');
  const config = { platform: 'win32', arch: 'x64', requireFrom: f.requireFrom };
  assert.equal(bundledExecutable(config), expected);
  assert.equal(installedExecutable({}, { LOCALAPPDATA: 'C:/Users/LENOVO/AppData/Local' },
    'win32', config), expected);
});

test('resolves Linux glibc/musl and macOS arm64 without postinstall', async t => {
  const f = await fixture(t);
  const glibc = await f.install('opencode-linux-x64');
  const musl = await f.install('opencode-linux-x64-baseline-musl');
  const darwin = await f.install('opencode-darwin-arm64');
  assert.equal(bundledExecutable({
    platform: 'linux', arch: 'x64', libc: 'glibc', requireFrom: f.requireFrom,
  }), glibc);
  assert.equal(bundledExecutable({
    platform: 'linux', arch: 'x64', libc: 'musl', requireFrom: f.requireFrom,
  }), musl);
  assert.equal(bundledExecutable({
    platform: 'darwin', arch: 'arm64', requireFrom: f.requireFrom,
  }), darwin);
});

test('missing, unsupported or mismatched official binaries never silently fall back', async t => {
  const f = await fixture(t);
  assert.throws(() => bundledExecutable({
    platform: 'win32', arch: 'x64', requireFrom: f.requireFrom,
  }), error => error.code === 'SERVER_BUNDLED_CLI_MISSING');
  assert.throws(() => bundledExecutable({
    platform: 'freebsd', arch: 'x64', requireFrom: f.requireFrom,
  }), error => error.code === 'SERVER_BUNDLED_CLI_UNSUPPORTED');
  const invalid = await fixture(t, '2.1.2');
  await invalid.install('opencode-windows-x64');
  assert.throws(() => bundledExecutable({
    platform: 'win32', arch: 'x64', requireFrom: invalid.requireFrom,
  }), error => error.code === 'SERVER_BUNDLED_CLI_INVALID');
  const mismatch = await fixture(t);
  await mismatch.install('opencode-windows-x64', '2.1.2');
  assert.throws(() => bundledExecutable({
    platform: 'win32', arch: 'x64', requireFrom: mismatch.requireFrom,
  }), error => error.code === 'SERVER_BUNDLED_CLI_INVALID');
});

test('explicit executable path remains an opt-in override', () => {
  assert.equal(installedExecutable({ opencodeExecutable: './other-opencode.exe' }, {},
    'win32'), path.resolve('./other-opencode.exe'));
  assert.equal(installedExecutable({}, { OPENCODE_EXECUTABLE: './env-opencode.exe' },
    'win32'), path.resolve('./env-opencode.exe'));
});
