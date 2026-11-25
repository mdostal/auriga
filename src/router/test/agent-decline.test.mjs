// PANT-1459 (pantheon-v2#598): assigned_idle must not re-run a ticket its
// assignee already declined, nor one whose last N runs delivered nothing, nor a
// founder-claimed ticket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

const CFG = {
  AGENTS: { 'flayr-build': { id: 'B', runtime: 'claude', maxInflight: 2 } },
  RUNTIME_CAP: { claude: 2 },
  PROJECT_NAMES: {},
  CAPS: { assignedIdleStaleMs: 30 * 60 * 1000, assignedIdlePerCycle: 5, zombieStaleMs: 20 * 60 * 1000 },
  HUMAN_NAMES: ['mathew', 'dostal'],
};
const NOW = 1_700_000_000_000;
const H = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const todo = (extra = {}) => ({
  id: 'FFE-880', identifier: 'FFE-880', status: 'todo', assignee_id: 'B',
  created_at: iso(NOW - 48 * H), parent_issue_id: 'EPIC', title: 'epic', description: 'work', ...extra,
});
const run = (agoMs, output, extra = {}) => ({
  agent_id: 'B', status: 'completed', created_at: iso(NOW - agoMs), started_at: iso(NOW - agoMs),
  completed_at: iso(NOW - agoMs + 25_000), result: { output }, ...extra,
});
const detect = (issue, runs, cfg = CFG) =>
  core.detectAssignedIdle([issue], { [issue.identifier]: runs }, cfg, core.agentIdSet(cfg.AGENTS), NOW);

test('a ticket whose latest run declined it is unassigned and parked, not re-run', () => {
  const actions = detect(todo(), [run(H, 'Routed to me again. Nothing has changed since my comment at 08:48.')]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'unassign');
  assert.equal(actions[0].reason, 'assigned-idle-agent-declined');
  assert.equal(actions[0].park, true);
});

test('decline phrasing variants are recognised (curly apostrophes too)', () => {
  for (const out of [
    "Claimed by the founder, so I'm not picking this up.",
    'I won’t pick this up: the description says don’t pick this up.',
    'Declining this ticket; it is a backlog epic.',
  ]) assert.ok(core.isDeclinedRun(run(H, out), NOW), out);
  assert.equal(core.isDeclinedRun(run(H, 'Opened https://github.com/o/r/pull/12 and set in_review.'), NOW), false);
});

test('a failed run never counts as a decline', () => {
  const r = run(H, 'Routed to me again.', { status: 'failed', error: 'boom' });
  assert.equal(core.isDeclinedRun(r, NOW), false);
  assert.equal(detect(todo(), [r])[0].action, 'start');
});

test('last N completed runs with no PR/push/commit -> no-progress park', () => {
  const runs = [run(3 * H, 'Looked around, unclear scope.'), run(2 * H, 'Still unclear.'), run(H, 'Same as before.')];
  const a = detect(todo(), runs);
  assert.equal(a[0].action, 'unassign');
  assert.equal(a[0].reason, 'assigned-idle-no-progress');
  assert.equal(a[0].noProgressRuns, 3);
});

test('fewer than N quiet runs, or any run with a PR, still re-runs', () => {
  assert.equal(detect(todo(), [run(2 * H, 'unclear'), run(H, 'unclear')])[0].action, 'start');
  const runs = [run(3 * H, 'Opened https://github.com/o/r/pull/7'), run(2 * H, 'unclear'), run(H, 'unclear')];
  assert.equal(detect(todo(), runs)[0].action, 'start');
});

test('assignedIdleNoProgressRuns: 0 turns the no-progress rule off', () => {
  const cfg = { ...CFG, CAPS: { ...CFG.CAPS, assignedIdleNoProgressRuns: 0 } };
  const runs = [run(3 * H, 'a'), run(2 * H, 'b'), run(H, 'c')];
  assert.equal(detect(todo(), runs, cfg)[0].action, 'start');
});

test("other agents' runs and provider-limit failures are ignored", () => {
  const runs = [
    run(4 * H, 'Routed to me again.', { agent_id: 'OTHER' }),
    run(30 * 60 * 1000 + 60_000, '', { status: 'failed', error: "You've hit your session limit · resets 9pm (UTC)" }),
  ];
  const a = detect(todo(), runs);
  assert.equal(a.length, 0, 'quota hold, no rerun and no park');
  assert.equal(detect(todo(), [run(4 * H, 'Routed to me again.', { agent_id: 'OTHER' })])[0].action, 'start');
});

test('runs before the last park are not counted again', () => {
  const issue = todo({ metadata: { assigned_idle_parked_at: iso(NOW - 2 * H) } });
  assert.equal(detect(issue, [run(3 * H, 'Routed to me again.')])[0].action, 'start');
  assert.equal(detect(issue, [run(H, 'Routed to me again.')])[0].action, 'unassign');
});

test('founder-claimed tickets are skipped by assigned_idle and by fresh routing', () => {
  const desc = 'Backlog epic. Claimed by Mathew, don’t pick this up.';
  assert.equal(core.isFounderClaimed({ description: desc }, CFG), true);
  assert.equal(detect(todo({ description: desc }), []).length, 0);
  const cfg = { ...CFG, FOUNDER_CLAIM_MARKERS: ['founder-owned'] };
  assert.equal(core.isFounderClaimed({ description: 'FOUNDER-OWNED epic' }, cfg), true);
  assert.equal(core.isFounderClaimed({ description: 'FOUNDER-OWNED epic' }, { HUMAN_NAMES: [] }), false);
  assert.equal(core.isFounderClaimed({ description: 'founder-owned', }, { founder_claim_markers: ['founder-owned'] }), true);
  assert.equal(core.isHumanTodo({ description: desc }, CFG), true);
});

test('the router-written park reasons go stale once a human moves the ticket off blocked', () => {
  const parked = { status: 'blocked', metadata: { blocked_reason: 'assigned-idle-agent-declined' } };
  assert.equal(core.isAgentParked(parked), true);
  assert.equal(core.isAgentParked({ ...parked, status: 'todo' }), false);
});
