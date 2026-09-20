import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseDispatchAdapter } from './BaseDispatchAdapter.ts';

class MockAdapter extends BaseDispatchAdapter {
  constructor(config) {
    super(config);
    this.calls = 0;
    this.shouldThrow = false;
    this.timeoutDelay = 0;
  }

  async performDispatch(request) {
    this.calls++;
    
    if (this.timeoutDelay > 0) {
      await new Promise(r => setTimeout(r, this.timeoutDelay));
    }
    
    if (this.shouldThrow) {
      throw new Error('Provider error');
    }
    
    return {
      tokens: 100,
      latency: 50,
      cost: 0.01,
      response: { text: 'Hello' },
      model: request.model || 'mock-model'
    };
  }
}

test('throws descriptive error on invalid config', () => {
  assert.throws(
    () => new MockAdapter(null),
    /Invalid config: config object is required/
  );
});

test('successful dispatch logs telemetry and returns standard shape', async () => {
  const adapter = new MockAdapter({});
  const result = await adapter.dispatch({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }]
  });
  
  assert.equal(result.model, 'test-model');
  assert.equal(result.tokens, 100);
  assert.equal(result.latency, 50);
  assert.equal(result.cost, 0.01);
  assert.equal(adapter.calls, 1);
});

test('retries with exponential backoff on failure', async () => {
  const adapter = new MockAdapter({ maxAttempts: 3 });
  
  // Make it throw errors on the first 2 attempts, then succeed
  adapter.performDispatch = async (request) => {
    adapter.calls++;
    if (adapter.calls < 3) {
      throw new Error('Temporary provider error');
    }
    return {
      tokens: 10,
      latency: 20,
      response: { text: 'Success on 3rd try' },
      model: request.model
    };
  };

  const start = Date.now();
  const result = await adapter.dispatch({ model: 'test-model', messages: [] });
  const duration = Date.now() - start;
  
  assert.equal(adapter.calls, 3);
  assert.equal(result.tokens, 10);
  // Backoff waits: 2^0 = 1s, 2^1 = 2s. Total wait ~3s.
  assert.ok(duration >= 2900, `Duration was ${duration}ms, expected >= 2900ms`);
});

test('handles network timeout correctly', async () => {
  // Use a very short timeout and backoff to speed up tests
  const adapter = new MockAdapter({ maxAttempts: 2, timeoutMs: 100 });
  
  // This adapter call will take 500ms, triggering the 100ms timeout
  adapter.timeoutDelay = 500;
  
  // It should attempt 2 times, each failing after ~100ms
  const start = Date.now();
  await assert.rejects(
    () => adapter.dispatch({ model: 'test-model', messages: [] }),
    /Network timeout after 100ms/
  );
  
  // Two timeout attempts (~200ms total) + one 1000ms backoff = ~1200ms
  assert.equal(adapter.calls, 2);
});
