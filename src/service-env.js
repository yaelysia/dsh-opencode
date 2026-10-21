import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Prepare only the OpenCode child environment; never mutate the host. */
export function childEnvironment(env, root, direct = false) {
  const result = { ...env };
  if (direct) {
    for (const key of Object.keys(result)) {
      if (/^(?:http|https|all)_proxy$/i.test(key)) delete result[key];
    }
  }
  const exclusions = Object.entries(result).filter(([key]) => /^no_proxy$/i.test(key)).map(([, value]) => value);
  for (const key of Object.keys(result)) if (/^no_proxy$/i.test(key)) delete result[key];
  const noProxy = [...new Set([...exclusions.join(',').split(','), 'localhost', '127.0.0.1', '::1']
    .map(s => s.trim()).filter(Boolean))].join(',');
  result.NO_PROXY = noProxy;
  result.no_proxy = noProxy;
  for (const kind of ['CACHE', 'DATA', 'CONFIG', 'STATE']) {
    const key = 'XDG_' + kind + '_HOME';
    if (!result[key]) result[key] = path.join(root, kind.toLowerCase());
  }
  return result;
}

/** Only an isolated child sees this OpenCode-specific Basic Auth configuration. */
export function secureServerEnvironment(env, { password, username, passwordEnv } = {}) {
  const secret = password ?? randomBytes(32).toString('hex');
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new TypeError('OpenCode child password must be a 32-byte random hex secret');
  }
  const result = { ...env };
  if (passwordEnv && passwordEnv !== 'OPENCODE_SERVER_PASSWORD') delete result[passwordEnv];
  result.OPENCODE_SERVER_PASSWORD = secret;
  result.OPENCODE_SERVER_USERNAME = username || env.OPENCODE_SERVER_USERNAME || 'opencode';
  return result;
}
