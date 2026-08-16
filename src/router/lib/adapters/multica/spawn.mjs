// createMulticaSpawnAdapter(cfg) — the real, Multica-backed implementation of
// SpawnAdapter (see ../spawn-adapter.mjs). Ports:
//   - assignIssue/rerunIssue/unassignIssue verbatim from lib/multica.mjs
//     (same CLI invocation, same read-degrades/write-propagates asymmetry).
//   - dispatch(issue, lane): the assign -> verify-a-run-started -> force-rerun
//     sequence currently inline in auriga-router.mjs's cycle() "route new
//     todos" block (see that file's comment "verify a run started;
//     force-enqueue if not (dead-zone fix)"). NOT wired into cycle() by this
//     story — this is a behavior-preserving port, tested in isolation.
//   - describeLanes(): assembles PROJECT_LANE/DEFAULT_LANE/HIVE_LANE/
//     REVIEW_LANE/RUNTIME_CAP from lib/config-substrate.mjs into a LaneMap.
//
// Plain factory function, no class (this codebase has zero `class`
// declarations anywhere). Every method is SYNCHRONOUS — matches
// spawn-adapter.mjs's contract exactly, because the real transport
// (execFileSync) is itself synchronous. dispatch()'s verify-delay wait is
// therefore a REAL synchronous block (Atomics.wait on a throwaway
// SharedArrayBuffer — the standard main-thread-safe synchronous-sleep trick
// in Node), not `await sleep(...)`; a test injects cfg.sleep to avoid
// actually blocking for CAPS.verifyDelayMs.
//
// *****************************************************************
// *** This adapter has NO provisioning method of any kind — by design,
// *** not by omission. See ../spawn-adapter.mjs's header comment and
// *** ../README.md's "No pre-emptive integrations" section: Auriga must
// *** never pre-build a concept for a tool (Vulcan, or any future
// *** provisioner) it doesn't yet have a real story that needs. Do NOT
// *** add a provision(...)/createEnvironment(...)/bootstrap(...) method
// *** (or any hook/middleware slot) here, ever, without a real story AND
// *** an explicit design decision revisiting this rule.
// *****************************************************************

import { execFileSync } from 'node:child_process';
import { classifyRun, latestRun } from '../../core.mjs';
import {
  PROJECT_LANE as SUBSTRATE_PROJECT_LANE,
  DEFAULT_LANE as SUBSTRATE_DEFAULT_LANE,
  HIVE_LANE as SUBSTRATE_HIVE_LANE,
  REVIEW_LANE as SUBSTRATE_REVIEW_LANE,
  RUNTIME_CAP as SUBSTRATE_RUNTIME_CAP,
} from '../../config-substrate.mjs';

// Default verify-delay, mirrors lib/config.mjs's CAPS.verifyDelayMs value
// (CAPS itself stays in lib/config.mjs — substrate-agnostic policy, not
// moved by this story). Callers wire the live CAPS.verifyDelayMs through
// cfg.verifyDelayMs; this default only applies when cfg omits it.
const DEFAULT_VERIFY_DELAY_MS = 6000;

// Real synchronous sleep: Atomics.wait blocks the calling thread until `ms`
// elapses (the watched cell never changes, so it always times out). Safe to
// call on Node's main thread (unlike browsers, which restrict Atomics.wait
// to workers). A no-op for ms <= 0.
function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {{
 *   cli?: string, profile?: string,
 *   verifyDelayMs?: number, sleep?: (ms: number) => void,
 *   projectLane?: object, defaultLane?: string[], hiveLane?: string[],
 *   reviewLane?: string[], runtimeCap?: object,
 * }} [cfg]
 *   cli/profile default to today's MULTICA_CLI/MULTICA_PROFILE env-var
 *   behavior (see lib/multica.mjs). verifyDelayMs/sleep let a test override
 *   the real delay/blocking-wait; the lane-map fields let a test (or a
 *   future caller) pass a fixture lane map instead of the live
 *   config-substrate.mjs values, which are the defaults for all five.
 * @returns {import('../spawn-adapter.mjs').SpawnAdapter}
 */
export function createMulticaSpawnAdapter(cfg = {}) {
  const CLI = cfg.cli || process.env.MULTICA_CLI || '/Users/dostal/.local/bin/multica';
  const PROFILE = cfg.profile || process.env.MULTICA_PROFILE || 'dostal';
  const VERIFY_DELAY_MS = cfg.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS;
  const sleep = cfg.sleep || sleepSync;

  const PROJECT_LANE = cfg.projectLane || SUBSTRATE_PROJECT_LANE;
  const DEFAULT_LANE = cfg.defaultLane || SUBSTRATE_DEFAULT_LANE;
  const HIVE_LANE = cfg.hiveLane || SUBSTRATE_HIVE_LANE;
  const REVIEW_LANE = cfg.reviewLane || SUBSTRATE_REVIEW_LANE;
  const RUNTIME_CAP = cfg.runtimeCap || SUBSTRATE_RUNTIME_CAP;

  // The three env vars must be UNSET (stale values 404). execFileSync inherits
  // process.env, so we delete them from a cloned env instead of `env -u`.
  // SECURITY-RELEVANT — preserved verbatim from lib/multica.mjs; do not drop.
  function cleanEnv() {
    const e = { ...process.env };
    delete e.MULTICA_TOKEN;
    delete e.MULTICA_PAT_TOKEN;
    delete e.MULTICA_WORKSPACE_ID;
    return e;
  }

  function run(args, { json = true } = {}) {
    const out = execFileSync(CLI, ['--profile', PROFILE, ...args], {
      env: cleanEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!json) return out;
    return out.trim() ? JSON.parse(out) : null;
  }

  // WRITE method: propagates any CLI failure to the caller (no try/catch) —
  // matches lib/multica.mjs's assignIssue exactly.
  function assignIssue(identifier, agentName) {
    return run(['issue', 'assign', identifier, '--to', agentName, '--output', 'json']);
  }

  // WRITE method: propagates any CLI failure to the caller (no try/catch) —
  // matches lib/multica.mjs's rerunIssue exactly.
  function rerunIssue(identifier) {
    return run(['issue', 'rerun', identifier, '--output', 'json']);
  }

  // WRITE method: propagates any CLI failure to the caller (no try/catch) —
  // matches lib/multica.mjs's unassignIssue exactly. Used by the blocked->todo
  // auto-unblock pass so a freshly-unblocked story re-enters build routing as
  // an UNASSIGNED candidate.
  function unassignIssue(identifier) {
    return run(['issue', 'assign', identifier, '--unassign', '--output', 'json']);
  }

  // Private: the dispatch/execution history for one issue (was issueRuns).
  // Degrades gracefully (returns []) on any failure — matches
  // lib/multica.mjs exactly. Only used internally by dispatch()'s verify
  // step; not part of the SpawnAdapter contract (that's getIssueRuns's job
  // on BacklogAdapter).
  function getIssueRuns(identifier) {
    try {
      const res = run(['issue', 'runs', identifier, '--output', 'json']);
      return Array.isArray(res) ? res : [];
    } catch (e) {
      process.stderr.write(`issueRuns(${identifier}) failed: ${e.message}\n`);
      return [];
    }
  }

  // dispatch(issue, lane): behavior-preserving port of auriga-router.mjs's
  // cycle() "route new todos" block (assign -> verify a run started ->
  // force-rerun if not). `lane` is a dispatch-target agent name (e.g.
  // 'auriga-dev') — same string cycle() calls `p.agent` and passes straight
  // to mcaImpl.assignIssue.
  //
  // Ported exactly:
  //   - assign is wrapped so an assign failure short-circuits (skips verify)
  //     instead of throwing out of dispatch() — mirrors cycle()'s own
  //     try/catch around `mcaImpl.assignIssue(p.identifier, p.agent)`.
  //     (cycle()'s further reaction to an assign failure — blocking the
  //     runtime for the rest of the cycle on a quota/limit error — is
  //     per-cycle BATCH policy across many picks, not a single dispatch()
  //     call's concern, so it stays in the future router-cutover, not here.)
  //   - after assign, sleep CAPS.verifyDelayMs (cfg.verifyDelayMs here),
  //     then read runs; "started" = any run row classifies active/done/failed
  //     ("any run row means it dispatched" — cycle()'s own comment).
  //   - if not started: force-rerun, catching (not propagating) a rerun
  //     failure — mirrors cycle()'s `try { mcaImpl.rerunIssue(...) } catch`.
  function dispatch(issue, lane) {
    const identifier = issue && issue.identifier;

    try {
      assignIssue(identifier, lane);
    } catch (e) {
      return { identifier, lane, assigned: false, assignError: e.message, started: false, forcedRerun: false };
    }

    sleep(VERIFY_DELAY_MS);

    const runs = getIssueRuns(identifier);
    const now = Date.now();
    const started = runs.length > 0 && runs.some((r) => {
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
  }

  // describeLanes(): the runner-side analog of lib/config.mjs's
  // PROJECT_LANE/HIVE_LANE/DEFAULT_LANE/REVIEW_LANE tables, assembled
  // (unaltered) alongside RUNTIME_CAP into one LaneMap — byte-identical to
  // today's config-substrate.mjs values, including the KNOWN GAP (PROJECT_LANE
  // not covering all named projects; see config-substrate.mjs's comment).
  function describeLanes() {
    return {
      projectLane: PROJECT_LANE,
      defaultLane: DEFAULT_LANE,
      hiveLane: HIVE_LANE,
      reviewLane: REVIEW_LANE,
      runtimeCap: RUNTIME_CAP,
    };
  }

  return Object.freeze({
    dispatch,
    describeLanes,
    assignIssue,
    rerunIssue,
    unassignIssue,
  });
}
