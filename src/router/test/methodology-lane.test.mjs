// PANT-997 — methodology-aware DEFAULT_LANE (VISION.md ②). A non-PROJECT_LANE
// story that declares a methodology or skill its default lane can't run is
// routed to an agent that can, instead of the flat DEFAULT_LANE spread.
// Pure-function coverage (declaredRequirements, methodologyFallbackLane) plus
// the chooseAgentForProject / selectAssignments wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';
import * as realCfg from '../lib/config.mjs';

const CFG = {
  AGENTS: {
    'auriga-build': { id: 'AB', runtime: 'claude', maxInflight: 2 },
    'mnemosyne-dev': { id: 'MN', runtime: 'claude', maxInflight: 2 },
    'auriga-dev': { id: 'A', runtime: 'codex', maxInflight: 3 },
    'heimdall-dev-codex': { id: 'H', runtime: 'codex', maxInflight: 3 },
  },
  RUNTIME_CAP: { claude: 4, codex: 4 },
  RUNTIME_CAPABILITIES: { claude: ['hive', 'classic', 'tdd', 'bdd'], codex: [] },
  PROJECT_LANE: { MAPPED: ['heimdall-dev-codex'] },
  PROJECT_ROUTE: {},
  DEFAULT_LANE: ['auriga-dev', 'heimdall-dev-codex'],
  HIVE_LANE: ['auriga-build', 'mnemosyne-dev'],
  PROJECT_IDS: ['UNMAPPED', 'MAPPED'],
  PROJECT_NAMES: {},
  CAPS: { perCyclePerAgent: 5, perCycleTotal: 10 },
  HUMAN_NAMES: [],
};

// Non-seed (has a parent) so the planning-lane seed path never applies.
const story = (id, description = '', extra = {}) => ({
  id, identifier: id, project_id: 'UNMAPPED', number: 1, status: 'todo', assignee_id: null,
  title: 'work', parent_issue_id: 'epic', description, ...extra,
});

const pick = (issue, cfg = CFG, trace = {}) => core.chooseAgentForProject(
  issue.project_id, cfg, {}, {}, { perAgent: {}, perRuntime: {}, perAgentCycle: {} },
  false, new Set(), Infinity, trace, issue,
);

// ---- declaredRequirements ----------------------------------------------------

test('declaredRequirements: nothing declared -> []', () => {
  assert.deepEqual(core.declaredRequirements(story('a', 'Fix the thing.')), []);
  assert.deepEqual(core.declaredRequirements({}), []);
});

test('declaredRequirements: a methodology line, lowercased', () => {
  assert.deepEqual(core.declaredRequirements(story('a', 'target_repo: x\nmethodology: TDD\n')), ['tdd']);
});

test('declaredRequirements: skills as inline list, bracket list, block list and single skill', () => {
  assert.deepEqual(core.declaredRequirements(story('a', 'skills: hive, dataviz\n')), ['dataviz', 'hive']);
  assert.deepEqual(core.declaredRequirements(story('a', 'skills: [hive, dataviz]\n')), ['dataviz', 'hive']);
  assert.deepEqual(core.declaredRequirements(story('a', 'skills:\n  - hive\n  - dataviz\nnotes: x\n  - not-a-skill\n')), ['dataviz', 'hive']);
  assert.deepEqual(core.declaredRequirements(story('a', 'skill: hive\n')), ['hive']);
});

test('declaredRequirements: methodology:/skill: labels, string or object form', () => {
  const issue = story('a', '', { labels: ['methodology:bdd', { name: 'skill:hive' }, 'story'] });
  assert.deepEqual(core.declaredRequirements(issue), ['bdd', 'hive']);
});

test('declaredRequirements: prose mentioning "methodology" mid-line is not a declaration', () => {
  assert.deepEqual(core.declaredRequirements(story('a', 'We discussed the methodology: tdd was rejected.')), []);
});

// ---- agentCapabilities -------------------------------------------------------

test('agentCapabilities: runtime list by default, an agent\'s own list overrides it', () => {
  assert.deepEqual(core.agentCapabilities('auriga-build', CFG), ['hive', 'classic', 'tdd', 'bdd']);
  assert.deepEqual(core.agentCapabilities('auriga-dev', CFG), []);
  const cfg = { ...CFG, AGENTS: { ...CFG.AGENTS, 'auriga-dev': { ...CFG.AGENTS['auriga-dev'], capabilities: ['TDD'] } } };
  assert.deepEqual(core.agentCapabilities('auriga-dev', cfg), ['tdd']);
  assert.deepEqual(core.agentCapabilities('no-such-agent', CFG), []);
});

// ---- methodologyFallbackLane -------------------------------------------------

test('methodologyFallbackLane: nothing declared -> DEFAULT_LANE unchanged', () => {
  assert.deepEqual(core.methodologyFallbackLane(story('a', 'Fix it.'), CFG),
    { lane: ['auriga-dev', 'heimdall-dev-codex'], reason: 'default_lane', required: [] });
});

test('methodologyFallbackLane: a methodology codex can\'t run -> the capable hive agents', () => {
  assert.deepEqual(core.methodologyFallbackLane(story('a', 'methodology: tdd\n'), CFG),
    { lane: ['auriga-build', 'mnemosyne-dev'], reason: 'methodology_lane', required: ['tdd'] });
});

test('methodologyFallbackLane: a capable DEFAULT_LANE agent keeps its place ahead of HIVE_LANE', () => {
  const cfg = { ...CFG, AGENTS: { ...CFG.AGENTS, 'heimdall-dev-codex': { ...CFG.AGENTS['heimdall-dev-codex'], capabilities: ['tdd'] } } };
  assert.deepEqual(core.methodologyFallbackLane(story('a', 'methodology: tdd\n'), cfg).lane,
    ['heimdall-dev-codex', 'auriga-build', 'mnemosyne-dev']);
});

test('methodologyFallbackLane: every DEFAULT_LANE agent capable -> DEFAULT_LANE unchanged', () => {
  const cfg = { ...CFG, RUNTIME_CAPABILITIES: { ...CFG.RUNTIME_CAPABILITIES, codex: ['tdd'] } };
  assert.deepEqual(core.methodologyFallbackLane(story('a', 'methodology: tdd\n'), cfg),
    { lane: ['auriga-dev', 'heimdall-dev-codex'], reason: 'default_lane', required: ['tdd'] });
});

test('methodologyFallbackLane: a requirement no agent declares is ignored, not stranded', () => {
  assert.deepEqual(core.methodologyFallbackLane(story('a', 'methodology: waterfall\n'), CFG),
    { lane: ['auriga-dev', 'heimdall-dev-codex'], reason: 'default_lane', required: [] });
});

test('methodologyFallbackLane: every declared requirement must be met by the same agent', () => {
  const cfg = { ...CFG, AGENTS: { ...CFG.AGENTS, 'mnemosyne-dev': { ...CFG.AGENTS['mnemosyne-dev'], capabilities: ['tdd', 'dataviz'] } } };
  assert.deepEqual(core.methodologyFallbackLane(story('a', 'methodology: tdd\nskills: dataviz\n'), cfg).lane, ['mnemosyne-dev']);
});

test('methodologyFallbackLane: known requirement but no capable DEFAULT/HIVE agent -> no_capable_lane', () => {
  // consus-dev can run it but sits in neither lane; the router must not pick it.
  const cfg = { ...CFG, AGENTS: { ...CFG.AGENTS, 'consus-dev': { id: 'C', runtime: 'claude', capabilities: ['dataviz'] } } };
  assert.deepEqual(core.methodologyFallbackLane(story('a', 'skills: dataviz\n'), cfg),
    { lane: [], reason: 'no_capable_lane', required: ['dataviz'] });
});

// ---- chooseAgentForProject wiring ---------------------------------------------

test('chooseAgentForProject: a methodology story on an unmapped project lands on a capable agent', () => {
  const trace = {};
  assert.equal(pick(story('a', 'methodology: classic\n'), CFG, trace), 'auriga-build');
  assert.equal(trace.reason, 'methodology_lane');
  assert.deepEqual(trace.candidates.map((c) => c.agent), ['auriga-build', 'mnemosyne-dev']);
});

test('chooseAgentForProject: a plain story still spreads across DEFAULT_LANE', () => {
  const trace = {};
  assert.equal(pick(story('a', 'Fix it.'), CFG, trace), 'auriga-dev');
  assert.equal(trace.reason, 'default_lane');
});

test('chooseAgentForProject: PROJECT_LANE still wins over the methodology fallback', () => {
  const trace = {};
  assert.equal(pick(story('a', 'methodology: tdd\n', { project_id: 'MAPPED' }), CFG, trace), 'heimdall-dev-codex');
  assert.equal(trace.reason, 'project_lane');
});

test('chooseAgentForProject: without an issue the plain DEFAULT_LANE is used (old call shape)', () => {
  const trace = {};
  const agent = core.chooseAgentForProject('UNMAPPED', CFG, {}, {}, { perAgent: {}, perRuntime: {} }, false, new Set(), Infinity, trace);
  assert.equal(agent, 'auriga-dev');
  assert.equal(trace.reason, 'default_lane');
});

test('chooseAgentForProject: no capable lane -> null with reason no_capable_lane', () => {
  const cfg = { ...CFG, AGENTS: { ...CFG.AGENTS, 'consus-dev': { id: 'C', runtime: 'claude', capabilities: ['dataviz'] } } };
  const trace = {};
  assert.equal(pick(story('a', 'skills: dataviz\n'), cfg, trace), null);
  assert.equal(trace.reason, 'no_capable_lane');
  assert.deepEqual(trace.candidates, []);
});

// ---- selectAssignments wiring --------------------------------------------------

test('selectAssignments: methodology story -> capable agent; plain story -> DEFAULT_LANE', () => {
  const tdd = story('TDD-1', 'methodology: tdd\n');
  assert.equal(core.isHiveStory(tdd), false, 'fixture must not already be a full hive story');
  const out = core.selectAssignments([tdd, story('PLAIN-2', 'Fix it.', { number: 2 })], CFG, {});
  const byId = Object.fromEntries(out.map((a) => [a.identifier, a]));
  assert.equal(byId['TDD-1'].agent, 'auriga-build');
  assert.equal(byId['TDD-1'].decisionReason, 'methodology_lane');
  assert.equal(byId['PLAIN-2'].agent, 'auriga-dev');
  assert.equal(byId['PLAIN-2'].decisionReason, 'default_lane');
});

test('selectAssignments: no capable lane -> the story is held, not sent to codex', () => {
  const cfg = { ...CFG, AGENTS: { ...CFG.AGENTS, 'consus-dev': { id: 'C', runtime: 'claude', capabilities: ['dataviz'] } } };
  assert.deepEqual(core.selectAssignments([story('VIZ-1', 'skills: dataviz\n')], cfg, {}).map((a) => a.agent), []);
});

// ---- real default config -------------------------------------------------------

test('default config: a tdd story with no project lane routes to a HIVE_LANE agent, never codex', () => {
  assert.ok(realCfg.RUNTIME_CAPABILITIES.claude.includes('hive'));
  const { lane, reason } = core.methodologyFallbackLane(story('a', 'methodology: tdd\n'), realCfg);
  assert.equal(reason, 'methodology_lane');
  assert.ok(lane.length > 0);
  for (const name of lane) {
    assert.ok(realCfg.HIVE_LANE.includes(name), `${name} should be a hive lane agent`);
    assert.notEqual(realCfg.AGENTS[name].runtime, 'codex');
  }
});
