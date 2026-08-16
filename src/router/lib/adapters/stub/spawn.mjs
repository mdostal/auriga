// In-memory stub implementation of SpawnAdapter (see ../spawn-adapter.mjs).
// Plain factory function, no class. Records every call it receives into
// `.calls` (array of { method, args }) so a test can assert on exactly what
// was dispatched/assigned/rerun/unassigned without a live runner — mirrors
// test/support/mock-mca.mjs's `.calls` tracking pattern.
//
// describeLanes() returns a small hardcoded fixture lane map. This stub is
// deliberately NOT wired to test/fixtures/test-profiles-runners.mjs's RUNNERS
// fixture — production/stub code under lib/ must not depend on anything
// under test/, even a fixture file. RUNNERS is a separate, independently
// defined fixture for tests that want a richer or differently-shaped lane
// map than this stub's own default.

/**
 * @returns {import('../spawn-adapter.mjs').SpawnAdapter}
 */
export function createStubSpawnAdapter() {
  const calls = [];
  const record = (method, args) => { calls.push({ method, args }); };

  const LANES = Object.freeze({
    'stub-build-lane': Object.freeze({ agents: ['stub-dev-1', 'stub-dev-2'], runtime: 'stub-build' }),
    'stub-review-lane': Object.freeze({ agents: ['stub-reviewer-1'], runtime: 'stub-review' }),
  });

  return Object.freeze({
    calls,

    dispatch(issue, lane) {
      record('dispatch', { issue, lane });
      return { ok: true, lane };
    },

    describeLanes() {
      return LANES;
    },

    assignIssue(id, agent) {
      record('assignIssue', { id, agent });
    },

    rerunIssue(id) {
      record('rerunIssue', { id });
    },

    unassignIssue(id) {
      record('unassignIssue', { id });
    },
  });
}
