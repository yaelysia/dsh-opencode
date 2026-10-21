import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { failure } from './errors.js';

// The official opencode-ai dependency and all its platform binaries are pinned.
export const PINNED_OPENCODE_VERSION = '1.19.3';

function variantsFor(platform, arch, libc) {
  const prefix = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[platform];
  if (!prefix || !['x64', 'arm64'].includes(arch)) {
    throw failure('Unsupported bundled OpenCode platform: ' + platform + '/' + arch,
      'SERVER_BUNDLED_CLI_UNSUPPORTED');
  }
  const base = 'opencode-' + prefix + '-' + arch;
  // Baseline is compatible with x64 hardware without AVX2 and needs no probe.
  const names = arch === 'x64' ? [base + '-baseline', base] : [base];
  return platform === 'linux' && libc === 'musl'
    ? names.map(name => name + '-musl') : names;
}

function systemLibc() {
  return process.report?.getReport?.().header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

/** Resolve the native executable directly through the official npm dependency.
 * Works even when pnpm disables the package's postinstall script. */
export function bundledExecutable({
  platform = process.platform, arch = process.arch,
  libc = systemLibc(), requireFrom = createRequire(import.meta.url),
} = {}) {
  let manifestPath;
  try { manifestPath = requireFrom.resolve('opencode-ai/package.json'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw failure('Pinned OpenCode CLI is missing. Reinstall dsh-opencode to install '
      + 'opencode-ai@' + PINNED_OPENCODE_VERSION, 'SERVER_BUNDLED_CLI_MISSING');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== PINNED_OPENCODE_VERSION) {
    throw failure('Unexpected OpenCode CLI version: ' + manifest.version
      + ', expected ' + PINNED_OPENCODE_VERSION, 'SERVER_BUNDLED_CLI_INVALID');
  }
  // pnpm places optional platform binaries beside opencode-ai, not this plugin.
  const fromPackage = createRequire(manifestPath);
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  for (const name of variantsFor(platform, arch, libc)) {
    let packagePath;
    try { packagePath = fromPackage.resolve(name + '/package.json'); }
    catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    const binaryManifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (binaryManifest.version !== PINNED_OPENCODE_VERSION) {
      throw failure('OpenCode platform package version mismatch: ' + name,
        'SERVER_BUNDLED_CLI_INVALID');
    }
    const executable = path.join(path.dirname(packagePath), 'bin', binaryName);
    if (existsSync(executable)) return executable;
  }
  throw failure('No supported OpenCode CLI binary found for ' + platform + '/' + arch
    + ' in opencode-ai@' + PINNED_OPENCODE_VERSION
    + '. Reinstall the plugin with optional dependencies enabled.',
    'SERVER_BUNDLED_CLI_MISSING');
}
