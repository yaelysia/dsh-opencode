import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODELS, createAdapter } from '../src/bridge.js';

test('both default models are listed', () => {
  const adapter = createAdapter();
  assert.deepEqual(adapter.listModels('opencode-serve').map(x => x.id), [...DEFAULT_MODELS]);
});
