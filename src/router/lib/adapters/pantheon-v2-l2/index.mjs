// pantheon-v2-l2 — the ONLY sanctioned path from Auriga to Pantheon (see
// ./README.md). Real implementation, replacing the prior intentional stub.
//
// Why now: operator's explicit, repeated correction (this epic's own real
// driver) -- "auriga asks the pantheon for tickets, the pantheon gives it
// to auriga -- NO ONE INTEGRATES DIRECTLY TO MULTICA." Auriga's own
// multica/backlog.mjs and multica/spawn.mjs adapters shelled out directly
// to a native `multica` CLI binary -- a real, standing architecture
// violation, and (separately) one that can't even run inside this
// container (a macOS Mach-O binary, confirmed empirically broken here).
// Pantheon (pantheon-v2's own core-api, core/api/backlog.ts) now wraps
// Multica's real REST API and exposes it as Pantheon's own ticket API;
// this file is the Auriga-side half of that cutover.
//
// Every method stays SYNCHRONOUS (see ../backlog-adapter.mjs /
// ../spawn-adapter.mjs), matching the pre-existing, unmodified
// auriga-router.mjs's cycle(), which never awaits its injected `backlog`/
// `spawn` dependency. Achieved the identical way the multica/ adapters
// achieved it -- a real, blocking execFileSync call -- just against `curl`
// hitting Pantheon's HTTP API instead of the `multica` CLI binary (see
// ./http-runner.mjs). This container needs zero Multica credentials, zero
// Multica CLI binary, and zero direct network path to Multica as a result
// -- only network access to core-api, which docker-compose already
// provides on the shared `pantheon` network.
//
// Return shapes are mapped back to the EXACT raw, snake_case,
// Multica-CLI-shaped fields lib/core.mjs already reads directly (id,
// identifier, title, status, assignee_id, assignee_type, project_id,
// parent_issue_id, labels, metadata, ...) -- confirmed by reading
// lib/core.mjs's own field accesses directly, not assumed. This is
// deliberate: Auriga's real, live consumer code was never actually
// backend-agnostic in practice (despite the adapter interface's own
// aspiration to be), so this adapter preserves that shape rather than
// silently changing it and risking a subtle behavior break.
//
// GitHub-based PR discovery (multica/backlog.mjs's ghOpenPrs/ghPrs/
// ghListRepos/listCandidatePullRequests) is DELIBERATELY NOT ported here --
// that is a GitHub integration, not a Multica one, and out of scope for
// this epic (which is specifically about the Multica board bridge). This
// adapter simply doesn't implement listCandidatePullRequests;
// auriga-router.mjs's cycle() already duck-types for its absence
// (`typeof backlog.listCandidatePullRequests === 'function'`) and falls
// back to per-identifier getIssuePullRequests, which IS implemented here.

import { execFileSync } from 'node:child_process';
import { makeHttpRun } from './http-runner.mjs';
import {
  PROJECT_LANE as SUBSTRATE_PROJECT_LANE,
  DEFAULT_LANE as SUBSTRATE_DEFAULT_LANE,
  HIVE_LANE as SUBSTRATE_HIVE_LANE,
  REVIEW_LANE as SUBSTRATE_REVIEW_LANE,
  RUNTIME_CAP as SUBSTRATE_RUNTIME_CAP,
} from '../../config-substrate.mjs';
import { classifyRun, latestRun } from '../../core.mjs';

const DEFAULT_BASE_URL = 'http://core-api:3012';
const DEFAULT_VERIFY_DELAY_MS = 6000;

// Real synchronous sleep — ported verbatim from multica/spawn.mjs (same
// Atomics.wait-on-a-throwaway-SharedArrayBuffer trick; see that file's own
// comment for why this is safe on Node's main thread).
function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Maps Pantheon's clean, camelCase BoardQueue Issue shape back to the raw,
// snake_case fields lib/core.mjs reads directly (confirmed via direct
// inspection of core.mjs's own field accesses: id, identifier, title,
// description, status, assignee_id, project_id, parent_issue_id, labels,
// metadata — never parentId/createdAt/assignee.type, the BoardQueue port's
// own vocabulary). Deliberately keeps Auriga's real, existing consumer
// code working unchanged rather than "fixing" it as an unplanned side
// effect of this cutover.
function toRawIssue(issue) {
  if (!issue) return issue;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    labels: issue.labels,
    assignee_id: issue.assignee ? issue.assignee.id : null,
    assignee_type: issue.assignee ? issue.assignee.type : null,
    project_id: issue.project ?? null,
    parent_issue_id: issue.parentId ?? null,
    metadata: issue.metadata,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/**
 * @param {{ baseUrl?: string, exec?: Function }} [cfg]
 *   baseUrl defaults to PANTHEON_API_URL, then DEFAULT_BASE_URL (matching
 *   the docker-compose internal hostname for core-api). exec lets a test
 *   inject a fake execFileSync.
 * @returns {import('../backlog-adapter.mjs').BacklogAdapter}
 */
export function createPantheonV2L2BacklogAdapter(cfg = {}) {
  const BASE_URL = (cfg.baseUrl || process.env.PANTHEON_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const run = makeHttpRun(cfg.exec || execFileSync, BASE_URL);

  // Per-project issue list. NOT called by auriga-router.mjs's own cycle()
  // today (it uses listAllIssues below instead) but part of the
  // BacklogAdapter typedef contract, so implemented for real rather than
  // left throwing.
  function listIssues(projectId) {
    const res = run('GET', `/api/backlog/issues?project=${encodeURIComponent(projectId)}`);
    return ((res && res.issues) || []).map(toRawIssue);
  }

  // Pantheon's backlog API is deliberately board-wide, not project-scoped
  // -- BoardQueue (the L1 port it wraps) has no project concept baked into
  // its default listing, and leaking Multica's own project-id vocabulary
  // through the sanctioned Auriga<->Pantheon boundary would defeat the
  // point of the boundary. listAllProjectIds() therefore returns a single
  // sentinel so listAllIssues (below) does exactly one unfiltered,
  // board-wide scan -- matching real usage
  // (`backlog.listAllIssues(backlog.listAllProjectIds())`,
  // auriga-router.mjs line ~128) with equivalent real coverage (every
  // issue Pantheon's backlog knows about), just without Auriga needing to
  // understand Multica's project concept to get there.
  function listAllProjectIds() {
    return ['__pantheon_board__'];
  }

  // Board-wide aggregate — REQUIRED by auriga-router.mjs's cycle() (not
  // just a typedef "extra"; confirmed via direct grep of the real call
  // site). Ignores scanIds (see listAllProjectIds's comment above) and
  // always does one full, paginated board scan via Pantheon's backlog API
  // (core/api/backlog.ts's GET /api/backlog/issues already paginates
  // internally via MulticaBoardAdapter.list()).
  function listAllIssues(_scanIds) {
    const res = run('GET', '/api/backlog/issues');
    return ((res && res.issues) || []).map(toRawIssue);
  }

  // Degrades gracefully (returns []) on any failure — matches the
  // multica-direct adapter's own established convention for this method.
  function getIssueRuns(identifier) {
    try {
      const res = run('GET', `/api/backlog/issues/${encodeURIComponent(identifier)}/runs`);
      return (res && res.runs) || [];
    } catch (e) {
      process.stderr.write(`pantheon-v2-l2: getIssueRuns(${identifier}) failed: ${e.message}\n`);
      return [];
    }
  }

  // Native Multica PR linkage only (GET /api/backlog/issues/:id/pull-requests
  // -> Pantheon's own MulticaBoardAdapter.getIssuePullRequests, which wraps
  // Multica's native `issue pull-requests` linkage). Deliberately does NOT
  // fold in the GitHub-scan fallback the old multica/backlog.mjs adapter
  // had (see this file's header comment) — a separate, out-of-scope
  // integration. Degrades gracefully on failure, matching the old adapter.
  function getIssuePullRequests(identifier) {
    try {
      const res = run('GET', `/api/backlog/issues/${encodeURIComponent(identifier)}/pull-requests`);
      return (res && res.pull_requests) || [];
    } catch (e) {
      process.stderr.write(`pantheon-v2-l2: getIssuePullRequests(${identifier}) failed: ${e.message}\n`);
      return [];
    }
  }

  // WRITE method: propagates any failure to the caller (no try/catch) —
  // matches the multica-direct adapter's own convention; auriga-router.mjs's
  // call sites already wrap this in their own try/catch.
  function setIssueStatus(identifier, status) {
    return run('POST', `/api/backlog/issues/${encodeURIComponent(identifier)}/status`, { status });
  }

  // Best-effort: degrades gracefully (returns null on failure) — matches
  // the multica-direct adapter's own convention. A comment failure must
  // never abort a review dispatch.
  function commentOnIssue(identifier, body) {
    try {
      return run('POST', `/api/backlog/issues/${encodeURIComponent(identifier)}/comments`, {
        body,
        author: 'auriga',
      });
    } catch (e) {
      process.stderr.write(`pantheon-v2-l2: commentOnIssue(${identifier}) failed: ${e.message}\n`);
      return null;
    }
  }

  return Object.freeze({
    listIssues,
    listAllProjectIds,
    getIssueRuns,
    getIssuePullRequests,
    setIssueStatus,
    commentOnIssue,

    // "Ported extra", not part of the BacklogAdapter typedef contract, but
    // REQUIRED by auriga-router.mjs's real cycle() — see this function's
    // own comment above.
    listAllIssues,
  });
}

/**
 * @param {{
 *   baseUrl?: string, exec?: Function,
 *   verifyDelayMs?: number, sleep?: (ms: number) => void,
 *   projectLane?: object, defaultLane?: string[], hiveLane?: string[],
 *   reviewLane?: string[], runtimeCap?: object,
 * }} [cfg]
 * @returns {import('../spawn-adapter.mjs').SpawnAdapter}
 */
export function createPantheonV2L2SpawnAdapter(cfg = {}) {
  const BASE_URL = (cfg.baseUrl || process.env.PANTHEON_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const run = makeHttpRun(cfg.exec || execFileSync, BASE_URL);
  const VERIFY_DELAY_MS = cfg.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS;
  const sleep = cfg.sleep || sleepSync;

  // Lane config is pure Auriga-side static config (lib/config-substrate.mjs)
  // — zero Multica/Pantheon dependency, so it's carried over unchanged from
  // the multica-direct adapter rather than re-derived.
  const PROJECT_LANE = cfg.projectLane || SUBSTRATE_PROJECT_LANE;
  const DEFAULT_LANE = cfg.defaultLane || SUBSTRATE_DEFAULT_LANE;
  const HIVE_LANE = cfg.hiveLane || SUBSTRATE_HIVE_LANE;
  const REVIEW_LANE = cfg.reviewLane || SUBSTRATE_REVIEW_LANE;
  const RUNTIME_CAP = cfg.runtimeCap || SUBSTRATE_RUNTIME_CAP;

  // Assign-by-NAME (not id) is the real contract this method has always
  // had (multica/spawn.mjs's own assignIssue(identifier, agentName) used
  // `--to <name>`, not `--to-id`) — lanes are configured with agent NAMES
  // (see describeLanes below), and cycle() passes `p.agent` (a name)
  // straight through. Resolving that name to Pantheon's real backend id
  // happens via GET /api/backlog/agents/:name -- a route deliberately
  // scoped so this adapter never needs to learn a Multica workspace id or
  // agent uuid on its own; it only ever hands over a name it already has.
  function resolveAgentId(agentName) {
    const res = run('GET', `/api/backlog/agents/${encodeURIComponent(agentName)}`);
    if (!res || !res.id) {
      throw new Error(`pantheon-v2-l2: no agent named "${agentName}"`);
    }
    return res.id;
  }

  // WRITE method: propagates any failure to the caller (no try/catch) —
  // matches the multica-direct adapter's own convention.
  function assignIssue(identifier, agentName) {
    const agentId = resolveAgentId(agentName);
    return run('POST', `/api/backlog/issues/${encodeURIComponent(identifier)}/assign`, {
      type: 'agent',
      id: agentId,
    });
  }

  // WRITE method: propagates any failure to the caller — matches the
  // multica-direct adapter's own convention.
  function rerunIssue(identifier) {
    return run('POST', `/api/backlog/issues/${encodeURIComponent(identifier)}/rerun`);
  }

  // WRITE method: propagates any failure to the caller — matches the
  // multica-direct adapter's own convention. Used by the blocked->todo
  // auto-unblock pass so a freshly-unblocked story re-enters build routing
  // as an UNASSIGNED candidate.
  function unassignIssue(identifier) {
    return run('POST', `/api/backlog/issues/${encodeURIComponent(identifier)}/unassign`);
  }

  // Private: run history for one issue, used only by dispatch()'s verify
  // step below — NOT part of the SpawnAdapter contract (that's
  // getIssueRuns's job on BacklogAdapter). Degrades gracefully, matching
  // the multica-direct adapter's own convention.
  function getIssueRunsForVerify(identifier) {
    try {
      const res = run('GET', `/api/backlog/issues/${encodeURIComponent(identifier)}/runs`);
      return (res && res.runs) || [];
    } catch (e) {
      process.stderr.write(`pantheon-v2-l2: getIssueRuns(${identifier}) failed: ${e.message}\n`);
      return [];
    }
  }

  // dispatch(issue, lane): behavior-preserving port of
  // multica/spawn.mjs's own dispatch() (assign -> verify a run started ->
  // force-rerun if not) — NOT called by any cycle() call site today, for
  // the exact same reason the multica-direct version wasn't: this
  // method's verify-wait is a real synchronous Atomics.wait block, and
  // auriga-router.mjs's own "route new todos" pass needs to stay
  // responsive during that wait, so it keeps its own non-blocking
  // sequence instead. See spawn-adapter.mjs's typedef for the full
  // rationale. Kept here as a real, tested, available method for a future
  // short-lived caller.
  function dispatch(issue, lane) {
    const identifier = issue && issue.identifier;

    try {
      assignIssue(identifier, lane);
    } catch (e) {
      return { identifier, lane, assigned: false, assignError: e.message, started: false, forcedRerun: false };
    }

    sleep(VERIFY_DELAY_MS);

    const runs = getIssueRunsForVerify(identifier);
    const now = Date.now();
    const started = runs.length > 0 && runs.some((r) => {
      const c = classifyRun(r, now);
      return c.active || c.done || c.failed;
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

  // Zero Multica/Pantheon dependency — carried over unchanged.
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
