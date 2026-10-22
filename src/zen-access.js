import { existsSync } from 'node:fs';
import path from 'node:path';

/** Presence hints only. Never read, log, copy, or move the credentials.
 * Provider access and free-tier eligibility are exclusively determined by Zen. */
export function zenAuthSource(env, exists = existsSync) {
  if (typeof env.OPENCODE_API_KEY === 'string' && env.OPENCODE_API_KEY.trim()) return 'env-key';
  if (typeof env.OPENCODE_AUTH_CONTENT === 'string' && env.OPENCODE_AUTH_CONTENT.trim()) {
    return 'env-auth';
  }
  if (typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()) {
    try {
      if (exists(path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json'))) return 'local-file';
    } catch { return 'unknown'; }
  }
  return 'none';
}

export function zenEnvironmentHints(env, { direct = true } = {}) {
  return {
    authSource: zenAuthSource(env),
    proxyMode: direct ? 'proxy-vars-cleared' : 'proxy-vars-inherited',
  };
}
