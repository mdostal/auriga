import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiAdapter, AuthenticationError } from './GeminiAdapter.ts';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('throws AuthenticationError when no GOOGLE_API_KEY is available', () => {
  const savedKey = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    assert.throws(
      () => new GeminiAdapter({}),
      AuthenticationError
    );
  } finally {
    if (savedKey !== undefined) process.env.GOOGLE_API_KEY = savedKey;
  }
});

test('successful dispatch calls Gemini API with correct parameters and normalizes response', async () => {
  let capturedUrl;
  let capturedOptions;

  const adapter = new GeminiAdapter({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return jsonResponse(200, {
        candidates: [
          {
            content: { parts: [{ text: 'Hello from Gemini' }] },
            finishReason: 'STOP',
            safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' }],
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      });
    },
  });

  const result = await adapter.dispatch({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.match(capturedUrl, /^https:\/\/generativelanguage\.googleapis\.com\/v1\/models\/gemini-2\.0-flash:generateContent\?key=test-key$/);
  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.contents[0].parts[0].text, 'user: hi');
  assert.equal(capturedOptions.method, 'POST');

  assert.equal(result.model, 'gemini-2.0-flash');
  assert.equal(result.tokens, 15);
  assert.equal(result.response.text, 'Hello from Gemini');
  assert.deepEqual(result.response.safetyRatings, [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' }]);
  assert.ok(typeof result.latency === 'number');
});

test('retries via base adapter on 429 rate limit and eventually succeeds', async () => {
  let calls = 0;

  const adapter = new GeminiAdapter({
    apiKey: 'test-key',
    maxAttempts: 2,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(429, { error: 'rate limited' });
      }
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP', safetyRatings: [] }],
        usageMetadata: { totalTokenCount: 3 },
      });
    },
  });

  const result = await adapter.dispatch({ model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'retry me' }] });

  assert.equal(calls, 2);
  assert.equal(result.response.text, 'ok');
});

test('handles Gemini safety filter blocks gracefully instead of throwing', async () => {
  const adapter = new GeminiAdapter({
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse(200, {
      candidates: [{ finishReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }] }],
      usageMetadata: { totalTokenCount: 8 },
    }),
  });

  const result = await adapter.dispatch({ model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'blocked content' }] });

  assert.equal(result.response.blocked, true);
  assert.equal(result.response.text, '');
  assert.deepEqual(result.response.safetyRatings, [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH' }]);
});

test('returns structured output for a reasoning task dispatched to Gemini', async () => {
  const adapter = new GeminiAdapter({
    apiKey: 'test-key',
    fetchImpl: async () => jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: 'reasoned answer' }] }, finishReason: 'STOP', safetyRatings: [] }],
      usageMetadata: { totalTokenCount: 42 },
    }),
  });

  const result = await adapter.dispatch({
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'reason about this' }],
    task: 'reasoning',
  });

  assert.equal(result.model, 'gemini-2.0-flash');
  assert.equal(result.tokens, 42);
  assert.equal(result.response.text, 'reasoned answer');
  assert.equal(result.response.finishReason, 'STOP');
});
