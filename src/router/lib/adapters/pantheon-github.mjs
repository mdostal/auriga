// Pantheon-native GitHub facade calls — replaces gh-CLI-based PR discovery
// (github-cli.mjs's makeGhRun/makeGhListRepos/makeGhPrs) for the
// pantheon-v2-l2 adapter. Delegates to Pantheon's own core/api/github.ts
// facade (GET /api/github/repos and GET /api/github/repos/:owner/:repo/pulls),
// which holds GITHUB_TOKEN centrally — no GH_TOKEN in Auriga's container.
//
// Same factory-function shape as github-cli.mjs so callers can swap
// implementations with a minimal diff: both export make* factories that accept
// a transport function and return the same (owner, limit?) => string[] and
// (repo, state?) => any[] signatures. gatherReviewRepos and
// makeListCandidatePullRequests from github-cli.mjs are pure logic and are
// re-used unchanged.
//
// Response mapping: Pantheon proxies the GitHub REST API verbatim, so PR
// objects carry GitHub REST field names — html_url (not url), merged_at (not
// mergedAt), and head.ref (nested, not headRefName). The existing code
// already handles html_url (pr-matching.mjs checks pr.url || pr.html_url) and
// merged_at (github-pr-state.mjs's PR_TIMESTAMP_FIELDS checks both spellings).
// The only gap is head.ref — normalized below to head_ref (pr-matching.mjs
// already checks pr.head_ref as an alternative to pr.headRefName).

/**
 * Maps a GitHub REST API pull-request object to the shape prMatchesStory and
 * github-pr-state.mjs expect: adds head_ref (flattened from head.ref) and
 * normalizes url from html_url. All other fields (title, body, state,
 * number, merged_at, etc.) are already in a compatible shape and are
 * forwarded unchanged.
 */
function normalizePr(pr) {
  if (!pr || typeof pr !== 'object') return pr;
  return {
    ...pr,
    head_ref: (pr.head && pr.head.ref) || null,
    url: pr.url || pr.html_url || null,
  };
}

/**
 * @param {(method: string, path: string) => any} run  makeHttpRun result
 * @returns {(owner: string, limit?: number) => string[]}
 */
export function makePantheonGhListRepos(run) {
  return function listRepos(owner, limit = 300) {
    try {
      const arr = run('GET', `/api/github/repos?owner=${encodeURIComponent(owner)}&per_page=${limit}`);
      return Array.isArray(arr) ? arr.map((r) => r && r.full_name).filter(Boolean) : [];
    } catch (e) {
      process.stderr.write('pantheon-github: listRepos(' + owner + ') failed: ' + e.message + '\n');
      return [];
    }
  };
}

/**
 * @param {(method: string, path: string) => any} run  makeHttpRun result
 * @returns {(repo: string, state?: string) => any[]}
 */
export function makePantheonGhPrs(run) {
  return function ghPrs(repo, state = 'all') {
    const slash = String(repo).indexOf('/');
    if (slash < 0) {
      process.stderr.write('pantheon-github: ghPrs: invalid repo slug "' + repo + '"\n');
      return [];
    }
    const owner = repo.slice(0, slash);
    const name = repo.slice(slash + 1);
    try {
      const arr = run(
        'GET',
        `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=${encodeURIComponent(state)}&per_page=100`,
      );
      return Array.isArray(arr) ? arr.map(normalizePr) : [];
    } catch (e) {
      process.stderr.write('pantheon-github: ghPrs(' + repo + ') failed: ' + e.message + '\n');
      return [];
    }
  };
}
