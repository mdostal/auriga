import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { emitMetric, queryMetrics, resetMetrics } from '../lib/metrics.mjs';

describe('metrics aggregation', () => {
  beforeEach(() => {
    resetMetrics();
  });

  test('emits metric and tracks hourly aggregation', () => {
    const now = new Date();
    const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}T${now.getUTCHours()}:00:00Z`;

    emitMetric({
      model: 'claude-sonnet',
      latency: 1200,
      tokens: 1000,
      cost: 0.003
    });

    emitMetric({
      model: 'claude-sonnet',
      latency: 1500,
      tokens: 2000,
      cost: 0.006
    });

    const metrics = queryMetrics(hourKey);
    assert.ok(Math.abs(metrics.totalCost - 0.009) < 0.00001);
    assert.ok(metrics.models['claude-sonnet']);
    assert.ok(Math.abs(metrics.models['claude-sonnet'].totalCost - 0.009) < 0.00001);
    assert.equal(metrics.models['claude-sonnet'].calls, 2);
    assert.equal(metrics.models['claude-sonnet'].totalTokens, 3000);
    assert.equal(metrics.models['claude-sonnet'].averageLatency, 1350);
  });

  test('returns zeros for empty hour', () => {
    const metrics = queryMetrics('2021-01-01T00:00:00Z');
    assert.equal(metrics.totalCost, 0);
    assert.deepEqual(metrics.models, {});
  });
});
