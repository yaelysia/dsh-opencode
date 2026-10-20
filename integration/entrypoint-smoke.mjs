import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { apply, Config, name } from '../index.js';

test('real DSH packages load the plugin, register its adapter, and run a local title', async () => {
  assert.equal(name, 'opencode-serve');
  assert.ok(Config);
  let adapter, registration, cleanup;
  const ctx = {
    logger: { info() {}, warn() {} },
    fiber: { entry: { options: { id: 'test-entrypoint' } } },
    llm: {
      registerAdapter(providers, instance) {
        assert.deepEqual(providers, ['opencode-serve']);
        adapter = instance;
      },
      registerConfigurableProviders(items) { registration = items; },
    },
    effect(fn) { cleanup = fn(); },
  };
  apply(ctx, { autoStart: false, localTitles: true });
  try {
    assert.ok(adapter instanceof LlmAdapter);
    assert.equal(registration[0].settingsNs, 'test-entrypoint');
    const [model] = adapter.listModels('opencode-serve');
    const prepared = await adapter.prepareCall('opencode-serve', model.id);
    const chunks = [];
    for await (const chunk of prepared.stream({
      provider: 'opencode-serve', model: model.id, purpose: 'session-title',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Local title smoke' }] }],
    })) chunks.push(chunk);
    assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block.text, 'Local title smoke');
    assert.equal(chunks.at(-1)?.reason.kind, 'stop');
  } finally {
    await cleanup?.();
  }
});
