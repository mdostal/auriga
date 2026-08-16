// Asserts every method on both pantheon-v2-l2 adapters throws the documented
// NotImplementedError shape (see ../lib/adapters/pantheon-v2-l2/index.mjs and
// its README.md) rather than silently succeeding or returning a
// plausible-looking empty result — the whole point of this stub is that it
// fails loudly if anyone accidentally wires it in as if it were real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPantheonV2L2BacklogAdapter,
  createPantheonV2L2SpawnAdapter,
} from '../lib/adapters/pantheon-v2-l2/index.mjs';

function assertThrowsNotImplemented(fn, label) {
  assert.throws(
    fn,
    (err) => {
      assert.equal(err.name, 'NotImplementedError', `${label}: err.name`);
      assert.match(err.message, /README\.md/, `${label}: err.message should reference README.md`);
      return true;
    },
    label,
  );
}

// ---- BacklogAdapter: every method throws ----

test('createPantheonV2L2BacklogAdapter(): every BacklogAdapter method throws NotImplementedError', () => {
  const backlog = createPantheonV2L2BacklogAdapter();

  assertThrowsNotImplemented(() => backlog.listIssues('any-project'), 'listIssues');
  assertThrowsNotImplemented(() => backlog.listAllProjectIds(), 'listAllProjectIds');
  assertThrowsNotImplemented(() => backlog.getIssueRuns('ANY-1'), 'getIssueRuns');
  assertThrowsNotImplemented(() => backlog.getIssuePullRequests('ANY-1'), 'getIssuePullRequests');
  assertThrowsNotImplemented(() => backlog.setIssueStatus('ANY-1', 'todo'), 'setIssueStatus');
  assertThrowsNotImplemented(() => backlog.commentOnIssue('ANY-1', 'hello'), 'commentOnIssue');
});

// ---- SpawnAdapter: every method throws ----

test('createPantheonV2L2SpawnAdapter(): every SpawnAdapter method throws NotImplementedError', () => {
  const spawn = createPantheonV2L2SpawnAdapter();

  assertThrowsNotImplemented(() => spawn.dispatch({ identifier: 'ANY-1' }, 'some-lane'), 'dispatch');
  assertThrowsNotImplemented(() => spawn.describeLanes(), 'describeLanes');
  assertThrowsNotImplemented(() => spawn.assignIssue('ANY-1', 'some-agent'), 'assignIssue');
  assertThrowsNotImplemented(() => spawn.rerunIssue('ANY-1'), 'rerunIssue');
  assertThrowsNotImplemented(() => spawn.unassignIssue('ANY-1'), 'unassignIssue');
});

// ---- SpawnAdapter: still no provisioning method — see spawn-adapter.mjs's
// header comment. This stub must not add one either. ----

test('createPantheonV2L2SpawnAdapter(): has no provision/createEnvironment/bootstrap method', () => {
  const spawn = createPantheonV2L2SpawnAdapter();
  assert.equal(spawn.provision, undefined);
  assert.equal(spawn.createEnvironment, undefined);
  assert.equal(spawn.bootstrap, undefined);
});
