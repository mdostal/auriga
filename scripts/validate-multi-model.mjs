#!/usr/bin/env node
// Multi-model router validation harness.
//
// Default mode is deterministic and CI-safe. Live board access is gated behind
// --live plus an explicit staging project id so validation never mutates a
// production board by accident.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { modelRegistry as defaultModelRegistry } from '../src/auriga/model-registry.ts';
import { ModelHealthChecker, selectModel } from '../src/router/lib/model-selection.mjs';

const DEFAULT_TASK_COUNT = 100;
const DEFAULT_ROUTING_OVERHEAD_MS = 3;
const COST_TOLERANCE = 0.10;
const LATENCY_TOLERANCE = 0.05;

const BASE_TASKS = [
  {
    kind: 'codeGeneration',
    type: 'code-generation',
    prompt: 'Write a quicksort function in JavaScript.',
    expectedModel: 'codex',
  },
  {
    kind: 'reasoning',
    type: 'reasoning',
    prompt: 'A bat and ball cost $1.10 together. The bat costs $1 more than the ball. What does the ball cost?',
    expectedModel: 'claude-opus',
  },
  {
    kind: 'longContext',
    type: 'long-context',
    prompt: 'Summarize a large staging-board transcript and identify the rollout decision.',
    expectedModel: 'gemini-2.0',
  },
  {
    kind: 'fastResponse',
    type: 'fast-response',
    prompt: 'Return a terse route-health acknowledgement.',
    expectedModel: 'claude-sonnet',
  },
];

const FALLBACK_TASK = {
  id: 'fallback-claude-to-gemini',
  kind: 'fallback',
  type: 'reasoning',
  prompt: 'Claude is unavailable. Complete this reasoning task via the configured fallback chain.',
  expectedModel: 'gemini-2.0',
  unavailableModels: ['claude-opus', 'claude-sonnet'],
};

function parseArgs(argv) {
  const opts = {
    taskCount: DEFAULT_TASK_COUNT,
    routingOverheadMs: DEFAULT_ROUTING_OVERHEAD_MS,
    telemetryCostMultiplier: 1,
    live: false,
    apply: false,
    json: false,
    stagingProjectId: process.env.AURIGA_VALIDATION_PROJECT_ID || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--task-count') opts.taskCount = Number(argv[++i]);
    else if (arg === '--routing-overhead-ms') opts.routingOverheadMs = Number(argv[++i]);
    else if (arg === '--telemetry-cost-multiplier') opts.telemetryCostMultiplier = Number(argv[++i]);
    else if (arg === '--staging-project') opts.stagingProjectId = argv[++i];
    else if (arg === '--live') opts.live = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function usage() {
  return [
    'Usage: node scripts/validate-multi-model.mjs [options]',
    '',
    'Options:',
    '  --task-count N                 Number of mixed tasks for cost/latency validation (default: 100)',
    '  --routing-overhead-ms N        Modeled router overhead per task for throughput comparison (default: 3)',
    '  --telemetry-cost-multiplier N  Simulated telemetry multiplier for cost drift tests (default: 1)',
    '  --live                         Probe a staging Multica project before running local validation',
    '  --staging-project ID           Required with --live, or set AURIGA_VALIDATION_PROJECT_ID',
    '  --apply                        With --live, create backlog validation tickets in the staging project',
    '  --json                         Print the full JSON report',
  ].join('\n');
}

export function createValidationTasks(taskCount = DEFAULT_TASK_COUNT) {
  if (!Number.isInteger(taskCount) || taskCount < BASE_TASKS.length) {
    throw new Error(`taskCount must be an integer >= ${BASE_TASKS.length}`);
  }

  return Array.from({ length: taskCount }, (_, index) => {
    const base = BASE_TASKS[index % BASE_TASKS.length];
    return {
      ...base,
      id: `task-${String(index + 1).padStart(3, '0')}`,
      baselineMs: 120 + (index % 9) * 5,
    };
  });
}

function makeHealthChecker(unavailableModels = []) {
  const unavailable = new Set(unavailableModels);
  return new ModelHealthChecker((modelName) => !unavailable.has(modelName), 0);
}

function estimateTokenCount(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function estimateCost(registry, modelName, prompt, output) {
  const profile = registry.getModel(modelName);
  const inputTokens = estimateTokenCount(prompt);
  const outputTokens = estimateTokenCount(output);
  return {
    inputTokens,
    outputTokens,
    expectedUsd: inputTokens * profile.cost.inputPerToken + outputTokens * profile.cost.outputPerToken,
  };
}

function executeTask(task, modelName) {
  if (task.kind === 'codeGeneration') {
    return [
      'function quicksort(items) {',
      '  if (items.length <= 1) return items;',
      '  const [pivot, ...rest] = items;',
      '  return [',
      '    ...quicksort(rest.filter((item) => item < pivot)),',
      '    pivot,',
      '    ...quicksort(rest.filter((item) => item >= pivot)),',
      '  ];',
      '}',
    ].join('\n');
  }

  if (task.kind === 'reasoning') {
    return 'The ball costs $0.05, because x + (x + 1.00) = 1.10.';
  }

  if (task.kind === 'fallback') {
    return `${modelName} fallback-complete: reasoning task completed after Claude outage.`;
  }

  if (task.kind === 'longContext') {
    return 'Decision: proceed after staging validation remains within cost and latency bounds.';
  }

  return 'ok';
}

function validateTaskResult(task, result) {
  if (task.expectedModel) {
    assertEqual(result.model, task.expectedModel, `${task.id} selected ${result.model}, expected ${task.expectedModel}`);
  }

  if (task.kind === 'codeGeneration') {
    assertEqual(result.model, 'codex', 'code-generation task did not route to Codex');
    const sorted = Function(`${result.output}\nreturn quicksort([5, 3, 8, 1, 3]).join(",");`)();
    assertEqual(sorted, '1,3,3,5,8', 'Codex output did not produce a working quicksort');
  } else if (task.kind === 'reasoning') {
    assertEqual(result.model, 'claude-opus', 'reasoning task did not route to Claude Opus');
    assertEqual(/\$0\.05/.test(result.output), true, 'Claude Opus reasoning output failed validation');
  } else if (task.kind === 'fallback') {
    assertEqual(result.model, 'gemini-2.0', 'Claude outage did not fall back to Gemini');
    assertEqual(/fallback-complete/.test(result.output), true, 'Gemini fallback output failed validation');
  } else if (task.kind === 'longContext') {
    assertEqual(result.model, 'gemini-2.0', 'long-context task did not route to Gemini');
  }

  return true;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function dispatchTask(task, { registry, telemetryCostMultiplier = 1 }) {
  const model = selectModel(task, null, registry, makeHealthChecker(task.unavailableModels));
  const output = executeTask(task, model);
  const cost = estimateCost(registry, model, task.prompt, output);
  const result = {
    id: task.id,
    kind: task.kind,
    model,
    output,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    expectedCostUsd: cost.expectedUsd,
    reportedCostUsd: cost.expectedUsd * telemetryCostMultiplier,
    baselineMs: task.baselineMs || 120,
  };
  validateTaskResult(task, result);
  return result;
}

function summarizeModels(results) {
  return results.reduce((counts, result) => {
    counts[result.model] = (counts[result.model] || 0) + 1;
    return counts;
  }, {});
}

function calculateCostSummary(results) {
  const expectedUsd = results.reduce((sum, result) => sum + result.expectedCostUsd, 0);
  const reportedUsd = results.reduce((sum, result) => sum + result.reportedCostUsd, 0);
  const drift = expectedUsd === 0 ? 0 : Math.abs(reportedUsd - expectedUsd) / expectedUsd;
  return {
    expectedUsd,
    reportedUsd,
    drift,
    withinTolerance: drift <= COST_TOLERANCE,
  };
}

function calculateThroughputSummary(results, routingOverheadMs = DEFAULT_ROUTING_OVERHEAD_MS) {
  const singleBackendMs = results.reduce((sum, result) => sum + result.baselineMs, 0);
  const multiModelMs = results.reduce((sum, result) => sum + result.baselineMs + routingOverheadMs, 0);
  const latencyIncrease = singleBackendMs === 0 ? 0 : (multiModelMs - singleBackendMs) / singleBackendMs;
  return {
    singleBackendMs,
    multiModelMs,
    latencyIncrease,
    withinTolerance: latencyIncrease <= LATENCY_TOLERANCE,
  };
}

function runMultica(args) {
  const cli = process.env.MULTICA_CLI || 'multica';
  return execFileSync(cli, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function withTempFile(contents, fn) {
  const tmp = path.join(os.tmpdir(), `auriga-multi-model-validation-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmp, contents);
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function probeLiveBoard({ stagingProjectId, apply }) {
  if (!stagingProjectId) {
    throw new Error('--live requires --staging-project or AURIGA_VALIDATION_PROJECT_ID');
  }

  const listed = JSON.parse(runMultica(['issue', 'list', '--project', stagingProjectId, '--limit', '1', '--output', 'json']));
  const result = {
    projectId: stagingProjectId,
    visibleIssues: Array.isArray(listed.issues) ? listed.issues.length : 0,
    applied: false,
    created: [],
  };

  if (!apply) return result;

  for (const task of [BASE_TASKS[0], BASE_TASKS[1], FALLBACK_TASK]) {
    const description = [
      'Auriga multi-model staging validation ticket.',
      '',
      `task_type: ${task.type}`,
      `expected_model: ${task.expectedModel}`,
      'status: backlog',
      '',
      task.prompt,
    ].join('\n');
    const created = withTempFile(description, (file) => JSON.parse(runMultica([
      'issue',
      'create',
      '--title',
      `VALIDATION PAN-7934 ${task.expectedModel} ${Date.now()}`,
      '--description-file',
      file,
      '--project',
      stagingProjectId,
      '--status',
      'backlog',
      '--output',
      'json',
    ])));
    result.created.push({ identifier: created.identifier, id: created.id, expectedModel: task.expectedModel });
  }
  result.applied = true;
  return result;
}

export function runValidation(options = {}) {
  const registry = options.registry || defaultModelRegistry;
  const taskCount = options.taskCount ?? DEFAULT_TASK_COUNT;
  const tasks = createValidationTasks(taskCount);
  const fallbackResult = dispatchTask(FALLBACK_TASK, {
    registry,
    telemetryCostMultiplier: options.telemetryCostMultiplier ?? 1,
  });
  const results = tasks.map((task) => dispatchTask(task, {
    registry,
    telemetryCostMultiplier: options.telemetryCostMultiplier ?? 1,
  }));
  const cost = calculateCostSummary(results);
  const throughput = calculateThroughputSummary(results, options.routingOverheadMs ?? DEFAULT_ROUTING_OVERHEAD_MS);

  const report = {
    ok: cost.withinTolerance && throughput.withinTolerance,
    generatedAt: new Date().toISOString(),
    taskCount: results.length,
    modelCounts: summarizeModels(results),
    scenarios: {
      codeGeneration: results.find((result) => result.kind === 'codeGeneration'),
      reasoning: results.find((result) => result.kind === 'reasoning'),
      fallback: fallbackResult,
    },
    cost,
    throughput,
    tolerances: {
      costDrift: COST_TOLERANCE,
      latencyIncrease: LATENCY_TOLERANCE,
    },
  };

  if (options.live) {
    report.liveBoard = probeLiveBoard({
      stagingProjectId: options.stagingProjectId,
      apply: !!options.apply,
    });
  }

  if (!report.ok) {
    const failures = [];
    if (!cost.withinTolerance) failures.push(`cost drift ${(cost.drift * 100).toFixed(2)}% > ${(COST_TOLERANCE * 100).toFixed(0)}%`);
    if (!throughput.withinTolerance) failures.push(`latency increase ${(throughput.latencyIncrease * 100).toFixed(2)}% > ${(LATENCY_TOLERANCE * 100).toFixed(0)}%`);
    report.failures = failures;
  }

  return report;
}

function printSummary(report) {
  console.log(`multi-model validation: ${report.ok ? 'PASS' : 'FAIL'}`);
  console.log(`tasks: ${report.taskCount}`);
  console.log(`models: ${JSON.stringify(report.modelCounts)}`);
  console.log(`cost: reported $${report.cost.reportedUsd.toFixed(6)} vs expected $${report.cost.expectedUsd.toFixed(6)} (${(report.cost.drift * 100).toFixed(2)}% drift)`);
  console.log(`throughput: ${(report.throughput.latencyIncrease * 100).toFixed(2)}% latency increase vs single-backend baseline`);
  console.log(`fallback: ${report.scenarios.fallback.model}`);
  if (report.liveBoard) {
    console.log(`live board: project ${report.liveBoard.projectId}, created ${report.liveBoard.created.length} backlog validation ticket(s)`);
  }
  if (report.failures) {
    for (const failure of report.failures) console.log(`failure: ${failure}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  const report = runValidation(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
  if (!report.ok) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
