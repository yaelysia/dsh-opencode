import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, configSnapshot } from '../index.js';


test('new structured mode is an editable, opt-in DSH setting without changing legacy defaults', () => {
  const defaults = configSnapshot(Config({}));
  assert.equal(defaults.structuredToolsEnabled, false);
  assert.equal(configSnapshot(Config({ structuredToolsEnabled: true })).structuredToolsEnabled, true);
});
