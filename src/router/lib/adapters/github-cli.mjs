// Shared gh-CLI helper primitives, factored out of multica/backlog.mjs and
// pantheon-v2-l2/index.mjs, which each carried a byte-near-identical private
// copy of ghRun/ghListRepos/ghPrs (pantheon-v2-l2's own header comment
// admitted it was ported "byte-faithful" to the other) plus, in
// multica/backlog.mjs, the same review-repo-gathering loop hand-copied a
// SECOND time inside getIssuePullRequests.
//
// This is exactly the drift risk that already caused a real bug once (GH
// #81's PR-state casing check, hand-copied three times, one copy simply
// wrong) — found live again during this extraction: pantheon-v2-l2's own
// 15s exec timeout (GH #70/PANT-24 — a single hanging repo must never stall
// the whole board-wide PR scan) was NEVER ported back to multica/backlog.mjs,
// which had no timeout at all until this file unified them.
//
// execFileSync is INJECTED (never imported here), for the same reason
// documented in multica/cli-runner.mjs: callers' own test suites rely on
// node:test's t.mock.module + a cache-busting dynamic import per test to get
// a fresh execFileSync binding — a module-scoped import here would silently
// defeat that.

/**
 * Builds the `gh <args...>` execFileSync wrapper shared by every gh-CLI
 * consumer in this adapters directory. `env` is a thunk (not a plain value)
 * so a caller that needs per-call freshness (e.g. cleanEnv() re-cloning
 * process.env with Multica credentials stripped) gets it — the two current
 * real callers deliberately differ here: multica/backlog.mjs's process holds
 * Multica credentials and must scrub them before they'd reach a gh
 * subprocess; pantheon-v2-l2's container holds none by design and passes
 * process.env straight through. That difference is real and preserved, not
 * papered over by this extraction.
 * @param {(cmd: string, args: string[], opts: object) => string} execFn
 * @param {string} gh
 * @param {{ env?: () => NodeJS.ProcessEnv }} [opts]
 * @returns {(args: string[], maxBuffer?: number) => any}
 */
export function makeGhRun(execFn, gh, { env = () => process.env } = {}) {
  return function ghRun(args, maxBuffer = 32 * 1024 * 1024) {
    const out = execFn(gh, args, {
      env: env(),
      encoding: 'utf8',
      maxBuffer,
      // GH #70/PANT-24: listCandidatePullRequests does up to ~100+ sequential
      // calls (one per repo); an unbounded hang on a single slow/hanging repo
      // must never stall the whole scan. 15s per call, bounded worst case.
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() ? JSON.parse(out) : [];
  };
}

/**
 * Every non-archived repo an owner has, as ["owner/repo", ...]. Degrades
 * gracefully (returns []) on any failure — a listing failure must never
 * abort the caller's own board-wide scan.
 * @param {ReturnType<typeof makeGhRun>} ghRun
 * @returns {(owner: string, limit?: number) => string[]}
 */
export function makeGhListRepos(ghRun) {
  return function ghListRepos(owner, limit = 300) {
    try {
      const arr = ghRun(
        ['repo', 'list', owner, '--no-archived', '--limit', String(limit), '--json', 'nameWithOwner'],
        16 * 1024 * 1024,
      );
      return Array.isArray(arr) ? arr.map((r) => r && r.nameWithOwner).filter(Boolean) : [];
    } catch (e) {
      process.stderr.write('ghListRepos(' + owner + ') failed: ' + e.message + '\n');
      return [];
    }
  };
}

/**
 * All PRs (any state by default) for one repo, as [{...,state,mergedAt}] —
 * every field core.mjs's github-pr-state.mjs helpers (isPrOpen/isPrMerged)
 * need. Degrades gracefully (returns []) on any failure, same convention as
 * ghListRepos above.
 * @param {ReturnType<typeof makeGhRun>} ghRun
 * @returns {(repo: string, state?: string) => any[]}
 */
export function makeGhPrs(ghRun) {
  return function ghPrs(repo, state = 'all') {
    try {
      return ghRun([
        'pr', 'list', '--repo', repo, '--state', state,
        '--json', 'number,title,headRefName,baseRefName,body,url,state,mergedAt', '--limit', '100',
      ]);
    } catch (e) {
      process.stderr.write('ghPrs(' + repo + ') failed: ' + e.message + '\n');
      return [];
    }
  };
}

/**
 * The set of repos to scan for review-lane PR discovery: every repo owned by
 * reviewRepoOwner (live-discovered via ghListRepos) plus any explicitly
 * listed reviewSearchRepos. Was hand-copied at two call sites within
 * multica/backlog.mjs alone (listCandidatePullRequests and
 * getIssuePullRequests's own narrower per-identifier fallback) before this
 * extraction, on top of the third copy in pantheon-v2-l2/index.mjs.
 * @param {ReturnType<typeof makeGhListRepos>} ghListRepos
 * @param {string|null} reviewRepoOwner
 * @param {string[]} reviewSearchRepos
 * @returns {Set<string>}
 */
export function gatherReviewRepos(ghListRepos, reviewRepoOwner, reviewSearchRepos) {
  return new Set([
    ...(reviewRepoOwner ? ghListRepos(reviewRepoOwner) : []),
    ...(reviewSearchRepos || []),
  ]);
}

/**
 * The raw, UNFILTERED board-wide PR candidate scan: gatherReviewRepos() then
 * one ghPrs('all') call per repo. Run ONCE per cycle by callers (see
 * auriga-router.mjs); callers apply core.mjs's own
 * prMatchesStory/prIdentityMatchesStory themselves — this function does no
 * filtering of its own.
 * @param {ReturnType<typeof makeGhListRepos>} ghListRepos
 * @param {ReturnType<typeof makeGhPrs>} ghPrs
 * @param {string|null} reviewRepoOwner
 * @param {string[]} reviewSearchRepos
 * @returns {() => any[]}
 */
export function makeListCandidatePullRequests(ghListRepos, ghPrs, reviewRepoOwner, reviewSearchRepos) {
  return function listCandidatePullRequests() {
    const repos = gatherReviewRepos(ghListRepos, reviewRepoOwner, reviewSearchRepos);
    const all = [];
    for (const repo of repos) {
      for (const pr of ghPrs(repo, 'all')) {
        pr._repo = repo;
        all.push(pr);
      }
    }
    return all;
  };
}
