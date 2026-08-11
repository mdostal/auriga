// GET /api/gaps — computed gaps between what Auriga scans and what actually
// exists: Multica projects not covered by cfg.PROJECT_IDS, stories with no
// resolvable target_repo, lanes sitting idle, and scheduled maintenance
// autopilots that are paused or overdue. This is the surface that would have
// made the CADEX/Tools/GigRadar/dashboards orphan incident visible before it
// happened. The Multica query is the slow part, so results are cached for
// `ttlMs` (default 30s) rather than recomputed on every request.
import express from 'express';

// Mirrors the target_repo resolution order build agents use: a `target_repo:`
// line in the issue's own YAML description body, else metadata.target_repo.
const TARGET_REPO_RE = /^target_repo:\s*(\S+)/m;

function resolveTargetRepo(issue) {
  const meta = issue.metadata && issue.metadata.target_repo;
  if (typeof meta === 'string' && meta.trim()) return meta.trim();
  const m = TARGET_REPO_RE.exec(issue.description || '');
  return m ? m[1] : null;
}

function parseTimeMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function latestAutopilotRun(runs = []) {
  return [...runs].sort((a, b) => {
    const aMs = parseTimeMs(a.triggered_at || a.created_at || a.completed_at) || 0;
    const bMs = parseTimeMs(b.triggered_at || b.created_at || b.completed_at) || 0;
    return bMs - aMs;
  })[0] || null;
}

function summarizeSchedulerGaps(mca, now, graceMs) {
  if (typeof mca.listAutopilots !== 'function') return [];
  const autopilots = mca.listAutopilots();
  return autopilots
    .filter((a) => Array.isArray(a.trigger_kinds) && a.trigger_kinds.includes('schedule'))
    .map((a) => {
      const nextRunMs = parseTimeMs(a.next_run_at);
      const lastRunMs = parseTimeMs(a.last_run_at);
      const overdueMs = nextRunMs == null ? null : now - nextRunMs;
      const paused = (a.status || '').toLowerCase() !== 'active';
      const overdue = overdueMs != null && overdueMs > graceMs;
      if (!paused && !overdue) return null;

      let latestRun = null;
      if (typeof mca.autopilotRuns === 'function') {
        latestRun = latestAutopilotRun(mca.autopilotRuns(a.id));
      }

      return {
        id: a.id,
        title: a.title,
        status: a.status,
        reason: paused ? 'paused' : 'overdue',
        last_run_at: a.last_run_at || null,
        last_run_status: a.last_run_status || latestRun?.status || null,
        last_run_age_ms: lastRunMs == null ? null : now - lastRunMs,
        next_run_at: a.next_run_at || null,
        overdue_ms: overdueMs != null && overdueMs > 0 ? overdueMs : 0,
        failure_reason: latestRun?.failure_reason || null,
      };
    })
    .filter(Boolean);
}

export function createGapsRouter(cfg, mca, core, opts = {}) {
  const ttlMs = opts.ttlMs ?? 30000;
  const schedulerGapGraceMs = opts.schedulerGapGraceMs ?? 2 * 60 * 1000;
  const nowFn = opts.now || (() => Date.now());
  const router = express.Router();
  let cache = null; // { at, body }

  router.get('/api/gaps', (req, res) => {
    try {
      const now = nowFn();
      if (cache && now - cache.at < ttlMs) {
        return res.json(cache.body);
      }

      const projects = mca.listAllProjects();
      const missingProjects = projects
        .filter((p) => !cfg.PROJECT_IDS.includes(p.id))
        .map((p) => ({ id: p.id, title: p.title }));

      const issues = mca.listAllIssues(cfg.PROJECT_IDS);
      const missingTargetRepo = issues
        .filter((i) => !resolveTargetRepo(i))
        .map((i) => ({ identifier: i.identifier, title: i.title, project_id: i.project_id }));

      const inflight = core.computeInflight(issues, cfg.AGENTS);
      const queued = core.computeAssignedQueued(issues, cfg.AGENTS);
      const idleLanes = Object.keys(cfg.AGENTS).filter(
        (name) => (inflight[name] || 0) === 0 && (queued[name] || 0) === 0
      );
      const autopilotSchedulerGaps = summarizeSchedulerGaps(mca, now, schedulerGapGraceMs);

      const body = {
        missing_projects: missingProjects,
        stories_missing_target_repo: missingTargetRepo,
        idle_lanes: idleLanes,
        autopilot_scheduler_gaps: autopilotSchedulerGaps,
        computed_at: new Date(now).toISOString(),
      };
      cache = { at: now, body };
      res.json(body);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return router;
}
