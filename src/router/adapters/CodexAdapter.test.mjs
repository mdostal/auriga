import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, AuthenticationError } from './CodexAdapter.ts';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

const COMPLETION_BODY = {
  model: 'code-davinci-002',
  choices: [{ text: 'console.log("hi")', finish_reason: 'stop' }],
  usage: { total_tokens: 42 },
};

test('initializing without an API key throws AuthenticationError', () => {
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => new CodexAdapter({}), AuthenticationError);
  } finally {
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
  }
});

test('dispatch calls the OpenAI Completions API with correct parameters', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, COMPLETION_BODY);
  });

  const adapter = new CodexAdapter({ apiKey: 'sk-test' });
  await adapter.dispatch({ model: 'codex', messages: [{ role: 'user', content: 'write a hello world' }] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'code-davinci-002');
  assert.equal(body.prompt, 'write a hello world');
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.temperature, 0);
});

test('dispatch extracts code, tokens, and finish_reason from a successful completion', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, COMPLETION_BODY));

  const adapter = new CodexAdapter({ apiKey: 'sk-test' });
  const result = await adapter.dispatch({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.tokens, 42);
  assert.equal(result.response.code, 'console.log("hi")');
  assert.equal(result.response.finishReason, 'stop');
  assert.equal(result.model, 'code-davinci-002');
});

test('a 429 rate limit response is retried via the base adapter', async (t) => {
  let attempt = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempt++;
    if (attempt === 1) {
      return jsonResponse(429, { error: 'rate limited' });
    }
    return jsonResponse(200, COMPLETION_BODY);
  });

  const adapter = new CodexAdapter({ apiKey: 'sk-test', maxAttempts: 2 });
  const result = await adapter.dispatch({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(attempt, 2);
  assert.equal(result.tokens, 42);
});

test('a 401 response from the API surfaces as an AuthenticationError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(401, { error: 'invalid api key' }));

  const adapter = new CodexAdapter({ apiKey: 'sk-bad', maxAttempts: 1 });
  await assert.rejects(
    () => adapter.dispatch({ model: 'codex', messages: [{ role: 'user', content: 'hi' }] }),
    AuthenticationError
  );
});
