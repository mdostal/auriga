// t016 — orchestrator hand-down, first slice: explicit project -> child-board
// routing. Pure-function coverage (registry derivation, topology resolution,
// core route resolution, selectAssignments/cascade wiring) and the
// `project add --child` CLI (spawned against throwaway registry/topology
// files, never the committed ones). The cycle()-level
// stub-adapter test lives in router-cycle.e2e.test.mjs next to hand-up's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';
import { deriveProjectLane, deriveProjectRoute, upsertProject } from '../lib/project-registry.mjs';
import { resolveChildBoardConfigs } from '../lib/orchestrator-topology.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'auriga.mjs');

const CFG = {
  AGENTS: {
    'auriga-build': { id: 'AB', runtime: 'claude', maxInflight: 2 },
    'auriga-dev': { id: 'A', runtime: 'codex', maxInflight: 3 },
    'minerva-dev': { id: 'M', runtime: 'claude-planning', maxInflight: 3 },
  },
  RUNTIME_CAP: { claude: 2, codex: 4 },
  PROJECT_LANE: { LOCAL: ['auriga-build'], CHILD: ['auriga-build'], GHOST: ['auriga-build'] },
  PROJECT_ROUTE: {
    CHILD: { kind: 'child', childId: 'firefly-events' },
    GHOST: { kind: 'child', childId: 'no-such-child' },
    DARK: { kind: 'child', childId: 'unreachable-child' },
  },
  DEFAULT_LANE: ['auriga-dev'],
  HIVE_LANE: ['auriga-build'],
  PROJECT_IDS: ['LOCAL', 'CHILD', 'GHOST', 'DARK'],
  PROJECT_NAMES: {},
  CAPS: { perCyclePerAgent: 2, perCycleTotal: 5 },
  HUMAN_NAMES: [],
};

const CHILD_BOARDS = {
  'firefly-events': { baseUrl: 'http://firefly-core-api:3012', projectId: 'ff-proj' },
  'unreachable-child': null,
};

// Non-seed story (has a parent) so the planning-lane seed path never applies.
const story = (id, project, num) =>
  ({ id, identifier: id, project_id: project, number: num, status: 'todo', assignee_id: null, title: 'work', parent_issue_id: 'epic' });

// ---- resolveRouteTarget ------------------------------------------------------

test('resolveRouteTarget: a project with an agent lane resolves to that lane', () => {
  assert.deepEqual(core.resolveRouteTarget(story('a', 'LOCAL', 1), CFG, CHILD_BOARDS), { kind: 'agent', lane: ['auriga-build'] });
});

test('resolveRouteTarget: an unmapped project resolves to DEFAULT_LANE', () => {
  assert.deepEqual(core.resolveRouteTarget(story('a', 'ELSEWHERE', 1), CFG, CHILD_BOARDS), { kind: 'agent', lane: ['auriga-dev'] });
});

test('resolveRouteTarget: a child-routed project resolves to the child and its board', () => {
  assert.deepEqual(core.resolveRouteTarget(story('a', 'CHILD', 1), CFG, CHILD_BOARDS), {
    kind: 'child', childId: 'firefly-events', board: CHILD_BOARDS['firefly-events'],
  });
});

test('resolveRouteTarget: an unknown child is rejected to the human path, never an agent lane', () => {
  assert.deepEqual(core.resolveRouteTarget(story('a', 'GHOST', 1), CFG, CHILD_BOARDS), {
    kind: 'human', reason: 'unknown-child', childId: 'no-such-child',
  });
});

test('resolveRouteTarget: a registered child with no reachability config is rejected to the human path', () => {
  assert.deepEqual(core.resolveRouteTarget(story('a', 'DARK', 1), CFG, CHILD_BOARDS), {
    kind: 'human', reason: 'child-unreachable', childId: 'unreachable-child',
  });
});

test('resolveRouteTarget: no childBoards at all (empty topology) rejects every child route', () => {
  assert.equal(core.resolveRouteTarget(story('a', 'CHILD', 1), CFG).kind, 'human');
});

test('resolveRouteTarget: a legacy registry entry (lane array, no route) resolves to its agent lane', () => {
  const legacy = { projects: [{ id: 'OLD', name: 'Old', notes: '', lane: ['auriga-dev'], registered_at: 't' }] };
  const cfg = { ...CFG, PROJECT_LANE: deriveProjectLane(legacy), PROJECT_ROUTE: deriveProjectRoute(legacy) };
  assert.deepEqual(cfg.PROJECT_ROUTE, {});
  assert.deepEqual(core.resolveRouteTarget(story('a', 'OLD', 1), cfg, CHILD_BOARDS), { kind: 'agent', lane: ['auriga-dev'] });
});

test('resolveRouteTarget: a cfg without PROJECT_ROUTE (pre-t016 tenant config) keeps agent routing', () => {
  const { PROJECT_ROUTE: _omit, ...legacyCfg } = CFG;
  assert.equal(core.resolveRouteTarget(story('a', 'CHILD', 1), legacyCfg, CHILD_BOARDS).kind, 'agent');
});

// ---- registry derivation / upsert -------------------------------------------

test('deriveProjectRoute: only child routes are derived; agent/absent routes stay on PROJECT_LANE', () => {
  const data = {
    projects: [
      { id: 'p1', lane: ['x'] },
      { id: 'p2', lane: [], route: { kind: 'child', childId: 'c1' } },
      { id: 'p3', lane: ['y'], route: { kind: 'agent' } },
    ],
  };
  assert.deepEqual(deriveProjectRoute(data), { p2: { kind: 'child', childId: 'c1' } });
  assert.deepEqual(deriveProjectRoute({}), {});
});

test('upsertProject: child sets the route, null clears it, undefined leaves it alone', () => {
  const added = upsertProject({ projects: [] }, { id: 'p', child: 'c1' }, 't0');
  assert.deepEqual(added.projects[0].route, { kind: 'child', childId: 'c1' });
  const untouched = upsertProject(added, { id: 'p', notes: 'n' });
  assert.deepEqual(untouched.projects[0].route, { kind: 'child', childId: 'c1' });
  const cleared = upsertProject(untouched, { id: 'p', child: null });
  assert.equal('route' in cleared.projects[0], false);
  assert.deepEqual(added.projects[0].route, { kind: 'child', childId: 'c1' }, 'pure: input not mutated');
});

// ---- resolveChildBoardConfigs ------------------------------------------------

test('resolveChildBoardConfigs: per-child reachability, AURIGA_CONFIG childBoards override, null when unreachable', () => {
  const topology = {
    parent: null,
    children: [
      { id: 'a', baseUrl: 'http://a', projectId: 'pa' },
      { id: 'b', baseUrl: 'http://b', projectId: 'pb' },
      { id: 'c' },
    ],
  };
  const boards = resolveChildBoardConfigs(topology, { childBoards: { b: { baseUrl: 'http://b2', projectId: 'pb2' } } });
  assert.deepEqual(boards, {
    a: { baseUrl: 'http://a', projectId: 'pa' },
    b: { baseUrl: 'http://b2', projectId: 'pb2' },
    c: null,
  });
  assert.deepEqual(resolveChildBoardConfigs({ parent: null, children: [] }), {});
});

// ---- selectAssignments / cascade ---------------------------------------------

test('selectAssignments: child-routed todos become handDowns and are never dispatched to an agent', () => {
  const picks = core.selectAssignments([story('l1', 'LOCAL', 1), story('c1', 'CHILD', 2)], CFG, {}, { childBoards: CHILD_BOARDS });
  assert.deepEqual(picks.map((p) => p.identifier), ['l1']);
  assert.deepEqual(picks.handDowns, [{ identifier: 'c1', issueId: 'c1', childId: 'firefly-events', board: CHILD_BOARDS['firefly-events'] }]);
  assert.deepEqual(picks.handDownRejected, []);
});

test('selectAssignments: unknown/unreachable child routes are held (handDownRejected), never dispatched', () => {
  const picks = core.selectAssignments([story('g1', 'GHOST', 1), story('d1', 'DARK', 2)], CFG, {}, { childBoards: CHILD_BOARDS });
  assert.equal(picks.length, 0);
  assert.deepEqual(picks.handDowns, []);
  assert.deepEqual(picks.handDownRejected, [
    { identifier: 'g1', issueId: 'g1', childId: 'no-such-child', reason: 'unknown-child' },
    { identifier: 'd1', issueId: 'd1', childId: 'unreachable-child', reason: 'child-unreachable' },
  ]);
});

test('selectAssignments: a child-routed top-level seed is handed down, not sent to the planning lane', () => {
  const seed = { ...story('s1', 'CHILD', 1), parent_issue_id: null, labels: ['idea'] };
  const picks = core.selectAssignments([seed], CFG, {}, { childBoards: CHILD_BOARDS });
  assert.equal(picks.length, 0);
  assert.equal(picks.handDowns.length, 1);
});

test('detectCascadeDispatch: child-routed dependents are never cascade-dispatched to an agent', () => {
  const dep = { ...story('dep', 'LOCAL', 1), status: 'done' };
  const child = { ...story('c1', 'CHILD', 2), metadata: { depends_on: 'dep' } };
  const local = { ...story('l1', 'LOCAL', 3), metadata: { depends_on: 'dep' } };
  const issues = [dep, child, local];
  const statusById = new Map(issues.map((i) => [i.id, i.status]));
  const actions = core.detectCascadeDispatch(issues, new Set(['dep']), statusById, CFG);
  assert.deepEqual(actions.map((a) => a.identifier), ['l1']);
});

// ---- `auriga project add --child` (real spawned CLI, throwaway files) ------

function runCli(args, envOverrides = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN_PATH, ...args], { encoding: 'utf8', env: { ...process.env, ...envOverrides } });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function withTempFiles(topologyChildren, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'auriga-hand-down-'));
  const registryPath = join(dir, 'projects.json');
  const topologyPath = join(dir, 'orchestrator-topology.json');
  writeFileSync(registryPath, JSON.stringify({ dispatch_order: [], projects: [] }) + '\n', 'utf8');
  writeFileSync(topologyPath, JSON.stringify({ parent: null, children: topologyChildren }) + '\n', 'utf8');
  const env = {
    AURIGA_PROJECTS_REGISTRY_PATH: registryPath,
    AURIGA_ORCHESTRATOR_TOPOLOGY_PATH: topologyPath,
    AURIGA_BACKLOG_ADAPTER: 'stub',
    AURIGA_STUB_PROJECT_IDS: 'p1',
  };
  try {
    fn({ env, readRegistry: () => JSON.parse(readFileSync(registryPath, 'utf8')) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI: `project add --child` with a registered child writes the route; `project list` shows it', () => {
  withTempFiles([{ id: 'firefly-events' }], ({ env, readRegistry }) => {
    const result = runCli(['project', 'add', 'p1', '--child', 'firefly-events'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readRegistry().projects[0].route, { kind: 'child', childId: 'firefly-events' });
    assert.match(runCli(['project', 'list'], env).stdout, /lane=child:firefly-events/);

    const cleared = runCli(['project', 'add', 'p1', '--no-child'], env);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal('route' in readRegistry().projects[0], false);
  });
});

test('CLI: `project add --child` with an unknown child fails loudly and writes nothing', () => {
  withTempFiles([], ({ env, readRegistry }) => {
    const result = runCli(['project', 'add', 'p1', '--child', 'nope'], env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a registered child/);
    assert.deepEqual(readRegistry().projects, []);
  });
});

test('CLI: `project add --child` with no value is rejected', () => {
  withTempFiles([{ id: 'x' }], ({ env, readRegistry }) => {
    const result = runCli(['project', 'add', 'p1', '--child'], env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--child requires/);
    assert.deepEqual(readRegistry().projects, []);
  });
});
