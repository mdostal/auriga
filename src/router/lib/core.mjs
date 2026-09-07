// Auriga auto-router — PURE decision logic (no live calls).
// Everything here is deterministic and unit-tested with mocked inputs.

import { isPrMerged } from './github-pr-state.mjs';
import { ISSUE_STATUS, isTerminalIssueStatus } from './issue-status.mjs';
import { classifyRun, hasActiveRun, latestRun } from './run-classification.mjs';
import { storyKey, slugKey, descStoryDeps, descStoryId } from './story-identity.mjs';
import {
  hasTargetRepo, prReferencesIssue, prMatchesStory, prIdentityMatchesStory,
  repoFromPrUrl, prIsOpen, hasOpenPrForIssue, normalizeRepoSlug, targetRepoValue,
} from './pr-matching.mjs';
import {
  computeInflight, computeAssignedQueued, computeRuntimeInflight, agentHasCapacity,
  computeReviewInflight, chooseReviewAgent,
} from './capacity.mjs';
import { DEFAULT_SQUAD_RULES, reviewSquadPlan, squadPlanSummary } from './review-squad.mjs';
export { isPrMerged };
export { classifyRun, hasActiveRun, latestRun };
export { storyKey, slugKey, descStoryDeps, descStoryId };
export {
  hasTargetRepo, prReferencesIssue, prMatchesStory, prIdentityMatchesStory,
  repoFromPrUrl, prIsOpen, hasOpenPrForIssue, normalizeRepoSlug, targetRepoValue,
};
export {
  computeInflight, computeAssignedQueued, computeRuntimeInflight, agentHasCapacity,
  computeReviewInflight, chooseReviewAgent,
};
export { DEFAULT_SQUAD_RULES, reviewSquadPlan, squadPlanSummary };

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

// storyKey/slugKey/descStoryDeps/descStoryId now live in
// ./story-identity.mjs — imported + re-exported above (t011 decomposition).

// classifyRun/hasActiveRun/latestRun now live in ./run-classification.mjs —
// imported + re-exported above (t011 decomposition).

// computeInflight/computeAssignedQueued/computeRuntimeInflight/
// agentHasCapacity now live in ./capacity.mjs — imported + re-exported
// above (t011 decomposition).

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
//
// LOOP FIX (found live 2026-09-01, PANT-79): the childless+top-level fallback
// misclassifies any standalone, already-scoped bug/fix ticket as a seed --
// there is no such thing in this heuristic as "top-level but not actually an
// idea." Minerva correctly declines these (see its own instructions' non-seed
// check) and unassigns, but isSeed() re-evaluates true on the very next
// cycle since the issue is still top-level and still childless, producing an
// infinite minerva-dev<->unassign dispatch loop (confirmed live: PANT-79
// cycled 4 times before Minerva self-mitigated by setting status to
// `blocked`, which only sidesteps the candidate-pool filter rather than
// fixing the misclassification). The `not-a-seed` label is the durable
// escape hatch: Minerva applies it when declining an issue for this reason
// (see minerva-dev's own live agent instructions), and it's checked FIRST,
// before the explicit-mark and heuristic legs, so it always wins even if a
// human later adds 'idea'/'needs-plan' back by mistake.
export function isSeed(issue, allIssues = []) {
  // `multica issue list`/`get` return labels as an array of label OBJECTS
  // ({ id, name, color, ... }), not plain strings — normalize to names so
  // this matches real API data, not just string-array test fixtures.
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  if (labelNames.includes('not-a-seed')) return false;
  const explicitlyMarked = labelNames.includes('idea') || labelNames.includes('needs-plan') || labelNames.includes('consus-idea');
  if (explicitlyMarked) return true;
  const isTopLevel = !issue.parent_issue_id;
  const isChildless = !allIssues.some((i) => i.parent_issue_id === issue.id);
  return isTopLevel && isChildless;
}

// Is this issue explicitly marked for hand-up to this instance's registered
// parent (t015 — orchestrator hand-up)? Mirrors isSeed()'s label-detection
// shape exactly: a `hand-up` label is the durable, human/Minerva-applied
// signal that "this doesn't fit anything I have access to" — a judgment
// call the router never makes on its own (see this epic's design-discussion.md,
// Open Question 1). Same label-object-vs-string normalization isSeed() needs
// (`multica issue list`/`get` return labels as [{id, name, ...}], not plain
// strings).
//
// This predicate alone does NOT decide whether a hand-up actually happens —
// selectAssignments only acts on it when NO normal local route exists (the
// label means "if nothing else fits", never an unconditional override of a
// working local dispatch) AND a real parent board is configured
// (opts.parentBoardConfig, from orchestrator-topology.mjs's
// resolveParentBoardConfig()) — see selectAssignments below.
export function isHandUp(issue) {
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  return labelNames.includes('hand-up');
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
    if (!isTerminalIssueStatus(st)) return false;
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
  // Identifiers already handled by the cascade pass this cycle — exclude them so a
  // just-cascaded (assigned+rerun) dependent is not double-dispatched here.
  const exclude = opts.exclude || new Set();

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
    .filter((i) => (i.status || '').toLowerCase() === ISSUE_STATUS.TODO)
    .filter((i) => !exclude.has(i.identifier))
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

  // t015 — orchestrator hand-up: decisions are returned as DATA (never
  // acted on here — core.mjs stays pure/no-I/O, same invariant t011's
  // decomposition preserved everywhere else). auriga-router.mjs's cycle()
  // performs the actual cross-board createIssue + local comment/unassign/
  // status-change for each entry. Attached to the returned `chosen` array
  // as a non-array-breaking extra property (see the `return` below) so
  // every existing caller that treats this return value as a plain array
  // (`.length`, `for...of`, etc.) is unaffected.
  const handUps = [];

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
    if (!agent) {
      // Hand-up fallback: ONLY when no normal local route exists (the
      // hand-up label means "if nothing else fits", never an unconditional
      // override of a working local dispatch) AND a real parent board is
      // configured. No configured parent -> falls through unchanged to the
      // existing isHumanTodo/human-queue-export path, exactly like any
      // other unroutable ticket.
      if (isHandUp(issue) && opts.parentBoardConfig) {
        handUps.push({ identifier: issue.identifier, issueId: issue.id, reason: 'no-local-route' });
      }
      continue;
    }
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
  chosen.handUps = handUps;
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
// real — a linked PR has actually merged (see isPrMerged in
// github-pr-state.mjs), not merely runStatus reporting success. This is the
// false-confidence guard: runStatus is never treated as "done" on its own.
// prsByIssue: { [identifier]: pullRequest[] } — real gh-CLI-shaped PR objects
// (see lib/adapters/pantheon-v2-l2/index.mjs's ghPrs()) as of the
// pantheon-owns-multica-board-bridge cutover; GH #81 found this function
// still checking the OLD Multica-native shape's casing (lowercase
// 'merged'/snake_case merged_at) and never firing on a real one.
export function detectVerifiedDone(inReviewIssues, prsByIssue) {
  const actions = [];
  for (const i of inReviewIssues) {
    if (isSmokeScratch(i.title)) continue;
    const prs = prsByIssue[i.identifier] || [];
    const merged = prs.some(isPrMerged);
    if (merged) {
      actions.push({ identifier: i.identifier, issueId: i.id, projectId: i.project_id, action: 'advance-done' });
    }
  }
  return actions;
}

// Detect zombies among in_progress issues.
// runsByIssue: { [identifier]: runs[] }. Returns recovery actions.
// action 'rerun' when the issue already has an assignee; 'assign' when it needs (re)routing.
// Is an assignee id one of the Claude+plugin-hive lanes that can actually run
// /hive:execute|review|test? Only these may hold a hive-methodology story.
export function isHiveCapableAssignee(assigneeId, cfg) {
  if (!assigneeId) return false;
  const laneNames = new Set([...(cfg.HIVE_LANE || []), ...(cfg.REVIEW_LANE || [])]);
  for (const name of laneNames) {
    const a = cfg.AGENTS[name];
    if (a && a.id === assigneeId) return true;
  }
  return false;
}

export function detectZombies(inProgressIssues, runsByIssue, cfg, now = Date.now()) {
  const actions = [];
  for (const i of inProgressIssues) {
    if (isSmokeScratch(i.title)) continue;
    const runs = runsByIssue[i.identifier] || [];
    if (hasActiveRun(runs, now, cfg.CAPS.zombieStaleMs)) continue; // healthy & fresh
    const lr = latestRun(runs);
    const stale = !lr || classifyRun(lr, now).failed || classifyRun(lr, now).ageMs > cfg.CAPS.zombieStaleMs;
    if (!stale) continue;
    const isHive = isHiveStory(i);
    // FIX 2026-07-31 (codex mis-routing): a hive story stuck on a NON-hive-capable
    // lane (codex/opencode) must never be re-run on that same lane — that just re-
    // fires the self-block ("plugin-hive execute is unavailable in this Codex
    // runtime"). Force a REASSIGN to a hive lane instead of a same-assignee rerun.
    const misLaned = isHive && !!i.assignee_id && !isHiveCapableAssignee(i.assignee_id, cfg);
    // GH #75 / t001-zombie-give-up: bound zombie-recovery retries instead of
    // re-firing assign/rerun forever. runsByIssue already gives us the
    // issue's own run history for free, so its length is a natural, stateless
    // attempt counter — no new persistent state needed.
    //
    // Hellsing boundary: this is a deliberate, BOUNDED stopgap, not the real
    // fix. pantheon-v2's plugins/hellsing/README.md reserves "the dangerous
    // actuation of terminating stuck processes" for a separate god (Hellsing),
    // keeping Auriga "a thin, event-driven state-machine consumer." Hellsing
    // is phase:concept with no runnable code today, and Auriga has no
    // SpawnAdapter method to actually terminate a stuck process (adding one
    // pre-emptively would violate adapters/README.md's no-pre-emptive-
    // integrations rule). So once an issue exhausts its attempt budget,
    // Auriga stops re-actuating and surfaces a clear 'give-up' signal (logged
    // + commented on the issue) instead of silently looping forever. Real
    // termination/actuation stays Hellsing's job once it exists and runs.
    if (runs.length >= cfg.CAPS.zombieMaxAttempts) {
      actions.push({
        identifier: i.identifier,
        issueId: i.id,
        projectId: i.project_id,
        lane: cfg.PROJECT_NAMES[i.project_id] || i.project_id,
        hasAssignee: !!i.assignee_id,
        isHive,
        action: 'give-up',
        reason: 'max-attempts-exhausted',
      });
      continue;
    }
    actions.push({
      identifier: i.identifier,
      issueId: i.id,
      projectId: i.project_id,
      lane: cfg.PROJECT_NAMES[i.project_id] || i.project_id,
      hasAssignee: !!i.assignee_id,
      isHive,
      action: (i.assignee_id && !misLaned) ? 'rerun' : 'assign',
      reason: misLaned ? 'hive-on-noncapable-lane'
        : (!lr ? 'no-runs' : (classifyRun(lr, now).failed ? 'last-run-failed' : 'run-stale')),
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

// hasTargetRepo/prReferencesIssue/prMatchesStory/prIdentityMatchesStory/
// repoFromPrUrl/prIsOpen/hasOpenPrForIssue/normalizeRepoSlug/targetRepoValue
// now live in ./pr-matching.mjs — imported + re-exported above (t011
// decomposition).

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
// computeReviewInflight/chooseReviewAgent now live in ./capacity.mjs —
// imported + re-exported above (t011 decomposition).

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

// ============================================================================
// MULTI-STORY CRUX: blocked -> todo auto-unblock (PAN-6662, 2026-07-31)
// ----------------------------------------------------------------------------
// A decomposed epic parks its non-root stories in `blocked` at plan time because
// their dependency stories aren't built yet. Every other pass here only ever
// looks at todo/in_progress/in_review — NOTHING un-parks a blocked story once its
// deps merge. So an epic builds its root story, advances it to done, and then
// stalls forever: cm-02 (depends on cm-01) never leaves `blocked`, even though
// cm-01 is done. This pass closes that gap.
//
// A blocked story is READY to become `todo` iff:
//   (a) it DECLARES a dependency graph — metadata.depends_on is non-empty, AND
//   (b) every declared dependency is in a terminal-success state (depsSatisfied,
//       the same gate the build-dispatch candidate pool uses).
// A blocked story with NO declared deps is parked for some other (human) reason
// and is deliberately left untouched — this pass never touches `deps=NONE`
// blocked work.
//
// The router applies the transition (status->todo + unassign so it re-enters
// routing as a fresh candidate) and separately guards with a zero-prior-runs
// check, so a story that was parked in `blocked` but already carries runs / an
// open PR (an anomaly) is never re-dispatched.
// Are this story's DESCRIPTION-declared dependency slugs all satisfied? Each dep
// slug (e.g. "m-01-core-recall-interface" or "p1-router-capability-routing") is
// resolved to its SIBLING story (same parent_issue_id) by, in order:
//   1. an EXACT match against the sibling's own declared `id:` slug (descStoryId)
//      — the "p1-..." convention, where the full slug IS the identity; or
//   2. the short epic-scoped key (storyKey === slugKey) — the "m-01"/"cm-07"
//      convention, kept for backward compatibility.
// A resolved sibling BLOCKS unless it is terminal (done/cancelled). A parseable
// short-key slug that has no matching sibling does not block, matching the legacy
// anti-deadlock rule. An unparseable declared slug blocks unless it resolved by
// exact id first; this keeps p1/v1/s1-style exact-id deps from silently satisfying.
export function descDepsSatisfied(issue, allIssues = []) {
  const slugs = descStoryDeps(issue);
  if (!slugs.length) return true;
  const siblings = allIssues.filter((s) => s.parent_issue_id && s.parent_issue_id === issue.parent_issue_id && s.id !== issue.id);
  for (const slug of slugs) {
    const slugLower = slug.toLowerCase();
    let dep = siblings.find((s) => descStoryId(s) === slugLower);
    if (!dep) {
      const k = slugKey(slug);
      if (!k) return false; // exact-id-style dep declared but unresolved: conservative block
      dep = siblings.find((s) => storyKey(s) === k);
      if (!dep) continue; // unresolved — don't block (avoid deadlock)
    }
    if (!isTerminalIssueStatus((dep.status || '').toLowerCase())) return false;
  }
  return true;
}

// True when a story DECLARES a dependency graph anywhere (metadata OR description).
export function hasDeclaredDeps(issue) {
  const raw = issue && issue.metadata && issue.metadata.depends_on;
  if (raw != null && String(raw).trim() !== '') return true;
  return descStoryDeps(issue).length > 0;
}

// A story's full dependency gate: BOTH its metadata ticket-id deps (depsSatisfied)
// AND its description slug deps (descDepsSatisfied) must be satisfied.
export function allDepsSatisfied(issue, statusById, allIssues = []) {
  return depsSatisfied(issue, statusById) && descDepsSatisfied(issue, allIssues);
}

// blocked -> todo when a story's declared deps clear. `allIssues` (optional, added
// 2026-07-31) lets the pass resolve DESCRIPTION-declared slug deps against siblings,
// not just metadata ticket-id deps — the m-02-depends-on-m-01 case, where the dep
// lived only in the description and the child never unblocked though its dep was done.
export function detectUnblocks(blockedIssues, statusById, allIssues = []) {
  const actions = [];
  for (const i of blockedIssues) {
    if (isSmokeScratch(i.title)) continue;
    if (!hasDeclaredDeps(i)) continue; // parked for a non-dependency reason — leave it
    if (!allDepsSatisfied(i, statusById, allIssues)) continue; // a declared dep isn't done yet
    actions.push({ identifier: i.identifier, issueId: i.id, projectId: i.project_id, action: 'unblock-to-todo' });
  }
  return actions;
}

// ============================================================================
// STATUS TRUTH: "done" must mean MERGED, not branch-pushed (2026-07-31).
// ----------------------------------------------------------------------------
// A story can reach `done` via a build/ship agent that set the status directly
// after merely pushing a branch / opening a PR (bypassing the router's merged
// gate in detectVerifiedDone, which only ever ADVANCES to done on a real merge —
// it never DEMOTES a wrongly-done story). detectFalseDone is that missing guard:
// a `done` story that STILL has a matching OPEN (unmerged) PR is a lie — demote it
// back to in_review so the review lane picks it up and either merges it (truth) or
// loops it back. STRICTLY PR-gated: only fires when a real open PR referencing the
// story is found. A done story with NO discoverable open PR is left untouched — it
// may be a legitimately-done non-code task (planning/decision/doc), and demoting it
// on absence would be wrong. `openPrs` is the board-wide open-PR array the router
// already gathered (gh pr list across the search repos).
// The story's OWN recorded PR url (metadata.pr_url, or a `pr_url:` line in the
// description), or null. This is the authoritative "this exact PR belongs to this
// story" signal the build/ship lane records when it opens the PR.
export function ownPrUrl(issue = {}) {
  const meta = issue && issue.metadata && issue.metadata.pr_url;
  if (typeof meta === 'string' && meta.trim()) return meta.trim();
  const m = (issue.description || '').match(/(^|\n)\s*pr_url:\s*(\S+)/i);
  return m ? m[2].trim() : null;
}

// Compare two github PR urls ignoring protocol / trailing slash / .git.
export function samePrUrl(a, b) {
  const norm = (u) => String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return !!a && !!b && norm(a) === norm(b);
}

export function detectFalseDone(doneIssues, openPrs = []) {
  const actions = [];
  for (const i of doneIssues) {
    if (isSmokeScratch(i.title)) continue;
    // AUTHORITATIVE PATH (collision-proof): when the story records its OWN PR url,
    // ONLY that exact PR being still open can demote it. If its own PR is merged or
    // closed (absent from the gathered open-PR set) the story is truly shipped and
    // must NEVER be demoted. This closes the generic-key collision loop: a story
    // keyed "s1"/"p1" was being demoted by an UNRELATED open PR that merely said
    // "S1 ..." in its title, re-dispatching the review lane onto already-merged work
    // every cycle (PAN-6952: own PR mdostal/logic-loops#1 was MERGED, yet
    // dostal-swarm#96 "docs: S1 pipeline-contract" kept demoting it). The fuzzy
    // story key is never trusted for a STATUS MUTATION when an authoritative url exists.
    const own = ownPrUrl(i);
    if (own) {
      const ownStillOpen = (openPrs || []).find((p) => prIsOpen(p) && samePrUrl(p.url || p.html_url, own));
      if (!ownStillOpen) continue; // own PR merged/closed -> genuinely done, leave it
      actions.push({
        identifier: i.identifier, issueId: i.id, projectId: i.project_id,
        action: 'demote-to-in-review', prUrl: own,
      });
      continue;
    }
    // FALLBACK (no recorded own PR — older slug-branched stories whose PR branch
    // carries the story key but not the PAN id): match by branch/title identity,
    // repo-qualified. Kept so the m-01-style genuine false-done still fires.
    const wantRepo = normalizeRepoSlug(targetRepoValue(i) || '');
    const repoQualifies = (p) => {
      if (!wantRepo) return true;
      const prRepo = normalizeRepoSlug(p._repo || repoFromPrUrl(p) || '');
      return !prRepo || prRepo === wantRepo;
    };
    const pr = (openPrs || []).find((p) => {
      if (!prIsOpen(p)) return false;
      if (!prIdentityMatchesStory(p, i)) return false; // branch/title identity only (never body)
      return repoQualifies(p);
    });
    if (!pr) continue; // no OWN open PR -> either merged or a non-code done task -> leave it
    // GUARD (GitHub issue #76 / PANT-4 thrash): a stray still-open PR that merely
    // identity-matches the story (a stale retry, an old draft, anything else
    // referencing the same ticket id/key) must not out-rank a REAL merged PR for the
    // same story in the same repo. Without this, detectVerifiedDone advances the story
    // to done off the merged PR while detectFalseDone immediately demotes it again off
    // the unrelated open one, and the two detectors thrash done<->in_review forever.
    // A merged identity-matching PR means the story is genuinely done -> skip the demotion.
    const mergedPr = (openPrs || []).find((p) => {
      if (!isPrMerged(p)) return false;
      if (!prIdentityMatchesStory(p, i)) return false;
      return repoQualifies(p);
    });
    if (mergedPr) continue; // a merged own PR beats a stray open one -> genuinely done, leave it
    actions.push({
      identifier: i.identifier, issueId: i.id, projectId: i.project_id,
      action: 'demote-to-in-review', prUrl: pr.url || pr.html_url || null,
    });
  }
  return actions;
}

// Pure-code state-machine: which non-terminal PARENT issues should roll up to
// `done` because every one of their children is already terminal (done/cancelled)?
// Nothing else advances a parent/epic when its last child completes — detectVerifiedDone
// only advances the leaf story that owns a merged PR. `issues` is the whole scanned
// board; a parent is any issue that at least one other issue names via parent_issue_id.
// Only fires when the parent is IN the scanned set, is not already terminal, and ALL of
// its (visible) children are terminal — so it never rolls up an epic mid-flight.
export function detectParentDone(issues) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const childrenByParent = new Map();
  for (const i of issues) {
    if (!i.parent_issue_id) continue;
    if (!childrenByParent.has(i.parent_issue_id)) childrenByParent.set(i.parent_issue_id, []);
    childrenByParent.get(i.parent_issue_id).push(i);
  }
  const actions = [];
  for (const [parentId, kids] of childrenByParent) {
    const parent = byId.get(parentId);
    if (!parent) continue; // parent not in scanned set — can't judge
    if (isSmokeScratch(parent.title)) continue;
    const pst = (parent.status || '').toLowerCase();
    if (isTerminalIssueStatus(pst)) continue; // already closed
    if (!kids.length) continue;
    const allDone = kids.every((k) => isTerminalIssueStatus((k.status || '').toLowerCase()));
    if (allDone) actions.push({ identifier: parent.identifier, issueId: parent.id, projectId: parent.project_id, action: 'advance-parent-done' });
  }
  return actions;
}

// DEFAULT_SQUAD_RULES/reviewSquadPlan/squadPlanSummary now live in
// ./review-squad.mjs — imported + re-exported above (t011 decomposition).

// ============================================================================
// CASCADE RE-DISPATCH — completion -> enqueue now-unblocked dependents (2026-08-01).
// ----------------------------------------------------------------------------
// THE self-draining fix (cascade gap). When a story reaches `done`, its
// dependents whose full dependency graph is NOW satisfied must be ENQUEUED so
// they actually build. Historically nothing did this end-to-end: detectUnblocks
// flipped a blocked dependent to `todo`+unassign and then RELIED on
// selectAssignments to pick it out of a throttled, board-deep FIFO — and because
// assignee-mutation alone does not reliably enqueue a run (the dispatch
// dead-zone), a dependency chain only advanced when a human ran
// `multica issue rerun`. This pass closes that: it finds the genuine dependents
// of what has completed and hands the router a targeted, idempotent enqueue action.

// Resolve a dependency SLUG to the exact sibling story it names — UNAMBIGUOUSLY.
// Order:
//   1. exact match on the sibling's declared `id:` slug (descStoryId) — the
//      "p1-<name>" convention, where the full slug IS the identity; else
//   2. the short epic-scoped key (storyKey === slugKey) ONLY when that key
//      resolves to EXACTLY ONE sibling. This is the false-unblock guard: the "p1"
//      short key is shared by every p1-* sibling (slugKey collapses them all to
//      "p1"), so a non-unique short-key match is REJECTED rather than resolved to
//      an arbitrary sibling — a story is never treated as satisfied against the
//      wrong dependency. Returns the sibling issue, or null when unresolved.
export function resolveDepSibling(slug, siblings = []) {
  const slugLower = String(slug || '').toLowerCase();
  if (!slugLower) return null;
  const byId = siblings.find((s) => descStoryId(s) === slugLower);
  if (byId) return byId;
  const k = slugKey(slug);
  if (!k) return null;
  const matches = siblings.filter((s) => storyKey(s) === k);
  return matches.length === 1 ? matches[0] : null; // unique short key only
}

// Does this story declare a dependency on ANY of the given completed story ids?
// Resolves BOTH metadata ticket-id deps and description slug deps (the latter via
// resolveDepSibling, so an ambiguous short key never mis-attributes a dependency).
export function dependsOnAny(issue, completedIds, allIssues = []) {
  if (!completedIds || completedIds.size === 0) return false;
  const raw = issue && issue.metadata && issue.metadata.depends_on;
  if (raw != null && raw !== '') {
    const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.some((id) => completedIds.has(id))) return true;
  }
  const slugs = descStoryDeps(issue);
  if (slugs.length) {
    const siblings = allIssues.filter((s) => s.parent_issue_id && s.parent_issue_id === issue.parent_issue_id && s.id !== issue.id);
    for (const slug of slugs) {
      const dep = resolveDepSibling(slug, siblings);
      if (dep && completedIds.has(dep.id)) return true;
    }
  }
  return false;
}

// Pure-code cascade selector. `completedIds`: Set of issue ids in a terminal-done
// state (the router passes the board's done/cancelled ids, because a story usually
// reaches `done` via an agent setting status directly, not via the router's
// merged-PR gate — a purely event-based trigger would miss most completions).
// Returns the dependents to ENQUEUE now — each is:
//   - status todo or blocked (never in_progress/in_review/done -> no double-dispatch),
//   - declares a dep on one of the completed stories (dependsOnAny) -> only the
//     genuine dependents of what completed, not every satisfied todo on the board,
//   - has its FULL declared graph satisfied (allDepsSatisfied — the genuine
//     metadata+slug gate, so a still-unmet sibling dep blocks it), and
//   - lives in a dispatch-aligned project (cfg.PROJECT_IDS) -> never fire into an
//     unaligned/unagented project.
// The caller completes idempotency (skip a candidate with an active run or an
// existing PR) and applies a per-cycle cap, so a wide board never mass-fires.
export function detectCascadeDispatch(issues, completedIds, statusById, cfg = {}) {
  if (!completedIds || completedIds.size === 0) return [];
  const aligned = new Set((cfg && cfg.PROJECT_IDS) || []);
  const actions = [];
  for (const i of issues) {
    const st = (i.status || '').toLowerCase();
    if (st !== ISSUE_STATUS.TODO && st !== ISSUE_STATUS.BLOCKED) continue;
    if (isSmokeScratch(i.title)) continue;
    if (aligned.size && !aligned.has(i.project_id)) continue;
    if (isHumanTodo(i, cfg)) continue;
    if (!hasDeclaredDeps(i)) continue;
    if (!dependsOnAny(i, completedIds, issues)) continue;
    if (!allDepsSatisfied(i, statusById, issues)) continue;
    actions.push({ identifier: i.identifier, issueId: i.id, projectId: i.project_id, status: st, action: 'cascade-enqueue' });
  }
  return actions;
}
