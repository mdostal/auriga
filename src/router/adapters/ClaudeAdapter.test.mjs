import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationError, ClaudeAdapter } from './ClaudeAdapter.ts';

function makeAdapter(fetch, config = {}) {
  return new ClaudeAdapter({
    apiKey: 'test-api-key',
    maxAttempts: 1,
    fetch,
    ...config,
  });
}

test('dispatch calls Anthropic Messages API with model and message parameters', async () => {
  const calls = [];
  const adapter = makeAdapter(async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: 'claude-sonnet',
          usage: { input_tokens: 7, output_tokens: 11 },
          content: [{ type: 'text', text: 'done' }],
        };
      },
    };
  });

  await adapter.dispatch({
    model: 'claude-sonnet',
    messages: [{ role: 'user', content: 'ship it' }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-api-key');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'claude-sonnet',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'ship it' }],
  });
});

test('dispatch normalizes successful Claude response tokens, completion, and latency', async () => {
  const adapter = makeAdapter(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: 'claude-sonnet',
        usage: { input_tokens: 10, output_tokens: 15 },
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
      };
    },
  }));

  const result = await adapter.dispatch({
    model: 'claude-sonnet',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.model, 'claude-sonnet');
  assert.equal(result.tokens, 25);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 15);
  assert.equal(result.completion, 'hello world');
  assert.equal(result.response.completion, 'hello world');
  assert.equal(typeof result.latency, 'number');
});

test('dispatch retries Anthropic 429 responses through BaseDispatchAdapter backoff', async () => {
  let calls = 0;
  const adapter = makeAdapter(async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        async json() {
          return { error: { message: 'rate limited' } };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: 'claude-sonnet',
          usage: { input_tokens: 1, output_tokens: 2 },
          content: [{ type: 'text', text: 'ok' }],
        };
      },
    };
  }, { maxAttempts: 2 });

  const start = Date.now();
  const result = await adapter.dispatch({
    model: 'claude-sonnet',
    messages: [{ role: 'user', content: 'retry' }],
  });

  assert.equal(calls, 2);
  assert.equal(result.completion, 'ok');
  assert.ok(Date.now() - start >= 900);
});

test('constructor throws AuthenticationError with actionable message when API key is missing', () => {
  assert.throws(
    () => new ClaudeAdapter({ env: {}, fetch: async () => ({ ok: true, status: 200, async json() { return {}; } }) }),
    (err) => err instanceof AuthenticationError && /Set ANTHROPIC_API_KEY/.test(err.message)
  );
});

test('dispatch accepts legacy prompt input as a user message', async () => {
  let body;
  const adapter = makeAdapter(async (_url, init) => {
    body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: 'claude-sonnet',
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'ok' }],
        };
      },
    };
  });

  await adapter.dispatch({ model: 'claude-sonnet', messages: [], prompt: 'legacy prompt' });

  assert.deepEqual(body.messages, [{ role: 'user', content: 'legacy prompt' }]);
});
