// pantheon-v2-l2 — the ONLY sanctioned path from Auriga to Pantheon (see
// ./README.md). Both factories below implement the BacklogAdapter (see
// ../backlog-adapter.mjs) and SpawnAdapter (see ../spawn-adapter.mjs) shapes
// as STUBS: every method throws immediately instead of returning a plausible
// -looking empty/success value. This is deliberate, not an oversight — see
// ./README.md's "intentionally unbuilt" statement and this epic's design
// decision that a stub which fails loudly is safer than one that looks like
// it's working (a silent no-op stub could be wired in by mistake and nobody
// would notice until a real Pantheon integration silently did nothing).
//
// Plain factory functions, no class (this codebase has zero `class`
// declarations anywhere) — matches every other adapter in this directory.
// Every method throws SYNCHRONOUSLY (no async/Promise anywhere), matching
// the synchronous contract both typedefs require.
//
// Building the real implementation here is Pantheon's own future, separate
// epic — not Auriga's job. Auriga stays agnostic of every specific external
// system (the adapter-boundary-integrity cross-cutting concern, see
// .pHive/CONTEXT.md and .pHive/cross-cutting-concerns.yaml).

const NOT_IMPLEMENTED_MESSAGE =
  'pantheon-v2-l2 is intentionally unbuilt — see ' +
  'src/router/lib/adapters/pantheon-v2-l2/README.md for why this adapter ' +
  'throws instead of doing anything, and what building the real ' +
  'implementation would require.';

function notImplemented(methodName) {
  const err = new Error(`pantheon-v2-l2: ${methodName}() is not implemented. ${NOT_IMPLEMENTED_MESSAGE}`);
  err.name = 'NotImplementedError';
  return err;
}

/**
 * @param {object} [cfg] Unused — accepted only for factory-signature parity
 *   with the other createXBacklogAdapter(cfg) implementations in this
 *   directory (multica/backlog.mjs, stub/backlog.mjs).
 * @returns {import('../backlog-adapter.mjs').BacklogAdapter}
 */
export function createPantheonV2L2BacklogAdapter(cfg = {}) {
  return Object.freeze({
    listIssues() {
      throw notImplemented('listIssues');
    },
    listAllProjectIds() {
      throw notImplemented('listAllProjectIds');
    },
    getIssueRuns() {
      throw notImplemented('getIssueRuns');
    },
    getIssuePullRequests() {
      throw notImplemented('getIssuePullRequests');
    },
    setIssueStatus() {
      throw notImplemented('setIssueStatus');
    },
    commentOnIssue() {
      throw notImplemented('commentOnIssue');
    },
  });
}

/**
 * @param {object} [cfg] Unused — accepted only for factory-signature parity
 *   with the other createXSpawnAdapter(cfg) implementations in this
 *   directory.
 * @returns {import('../spawn-adapter.mjs').SpawnAdapter}
 */
export function createPantheonV2L2SpawnAdapter(cfg = {}) {
  return Object.freeze({
    dispatch() {
      throw notImplemented('dispatch');
    },
    describeLanes() {
      throw notImplemented('describeLanes');
    },
    assignIssue() {
      throw notImplemented('assignIssue');
    },
    rerunIssue() {
      throw notImplemented('rerunIssue');
    },
    unassignIssue() {
      throw notImplemented('unassignIssue');
    },
  });
}
