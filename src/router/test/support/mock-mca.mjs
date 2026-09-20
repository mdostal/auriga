// A mock of lib/multica.mjs's shape for exercising auriga-router.mjs's
// cycle() end-to-end WITHOUT touching a live `multica`/`gh` CLI. Tracks every
// call so a test can assert on what the router actually did, and mutates an
// in-memory board so state-machine passes (assign/status/unassign) are
// observable across a single cycle() call.
//
// assignIssue() also synthesizes an active run for the assigned identifier —
// this stands in for "the platform started a run", which is what the
// router's post-assign verify step (see cycle()'s "route new todos" section)
// is checking for. Without it every assignment would fall through to
// verify_no_run -> rerun, which is real router behavior but not what these
// dispatch-shape tests are exercising.
export function createMockMca(boardIssues, agents) {
  const calls = { assign: [], rerun: [], status: [], unassign: [], comment: [] };
  const runsByIdentifier = {};

  const findIssue = (identifier) => boardIssues.find((i) => i.identifier === identifier);

  return {
    calls,
    runsByIdentifier,
    boardIssues,

    listAllProjectIds: () => [],
    listAllIssues: (projectIds) => boardIssues.filter((i) => projectIds.includes(i.project_id)),

    issueRuns: (identifier) => runsByIdentifier[identifier] || [],

    assignIssue: (identifier, agentName) => {
      calls.assign.push({ identifier, agentName });
      const issue = findIssue(identifier);
      if (issue) issue.assignee_id = agents[agentName] && agents[agentName].id;
      runsByIdentifier[identifier] = [
        ...(runsByIdentifier[identifier] || []),
        { status: 'in_progress', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() },
      ];
      return { ok: true };
    },

    rerunIssue: (identifier) => {
      calls.rerun.push({ identifier });
      runsByIdentifier[identifier] = [
        ...(runsByIdentifier[identifier] || []),
        { status: 'in_progress', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() },
      ];
      return { ok: true };
    },

    issueStatus: (identifier, status) => {
      calls.status.push({ identifier, status });
      const issue = findIssue(identifier);
      if (issue) issue.status = status;
      return { ok: true };
    },

    issuePullRequests: () => [],
    ghOpenPrs: () => [],
    ghListRepos: () => [],
    ghPrs: () => [],

    unassignIssue: (identifier) => {
      calls.unassign.push({ identifier });
      const issue = findIssue(identifier);
      if (issue) issue.assignee_id = null;
      return { ok: true };
    },

    issueComment: (identifier, body) => {
      calls.comment.push({ identifier, body });
      return { ok: true };
    },
  };
}

// Captures log(event, data) calls in order, for assertions on what the
// router observed/decided without writing to real log files.
export function createLogSink() {
  const events = [];
  const log = (event, data) => { events.push({ event, ...data }); };
  log.events = events;
  log.byEvent = (event) => events.filter((e) => e.event === event);
  return log;
}
