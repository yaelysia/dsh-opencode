import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { bundledExecutable, PINNED_OPENCODE_VERSION } from '../src/opencode-binary.js';

test('pinned official native CLI launches directly without wrapper postinstall', () => {
  const executable = bundledExecutable();
  assert.equal(path.basename(executable),
    process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  assert.ok(executable.includes('opencode-'), 'do not spawn npm launcher');
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  }).trim();
  assert.equal(version, PINNED_OPENCODE_VERSION);
  console.info('PINNED_OPENCODE_BINARY ' + JSON.stringify({
    version, platform: process.platform, arch: process.arch,
  }));
});
