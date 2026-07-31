// Auriga auto-router — PURE decision logic (no live calls).
// Everything here is deterministic and unit-tested with mocked inputs.

const ACTIVE_RUN_STATUSES = new Set([
  'running', 'in_progress', 'in progress', 'queued', 'pending', 'dispatched', 'started', 'assigned',
]);
const FAILED_RUN_STATUSES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'timeout']);
const ACTIVE_ISSUE_STATUSES = new Set(['in_progress', 'in progress', 'running']);

// Ignore smoke/scratch/verification tickets by title.
export function isSmokeScratch(title = '') {
  return /\b(smoke|scratch)\b/i.test(title) || /verification-swarm/i.test(title);
}

const HUMAN_TODO_LABEL = 'human-todo';

// Priority-1 filter: true when an issue must never enter the agent dispatch
// pool — labeled `human-todo`, or `waiting_on` a known human (cfg.HUMAN_NAMES)
// — because only a human can complete it. Excluded issues belong in the
// separate human queue instead (see scripts/export-human-queue.mjs).
export function isHumanTodo(issue, cfg) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l?.name || '').toLowerCase());
  if (labels.includes(HUMAN_TODO_LABEL)) return true;
  const waitingOn = issue.metadata && issue.metadata.waiting_on;
  if (typeof waitingOn !== 'string' || !waitingOn.trim()) return false;
  const humanNames = (cfg && cfg.HUMAN_NAMES) || [];
  const w = waitingOn.trim().toLowerCase();
  return humanNames.some((name) => w === name.toLowerCase() || w.includes(name.toLowerCase()));
}

// Why an issue was routed to the human queue — 'label' or 'waiting_on'.
// Callers should only call this once isHumanTodo(issue, cfg) is true.
export function humanTodoReason(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l?.name || '').toLowerCase());
  return labels.includes(HUMAN_TODO_LABEL) ? 'label' : 'waiting_on';
}

// Detect a "hive story" — a Minerva/plugin-hive-planned story that must route to
// HIVE_LANE (claude+plugin-hive agents), never DEFAULT_LANE/codex. Two signals:
// (1) explicit labels (forward-compat for when labels start being set), or
// (2) the description shape Minerva actually emits today: a `methodology:` key plus
// a `steps:` block with hive-role `agent:` entries (researcher/developer/tester/reviewer).
const HIVE_LABELS = new Set(['build', 'implementation', 'classic-methodology']);
const HIVE_METHODOLOGY_RE = /\bmethodology:\s*(classic|tdd|bdd)\b/i;
const HIVE_STEPS_RE = /\bsteps:\s*\r?\n/i;
const HIVE_STEP_AGENT_RE = /\bagent:\s*(researcher|developer|tester|reviewer)\b/i;

export function isHiveStory(issue = {}) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  if (labels.some((l) => HIVE_LABELS.has(String(l).toLowerCase()))) return true;
  const desc = issue.description || '';
  return HIVE_METHODOLOGY_RE.test(desc) && HIVE_STEPS_RE.test(desc) && HIVE_STEP_AGENT_RE.test(desc);
}

// Classify a single run object.
export function classifyRun(run, now = Date.now()) {
  const status = (run.status || '').toLowerCase();
  const failed = FAILED_RUN_STATUSES.has(status) || (run.error != null && run.error !== '');
  const hasCompleted = !!run.completed_at || status === 'completed' || status === 'done' || status === 'succeeded';
  const active = !failed && !hasCompleted && (ACTIVE_RUN_STATUSES.has(status) || (!run.completed_at && status === ''));
  const ts = run.completed_at || run.started_at || run.dispatched_at || run.created_at;
  const ageMs = ts ? now - new Date(ts).getTime() : Infinity;
  return { active, failed, done: hasCompleted && !failed, ageMs, status };
}

// Given an issue's runs (array), is any run currently active AND fresh?
// A run stuck in "running" longer than staleMs is treated as a silent hang
// (not active) so it can be recovered.
export function hasActiveRun(runs = [], now = Date.now(), staleMs = Infinity) {
  return runs.some((r) => {
    const c = classifyRun(r, now);
    return c.active && c.ageMs < staleMs;
  });
}

// Latest run by created_at/dispatched_at.
export function latestRun(runs = []) {
  if (!runs.length) return null;
  return [...runs].sort((a, b) => {
    const ta = new Date(a.created_at || a.dispatched_at || 0).getTime();
    const tb = new Date(b.created_at || b.dispatched_at || 0).getTime();
    return tb - ta;
  })[0];
}

// In-flight count per agent id. An issue is "in flight" for an agent ONLY when it
// is assigned to that agent AND actively running (in_progress / running).
//
// FIX 2026-07-28 (audit P0 "master switch"): previously this also counted assigned
// `todo`s as in-flight ("|| st === 'todo'"). That deadlocked the whole router:
// because assignee-mutation does not reliably enqueue a run (the dispatch dead-zone),
// assigned-todos accumulate on the board forever and never transition to running.
// Their phantom count then exceeds every RUNTIME_CAP (e.g. codex 12 > 4, claude 5 > 4)
// while real in_progress is 0 — so selectAssignments finds no agent with capacity and
// the router dispatches NOTHING, for hours, silently. Counting only truly-running
// issues makes real inflight ~0, freeing every lane. The per-cycle batch caps
// (CAPS.perCycleTotal / perCyclePerAgent) prevent over-assignment during the brief
// assign->run gap, and each assign is immediately re-run (enqueued) by the cycle loop.
export function computeInflight(issues, agents) {
  const idToName = {};
  for (const [name, a] of Object.entries(agents)) idToName[a.id] = name;
  const counts = {};
  for (const name of Object.keys(agents)) counts[name] = 0;
  for (const i of issues) {
    if (!i.assignee_id) continue;
    const name = idToName[i.assignee_id];
    if (!name) continue;
    const st = (i.status || '').toLowerCase();
    if (ACTIVE_ISSUE_STATUSES.has(st)) counts[name] += 1;
  }
  return counts;
}

// Count assigned-but-not-running issues per agent (the old "inflight" definition).
// Not used for capacity — kept for observability so the divergence between real
// in-flight and the assigned-todo backlog stays visible in the scan log.
export function computeAssignedQueued(issues, agents) {
  const idToName = {};
  for (const [name, a] of Object.entries(agents)) idToName[a.id] = name;
  const counts = {};
  for (const name of Object.keys(agents)) counts[name] = 0;
  for (const i of issues) {
    if (!i.assignee_id) continue;
    const name = idToName[i.assignee_id];
    if (!name) continue;
    const st = (i.status || '').toLowerCase();
    if (st === 'todo') counts[name] += 1;
  }
  return counts;
}

// Runtime in-flight totals derived from per-agent counts.
export function computeRuntimeInflight(inflight, agents) {
  const rt = {};
  for (const [name, count] of Object.entries(inflight)) {
    const r = agents[name]?.runtime;
    if (!r) continue;
    rt[r] = (rt[r] || 0) + count;
  }
  return rt;
}

// Can this agent accept one more, given per-agent and per-runtime caps and
// already-projected assignments this cycle?
export function agentHasCapacity(name, agents, runtimeCap, inflight, runtimeInflight, projected) {
  const a = agents[name];
  if (!a) return false;
  const agentNow = (inflight[name] || 0) + (projected.perAgent[name] || 0);
  if (agentNow >= a.maxInflight) return false;
  const rtNow = (runtimeInflight[a.runtime] || 0) + (projected.perRuntime[a.runtime] || 0);
  if (rtNow >= (runtimeCap[a.runtime] ?? Infinity)) return false;
  return true;
}

// Is this issue an un-planned "seed" that must route to the Minerva planning
// lane instead of a build lane (PAN-6646: build agents can't plan and just
// self-block on unplanned work)? True when either:
//   - it is explicitly marked ('idea' or 'needs-plan' label), OR
//   - it is unmarked, top-level (no parent_issue_id), AND childless (no issue
//     in allIssues has parent_issue_id === issue.id).
// allIssues should be the same in-memory candidate/scan array the caller
// already has (e.g. the `issues` passed into selectAssignments) — "childless"
// is only checked within that scanned set, which is expected.
//
// Scope note: the story's design doc frames the heuristic as three AND'd legs
// (no epic.yaml + no children + top-level). The "no epic.yaml" leg is
// deliberately dropped here — this router only has the Multica issue API, no
// filesystem access to any repo's .pHive/epics/, so it cannot check for an
// epic.yaml at all. This is a scope reduction, not an oversight: the
// remaining two legs (childless + top-level) match this story's verbatim
// acceptance criteria, which only asks for "unmarked AND childless AND
// top-level" and never mentions epic.yaml.
export function isSeed(issue, allIssues = []) {
  // `multica issue list`/`get` return labels as an array of label OBJECTS
  // ({ id, name, color, ... }), not plain strings — normalize to names so
  // this matches real API data, not just string-array test fixtures.
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  const explicitlyMarked = labelNames.includes('idea') || labelNames.includes('needs-plan') || labelNames.includes('consus-idea');
  if (explicitlyMarked) return true;
  const isTopLevel = !issue.parent_issue_id;
  const isChildless = !allIssues.some((i) => i.parent_issue_id === issue.id);
  return isTopLevel && isChildless;
}

// Dependency gate: is this issue's declared depends_on satisfied enough to dispatch?
// Minerva carries a decomposed story's story->story DAG into Multica as a `depends_on`
// metadata value (comma-separated dependency ISSUE ids — see fileStoriesToMultica). The router
// must NOT dispatch a story whose dependency stories aren't done yet. `statusById` is a Map of
// issueId -> lowercased status built from the same scanned board the caller already has.
//
// Rule: a dependency BLOCKS iff we can SEE it (it's in the scanned set) AND it isn't a terminal
// success/dead state (done/cancelled). A dependency we can't see (different/unscanned project)
// is NOT treated as blocking — that would deadlock forever on something the router can't observe;
// in practice an epic's stories all land in the same project so every dep is visible.
export function depsSatisfied(issue, statusById) {
  const raw = issue && issue.metadata && issue.metadata.depends_on;
  if (raw == null || raw === '') return true;
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    const st = statusById.get(id);
    if (st === undefined) continue; // unseen dep -> don't block (avoid deadlock)
    if (st !== 'done' && st !== 'cancelled' && st !== 'canceled') return false;
  }
  return true;
}

// Choose the best lane agent for a project: hive-tagged stories go to HIVE_LANE
// (never codex/opencode) regardless of project; everything else honors PROJECT_LANE
// order, else DEFAULT_LANE. Picks the candidate with the lowest current+projected
// load that still has capacity.
export function chooseAgentForProject(projectId, cfg, inflight, runtimeInflight, projected, isHive = false) {
  const lane = isHive ? cfg.HIVE_LANE : (cfg.PROJECT_LANE[projectId] || cfg.DEFAULT_LANE);
  const eligible = lane.filter((name) =>
    agentHasCapacity(name, cfg.AGENTS, cfg.RUNTIME_CAP, inflight, runtimeInflight, projected)
  );
  if (!eligible.length) return null;
  // Prefer lane order but break by lowest projected load.
  eligible.sort((x, y) => {
    const lx = (inflight[x] || 0) + (projected.perAgent[x] || 0);
    const ly = (inflight[y] || 0) + (projected.perAgent[y] || 0);
    if (lx !== ly) return lx - ly;
    return lane.indexOf(x) - lane.indexOf(y);
  });
  return eligible[0];
}

// Select this cycle's assignments from the board.
// Returns [{ identifier, issueId, projectId, agent, lane, runtime }].
// Respects per-agent inflight caps, per-runtime caps, and small per-cycle batch caps.
// blockedRuntimes: Set of runtime names to skip this cycle (rate-limited lanes).
export function selectAssignments(issues, cfg, inflight, opts = {}) {
  const blockedRuntimes = opts.blockedRuntimes || new Set();
  const maxTotal = opts.maxTotal ?? cfg.CAPS.perCycleTotal;
  const maxPerAgent = opts.maxPerAgent ?? cfg.CAPS.perCyclePerAgent;

  const runtimeInflight = computeRuntimeInflight(inflight, cfg.AGENTS);
  const projected = { perAgent: {}, perRuntime: {}, perAgentCycle: {} };

  // issueId -> lowercased status, over the WHOLE scanned board (not just candidates) so the
  // dependency gate can resolve a dep in any state (done/in_progress/todo/...).
  const statusById = new Map(issues.map((i) => [i.id, (i.status || '').toLowerCase()]));

  // Candidate pool: unassigned, status todo, not smoke/scratch, project in scan set,
  // NOT a human-todo (priority-1 rule — see isHumanTodo; routed to the human queue instead via
  // scripts/export-human-queue.mjs), and with its depends_on graph satisfied (never dispatch a
  // decomposed story whose dependency stories aren't done yet — see depsSatisfied).
  const candidates = issues
    .filter((i) => (i.status || '').toLowerCase() === 'todo')
    .filter((i) => !i.assignee_id)
    .filter((i) => !isSmokeScratch(i.title))
    .filter((i) => cfg.PROJECT_IDS.includes(i.project_id))
    .filter((i) => !isHumanTodo(i, cfg))
    .filter((i) => depsSatisfied(i, statusById));

  // Stable ordering: by project scan order, then by issue number ascending
  // (older/foundational tickets first).
  candidates.sort((a, b) => {
    const pa = cfg.PROJECT_IDS.indexOf(a.project_id);
    const pb = cfg.PROJECT_IDS.indexOf(b.project_id);
    if (pa !== pb) return pa - pb;
    return (a.number || 0) - (b.number || 0);
  });

  const PLANNING_AGENT = 'minerva-dev';

  const chosen = [];
  for (const issue of candidates) {
    if (chosen.length >= maxTotal) break;

    // Un-planned seeds MUST route to the Minerva planning lane, never a build
    // lane — and if the planning lane has no capacity this cycle, skip the
    // issue entirely rather than falling back to chooseAgentForProject.
    if (isSeed(issue, issues) && !isHiveStory(issue)) {
      if (!cfg.AGENTS[PLANNING_AGENT]) continue;
      if (!agentHasCapacity(PLANNING_AGENT, cfg.AGENTS, cfg.RUNTIME_CAP, inflight, runtimeInflight, projected)) continue;
      const runtime = cfg.AGENTS[PLANNING_AGENT].runtime;
      if (blockedRuntimes.has(runtime)) continue;
      if ((projected.perAgentCycle[PLANNING_AGENT] || 0) >= maxPerAgent) continue;

      projected.perAgent[PLANNING_AGENT] = (projected.perAgent[PLANNING_AGENT] || 0) + 1;
      projected.perRuntime[runtime] = (projected.perRuntime[runtime] || 0) + 1;
      projected.perAgentCycle[PLANNING_AGENT] = (projected.perAgentCycle[PLANNING_AGENT] || 0) + 1;

      chosen.push({
        identifier: issue.identifier,
        issueId: issue.id,
        projectId: issue.project_id,
        lane: cfg.PROJECT_NAMES[issue.project_id] || issue.project_id,
        agent: PLANNING_AGENT,
        runtime,
      });
      continue;
    }

    const agent = chooseAgentForProject(issue.project_id, cfg, inflight, runtimeInflight, projected, isHiveStory(issue));
    if (!agent) continue;
    const runtime = cfg.AGENTS[agent].runtime;
    if (blockedRuntimes.has(runtime)) continue;
    if ((projected.perAgentCycle[agent] || 0) >= maxPerAgent) continue;

    // commit projection
    projected.perAgent[agent] = (projected.perAgent[agent] || 0) + 1;
    projected.perRuntime[runtime] = (projected.perRuntime[runtime] || 0) + 1;
    projected.perAgentCycle[agent] = (projected.perAgentCycle[agent] || 0) + 1;

    chosen.push({
      identifier: issue.identifier,
      issueId: issue.id,
      projectId: issue.project_id,
      lane: cfg.PROJECT_NAMES[issue.project_id] || issue.project_id,
      agent,
      runtime,
    });
  }
  return chosen;
}

// Pure-code state-machine: advance in_progress issues whose latest run
// completed successfully to in_review. No agent call — a done, non-failed run
// (see classifyRun) is the only signal. Only considers issues currently
// in_progress, so a re-scan after the transition naturally stops re-firing
// (the issue is no longer in the input set) — idempotent by construction.
export function detectRunCompletions(inProgressIssues, runsByIssue, now = Date.now()) {
  const actions = [];
  for (const i of inProgressIssues) {
    if (isSmokeScratch(i.title)) continue;
    const lr = latestRun(runsByIssue[i.identifier] || []);
    if (!lr) continue;
    if (classifyRun(lr, now).done) {
      actions.push({ identifier: i.identifier, issueId: i.id, projectId: i.project_id, action: 'advance-in-review' });
    }
  }
  return actions;
}

// Pure-code state-machine: advance in_review issues to done once verify_ok is
// real — a linked PR has actually merged (state 'merged' or a non-null
// merged_at), not merely runStatus reporting success. This is the
// false-confidence guard: runStatus is never treated as "done" on its own.
// prsByIssue: { [identifier]: pullRequest[] } from `multica issue pull-requests`.
export function detectVerifiedDone(inReviewIssues, prsByIssue) {
  const actions = [];
  for (const i of inReviewIssues) {
    if (isSmokeScratch(i.title)) continue;
    const prs = prsByIssue[i.identifier] || [];
    const merged = prs.some((pr) => pr.state === 'merged' || pr.merged_at != null);
    if (merged) {
      actions.push({ identifier: i.identifier, issueId: i.id, projectId: i.project_id, action: 'advance-done' });
    }
  }
  return actions;
}

// Detect zombies among in_progress issues.
// runsByIssue: { [identifier]: runs[] }. Returns recovery actions.
// action 'rerun' when the issue already has an assignee; 'assign' when it needs (re)routing.
export function detectZombies(inProgressIssues, runsByIssue, cfg, now = Date.now()) {
  const actions = [];
  for (const i of inProgressIssues) {
    if (isSmokeScratch(i.title)) continue;
    const runs = runsByIssue[i.identifier] || [];
    if (hasActiveRun(runs, now, cfg.CAPS.zombieStaleMs)) continue; // healthy & fresh
    const lr = latestRun(runs);
    const stale = !lr || classifyRun(lr, now).failed || classifyRun(lr, now).ageMs > cfg.CAPS.zombieStaleMs;
    if (!stale) continue;
    actions.push({
      identifier: i.identifier,
      issueId: i.id,
      projectId: i.project_id,
      lane: cfg.PROJECT_NAMES[i.project_id] || i.project_id,
      hasAssignee: !!i.assignee_id,
      isHive: isHiveStory(i),
      action: i.assignee_id ? 'rerun' : 'assign',
      reason: !lr ? 'no-runs' : (classifyRun(lr, now).failed ? 'last-run-failed' : 'run-stale'),
    });
  }
  return actions;
}

// ============================================================================
// BACK-HALF OF THE LOOP: review / ship dispatch (pure decision logic).
// ----------------------------------------------------------------------------
// The state-machine already advances in_progress -> in_review when a build run
// completes. But nothing then reviews/tests/merges the PR, so the ticket stalls
// at in_review. selectReviewDispatch decides which in_review stories to hand to
// the Claude+plugin-hive REVIEW lane (cfg.REVIEW_LANE). The review AGENT does the
// git work (find the PR, /hive:review, /hive:test, merge->done OR comment->back);
// this function only decides *dispatch*, exactly like selectAssignments decides
// build dispatch. Router shells out (assign + rerun) to actually enqueue.

// A `target_repo:` line in the description is the build-lane's own signal, so its
// presence is a reliable "this story produced code in a repo" marker.
const TARGET_REPO_RE = /(^|\n)\s*target_repo:\s*\S+/i;
export function hasTargetRepo(issue = {}) {
  return TARGET_REPO_RE.test(issue.description || '');
}

// Broad PR<->ticket matcher. The old convention (branch feat/<TICKET-ID> only) was
// too narrow: build lanes name branches like feat/pan-6667-descriptive (lowercased +
// suffixed) and rarely start a title with the id. Match the ticket id (case-
// insensitive) ANYWHERE in the PR's head branch, title, or body.
export function prReferencesIssue(pr = {}, identifier = '') {
  if (!identifier) return false;
  const id = String(identifier).toLowerCase();
  const hay = [pr.headRefName, pr.head_ref, pr.branch, pr.title, pr.body]
    .filter((s) => typeof s === 'string')
    .join('\n')
    .toLowerCase();
  return hay.includes(id);
}

// Is a PR open (not merged/closed)? Tolerant of gh's uppercase 'OPEN' and of a
// missing state (open only when there is no merged/closed marker).
export function prIsOpen(pr = {}) {
  const st = (pr.state || '').toLowerCase();
  if (st === 'open') return true;
  if (st === 'merged' || st === 'closed') return false;
  return !pr.merged_at && !pr.mergedAt && !pr.closed_at && !pr.closedAt;
}

// Does this ticket have at least one OPEN PR referencing it? `prs` is the array of
// candidate PRs the router gathered (gh pr list across the story's resolvable repos).
export function hasOpenPrForIssue(identifier, prs = []) {
  return (prs || []).some((pr) => prIsOpen(pr) && prReferencesIssue(pr, identifier));
}

// Normalize a target_repo value (bare slug, https/ssh git URL, github.com/owner/repo,
// with or without a trailing .git) to an owner/repo slug, or null if it is not a bare
// GitHub slug (e.g. a local filesystem path with extra segments).
export function normalizeRepoSlug(value = '') {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '');
  const m = v.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return m[1] + '/' + m[2];
}

// The story's declared target_repo: metadata.target_repo (preferred) or a
// `target_repo: <value>` line in the description. Raw value (not normalized).
export function targetRepoValue(issue = {}) {
  const meta = issue && issue.metadata && issue.metadata.target_repo;
  if (typeof meta === 'string' && meta.trim()) return meta.trim();
  const m = (issue.description || '').match(/(^|\n)\s*target_repo:\s*(\S+)/i);
  return m ? m[2] : null;
}

// Whether to burn a Claude review run on an in_review story. STRICT gate: a REAL
// open PR referencing the ticket (hasOpenPR, computed by the router via gh). No PR
// => a parent seed / planning / idea ticket => NOT eligible => skipped (never
// dispatched, so the review path can never false-block it). A real matching open PR
// is also proof the target repo is resolvable (it is the PR's own repo), satisfying
// the "resolvable target_repo AND a real open PR" requirement.
export function reviewEligible(issue = {}, hasOpenPR = false) {
  return !!hasOpenPR;
}

// How many review slots each review-lane agent currently occupies. An in_review
// issue assigned to a review agent = that agent is (or should be) reviewing it,
// so it holds a slot until it leaves in_review (merged->done) or is sent back.
// This caps concurrent reviews at each agent's maxInflight without touching the
// build lanes' claude RUNTIME_CAP accounting (review agents use their own bucket).
export function computeReviewInflight(inReviewIssues, cfg) {
  const lane = cfg.REVIEW_LANE || [];
  const idToName = {};
  for (const n of lane) { const a = cfg.AGENTS[n]; if (a) idToName[a.id] = n; }
  const counts = {};
  for (const n of lane) counts[n] = 0;
  for (const i of inReviewIssues) {
    const name = idToName[i.assignee_id];
    if (name) counts[name] += 1;
  }
  return counts;
}

// Pick the review-lane agent with the most free capacity (lowest current+projected
// load) that is still under its maxInflight. Returns null when the lane is full.
export function chooseReviewAgent(cfg, reviewInflight, projected = {}) {
  const lane = cfg.REVIEW_LANE || [];
  const eligible = lane.filter((name) => {
    const a = cfg.AGENTS[name];
    if (!a) return false;
    const now = (reviewInflight[name] || 0) + (projected[name] || 0);
    return now < a.maxInflight;
  });
  if (!eligible.length) return null;
  eligible.sort((x, y) => {
    const lx = (reviewInflight[x] || 0) + (projected[x] || 0);
    const ly = (reviewInflight[y] || 0) + (projected[y] || 0);
    if (lx !== ly) return lx - ly;
    return lane.indexOf(x) - lane.indexOf(y);
  });
  return eligible[0];
}

// Decide this cycle's review/ship dispatches from the in_review board.
// runsByIssue: { [identifier]: runs[] } for the in_review issues.
// Returns [{ identifier, issueId, projectId, agent, action, reason }] where
//   action 'dispatch-review' = (re)assign to a review agent then enqueue a run;
//   action 'rerun-review'    = already assigned to a review agent but its run went
//                              stale/failed — re-enqueue the same assignment.
// IDEMPOTENCY: assignment to a review agent is the "already dispatched" marker.
//   - assignee is NOT a review agent  -> fresh review needed (dispatch-review).
//   - assignee IS a review agent + active/fresh run -> reviewing now, skip.
//   - assignee IS a review agent + run stale/failed -> rerun-review (safety net;
//     e.g. the agent finished but never merged/looped-back — re-fires after the
//     zombie window so a wedged review self-heals rather than stalling forever).
// A clean review leaves in_review by merging->done; a loop-back leaves by going
// back to todo+unassigned — either way the issue drops out of this input set next
// cycle, so this never double-acts on a resolved story.
export function selectReviewDispatch(inReviewIssues, runsByIssue, cfg, reviewInflight, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxTotal = opts.maxTotal ?? (cfg.CAPS && cfg.CAPS.perCycleReview) ?? 1;
  const staleMs = (cfg.CAPS && cfg.CAPS.zombieStaleMs) ?? Infinity;
  const openPrIds = opts.openPrIds instanceof Set ? opts.openPrIds : null;
  const lane = cfg.REVIEW_LANE || [];
  if (!lane.length) return [];
  const reviewAgentIds = new Set(lane.map((n) => cfg.AGENTS[n] && cfg.AGENTS[n].id).filter(Boolean));
  const idToName = {};
  for (const n of lane) { const a = cfg.AGENTS[n]; if (a) idToName[a.id] = n; }

  const actions = [];
  const projected = {};
  for (const i of inReviewIssues) {
    if (actions.length >= maxTotal) break;
    if (isSmokeScratch(i.title)) continue;
    const runs = runsByIssue[i.identifier] || [];

    if (reviewAgentIds.has(i.assignee_id)) {
      // already under review — only re-fire when its run is stale/failed
      if (hasActiveRun(runs, now, staleMs)) continue; // reviewing now
      const lr = latestRun(runs);
      const stale = !lr || classifyRun(lr, now).failed || classifyRun(lr, now).ageMs > staleMs;
      if (!stale) continue; // finished recently — give the agent time to act
      actions.push({
        identifier: i.identifier, issueId: i.id, projectId: i.project_id,
        agent: idToName[i.assignee_id], action: 'rerun-review', reason: 'review-stale',
      });
      continue;
    }

    // not yet under review — pick a review agent with free capacity
    // FRESH dispatch: gate on a REAL open PR referencing the ticket (opts.openPrIds,
    // computed by the router via gh). No PR => a parent seed / planning / idea ticket
    // => SKIP, so the review path can never false-block it. A story already assigned
    // to a review agent (handled above) is the self-heal path and is NOT PR-gated.
    const hasPr = openPrIds ? openPrIds.has(i.identifier) : false;
    if (!reviewEligible(i, hasPr)) continue;

    const agent = chooseReviewAgent(cfg, reviewInflight, projected);
    if (!agent) continue;
    projected[agent] = (projected[agent] || 0) + 1;
    actions.push({
      identifier: i.identifier, issueId: i.id, projectId: i.project_id,
      agent, action: 'dispatch-review', reason: 'needs-review',
    });
  }
  return actions;
}
