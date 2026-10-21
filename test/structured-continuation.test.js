import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StructuredToolBroker } from '../src/structured-broker.js';
import { StructuredAdapterRuntime } from '../src/structured-adapter.js';

const model = 'deepseek-v4.1-flash-free';
const tools = [{ name: 'glob', parameters: {
  type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'],
} }];
const user = { role: 'user', content: [{ type: 'text', text: 'Find the text file' }] };
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const options = { sessionId: 'retry-boundary', provider: 'opencode-serve', model, tools, messages: [user] };

function harness({ failAfterTool = true } = {}) {
  const broker = new StructuredToolBroker();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/session') return Response.json({ id: 'opencode-cycle' });
    if (pathname.endsWith('/abort')) return Response.json(true);
    if (pathname.endsWith('/message') && init.method === 'POST') {
      posts++;
      if (failAfterTool) {
        const { DSH_STRUCTURED_URL, DSH_STRUCTURED_TOKEN } = broker.environment();
        const callback = await fetch(DSH_STRUCTURED_URL + '/call', {
          method: 'POST', headers: {
            authorization: 'Bearer ' + DSH_STRUCTURED_TOKEN, 'content-type': 'application/json',
          }, body: JSON.stringify({ sessionID: 'opencode-cycle', messageID: 'assistant-1',
            callID: 'tool-1', name: 'glob', arguments: { pattern: '*.txt' } }),
        });
        assert.equal(callback.status, 200);
      }
      return Response.json({ info: { error: {
        name: 'APIError', data: { statusCode: 429, message: 'Upstream request failed: Endpoint is unavailable.' },
      } }, parts: [] });
    }
    throw Error('Unexpected route: ' + pathname);
  };
  const runtime = new StructuredAdapterRuntime({
    endpoint: 'http://127.0.0.1:4096', ssePreviewEnabled: false, timeoutMs: 10000,
  }, broker, fetchImpl);
  return { broker, runtime, get posts() { return posts; } };
}

test('post-tool upstream 429 stays terminal; DSH cannot retry a consumed tool result', async () => {
  const app = harness();
  try {
    const first = await collect(app.runtime.stream(options));
    assert.equal(first.at(-1).reason.kind, 'tool-calls');
    const call = first.find(c => c.type === 'tool-call-delta');
    assert.equal(call.name, 'glob');
    assert.equal(app.posts, 1);
    const next = { ...options, messages: [...options.messages,
      { role: 'assistant', content: [{ type: 'tool-call', id: call.id,
        name: call.name, arguments: call.argumentsDelta }] },
      { role: 'tool', toolCallId: call.id, isError: false,
        content: [{ type: 'text', text: 'text.txt' }] },
    ] };
    const isTerminal = error => {
      assert.equal(error.code, 'TOOL_CONTINUATION_FAILED');
      assert.equal(error.failure.status, 429);
      assert.match(error.message, /RATE_LIMIT HTTP 429/);
      assert.match(error.message, /Endpoint is unavailable/);
      return true;
    };
    await assert.rejects(() => collect(app.runtime.stream(next)), isTerminal);
    assert.equal(app.runtime.turns.size, 0);
    assert.equal(app.broker.calls.size, 0);
    await assert.rejects(() => collect(app.runtime.stream(next)), isTerminal);
    assert.equal(app.posts, 1, 'an already executed tool must not trigger another OpenCode request');
    const fresh = await collect(app.runtime.stream({ ...options, messages: [user, {
      role: 'user', content: [{ type: 'text', text: 'A different request after the failure' }],
    }] }));
    assert.equal(fresh.at(-1).reason.kind, 'tool-calls');
    assert.equal(app.posts, 2, 'a new human request may use a fresh OpenCode cycle');
    assert.equal(app.runtime.terminalFailures.size, 0);
  } finally { await app.runtime.dispose(); }
});

test('pre-tool upstream 429 still carries RATE_LIMIT for ordinary safe retry policy', async () => {
  const app = harness({ failAfterTool: false });
  try {
    await assert.rejects(() => collect(app.runtime.stream(options)), error => {
      assert.equal(error.code, 'RATE_LIMIT');
      assert.equal(error.failure.status, 429);
      return true;
    });
    assert.equal(app.runtime.terminalFailures.size, 0);
    assert.equal(app.posts, 1);
  } finally { await app.runtime.dispose(); }
});
