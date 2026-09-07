// In-memory stub implementation of BacklogAdapter (see ../backlog-adapter.mjs).
// Plain factory function, no class — matches this codebase's zero-`class`
// convention. Every method is SYNCHRONOUS (returns its plain result
// directly), matching the BacklogAdapter contract — in-memory operations are
// naturally synchronous, so there is nothing to await here.
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
  const runsByIdentifier = { ...seedData.runsByIdentifier };
  const pullRequestsByIdentifier = { ...seedData.pullRequestsByIdentifier };
  const comments = [];
  const createdIssues = [];
  let nextCreatedId = 1;

  return Object.freeze({
    listIssues(projectId) {
      return [...issuesByIdentifier.values()].filter((i) => i.project_id === projectId);
    },

    listAllProjectIds() {
      return [...new Set([...issuesByIdentifier.values()].map((i) => i.project_id))];
    },

    getIssueRuns(id) {
      return runsByIdentifier[id] || [];
    },

    getIssuePullRequests(id) {
      return pullRequestsByIdentifier[id] || [];
    },

    setIssueStatus(id, status) {
      const issue = issuesByIdentifier.get(id);
      if (issue) issue.status = status;
    },

    commentOnIssue(id, body) {
      comments.push({ id, body });
    },

    // Fabricates an identifier (stub-created-N) and pushes a new raw-shape
    // issue into the same in-memory map every other method reads/writes —
    // it is immediately visible to a subsequent listIssues()/getIssueRuns()
    // etc. call, matching this stub's existing mutate-in-place convention.
    createIssue(ticket = {}) {
      const identifier = `stub-created-${nextCreatedId++}`;
      const issue = {
        id: identifier,
        identifier,
        title: ticket.title,
        description: ticket.description || '',
        status: ticket.status || 'todo',
        labels: ticket.labels || [],
        assignee_id: null,
        assignee_type: null,
        project_id: ticket.project ?? null,
        parent_issue_id: ticket.parent ?? null,
        metadata: ticket.metadata || {},
      };
      issuesByIdentifier.set(identifier, issue);
      createdIssues.push(issue);
      return issue;
    },

    // ---- test-observability extras (NOT part of the BacklogAdapter contract) ----
    comments,
    createdIssues,
  });
}
