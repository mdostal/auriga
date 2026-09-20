import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry } from '../../auriga/model-registry.ts';
import {
  selectModel,
  getPreferredModel,
  ModelHealthChecker,
  NoAvailableModelError,
} from '../lib/model-selection.mjs';

const PROFILES = [
  { name: 'claude-sonnet', provider: 'anthropic', capabilities: ['code-generation', 'reasoning'], contextWindowTokens: 200_000, cost: { inputPerToken: 1, outputPerToken: 1 }, rateLimit: { requestsPerMinute: 1, tokensPerMinute: 1 } },
  { name: 'claude-opus', provider: 'anthropic', capabilities: ['reasoning', 'vision'], contextWindowTokens: 200_000, cost: { inputPerToken: 1, outputPerToken: 1 }, rateLimit: { requestsPerMinute: 1, tokensPerMinute: 1 } },
  { name: 'codex', provider: 'openai', capabilities: ['code-generation'], contextWindowTokens: 128_000, cost: { inputPerToken: 1, outputPerToken: 1 }, rateLimit: { requestsPerMinute: 1, tokensPerMinute: 1 } },
  { name: 'gemini-2.0', provider: 'google', capabilities: ['reasoning', 'vision'], contextWindowTokens: 1_000_000, cost: { inputPerToken: 1, outputPerToken: 1 }, rateLimit: { requestsPerMinute: 1, tokensPerMinute: 1 } },
];

const registry = () => new ModelRegistry(PROFILES);
const allHealthy = () => new ModelHealthChecker(() => true);
const allDown = () => new ModelHealthChecker(() => false);
// Marks exactly the given models unhealthy; everything else is healthy.
const downFor = (names) => new ModelHealthChecker((name) => !names.includes(name));

test('code-generation task prefers Codex over Claude', () => {
  const model = selectModel({ type: 'code-generation' }, null, registry(), allHealthy());
  assert.equal(model, 'codex');
});

test('reasoning task prefers Claude Opus over Gemini', () => {
  const model = selectModel({ type: 'reasoning' }, null, registry(), allHealthy());
  assert.equal(model, 'claude-opus');
});

test('falls back to the next model in the chain when the preferred model is unavailable', () => {
  // Preferred for code-generation is codex; take it down and expect the
  // next healthy model in MODEL_FALLBACK_CHAINS.codex.
  const model = selectModel({ type: 'code-generation' }, null, registry(), downFor(['codex']));
  assert.equal(model, 'claude-sonnet');
});

test('falls back past multiple unavailable models to the first healthy one', () => {
  const model = selectModel({ type: 'code-generation' }, null, registry(), downFor(['codex', 'claude-sonnet']));
  assert.equal(model, 'gemini-2.0');
});

test('lane override wins regardless of task type', () => {
  const model = selectModel({ type: 'code-generation' }, 'gemini-2.0', registry(), allHealthy());
  assert.equal(model, 'gemini-2.0');
});

test('lane override is not subject to a health check', () => {
  const model = selectModel({ type: 'reasoning' }, 'gemini-2.0', registry(), allDown());
  assert.equal(model, 'gemini-2.0');
});

test('lane override still validates the model exists in the registry', () => {
  assert.throws(
    () => selectModel({ type: 'reasoning' }, 'not-a-real-model', registry(), allHealthy()),
    /Unknown model "not-a-real-model"/
  );
});

test('throws NoAvailableModelError when every model in the chain is unavailable', () => {
  assert.throws(
    () => selectModel({ type: 'code-generation' }, null, registry(), allDown()),
    (err) => {
      assert.ok(err instanceof NoAvailableModelError);
      assert.match(err.message, /code-generation/);
      return true;
    }
  );
});

test('unknown task type falls back to the default preference', () => {
  assert.equal(getPreferredModel('unknown-task-type'), getPreferredModel(undefined));
  const model = selectModel({ type: 'unknown-task-type' }, null, registry(), allHealthy());
  assert.equal(model, getPreferredModel('unknown-task-type'));
});

test('ModelHealthChecker caches a health result for the TTL window', () => {
  let calls = 0;
  const checker = new ModelHealthChecker(() => { calls += 1; return true; }, 60_000);
  const t0 = 1_000_000;
  assert.equal(checker.isAvailable('codex', t0), true);
  assert.equal(checker.isAvailable('codex', t0 + 1000), true);
  assert.equal(calls, 1, 'second call within TTL should be served from cache');

  assert.equal(checker.isAvailable('codex', t0 + 61_000), true);
  assert.equal(calls, 2, 'call past the TTL should re-probe');
});

test('ModelHealthChecker.invalidate forces a re-probe on the next call', () => {
  let healthy = true;
  const checker = new ModelHealthChecker(() => healthy, 60_000);
  const t0 = 2_000_000;
  assert.equal(checker.isAvailable('codex', t0), true);
  healthy = false;
  checker.invalidate('codex');
  assert.equal(checker.isAvailable('codex', t0 + 1), false);
});
