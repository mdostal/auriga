// Proves that the router cycle makes zero GitHub API calls.
// After PANT-717, listCandidatePullRequests (which hit /api/github/repos and
// /api/github/repos/:owner/:repo/pulls on every ~76s cycle) was removed from
// the router and the backlog adapter entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPantheonV2L2BacklogAdapter } from '../lib/adapters/pantheon-v2-l2/index.mjs';
import { cycle } from '../auriga-router.mjs';
import * as cfg from '../lib/config.mjs';

test('createPantheonV2L2BacklogAdapter has no listCandidatePullRequests method', () => {
  const adapter = createPantheonV2L2BacklogAdapter({ exec: () => '{}' });
  assert.equal(typeof adapter.listCandidatePullRequests, 'undefined',
    'listCandidatePullRequests must be removed from the backlog adapter');
});

test('cycle() never calls listCandidatePullRequests even when the backlog adapter provides it', async () => {
  let githubCallCount = 0;
  const backlog = {
    listAllProjectIds: () => [],
    listAllIssues: () => [],
    getIssueRuns: () => [],
    getIssuePullRequests: () => [],
    setIssueStatus: () => {},
    commentOnIssue: () => {},
    // If listCandidatePullRequests is still present on the adapter and called, record it
    listCandidatePullRequests: () => { githubCallCount++; return []; },
  };
  const spawn = {
    assignIssue: () => {},
    rerunIssue: () => {},
    unassignIssue: () => {},
    describeLanes: () => ({}),
  };

  await cycle({ backlog, spawn, cfg, log: () => {}, sleep: async () => {} });

  assert.equal(githubCallCount, 0, `cycle() must not call listCandidatePullRequests, but it was called ${githubCallCount} time(s)`);
});
