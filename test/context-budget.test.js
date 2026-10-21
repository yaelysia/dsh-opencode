import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextBudget, modelWindow, estimateTokens, consumedTokens } from '../src/context-budget.js';

const catalog = { all: [{ id: 'opencode', models: {
  'deepseek-v4.1-flash-free': { limit: { context: 200_000, input: 180_000, output: 8000 } },
  'unknown-free': { limit: { context: 0, output: 0 } },
} }] };

test('model context comes from live OpenCode catalog, not a hard-coded 256K assumption', async () => {
  const calls = [];
  const client = { backendProviderId: 'opencode', async request(path, payload, signal, method) {
    calls.push({ path, method });
    return catalog;
  } };
  const budget = new ContextBudget(client);
  const a = await budget.limit('deepseek-v4.1-flash-free');
  const b = await budget.limit('deepseek-v4.1-flash-free');
  assert.deepEqual(a, { context: 200000, input: 180000, output: 8000 });
  assert.deepEqual(b, a);
  assert.deepEqual(calls, [{ path: '/provider', method: 'GET' }]);
  assert.equal(modelWindow(catalog, 'opencode', 'unknown-free'), null);
  assert.equal(modelWindow(catalog, 'other', 'deepseek-v4.1-flash-free'), null);
});

test('budget recommends native compaction only for reusable, near-limit history', () => {
  const budget = new ContextBudget({});
  const window = { context: 20_000, input: 18_000, output: 1000 };
  const input = { window, prompt: 'next question', system: 'system', tools: [], reused: true };
  assert.equal(budget.check({ ...input, priorTokens: 1200 }).action, 'allow');
  const high = budget.check({ ...input, priorTokens: 14000 });
  assert.equal(high.action, 'compact');
  assert.ok(high.projected > high.usable * 0.78);
  assert.equal(budget.check({ ...input, priorTokens: null }).action, 'allow');
  assert.equal(budget.check({ ...input, window: null }).action, 'allow');
});

test('single oversized input is rejected without dropping DSH message history', () => {
  const budget = new ContextBudget({});
  const w = { context: 8000, input: 7000, output: 1000 };
  const huge = 'x'.repeat(80_000);
  assert.equal(budget.check({ window: w, prompt: huge, system: '',
    tools: [], reused: false }).action, 'reject');
  assert.equal(budget.check({ window: w, prompt: huge, system: '',
    tools: [], reused: true, priorTokens: 5000 }).action, 'reject');
  // The hard single-input check wins if total fresh input exceeds available budget.
  assert.ok(estimateTokens('文件') >= 2);
});

test('last model usage counts cache tokens, not just uncached input', () => {
  assert.equal(consumedTokens({ input: 200, output: 100, cache: { read: 1000, write: 50 } }), 1350);
  assert.equal(consumedTokens({ total: 2000, input: 123 }), 2000);
  assert.equal(consumedTokens({}), null);
});

test('unavailable model catalog fails open to native OpenCode overflow handling', async () => {
  let calls = 0, warnings = 0;
  const budget = new ContextBudget({ backendProviderId: 'opencode', async request() {
    calls++; throw Object.assign(new Error('provider lookup failed'), { code: 'TRANSPORT' });
  } }, { logger: { warn() { warnings++; } } });
  assert.equal(await budget.limit('model'), null);
  assert.equal(await budget.limit('model'), null);
  assert.equal(calls, 1);
  assert.equal(warnings, 1);
});
