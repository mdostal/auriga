// Loop-level integration tests: drive the REAL auriga-router.mjs cycle()
// against a MOCK Multica layer (test/support/mock-mca.mjs) — no live
// `multica`/`gh` CLI calls. Uses the real lib/config.mjs + lib/core.mjs so
// these tests exercise the actual routing tables and decision logic, not a
// re-description of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycle } from '../auriga-router.mjs';
import * as cfg from '../lib/config.mjs';
import { createMockMca, createLogSink } from './support/mock-mca.mjs';

const NOOP_SLEEP = async () => {};

function projectId(name) {
  const id = Object.entries(cfg.PROJECT_NAMES).find(([, n]) => n === name)?.[0];
  if (!id) throw new Error(`no project id for ${name}`);
  return id;
}

let seq = 1000;
function makeIssue(overrides = {}) {
  const n = seq++;
  return {
    id: `id-${n}`,
    identifier: `PAN-${n}`,
    number: n,
    title: `story ${n}`,
    description: '',
    labels: [],
    status: 'todo',
    assignee_id: null,
    parent_issue_id: null,
    metadata: {},
    ...overrides,
  };
}

test('AC1: a hive-tagged todo dispatches to a HIVE_LANE agent (never codex/opencode) and verifies in-progress', async () => {
  const AURIGA = projectId('Auriga'); // default (non-hive) lane here is codex-only auriga-dev
  const hiveStory = makeIssue({ project_id: AURIGA, labels: ['build'] }); // 'build' is a HIVE_LABEL
  const mca = createMockMca([hiveStory], cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ mca, cfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 1);
  assert.equal(mca.calls.assign.length, 1);
  const [assignment] = mca.calls.assign;
  assert.equal(assignment.identifier, hiveStory.identifier);
  assert.ok(cfg.HIVE_LANE.includes(assignment.agentName), `expected a HIVE_LANE agent, got ${assignment.agentName}`);
  const codexOrOpencode = new Set(['auriga-dev', 'heimdall-dev-codex', 'heimdall-dev']);
  assert.ok(!codexOrOpencode.has(assignment.agentName), `hive story must NEVER route to codex/opencode, got ${assignment.agentName}`);
  assert.equal(cfg.AGENTS[assignment.agentName].runtime, 'claude');

  const verifyOk = log.byEvent('verify_ok');
  assert.equal(verifyOk.length, 1);
  assert.equal(verifyOk[0].identifier, hiveStory.identifier);
  assert.equal(verifyOk[0].runStatus, 'in_progress');
  assert.equal(log.byEvent('verify_no_run').length, 0);
});

test('AC2: a Pantheon Core [idea] seed routes to minerva-dev; its decomposed non-seed child routes to auriga-build', async () => {
  const PANTHEON_CORE = projectId('Pantheon Core');
  const seedIssue = makeIssue({ project_id: PANTHEON_CORE, labels: ['idea'], parent_issue_id: null });
  const childStory = makeIssue({ project_id: PANTHEON_CORE, parent_issue_id: seedIssue.id });
  const mca = createMockMca([seedIssue, childStory], cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ mca, cfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 2);
  const byIdentifier = Object.fromEntries(mca.calls.assign.map((a) => [a.identifier, a.agentName]));
  assert.equal(byIdentifier[seedIssue.identifier], 'minerva-dev');
  assert.equal(byIdentifier[childStory.identifier], 'auriga-build');
});

test('AC3: per-agent(2) and per-runtime (claude 2 / codex 4) caps hold within one cycle, never exceeding perCycleTotal(5)', async () => {
  const AURIGA = projectId('Auriga'); // single-agent lane: auriga-dev (codex)
  const HEIMDALL = projectId('Heimdall'); // two-agent lane: heimdall-dev (opencode) + heimdall-dev-codex (codex)
  const CONSUS = projectId('Consus'); // single-agent lane: consus-dev (claude)
  const PANTHEON_CORE = projectId('Pantheon Core'); // single-agent lane: auriga-build (claude)

  // Each carries a fake parent_issue_id so isSeed() short-circuits false (not
  // top-level) — these are meant to be plain build-lane candidates, not seeds.
  const issues = [
    ...Array.from({ length: 4 }, () => makeIssue({ project_id: AURIGA, parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 4 }, () => makeIssue({ project_id: HEIMDALL, parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 2 }, () => makeIssue({ project_id: CONSUS, parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 2 }, () => makeIssue({ project_id: PANTHEON_CORE, parent_issue_id: 'fake-parent' })),
  ];
  assert.equal(issues.length, 12); // more candidates than perCycleTotal, so the cap is actually exercised

  const mca = createMockMca(issues, cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ mca, cfg, log, sleep: NOOP_SLEEP });

  assert.ok(result.assigned <= cfg.CAPS.perCycleTotal, `assigned ${result.assigned} > perCycleTotal ${cfg.CAPS.perCycleTotal}`);
  assert.ok(mca.calls.assign.length <= cfg.CAPS.perCycleTotal);
  // The cap must have actually engaged — otherwise this test is not exercising it.
  assert.ok(mca.calls.assign.length > 0);

  const perAgent = {};
  const perRuntime = {};
  for (const { agentName } of mca.calls.assign) {
    perAgent[agentName] = (perAgent[agentName] || 0) + 1;
    const runtime = cfg.AGENTS[agentName].runtime;
    perRuntime[runtime] = (perRuntime[runtime] || 0) + 1;
  }
  for (const [agentName, count] of Object.entries(perAgent)) {
    assert.ok(count <= cfg.CAPS.perCyclePerAgent, `${agentName} got ${count} assignments > perCyclePerAgent ${cfg.CAPS.perCyclePerAgent}`);
  }
  for (const [runtime, count] of Object.entries(perRuntime)) {
    const cap = cfg.RUNTIME_CAP[runtime] ?? Infinity;
    assert.ok(count <= cap, `runtime ${runtime} got ${count} assignments > RUNTIME_CAP ${cap}`);
  }
});
