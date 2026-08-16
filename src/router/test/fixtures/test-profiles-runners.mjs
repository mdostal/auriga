// Shared fixture set: test PROFILES (issue "personas" in various board
// states) and RUNNERS (dispatch-target/lane fixtures). Reused by this
// story's stub-adapters.test.mjs + standalone-smoke.test.mjs, and intended
// for reuse by p2-router-cutover's cutover-e2e test too — keep this file
// generic enough for both, don't couple it to either story's test-only
// assertions.
//
// Reuses real project ids from ../../lib/config.mjs (rather than inventing
// fake ones) so a fixture issue actually routes through the real
// PROJECT_LANE/DEFAULT_LANE tables when driven through cycle().
//
// Covers, per the acceptance criteria, at least one issue in each of:
//   - todo                              (PROFILE_TODO)
//   - in_progress-with-done-run         (PROFILE_IN_PROGRESS_DONE_RUN)
//   - in_review-with-merged-PR          (PROFILE_IN_REVIEW_MERGED_PR)
//   - blocked-with-cleared-dependency   (PROFILE_BLOCKED_CLEARED, whose
//                                        declared dependency is
//                                        PROFILE_DONE_DEPENDENCY, itself done)

import * as cfg from '../../lib/config.mjs';

function projectId(name) {
  const id = Object.entries(cfg.PROJECT_NAMES).find(([, n]) => n === name)?.[0];
  if (!id) throw new Error(`no project id for ${name}`);
  return id;
}

const AURIGA = projectId('Auriga');

// Every profile carries a fake (non-scanned) parent_issue_id so lib/core.mjs's
// isSeed() never misclassifies one of these as an un-planned top-level seed —
// that classification isn't what these fixtures are exercising.
const FAKE_PARENT_ID = 'fixture-epic-1';

function makeIssue(overrides = {}) {
  return {
    id: overrides.identifier ? `id-${overrides.identifier}` : 'id-unknown',
    identifier: 'STUB-0',
    number: 0,
    title: 'untitled fixture issue',
    description: '',
    labels: [],
    status: 'todo',
    assignee_id: null,
    parent_issue_id: FAKE_PARENT_ID,
    project_id: AURIGA,
    metadata: {},
    ...overrides,
  };
}

// ---- state: todo ------------------------------------------------------
export const PROFILE_TODO = makeIssue({
  id: 'stub-issue-todo',
  identifier: 'STUB-100',
  number: 100,
  title: 'Add retry backoff to the fetch client',
});

// ---- state: in_progress, with a DONE run -------------------------------
export const PROFILE_IN_PROGRESS_DONE_RUN = makeIssue({
  id: 'stub-issue-inprogress',
  identifier: 'STUB-101',
  number: 101,
  title: 'Cache layer for pricing lookups',
  status: 'in_progress',
  assignee_id: cfg.AGENTS['auriga-dev'].id,
});

// ---- state: in_review, with a MERGED PR --------------------------------
export const PROFILE_IN_REVIEW_MERGED_PR = makeIssue({
  id: 'stub-issue-inreview',
  identifier: 'STUB-102',
  number: 102,
  title: 'Ship the websocket reconnect handler',
  status: 'in_review',
});

// ---- state: done — the dependency PROFILE_BLOCKED_CLEARED clears on -----
export const PROFILE_DONE_DEPENDENCY = makeIssue({
  id: 'stub-issue-done-dependency',
  identifier: 'STUB-103',
  number: 103,
  title: 'Foundational schema migration',
  status: 'done',
});

// ---- state: blocked, with a now-CLEARED dependency -----------------------
export const PROFILE_BLOCKED_CLEARED = makeIssue({
  id: 'stub-issue-blocked',
  identifier: 'STUB-104',
  number: 104,
  title: 'Build the report view on the new schema',
  status: 'blocked',
  metadata: { depends_on: PROFILE_DONE_DEPENDENCY.id },
});

export const ALL_PROFILES = [
  PROFILE_TODO,
  PROFILE_IN_PROGRESS_DONE_RUN,
  PROFILE_IN_REVIEW_MERGED_PR,
  PROFILE_DONE_DEPENDENCY,
  PROFILE_BLOCKED_CLEARED,
];

// runsByIdentifier: recent timestamps so a synthesized "done" run never also
// reads as a stale zombie (lib/core.mjs's zombieStaleMs default is 20 min).
const now = new Date().toISOString();
export const RUNS_BY_IDENTIFIER = {
  [PROFILE_IN_PROGRESS_DONE_RUN.identifier]: [
    { status: 'done', created_at: now, dispatched_at: now, completed_at: now },
  ],
};

export const PULL_REQUESTS_BY_IDENTIFIER = {
  [PROFILE_IN_REVIEW_MERGED_PR.identifier]: [
    {
      number: 1,
      title: PROFILE_IN_REVIEW_MERGED_PR.title,
      headRefName: `feat/${PROFILE_IN_REVIEW_MERGED_PR.identifier.toLowerCase()}`,
      state: 'merged',
      merged_at: now,
      url: `https://github.com/mdostal/auriga/pull/1`,
    },
  ],
};

// RUNNERS: dispatch-target/lane fixtures, independent of any concrete
// SpawnAdapter's own hardcoded describeLanes() default — a shared,
// reusable shape for tests that want to assert against a lane map without
// depending on a specific stub's internals.
export const RUNNERS = Object.freeze({
  'stub-build-lane': Object.freeze({ agents: ['stub-dev-1', 'stub-dev-2'], runtime: 'stub-build' }),
  'stub-review-lane': Object.freeze({ agents: ['stub-reviewer-1'], runtime: 'stub-review' }),
});
