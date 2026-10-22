import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { zenAuthSource, zenEnvironmentHints } from '../src/zen-access.js';

test('bundled CLI auth readiness reports only presence, never credential values', () => {
  const root = path.resolve('fixture-root');
  const location = path.join(root, 'opencode', 'auth.json');
  const accesses = [];
  const exists = filename => { accesses.push(filename); return filename === location; };
  assert.equal(zenAuthSource({ XDG_DATA_HOME: root }, exists), 'local-file');
  assert.deepEqual(accesses, [location]);
  assert.equal(zenAuthSource({ XDG_DATA_HOME: root }, () => false), 'none');
  assert.equal(zenAuthSource({ XDG_DATA_HOME: root }, () => { throw Error('denied'); }), 'unknown');
  assert.equal(zenAuthSource({ XDG_DATA_HOME: root,
    OPENCODE_API_KEY: 'never-emit-this-api-secret' }, exists), 'env-key');
  assert.equal(zenAuthSource({ XDG_DATA_HOME: root,
    OPENCODE_AUTH_CONTENT: '{"opencode":{"key":"never-log"}}' }, exists), 'env-auth');
});

test('proxy policy is explicit but never claims account eligibility or network availability', () => {
  const env = { XDG_DATA_HOME: path.resolve('none-for-test') };
  const status = zenEnvironmentHints(env, { direct: false });
  assert.deepEqual(status, { authSource: 'none', proxyMode: 'proxy-vars-inherited' });
  assert.equal(zenEnvironmentHints(env).proxyMode, 'proxy-vars-cleared');
  assert.doesNotMatch(JSON.stringify(status), /OPENCODE_API_KEY|auth.json|secret|password/);
});
