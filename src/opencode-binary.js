import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { failure } from './errors.js';

// Official prebuilt native packages are exact-version optional dependencies.
// Deliberately no opencode-ai wrapper: its postinstall may fail in DSH pnpm.
export const PINNED_OPENCODE_VERSION = '1.19.3';

function variantsFor(platform, arch, libc) {
  const prefix = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[platform];
  if (!prefix || !['x64', 'arm64'].includes(arch)) {
    throw failure('Unsupported bundled OpenCode platform: ' + platform + '/' + arch,
      'SERVER_BUNDLED_CLI_UNSUPPORTED');
  }
  const base = 'opencode-' + prefix + '-' + arch;
  const names = arch === 'x64' ? [base + '-baseline', base] : [base];
  return platform === 'linux' && libc === 'musl'
    ? names.map(name => name + '-musl') : names;
}

function systemLibc() {
  return process.report?.getReport?.().header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

/** Resolve the official, pinned, platform-specific binary directly.
 * No package postinstall, global PATH, runtime downloads or custom links. */
export function bundledExecutable({
  platform = process.platform, arch = process.arch,
  libc = systemLibc(), requireFrom = createRequire(import.meta.url),
} = {}) {
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  for (const name of variantsFor(platform, arch, libc)) {
    let packagePath;
    try { packagePath = requireFrom.resolve(name + '/package.json'); }
    catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (manifest.name !== name || manifest.version !== PINNED_OPENCODE_VERSION) {
      throw failure('OpenCode platform package mismatch: ' + name
        + ' (expected ' + PINNED_OPENCODE_VERSION + ')',
        'SERVER_BUNDLED_CLI_INVALID');
    }
    const executable = path.join(path.dirname(packagePath), 'bin', binaryName);
    if (existsSync(executable)) return executable;
  }
  throw failure('No supported official OpenCode CLI binary for ' + platform + '/' + arch
    + ' in pinned version ' + PINNED_OPENCODE_VERSION
    + '. Reinstall dsh-opencode with platform optional dependencies enabled.',
    'SERVER_BUNDLED_CLI_MISSING');
}
