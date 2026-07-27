// Auriga PLANNING LANE — PURE decision logic (no live calls).
//
// THE RULE: a raw/un-planned ticket is a SEED. Auriga routes SEEDs to the
// planning agent (minerva-dev), which runs plugin-hive kickoff+plan (via the
// `minerva-plan` entry) and files dependency-ordered PLANNED stories back to
// Multica as sub-issues of the seed. Auriga NEVER hand-creates story tickets —
// Minerva's plan produces them. Only the PLANNED stories then go to a dev
// BUILD lane, where the dev agent runs plugin-hive /hive:execute on the story
// and then /hive:review + /hive:test. Every stage is plugin-hive; nothing is
// ad-hoc "just code it".
//
// SEED / STORY CONVENTION (labels are workspace entities — matched by NAME):
//   idea | needs-plan     -> a SEED to be planned (route to the planning lane)
//   planned | epic | story-> a planned marker (its stories go to the build lane)
//   parent_issue_id set   -> a sub-issue == a PLANNED STORY -> build lane
//   a seed that already has sub-issues -> planning DONE; it's an epic container
//                                         (skip; only its story children build)
//
// Roles returned by classifyPlanningRole():
//   'seed'  -> planning lane (minerva-dev runs /hive:kickoff + /hive:plan)
//   'story' -> build lane    (dev agent runs /hive:execute + /hive:review + /hive:test)
//   'other' -> build lane    (unmarked top-level ticket; today's default behavior)
//   'epic'  -> SKIP          (a planned container; only its story sub-issues are work)
//
// Escalation (minerva-plan exit 2 = parked on a real strategic gate): handled
// AGENT-SIDE — minerva-dev posts the pending questions as a comment and sets the
// seed to `blocked`. Because a `blocked` (non-todo) seed drops out of the todo
// candidate pool, the router never silently re-routes it; it waits for a human /
// Consus to resolve the gate. The router's job here is only: never re-plan a
// seed that is in-flight, blocked, or already decomposed into stories.

import { agentHasCapacity, computeRuntimeInflight, isSmokeScratch } from './core.mjs';

// Normalize an issue's labels to a lowercase name list. The Multica issue JSON
// may carry labels as {id,name} objects, bare name strings, or bare id (UUID)
// strings depending on the endpoint — handle all three; a UUID is resolved to
// its name via labelMap (id -> name).
export function labelNamesOf(issue, labelMap = {}) {
  const raw = issue && issue.labels ? issue.labels : [];
  const out = [];
  for (const l of raw) {
    if (l == null) continue;
    if (typeof l === 'string') {
      out.push(String(labelMap[l] || l).toLowerCase());
    } else if (typeof l === 'object') {
      const n = l.name || l.label || (l.id && labelMap[l.id]) || '';
      if (n) out.push(String(n).toLowerCase());
    }
  }
  return out;
}

// Build the immutable per-cycle context the classifier needs: which issue ids
// are parents (have sub-issues), the label id->name map, and the configured
// seed/planned label vocabularies + fallback flag.
export function buildPlanningContext(issues = [], cfg = {}, labelMap = {}) {
  const hasChildren = new Set();
  for (const i of issues) if (i && i.parent_issue_id) hasChildren.add(i.parent_issue_id);
  const P = cfg.PLANNING || {};
  return {
    hasChildren,
    labelMap: labelMap || {},
    seedLabels: (P.seedLabels || ['idea', 'needs-plan']).map((s) => String(s).toLowerCase()),
    plannedLabels: (P.plannedLabels || ['planned', 'epic', 'story']).map((s) => String(s).toLowerCase()),
    seedFallback: !!P.seedFallback,
  };
}

// Classify a single issue's planning role. Deterministic; pure.
export function classifyPlanningRole(issue, ctx) {
  const names = labelNamesOf(issue, ctx.labelMap);
  const isParent = ctx.hasChildren.has(issue.id);
  const seedLabeled = names.some((n) => ctx.seedLabels.includes(n));
  const plannedLabeled = names.some((n) => ctx.plannedLabels.includes(n));

  // A sub-issue is, by construction, a PLANNED story (Minerva filed it).
  if (issue.parent_issue_id) return 'story';

  // Seed markers on a top-level ticket.
  if (seedLabeled) {
    // Already decomposed into children => planning is DONE; it's a container.
    return isParent ? 'epic' : 'seed';
  }

  // Explicitly-planned marker (epic if it owns children, else a standalone story).
  if (plannedLabeled) return isParent ? 'epic' : 'story';

  // Unmarked top-level ticket: the optional fallback treats a childless one as a
  // SEED. Default OFF so the router never hijacks an existing dev board — only
  // explicitly-marked seeds are planned unless PLANNING.seedFallback is enabled.
  if (ctx.seedFallback && !isParent) return 'seed';
  return 'other';
}

// A ticket is eligible for the BUILD lane (a dev agent running /hive:execute)
// only when it is a planned story or an unmarked default ticket — never a seed
// (that goes to planning) and never an epic container (only its stories build).
export function isBuildEligible(issue, ctx) {
  const role = classifyPlanningRole(issue, ctx);
  return role === 'story' || role === 'other';
}

// Select this cycle's SEED assignments for the planning lane. Returns
// [{ identifier, issueId, projectId, lane, agent, runtime, role }].
// Respects the planning agent's per-agent + per-runtime caps and a small
// per-cycle seed cap (planning is Claude-runtime; drain it sparingly).
export function selectPlanningAssignments(issues, cfg, inflight, ctx, opts = {}) {
  const P = cfg.PLANNING || {};
  const agentName = P.agent;
  if (!agentName || !cfg.AGENTS[agentName]) return [];
  const maxPerCycle = opts.maxPerCycle ?? P.maxPerCycle ?? 1;

  const runtimeInflight = computeRuntimeInflight(inflight, cfg.AGENTS);
  const projected = { perAgent: {}, perRuntime: {} };

  const seeds = issues
    .filter((i) => (i.status || '').toLowerCase() === 'todo')
    .filter((i) => !i.assignee_id)
    .filter((i) => !isSmokeScratch(i.title))
    .filter((i) => cfg.PROJECT_IDS.includes(i.project_id))
    .filter((i) => classifyPlanningRole(i, ctx) === 'seed');

  // Stable ordering: project scan order, then issue number ascending
  // (older/foundational seeds first).
  seeds.sort((a, b) => {
    const pa = cfg.PROJECT_IDS.indexOf(a.project_id);
    const pb = cfg.PROJECT_IDS.indexOf(b.project_id);
    if (pa !== pb) return pa - pb;
    return (a.number || 0) - (b.number || 0);
  });

  const chosen = [];
  for (const issue of seeds) {
    if (chosen.length >= maxPerCycle) break;
    if (!agentHasCapacity(agentName, cfg.AGENTS, cfg.RUNTIME_CAP, inflight, runtimeInflight, projected)) break;
    const runtime = cfg.AGENTS[agentName].runtime;
    projected.perAgent[agentName] = (projected.perAgent[agentName] || 0) + 1;
    projected.perRuntime[runtime] = (projected.perRuntime[runtime] || 0) + 1;
    chosen.push({
      identifier: issue.identifier,
      issueId: issue.id,
      projectId: issue.project_id,
      lane: 'planning',
      agent: agentName,
      runtime,
      role: 'seed',
    });
  }
  return chosen;
}
