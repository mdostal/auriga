// Auriga auto-router — PURE decision logic (no live calls).
// Everything here is deterministic and unit-tested with mocked inputs.

import { isPrOpen, isPrMerged } from './github-pr-state.mjs';
export { isPrMerged };

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

// ---------------------------------------------------------------------------
// Story-key + slug matching (2026-07-31, loop-integrity fixes).
// Minerva-planned stories carry a short epic-scoped key in their Multica title,
// e.g. "[m-02-file-layer-implementation] ..." and their build agents name PR
// branches after the SAME key ("feat/m-01-service", "feat/PAN-6952", etc.) —
// NOT always after the PAN-#### ticket id. cron-maker worked because its branches
// happened to embed the pan-#### id; mnemosyne#1 (feat/m-01-service) does not, so
// its PR never matched its ticket and sat forever. storyKey() extracts that short
// key so a PR can be matched to its ticket even when the branch has no PAN id.

// Unified story-key extractor. A story key
// identifies a story within its epic and appears at the START of the story's title
// bracket ("[<key>-<words>]") and at the start of a dependency SLUG ("<key>-<words>").
// The short-key convention is strictly <letters>-<digits>, e.g. m-02, cm-07,
// htq-01, flayr-01, jfpm-01, mit-04, v-04, lct-03. Epic-tag slugs such as
// "p1-router-capability-routing" are exact story ids, not short keys: treating
// every p1-* sibling as key "p1" collapses unrelated stories onto one key and
// can false-unblock dependents.
// The trailing (?![0-9]) forces the FULL number to be captured, so a longer-numbered key
// can never be read as a shorter one — ct-010 never collapses to ct-01.
// Downstream comparison is EXACT string equality (storyKey === slugKey), so correct
// full-key extraction is exactly what rejects false-prefix cross-matches.
function extractStoryKey(str = '') {
  const m = String(str).match(/^\s*\[?\s*([a-z]{1,8}-\d{1,3})(?![0-9])/i);
  return m ? m[1].toLowerCase() : null;
}

// Short epic-scoped key from a story TITLE's leading "[key-...]" bracket (e.g. "m-02",
// "cm-07", "hf-01"). null when the title has no parseable leading key.
export function storyKey(issue = {}) {
  return extractStoryKey(issue.title || '');
}

// Short key from a dependency SLUG (e.g. "m-01-core-recall-interface" -> "m-01",
// "cm-07-e2e-integration" -> "cm-07"). null when unparseable.
export function slugKey(slug = '') {
  return extractStoryKey(slug);
}

// Known plugin-hive PHASE tokens that appear inside a story's `steps:` block as
// `depends_on: [research]` etc. These are workflow phases, NOT story dependencies,
// and must be excluded when parsing a story's real cross-story dependency list.
const HIVE_PHASE_TOKENS = new Set([
  'research', 'implement', 'implementation', 'test', 'test-spec', 'tests',
  'review', 'plan', 'design', 'integrate', 'integration', 'spec', 'build',
]);

// Story-level dependency slugs declared in the DESCRIPTION (not metadata).
// Minerva emits the story's own dependencies as the FIRST `depends_on: [...]`
// line in the YAML front-matter (before the `steps:` block). Older stories carry
// this ONLY in the description, never mirrored into metadata.depends_on — so
// detectUnblocks/depsSatisfied (which read metadata only) never saw them and the
// child never unblocked (the m-02-depends-on-m-01 case). We read the FIRST
// depends_on line and drop any hive PHASE tokens defensively.
// Minerva emits a story's own dependency slugs in the description in TWO shapes, and
// BOTH must parse — else a real dependency is silently dropped and the story
// false-unblocks (the rsh-03/PAN-5830 case: a block-list dep on rsh-01 was missed, so
// the story looked dependency-free and was eligible to unblock while rsh-01 was still
// stuck). Forms:
//   1. inline array   ->  depends_on: [a-01-foo, b-02-bar]
//   2. YAML block list ->  depends_on:\n  - a-01-foo\n  - b-02-bar
// We drop any plugin-hive PHASE tokens (research/implement/test/...) defensively.
export function descStoryDeps(issue = {}) {
  const desc = issue.description || '';
  // Match the FIRST `depends_on:` in the description and capture EITHER an inline
  // [array] OR a block list — in one regex so the earliest occurrence wins. This
  // matters because a Minerva story's `steps:` block further down carries per-phase
  // `depends_on: [research]` lines; parsing inline-anywhere-first would grab a phase
  // dep and shadow the real story dep declared at the top (the rsh-03/PAN-5830 bug).
  const m = desc.match(/(^|\n)[ \t]*depends_on:[ \t]*(\[[^\]]*\]|\r?\n(?:[ \t]*-[ \t]*[^\n]+\r?\n?)+)/i);
  let raw = [];
  if (m) {
    const body = m[2];
    if (body.trimStart().startsWith('[')) {
      raw = body.trim().replace(/^\[|\]$/g, '').split(',');
    } else {
      raw = body.split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, ''));
    }
  }
  return raw
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .filter((s) => !HIVE_PHASE_TOKENS.has(s.toLowerCase()));
}

// A story's own declared id, from the Minerva YAML front-matter `id: <slug>` line
// (e.g. "id: p1-router-capability-routing"). Some epics (the "p1-..." convention)
// use this full descriptive slug as BOTH the story's identity and the value every
// sibling's depends_on: [...] names — there is no separate short "prefix-NN" key
// to extract (storyKey/slugKey return null for "p1-router-capability-routing",
// since the epic tag "p1" mixes a letter and a digit before the first hyphen,
// which the [a-z]{1,8}-\d{1,3} pattern below doesn't match). Falling through
// descDepsSatisfied's short-key lookup for this convention silently treated
// EVERY dep as unresolved -> vacuously satisfied, so a story never actually
// waited on its declared deps (PAN-6664 loop-integrity bug, 2026-07-31).
export function descStoryId(issue = {}) {
  const desc = issue.description || '';
  const m = desc.match(/(^|\n)\s*id:\s*([a-z0-9][a-z0-9_-]*)/i);
  return m ? m[2].trim().toLowerCase() : null;
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
    .filter((i) => (i.status || '').toLowerCase() === 'todo')
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

// Broader PR<->STORY matcher: matches on the ticket identifier (prReferencesIssue)
// OR on the story's short epic-scoped key (storyKey) appearing in the PR's head
// branch / title / body. The key match tolerates a trailing "-" (feat/m-01-service)
// but rejects a trailing digit so "m-01" never matches "m-010". This is what lets
// slug-branched PRs (mnemosyne#1 feat/m-01-service) match their PAN ticket, which
// the narrow id-only matcher missed.
export function prMatchesStory(pr = {}, issue = {}) {
  if (prReferencesIssue(pr, issue.identifier)) return true;
  const key = storyKey(issue);
  if (!key) return false;
  const hay = [pr.headRefName, pr.head_ref, pr.branch, pr.title, pr.body]
    .filter((s) => typeof s === 'string').join('\n').toLowerCase();
  const re = new RegExp('(?<![a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'i');
  return re.test(hay);
}

// STRICT identity matcher: the ticket id or the story's short key appears in the PR's
// HEAD BRANCH or TITLE only — never the body. A body can merely *mention* a ticket
// ("builds on PAN-6659") without being that ticket's PR; using the body to decide a
// status change (e.g. demoting a legitimately-merged done story) is a false-positive
// trap. Branch/title is the PR's own identity, so this is safe for status mutations.
export function prIdentityMatchesStory(pr = {}, issue = {}) {
  const idHay = [pr.headRefName, pr.head_ref, pr.branch, pr.title]
    .filter((s) => typeof s === 'string').join('\n').toLowerCase();
  const id = String(issue.identifier || '').toLowerCase();
  if (id && idHay.includes(id)) return true;
  const key = storyKey(issue);
  if (!key) return false;
  const re = new RegExp('(?<![a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'i');
  return re.test(idHay);
}

// owner/repo slug parsed from a PR's html url (github.com/owner/repo/pull/N), or null.
export function repoFromPrUrl(pr = {}) {
  const u = pr.url || pr.html_url || '';
  const m = String(u).match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\//i);
  return m ? m[1] : null;
}

// Is a PR open (not merged/closed)? See github-pr-state.mjs's isPrOpen —
// kept exported here under this name (not just re-exported from that module)
// because auriga-router.mjs accesses it as coreImpl.prIsOpen.
export const prIsOpen = isPrOpen;

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
  const terminal = (s) => s === 'done' || s === 'cancelled' || s === 'canceled';
  for (const slug of slugs) {
    const slugLower = slug.toLowerCase();
    let dep = siblings.find((s) => descStoryId(s) === slugLower);
    if (!dep) {
      const k = slugKey(slug);
      if (!k) return false; // exact-id-style dep declared but unresolved: conservative block
      dep = siblings.find((s) => storyKey(s) === k);
      if (!dep) continue; // unresolved — don't block (avoid deadlock)
    }
    if (!terminal((dep.status || '').toLowerCase())) return false;
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
  const terminal = (s) => s === 'done' || s === 'cancelled' || s === 'canceled';
  const actions = [];
  for (const [parentId, kids] of childrenByParent) {
    const parent = byId.get(parentId);
    if (!parent) continue; // parent not in scanned set — can't judge
    if (isSmokeScratch(parent.title)) continue;
    const pst = (parent.status || '').toLowerCase();
    if (terminal(pst)) continue; // already closed
    if (!kids.length) continue;
    const allDone = kids.every((k) => terminal((k.status || '').toLowerCase()));
    if (allDone) actions.push({ identifier: parent.identifier, issueId: parent.id, projectId: parent.project_id, action: 'advance-parent-done' });
  }
  return actions;
}

// ============================================================================
// REVIEW SQUAD — scale-by-ticket perspective plan (2026-07-31, PAN-6546).
// ----------------------------------------------------------------------------
// Mathew's binding intent (recovered Consus answer): a story that lands in
// `in_review` must be reviewed by a REAL multi-perspective SQUAD that TRULY
// verifies — not a single reviewer pass. The four perspectives are:
//   - product   (PO): does the change satisfy the story's intent / acceptance?
//   - technical  : correctness, conventions, security (the /hive:review pass)
//   - qa         : author + RUN tests, real build, Playwright/E2E where it
//                  matters — TRUE verification, never a diff read alone.
//   - ux         : user-facing surface quality + accessibility (design-review).
//
// "It has to be approached from at least the product, the technical, and a QA
//  and user-experience perspective for each and every ticket ... Some things
//  will not need the full team." — so the DEFAULT posture is the full four, and
// we only DROP a perspective when it is genuinely inapplicable to the ticket
// (UX on a headless backend change, product on a pure docs/chore change). Every
// drop is logged with a reason, so the scaling is explicit and inspectable.
//
// Auriga stays the THIN router: it computes this plan and fires ONE review
// dispatch carrying it (logged + posted to the ticket). The SQUAD itself runs
// inside the auriga-review agent, which reads the plan and executes each enabled
// perspective (see agents/auriga-review.instructions.md). This function is the
// single source of truth for "which perspectives, and does QA need Playwright".

// Built-in rule set — used when cfg.REVIEW_SQUAD_RULES is absent so the classifier
// is self-contained + unit-testable without a live config. cfg.REVIEW_SQUAD_RULES
// (config.mjs) is the inspectable, editable copy the router actually passes in.
export const DEFAULT_SQUAD_RULES = {
  // Signals that a change is USER-FACING (gets the full squad incl. UX + Playwright).
  ui: [
    'ui', 'ux', 'user-facing', 'frontend', 'front-end', 'page', 'screen', 'view',
    'component', 'dashboard', 'portal', 'css', 'tailwind', 'react', 'svelte', 'vue',
    'html', 'button', 'form', 'modal', 'layout', 'nav', 'menu', 'visual', 'design',
    'accessibility', 'a11y', 'responsive', 'animation', 'theme', 'styling', 'playwright',
  ],
  // Signals that a change is BACKEND/headless (product + technical + qa, NO ux).
  backend: [
    'api', 'endpoint', 'route', 'server', 'service', 'daemon', 'worker', 'schema',
    'model', 'database', 'migration', 'sql', 'query', 'integration', 'pipeline',
    'router', 'dispatch', 'auth', 'token', 'webhook', 'cron', 'queue', 'cli', 'sdk',
  ],
  // Signals that a change is DOCS/CHORE/CONFIG (technical + qa-smoke only).
  light: [
    'docs', 'documentation', 'readme', 'comment', 'typo', 'rename', 'chore',
    'bump', 'version bump', 'lint', 'formatting', 'format', 'whitespace',
    'config', 'gitignore', 'license', 'changelog',
  ],
  // tier -> which perspectives run + whether QA must drive a browser (Playwright).
  tiers: {
    full:     { product: true,  technical: true, qa: true, ux: true,  playwright: true },
    backend:  { product: true,  technical: true, qa: true, ux: false, playwright: false },
    light:    { product: false, technical: true, qa: true, ux: false, playwright: false },
    standard: { product: true,  technical: true, qa: true, ux: true,  playwright: true },
  },
};

// Count keyword hits from a list against a haystack (word-ish, case-insensitive).
function countSignals(hay, words) {
  const hits = [];
  for (const w of words) {
    const re = new RegExp('(?<![a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i');
    if (re.test(hay)) hits.push(w);
  }
  return hits;
}

// Classify an in_review story into a review-squad plan.
// Returns { tier, perspectives:{product,technical,qa,ux}, playwright, reason, signals }.
// tier:
//   'full'     — user-facing / UI change: product + technical + qa(Playwright) + ux.
//   'backend'  — headless api/service/data change: product + technical + qa (no ux).
//   'light'    — docs / chore / config / trivial: technical + qa-smoke only.
//   'standard' — default when signals are mixed/unknown: the full four (safe default,
//                honoring "each and every ticket" — we only drop a perspective on a
//                CLEAR backend/light signal, never on absence of signal).
export function reviewSquadPlan(issue = {}, cfg = {}) {
  const rules = (cfg && cfg.REVIEW_SQUAD_RULES) || DEFAULT_SQUAD_RULES;
  const labelNames = (issue.labels || [])
    .map((l) => (typeof l === 'string' ? l : (l && l.name) || ''))
    .join(' ');
  const hay = [issue.title, issue.description, labelNames, targetRepoValue(issue) || '']
    .filter((s) => typeof s === 'string')
    .join('\n')
    .toLowerCase();

  const uiHits = countSignals(hay, rules.ui || []);
  const backendHits = countSignals(hay, rules.backend || []);
  const lightHits = countSignals(hay, rules.light || []);

  // Decide the tier. UI signal wins (user-facing must get UX + Playwright). Then a
  // clear light-only change (light signals, no UI, no backend). Then backend. Else
  // the safe default: standard == full four perspectives.
  let tier;
  let reason;
  const signals = { ui: uiHits, backend: backendHits, light: lightHits };
  if (uiHits.length) {
    tier = 'full';
    reason = 'user-facing signals (' + uiHits.slice(0, 4).join(', ') + ') -> full squad + Playwright';
  } else if (lightHits.length && !backendHits.length) {
    tier = 'light';
    reason = 'docs/chore/config signals (' + lightHits.slice(0, 4).join(', ') + '), no product/UI surface -> technical + qa-smoke';
  } else if (backendHits.length) {
    tier = 'backend';
    reason = 'headless backend signals (' + backendHits.slice(0, 4).join(', ') + '), no user surface -> product + technical + qa (UX dropped: nothing to look at)';
  } else {
    tier = 'standard';
    reason = 'no decisive signal -> default full squad (each and every ticket baseline)';
  }

  const t = (rules.tiers && rules.tiers[tier]) || DEFAULT_SQUAD_RULES.tiers.standard;
  return {
    tier,
    perspectives: { product: !!t.product, technical: !!t.technical, qa: !!t.qa, ux: !!t.ux },
    playwright: !!t.playwright,
    reason,
    signals,
  };
}

// One-line human summary of a squad plan (for the dispatch log + ticket comment).
export function squadPlanSummary(plan) {
  const p = plan.perspectives;
  const on = ['product', 'technical', 'qa', 'ux'].filter((k) => p[k]);
  const qaTag = p.qa ? (plan.playwright ? 'qa+Playwright' : 'qa') : null;
  const parts = on.map((k) => (k === 'qa' ? qaTag : k));
  return `squad[${plan.tier}]: ${parts.join(' + ')} — ${plan.reason}`;
}

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
    if (st !== 'todo' && st !== 'blocked') continue;
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
