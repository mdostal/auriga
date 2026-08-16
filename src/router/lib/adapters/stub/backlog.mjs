// In-memory stub implementation of BacklogAdapter (see ../backlog-adapter.mjs).
// Plain factory function, no class — matches this codebase's zero-`class`
// convention. Every method is async (returns a Promise), matching the
// BacklogAdapter contract.
//
// createStubBacklogAdapter(seedData) seeds an in-memory Map keyed by each
// issue's `identifier` (never its internal id — see backlog-adapter.mjs's
// "id" convention note) from:
//   - seedData.issues: object[] — plain issue fixtures (reuse
//     test/support/mock-mca.mjs's / test/fixtures/test-profiles-runners.mjs's
//     shapes rather than inventing thinner ones)
//   - seedData.runsByIdentifier: { [identifier]: object[] }
//   - seedData.pullRequestsByIdentifier: { [identifier]: object[] }
//
// setIssueStatus/commentOnIssue mutate the SAME in-memory issue object a
// prior listIssues() call handed out (not a clone-on-read), so a caller that
// held onto that reference observes the mutation — the same
// mutate-by-reference behavior test/support/mock-mca.mjs already relies on
// for exercising auriga-router.mjs's cycle() across a single pass.

/**
 * @param {{ issues?: object[], runsByIdentifier?: Record<string, object[]>, pullRequestsByIdentifier?: Record<string, object[]> }} [seedData]
 * @returns {import('../backlog-adapter.mjs').BacklogAdapter}
 */
export function createStubBacklogAdapter(seedData = {}) {
  const issuesByIdentifier = new Map();
  for (const issue of seedData.issues || []) {
    if (issue && issue.identifier) issuesByIdentifier.set(issue.identifier, issue);
  }
  const runsByIdentifier = { ...(seedData.runsByIdentifier || {}) };
  const pullRequestsByIdentifier = { ...(seedData.pullRequestsByIdentifier || {}) };
  const comments = [];

  return Object.freeze({
    async listIssues(projectId) {
      return [...issuesByIdentifier.values()].filter((i) => i.project_id === projectId);
    },

    async listAllProjectIds() {
      return [...new Set([...issuesByIdentifier.values()].map((i) => i.project_id))];
    },

    async getIssueRuns(id) {
      return runsByIdentifier[id] || [];
    },

    async getIssuePullRequests(id) {
      return pullRequestsByIdentifier[id] || [];
    },

    async setIssueStatus(id, status) {
      const issue = issuesByIdentifier.get(id);
      if (issue) issue.status = status;
    },

    async commentOnIssue(id, body) {
      comments.push({ id, body });
    },

    // ---- test-observability extras (NOT part of the BacklogAdapter contract) ----
    comments,
  });
}
