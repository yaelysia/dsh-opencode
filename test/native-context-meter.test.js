import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStructuredAdapter } from '../src/structured-adapter.js';
import { StructuredToolBroker } from '../src/structured-broker.js';

const MODEL = 'deepseek-v4.1-flash-free';

test('structured model declares context capacity to the stock DSH ContextMeter', async () => {
  let readyCalls = 0, catalogCalls = 0;
  const adapter = createStructuredAdapter({
    structuredToolsEnabled: true,
    ensureService: async ({ requireManaged }) => {
      assert.equal(requireManaged, true);
      readyCalls++;
    },
  }, new StructuredToolBroker(), async (url, init) => {
    assert.equal(new URL(url).pathname, '/provider');
    assert.equal(init.method, 'GET');
    catalogCalls++;
    return Response.json({ all: [{ id: 'opencode', models: {
      [MODEL]: { limit: { context: 200000, input: 180000, output: 8192 } },
    } }] });
  });
  try {
    const prepared = await adapter.prepareCall('opencode-serve', MODEL);
    assert.deepEqual(prepared.model.context, { contextWindow: 200000 });
    assert.equal(prepared.model.provider, 'opencode-serve');
    assert.equal(prepared.model.id, MODEL);
    const next = await adapter.prepareCall('opencode-serve', MODEL);
    assert.equal(next.model.context.contextWindow, 200000);
    assert.equal(catalogCalls, 1, 'catalog capacity should be cached');
    assert.equal(readyCalls, 2);
  } finally { await adapter.runtime.dispose(); }
});

test('unavailable model context is omitted, never advertised as an invented 256K', async () => {
  const adapter = createStructuredAdapter({
    structuredToolsEnabled: true,
    ensureService: async () => {},
  }, new StructuredToolBroker(), async () => Response.json({ all: [] }));
  try {
    const prepared = await adapter.prepareCall('opencode-serve', MODEL);
    assert.equal(prepared.model.context, undefined);
  } finally { await adapter.runtime.dispose(); }
});
