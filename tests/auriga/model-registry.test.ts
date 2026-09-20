import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, modelRegistry } from '../../src/auriga/model-registry.ts';

test('getModel returns the capability profile for a known model', () => {
  const profile = modelRegistry.getModel('claude-sonnet');

  assert.equal(profile.name, 'claude-sonnet');
  assert.equal(profile.provider, 'anthropic');
  assert.ok(profile.capabilities.includes('code-generation'));
});

test('getModel throws a descriptive error for an unknown model', () => {
  assert.throws(
    () => modelRegistry.getModel('gpt-nonexistent'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gpt-nonexistent/);
      return true;
    }
  );
});

test('getModelsByCapability returns only models that support the capability', () => {
  const visionModels = modelRegistry.getModelsByCapability('vision');

  assert.ok(visionModels.length > 0);
  for (const profile of visionModels) {
    assert.ok(profile.capabilities.includes('vision'));
  }

  const names = visionModels.map((m) => m.name);
  assert.ok(names.includes('claude-opus'));
  assert.ok(names.includes('gemini-2.0'));
});

test('getModelsByCapability returns an empty array when no model supports the capability', () => {
  const registry = new ModelRegistry([]);
  assert.deepEqual(registry.getModelsByCapability('reasoning'), []);
});

test('cost-per-token and rate limit metadata are available on every registered model', () => {
  for (const profile of modelRegistry.listModels()) {
    assert.equal(typeof profile.cost.inputPerToken, 'number');
    assert.equal(typeof profile.cost.outputPerToken, 'number');
    assert.ok(profile.cost.inputPerToken > 0);
    assert.ok(profile.cost.outputPerToken > 0);

    assert.equal(typeof profile.rateLimit.requestsPerMinute, 'number');
    assert.equal(typeof profile.rateLimit.tokensPerMinute, 'number');
    assert.ok(profile.rateLimit.requestsPerMinute > 0);
    assert.ok(profile.rateLimit.tokensPerMinute > 0);
  }
});

test('hasModel reflects registration state', () => {
  assert.equal(modelRegistry.hasModel('codex'), true);
  assert.equal(modelRegistry.hasModel('does-not-exist'), false);
});

test('register adds a new model that can then be queried', () => {
  const registry = new ModelRegistry([]);
  registry.register({
    name: 'test-model',
    provider: 'test-provider',
    capabilities: ['reasoning'],
    contextWindowTokens: 1000,
    cost: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
    rateLimit: { requestsPerMinute: 10, tokensPerMinute: 1000 },
  });

  assert.equal(registry.hasModel('test-model'), true);
  assert.deepEqual(registry.getModelsByCapability('reasoning').map((m) => m.name), ['test-model']);
});

test('listModels includes all default models', () => {
  const names = modelRegistry.listModels().map((m) => m.name).sort();
  assert.deepEqual(names, ['claude-opus', 'claude-sonnet', 'codex', 'gemini-2.0']);
});
