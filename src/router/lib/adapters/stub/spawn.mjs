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
//
// dispatch() return shape matches createMulticaSpawnAdapter's real dispatch()
// (see ../multica/spawn.mjs): { identifier, lane, assigned, started,
// forcedRerun, runStatus?, runtimeId?, assignError?, rerunError? } — fixed as
// a follow-up to the p2-adapter-interface epic, which shipped this stub
// returning the incompatible `{ ok: true, lane }` and left dispatch()
// unwired from auriga-router.mjs's live "route new todos" path for exactly
// that reason. This stub has no real "did a run start" concept of its own
// (no external run history to check), so it always simulates an immediate,
// successful, already-started dispatch — never forcing a rerun — which is
// the same "assign implies a run appears" simplification
// test/support/mock-mca.mjs's mock and test/router-cycle.e2e.test.mjs's own
// mock adapters already use for the identical reason.

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
      const identifier = issue && issue.identifier;
      return {
        identifier, lane, assigned: true, started: true, forcedRerun: false,
        runStatus: 'in_progress', runtimeId: null,
      };
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
