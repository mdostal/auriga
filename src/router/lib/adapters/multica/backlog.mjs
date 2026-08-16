// createMulticaBacklogAdapter(cfg) — the real, Multica-backed implementation
// of BacklogAdapter (see ../backlog-adapter.mjs). A behavior-preserving PORT
// of lib/multica.mjs's issue CRUD, not a rewrite: every ported function keeps
// its exact CLI invocation, its exact pagination/safety-stop, and its exact
// read-degrades/write-propagates error-handling asymmetry from that file.
//
// Plain factory function, no class (this codebase has zero `class`
// declarations anywhere). Every method is SYNCHRONOUS — returns its plain
// result directly, never a Promise — matching backlog-adapter.mjs's contract
// exactly, because the real transport (execFileSync) is itself synchronous.
// See ../README.md for the fuller rationale.
//
// GitHub PR-discovery (was lib/multica.mjs's top-level ghOpenPrs/ghListRepos/
// ghPrs exports) is folded INSIDE this adapter as private helpers, per this
// story's Open Question 1 resolution (design-discussion.md): PR-lookup lives
// inside backlogAdapter, not a separate vcsAdapter — smaller diff, avoids an
// undocumented third adapter kind. Nothing outside this file calls
// ghOpenPrs/ghListRepos/ghPrs directly anymore.
//
// TWO PR-discovery surfaces, deliberately different shapes (see each
// function's own doc comment for the full rationale — found by an
// independent adversarial review of this epic's p2-router-cutover diff):
//   - listCandidatePullRequests(): the raw, UNFILTERED board-wide gh scan
//     (ghListRepos + per-repo ghPrs). auriga-router.mjs's cycle() calls this
//     ONCE per cycle and reuses the result across every issue, applying
//     lib/core.mjs's prMatchesStory/prIdentityMatchesStory itself — this is
//     what the router's own live "does issue X have a matching PR" decisions
//     use.
//   - getIssuePullRequests(identifier): a per-identifier lookup (Multica
//     native linkage + a narrower gh-based prMatchesIdentifier fallback),
//     kept for the BacklogAdapter typedef contract and for standalone
//     callers with no board-wide cache available. auriga-router.mjs's own
//     call sites do NOT use this for matching decisions any more — re-running
//     its internal full repo scan per issue per call site (no memoization)
//     was an O(issues x repos) gh-subprocess explosion per cycle, and its
//     narrower matching silently dropped slug-only-matching PRs before
//     core.mjs's richer matchers ever ran.
//
// Status-enum note (mined from src/engine/adapters/multica/index.ts, commit
// f4847ee, per research-brief.md §4): Multica's own vocabulary distinguishes
// 'blocked' (a declared dependency isn't satisfied yet) from a merely
// unpicked 'todo' — this adapter passes status strings straight through
// UNTRANSLATED, exactly like lib/multica.mjs did; interpreting them is
// lib/core.mjs's job, not this adapter's.

import { execFileSync } from 'node:child_process';
import { cleanEnv, makeRun } from './cli-runner.mjs';

/**
 * @param {{ cli?: string, profile?: string, ghCli?: string, reviewRepoOwner?: string, reviewSearchRepos?: string[] }} [cfg]
 *   cli/profile/ghCli default to today's MULTICA_CLI/MULTICA_PROFILE/GH_CLI
 *   env-var behavior (see lib/multica.mjs). reviewRepoOwner/reviewSearchRepos
 *   feed getIssuePullRequests's gh-based repo-discovery fallback (mirrors
 *   lib/config.mjs's REVIEW_REPO_OWNER/REVIEW_SEARCH_REPOS — a future cutover
 *   passes those values straight through here); both are optional, and with
 *   neither set the gh fallback simply finds no repos to search.
 * @returns {import('../backlog-adapter.mjs').BacklogAdapter}
 */
export function createMulticaBacklogAdapter(cfg = {}) {
  const CLI = cfg.cli || process.env.MULTICA_CLI || '/Users/dostal/.local/bin/multica';
  const PROFILE = cfg.profile || process.env.MULTICA_PROFILE || 'dostal';
  const GH = cfg.ghCli || process.env.GH_CLI || 'gh';
  const REVIEW_REPO_OWNER = cfg.reviewRepoOwner || null;
  const REVIEW_SEARCH_REPOS = cfg.reviewSearchRepos || [];

  // cleanEnv()/run() now live in ./cli-runner.mjs — shared with spawn.mjs
  // (see that module's header comment for why execFileSync is INJECTED here
  // rather than imported by cli-runner.mjs itself).
  const run = makeRun(execFileSync, CLI, PROFILE);

  function ghRun(args, maxBuffer = 32 * 1024 * 1024) {
    const out = execFileSync(GH, args, {
      env: cleanEnv(),
      encoding: 'utf8',
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() ? JSON.parse(out) : [];
  }

  // `multica issue list` caps at --limit (default 50) issues per call. Projects
  // with more than a page of issues (Pantheon Core — the seed-flood project)
  // were therefore only PARTIALLY scanned: every status pass silently missed
  // the tail of the board (PAN-6952 and dozens of others were invisible, so
  // they never advanced). Paginate with --offset until a short page is
  // returned so we get EVERY issue in the project. Loop + safety stop
  // preserved EXACTLY from lib/multica.mjs's listIssues.
  function listIssues(projectId, pageSize = 200) {
    const all = [];
    for (let offset = 0; ; offset += pageSize) {
      const res = run(['issue', 'list', '--project', projectId, '--output', 'json',
        '--limit', String(pageSize), '--offset', String(offset)]);
      const page = (res && res.issues) || [];
      for (const i of page) all.push(i);
      if (page.length < pageSize) break; // last (short) page
      if (offset > 100000) break;         // hard safety stop
    }
    return all;
  }

  // Every project id in the workspace. Used by the board-wide STATUS passes
  // (unblock, parent-rollup, false-done, verified-done) which must see the
  // whole board. Returns [] on any error so the caller falls back to the
  // static PROJECT_IDS (see lib/config-substrate.mjs).
  function listAllProjectIds() {
    try {
      const res = run(['project', 'list', '--output', 'json']);
      const ps = Array.isArray(res) ? res : (res && res.projects) || [];
      return ps.map((p) => p && p.id).filter(Boolean);
    } catch (e) {
      process.stderr.write('listAllProjectIds failed: ' + e.message + '\n');
      return [];
    }
  }

  // Board-wide aggregate over listIssues. NOT part of the BacklogAdapter
  // typedef contract (that only requires per-project listIssues), but ported
  // verbatim from lib/multica.mjs's listAllIssues (per this story's
  // files_to_modify) so the exact aggregation auriga-router.mjs's cycle()
  // needs (`mcaImpl.listAllIssues(scanIds)`) is available unchanged for the
  // future router-cutover story. One project failing must not abort the scan.
  function listAllIssues(projectIds) {
    const all = [];
    for (const p of projectIds) {
      try {
        for (const i of listIssues(p)) all.push(i);
      } catch (e) {
        process.stderr.write(`listIssues(${p}) failed: ${e.message}\n`);
      }
    }
    return all;
  }

  // The dispatch/execution history for one issue (was issueRuns). Degrades
  // gracefully (returns []) on any failure — matches lib/multica.mjs exactly.
  function getIssueRuns(identifier) {
    try {
      const res = run(['issue', 'runs', identifier, '--output', 'json']);
      return Array.isArray(res) ? res : [];
    } catch (e) {
      process.stderr.write(`issueRuns(${identifier}) failed: ${e.message}\n`);
      return [];
    }
  }

  // ---- private gh-backed PR-discovery helpers (were top-level exports in
  // lib/multica.mjs; nothing outside getIssuePullRequests needs them
  // directly anymore — see the file-header note on Open Question 1). ----

  // Open PRs for a repo via gh, as [{number,title,headRefName,baseRefName,body,url,state}].
  // Ported verbatim for fidelity with lib/multica.mjs's exported ghOpenPrs,
  // but getIssuePullRequests below calls ghPrs('all') instead of this one —
  // ghPrs('all') is a strict superset (it also carries mergedAt, needed to
  // detect a MERGED PR) so this narrower open-only variant isn't currently
  // invoked from here. Kept as a private helper for parity / potential
  // future direct reuse, not dead code left over from an incomplete port.
  function ghOpenPrs(repo) {
    try {
      return ghRun(['pr', 'list', '--repo', repo, '--state', 'open',
        '--json', 'number,title,headRefName,baseRefName,body,url,state', '--limit', '100']);
    } catch (e) {
      process.stderr.write('ghOpenPrs(' + repo + ') failed: ' + e.message + '\n');
      return [];
    }
  }

  // All PRs (any state) for a repo, as [{...,mergedAt}]. getIssuePullRequests
  // needs every state (not just open) because a caller (detectVerifiedDone)
  // must be able to see a MERGED PR too — run status alone is never trusted
  // as "done".
  function ghPrs(repo, state = 'all') {
    try {
      return ghRun(['pr', 'list', '--repo', repo, '--state', state,
        '--json', 'number,title,headRefName,baseRefName,body,url,state,mergedAt', '--limit', '100']);
    } catch (e) {
      process.stderr.write('ghPrs(' + repo + ') failed: ' + e.message + '\n');
      return [];
    }
  }

  // Every repo slug for an owner via `gh repo list`, as ['owner/name', ...].
  // Used only by getIssuePullRequests's repo-discovery fallback. Returns []
  // on any error so the fallback simply finds nothing rather than throwing.
  function ghListRepos(owner, limit = 300) {
    try {
      const arr = ghRun(['repo', 'list', owner, '--no-archived', '--limit', String(limit), '--json', 'nameWithOwner'], 16 * 1024 * 1024);
      return Array.isArray(arr) ? arr.map((r) => r && r.nameWithOwner).filter(Boolean) : [];
    } catch (e) {
      process.stderr.write('ghListRepos(' + owner + ') failed: ' + e.message + '\n');
      return [];
    }
  }

  // Simple identity heuristic for "does this PR belong to this issue" when
  // discovered via gh rather than Multica's native linkage: the identifier
  // (e.g. "PAN-1234", or a slug key like "m-01") appearing in the PR's title,
  // branch name, or body. Deliberately self-contained (does not depend on
  // lib/core.mjs's richer prMatchesStory/prIdentityMatchesStory, which need a
  // full issue object with slug metadata this per-id method doesn't have).
  //
  // DELIBERATELY NARROWER than prMatchesStory/prIdentityMatchesStory: this
  // only ever sees the raw identifier string, so it CANNOT match a PR whose
  // branch/title carries only the story's short slug key (e.g. "m-01",
  // branch feat/m-01-service) and never the literal "PAN-1234" text.
  // getIssuePullRequests's gh-fallback below (and therefore this helper) is
  // NOT used by auriga-router.mjs's own live call sites for that reason —
  // see cycle()'s listCandidatePullRequests-backed matchedPrs() helper, which
  // filters the full unfiltered board-wide scan with the real
  // prMatchesStory/prIdentityMatchesStory logic instead. This helper (and the
  // gh half of getIssuePullRequests) is kept only for a standalone
  // per-identifier caller with no board-wide cache available (e.g. a test, or
  // a future adapter consumer calling this method directly) — never reach
  // for this from router-side matching logic.
  function prMatchesIdentifier(pr, identifier) {
    const needle = String(identifier || '').toLowerCase();
    if (!needle) return false;
    return [pr && pr.title, pr && pr.headRefName, pr && pr.body]
      .some((s) => String(s || '').toLowerCase().includes(needle));
  }

  // The raw, UNFILTERED board-wide PR candidate scan (ghListRepos + per-repo
  // ghPrs('all')) — was, per-issue, folded inside getIssuePullRequests before
  // this fix; that meant every call re-ran this full repo scan (an
  // O(issues x repos) explosion in live `gh` subprocess spawns per cycle) AND
  // pre-filtered results through prMatchesIdentifier's raw-string-only
  // heuristic BEFORE auriga-router.mjs's call sites ever got a chance to
  // apply core.mjs's richer prMatchesStory/prIdentityMatchesStory — silently
  // dropping any PR that matches only via a story's short slug key. This
  // method does NO identity matching at all — that is deliberately the
  // caller's job — so callers can (and cycle() does) apply the full-quality
  // matcher. Callers should invoke this ONCE per cycle/scan and reuse the
  // result across every issue, exactly like the pre-cutover router's own
  // top-level ghListRepos/ghOpenPrs/ghPrs gather did. NOT part of the
  // BacklogAdapter typedef contract (same "ported extra" status as
  // listAllIssues above) — an adapter without a natural "board-wide PR scan"
  // concept simply doesn't implement it; auriga-router.mjs's cycle() checks
  // for its presence and falls back to getIssuePullRequests per-identifier
  // when absent (e.g. stub/test adapters).
  function listCandidatePullRequests() {
    const repos = new Set([
      ...(REVIEW_REPO_OWNER ? ghListRepos(REVIEW_REPO_OWNER) : []),
      ...REVIEW_SEARCH_REPOS,
    ]);
    const all = [];
    for (const repo of repos) {
      for (const pr of ghPrs(repo, 'all')) {
        pr._repo = repo;
        all.push(pr);
      }
    }
    return all;
  }

  // Pull/merge requests linked to one issue (was issuePullRequests). This
  // INTERNALLY calls BOTH Multica's native `issue pull-requests` linkage AND
  // a gh-backed discovery fallback (ghListRepos + ghPrs across the configured
  // repo set, matched via the narrower prMatchesIdentifier heuristic above),
  // merged and de-duplicated by PR url — Multica's issue<->PR linkage is
  // empty in practice (see auriga-router.mjs's own comment on why the router
  // had to build a gh-based scan), so gh discovery is what actually finds a
  // story's PR in that fallback path.
  //
  // auriga-router.mjs's cycle() does NOT call this for its own "does issue X
  // have a matching PR" decisions any more (see listCandidatePullRequests
  // above): re-running this method's full repo scan per issue per call site,
  // with zero memoization, was a real O(issues x repos) gh-subprocess
  // explosion per cycle, and prMatchesIdentifier's raw-identifier-only gh
  // fallback silently narrowed matches before core.mjs's richer
  // prMatchesStory/prIdentityMatchesStory ever ran. This method is kept as a
  // documented, DELIBERATELY NARROWER single-identifier lookup for a caller
  // with no board-wide cache available (tests exercise it directly; a future
  // adapter consumer may still want a one-off per-identifier lookup) — it is
  // still part of the BacklogAdapter typedef contract.
  //
  // Degrades gracefully: ANY single lookup failing (the multica CLI call,
  // one repo's gh lookup) never aborts the others; on total failure this
  // returns [], matching a "no PR yet" read rather than erroring the caller.
  function getIssuePullRequests(identifier) {
    const found = new Map(); // de-dupe key: pr.url (falls back to a repo#number key)

    try {
      const res = run(['issue', 'pull-requests', identifier, '--output', 'json']);
      for (const pr of (res && res.pull_requests) || []) {
        found.set(pr.url || `native:${pr.number}`, pr);
      }
    } catch (e) {
      process.stderr.write(`issuePullRequests(${identifier}) failed: ${e.message}\n`);
    }

    const repos = new Set([
      ...(REVIEW_REPO_OWNER ? ghListRepos(REVIEW_REPO_OWNER) : []),
      ...REVIEW_SEARCH_REPOS,
    ]);
    for (const repo of repos) {
      for (const pr of ghPrs(repo, 'all')) {
        if (prMatchesIdentifier(pr, identifier)) {
          pr._repo = repo;
          found.set(pr.url || `${repo}#${pr.number}`, pr);
        }
      }
    }

    return [...found.values()];
  }

  // Move an issue to a new status (was issueStatus). WRITE method:
  // propagates any CLI failure to the caller (no try/catch) — matches
  // lib/multica.mjs exactly. auriga-router.mjs's call sites already wrap
  // this in their own try/catch (see cycle()'s advance_error logging).
  function setIssueStatus(identifier, status) {
    return run(['issue', 'status', identifier, status, '--output', 'json']);
  }

  // Post a comment onto an issue (was issueComment; used to publish the
  // review-squad plan onto the ticket at dispatch time). Best-effort:
  // degrades gracefully (returns null on failure) — matches lib/multica.mjs
  // exactly. A comment failure must never abort a review dispatch.
  function commentOnIssue(identifier, body) {
    try {
      return run(['issue', 'comment', identifier, '--body', body, '--output', 'json']);
    } catch (e) {
      process.stderr.write(`issueComment(${identifier}) failed: ${e.message}\n`);
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

    // ---- ported/adapter-specific extras, NOT part of the BacklogAdapter
    // contract (see the doc comments on listAllIssues/
    // listCandidatePullRequests above) ----
    listAllIssues,
    listCandidatePullRequests,
  });
}
