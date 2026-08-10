import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runValidation } from '../../scripts/validate-multi-model.mjs';

test('code-gen task routes to Codex and produces valid code', () => {
  const report = runValidation({ taskCount: 100 });
  assert.equal(report.scenarios.codeGeneration.model, 'codex');
  assert.match(report.scenarios.codeGeneration.output, /function quicksort/);
  assert.equal(report.ok, true);
});

test('reasoning task routes to Claude Opus and produces correct analysis', () => {
  const report = runValidation({ taskCount: 100 });
  assert.equal(report.scenarios.reasoning.model, 'claude-opus');
  assert.match(report.scenarios.reasoning.output, /\$0\.05/);
});

test('Claude outage falls back to Gemini and completes successfully', () => {
  const report = runValidation({ taskCount: 100 });
  assert.equal(report.scenarios.fallback.model, 'gemini-2.0');
  assert.match(report.scenarios.fallback.output, /fallback-complete/);
});

test('100-task multi-model dispatch cost stays within 10 percent of expected', () => {
  const report = runValidation({ taskCount: 100, telemetryCostMultiplier: 1.08 });
  assert.equal(report.taskCount, 100);
  assert.equal(report.cost.withinTolerance, true);
  assert.ok(report.cost.drift <= 0.10, `cost drift was ${report.cost.drift}`);
});

test('multi-model throughput stays within five percent of single-backend baseline', () => {
  const report = runValidation({ taskCount: 100, routingOverheadMs: 5 });
  assert.equal(report.throughput.withinTolerance, true);
  assert.ok(report.throughput.latencyIncrease <= 0.05, `latency increase was ${report.throughput.latencyIncrease}`);
});

test('all three configured model families receive validation traffic', () => {
  const report = runValidation({ taskCount: 100 });
  assert.ok(report.modelCounts.codex > 0);
  assert.ok(report.modelCounts['claude-opus'] > 0);
  assert.ok(report.modelCounts['gemini-2.0'] > 0);
});
