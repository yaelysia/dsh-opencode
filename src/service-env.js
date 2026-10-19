import path from 'node:path';

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
