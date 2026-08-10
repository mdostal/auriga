import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

// The dispatch-aligned project set used by the cascade selector. Any two ids work;
// the point is that a candidate OUTSIDE this set is never cascaded.
const cfg = { PROJECT_IDS: ['PROJ'], HUMAN_NAMES: ['mathew', 'dostal'] };

function statusMap(issues) {
  return new Map(issues.map((i) => [i.id, (i.status || '').toLowerCase()]));
}

test('cascade: a completed parent enqueues its blocked dependent (metadata dep)', () => {
  const parent = { id: 'A', identifier: 'PAN-1', project_id: 'PROJ', status: 'done', title: 'parent' };
  const child = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', status: 'blocked', title: 'child', metadata: { depends_on: 'A' } };
  const issues = [parent, child];
  const acts = core.detectCascadeDispatch(issues, new Set(['A']), statusMap(issues), cfg);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].identifier, 'PAN-2');
  assert.equal(acts[0].status, 'blocked');
  assert.equal(acts[0].action, 'cascade-enqueue');
});

test('cascade: also enqueues a TODO dependent whose deps are now satisfied', () => {
  const parent = { id: 'A', identifier: 'PAN-1', project_id: 'PROJ', status: 'done', title: 'parent' };
  const child = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', status: 'todo', title: 'child', metadata: { depends_on: 'A' } };
  const issues = [parent, child];
  const acts = core.detectCascadeDispatch(issues, new Set(['A']), statusMap(issues), cfg);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].status, 'todo');
});

test('cascade: does NOT enqueue while a sibling dep is still unmet (genuine gate)', () => {
  const doneParent = { id: 'A', identifier: 'PAN-1', project_id: 'PROJ', status: 'done', title: 'p1' };
  const openParent = { id: 'C', identifier: 'PAN-3', project_id: 'PROJ', status: 'todo', title: 'p2' };
  const child = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', status: 'blocked', title: 'child', metadata: { depends_on: 'A,C' } };
  const issues = [doneParent, openParent, child];
  const acts = core.detectCascadeDispatch(issues, new Set(['A']), statusMap(issues), cfg);
  assert.equal(acts.length, 0, 'child must stay blocked until BOTH deps are done');
});

test('cascade: resolves a DESCRIPTION slug dep against a sibling (short-key form)', () => {
  const parent = 'EPIC';
  const m01 = { id: 'A', identifier: 'PAN-1', project_id: 'PROJ', parent_issue_id: parent, status: 'done', title: '[m-01-core] core' };
  const m02 = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', parent_issue_id: parent, status: 'blocked', title: '[m-02-file] file', metadata: {}, description: 'depends_on: [m-01-core]\n' };
  const issues = [m01, m02];
  const acts = core.detectCascadeDispatch(issues, new Set(['A']), statusMap(issues), cfg);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].identifier, 'PAN-2');
});

test('cascade: p1-* slug dep resolves by EXACT id, and a shared "p1" short key never false-resolves', () => {
  const parent = 'EPIC';
  // Two p1-* siblings both parse to the shared short key "p1"; the dep names ONE of
  // them by full slug. Only the exact-id match may resolve — a non-unique short key
  // must be rejected (the false-unblock guard).
  const capRouting = {
    id: 'A', identifier: 'PAN-1', project_id: 'PROJ', parent_issue_id: parent, status: 'done',
    title: '[p1-router-capability-routing] cap routing', description: 'id: p1-router-capability-routing\n',
  };
  const stateMachine = {
    id: 'C', identifier: 'PAN-3', project_id: 'PROJ', parent_issue_id: parent, status: 'blocked',
    title: '[p1-state-machine] sm', description: 'id: p1-state-machine\n',
  };
  const child = {
    id: 'B', identifier: 'PAN-2', project_id: 'PROJ', parent_issue_id: parent, status: 'blocked',
    title: '[p1-triage] triage', description: 'id: p1-triage\ndepends_on: [p1-router-capability-routing, p1-state-machine]\n',
  };
  const issues = [capRouting, stateMachine, child];
  // Only capRouting (A) is done; state-machine (C) still blocked -> child must NOT cascade,
  // even though the shared "p1" short key collides.
  let acts = core.detectCascadeDispatch(issues, new Set(['A']), statusMap(issues), cfg);
  assert.equal(acts.length, 0, 'exact-id dep on the not-done p1 sibling must still block');
  // Now finish the state-machine too -> child cascades.
  const done2 = issues.map((i) => (i.id === 'C' ? { ...i, status: 'done' } : i));
  acts = core.detectCascadeDispatch(done2, new Set(['A', 'C']), statusMap(done2), cfg);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].identifier, 'PAN-2');
});

test('cascade: never touches a dependent in an UNALIGNED project', () => {
  const parent = { id: 'A', identifier: 'PAN-1', project_id: 'PROJ', status: 'done', title: 'p' };
  const child = { id: 'B', identifier: 'PAN-2', project_id: 'OTHER', status: 'blocked', title: 'c', metadata: { depends_on: 'A' } };
  const issues = [parent, child];
  assert.equal(core.detectCascadeDispatch(issues, new Set(['A']), statusMap(issues), cfg).length, 0);
});

test('cascade: never re-fires an in_progress / in_review dependent (no double-dispatch)', () => {
  const parent = { id: 'A', identifier: 'PAN-1', project_id: 'PROJ', status: 'done', title: 'p' };
  const running = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', status: 'in_progress', title: 'c', metadata: { depends_on: 'A' } };
  const reviewing = { id: 'D', identifier: 'PAN-4', project_id: 'PROJ', status: 'in_review', title: 'c2', metadata: { depends_on: 'A' } };
  const issues = [parent, running, reviewing];
  assert.equal(core.detectCascadeDispatch(issues, new Set(['A']), statusMap(issues), cfg).length, 0);
});

test('cascade: a dependent with NO declared deps is left alone', () => {
  const parent = { id: 'A', identifier: 'PAN-1', project_id: 'PROJ', status: 'done', title: 'p' };
  const orphan = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', status: 'blocked', title: 'human-parked', metadata: {} };
  const issues = [parent, orphan];
  assert.equal(core.detectCascadeDispatch(issues, new Set(['A']), statusMap(issues), cfg).length, 0);
});

test('cascade: empty completed set -> no actions', () => {
  const child = { id: 'B', identifier: 'PAN-2', project_id: 'PROJ', status: 'blocked', title: 'c', metadata: { depends_on: 'A' } };
  assert.equal(core.detectCascadeDispatch([child], new Set(), statusMap([child]), cfg).length, 0);
});

test('resolveDepSibling: rejects a non-unique short key, accepts a unique one', () => {
  const a = { id: 'A', title: '[p1-alpha] a', description: 'id: p1-alpha\n' };
  const b = { id: 'B', title: '[p1-beta] b', description: 'id: p1-beta\n' };
  // both parse to short key "p1" -> ambiguous -> null
  assert.equal(core.resolveDepSibling('p1-alpha', [a, b]), a); // exact id still wins
  assert.equal(core.resolveDepSibling('p1-gamma', [a, b]), null); // no exact id, short key ambiguous
  // unique short key resolves
  const m = { id: 'M', title: '[m-01-core] c' };
  assert.equal(core.resolveDepSibling('m-01-core', [m, a]), m);
});

test('dependsOnAny: metadata id dep and slug dep both detected against the completed set', () => {
  const parent = 'EPIC';
  const dep = { id: 'A', parent_issue_id: parent, title: '[m-01-core] c' };
  const metaChild = { id: 'B', parent_issue_id: parent, metadata: { depends_on: 'A' } };
  const slugChild = { id: 'C', parent_issue_id: parent, description: 'depends_on: [m-01-core]\n' };
  assert.equal(core.dependsOnAny(metaChild, new Set(['A']), [dep, metaChild]), true);
  assert.equal(core.dependsOnAny(slugChild, new Set(['A']), [dep, slugChild]), true);
  assert.equal(core.dependsOnAny(metaChild, new Set(['Z']), [dep, metaChild]), false);
});
