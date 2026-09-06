// Shared dispatch()/describeLanes() logic, factored out of
// multica/spawn.mjs and pantheon-v2-l2/index.mjs, which each carried a
// byte-identical private copy (pantheon-v2-l2's own header comment admitted
// it was a "behavior-preserving port of multica/spawn.mjs's own dispatch()").
// Same drift risk already found and fixed once for the backlog-side gh-CLI
// helpers (github-cli.mjs, t008) and for GH #81's PR-state casing check
// (github-pr-state.mjs) — two hand-copies of the same logic is exactly the
// shape that let a real bug (the missing gh-CLI timeout) exist in only one
// copy for a while.
//
// dispatch()/describeLanes() themselves are 100% transport-agnostic
// orchestration: the only per-adapter difference is HOW assignIssue/
// rerunIssue/getIssueRuns talk to the outside world (multica CLI vs
// pantheon-v2-l2 HTTP) — the assign -> verify-a-run-started -> force-rerun
// sequence and the lane-map shape are identical. Dependencies are injected
// (never imported here), matching this directory's established convention
// (cli-runner.mjs, github-cli.mjs) so each adapter keeps supplying its own
// already-tested assignIssue/rerunIssue/getIssueRuns.

import { classifyRun, latestRun } from '../run-classification.mjs';

/**
 * Builds the assign -> verify-a-run-started -> force-rerun dispatch()
 * ported byte-identically from both multica/spawn.mjs and
 * pantheon-v2-l2/index.mjs. `assign` is wrapped so an assign failure
 * short-circuits (skips verify) instead of throwing out of dispatch(); a
 * rerun failure is caught (not propagated), matching auriga-router.mjs's
 * own cycle() "route new todos" try/catch shape.
 * @param {{
 *   assignIssue: (identifier: string, agentName: string) => any,
 *   rerunIssue: (identifier: string) => any,
 *   getIssueRuns: (identifier: string) => any[],
 *   sleep: (ms: number) => void,
 *   verifyDelayMs: number,
 * }} deps
 * @returns {(issue: object, lane: string) => object}
 */
export function makeDispatch({ assignIssue, rerunIssue, getIssueRuns, sleep, verifyDelayMs }) {
  return function dispatch(issue, lane) {
    const identifier = issue && issue.identifier;

    try {
      assignIssue(identifier, lane);
    } catch (e) {
      return { identifier, lane, assigned: false, assignError: e.message, started: false, forcedRerun: false };
    }

    sleep(verifyDelayMs);

    const runs = getIssueRuns(identifier);
    const now = Date.now();
    const started = runs.some((r) => {
      const c = classifyRun(r, now);
      return c.active || c.done || c.failed; // any run row means it dispatched
    });

    if (!started) {
      const result = { identifier, lane, assigned: true, started: false, forcedRerun: true };
      try {
        rerunIssue(identifier);
      } catch (e) {
        result.rerunError = e.message;
      }
      return result;
    }

    const lr = latestRun(runs);
    const c = lr ? classifyRun(lr, now) : {};
    return {
      identifier, lane, assigned: true, started: true, forcedRerun: false,
      runStatus: c.status, runtimeId: lr && lr.runtime_id,
    };
  };
}

/**
 * The runner-side analog of lib/config-substrate.mjs's PROJECT_LANE/
 * HIVE_LANE/DEFAULT_LANE/REVIEW_LANE tables, assembled alongside
 * RUNTIME_CAP into one LaneMap — identical shape in both adapters.
 * @param {{
 *   projectLane: object, defaultLane: string[], hiveLane: string[],
 *   reviewLane: string[], runtimeCap: object,
 * }} lanes
 * @returns {() => object}
 */
export function makeDescribeLanes({ projectLane, defaultLane, hiveLane, reviewLane, runtimeCap }) {
  return function describeLanes() {
    return {
      projectLane,
      defaultLane,
      hiveLane,
      reviewLane,
      runtimeCap,
    };
  };
}
