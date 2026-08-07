// GET /api/gaps — computed gaps between what Auriga scans and what actually
// exists: Multica projects not covered by cfg.PROJECT_IDS, stories with no
// resolvable target_repo, and lanes sitting idle. This is the surface that
// would have made the CADEX/Tools/GigRadar/dashboards orphan incident visible
// before it happened. The Multica query is the slow part, so results are
// cached for `ttlMs` (default 30s) rather than recomputed on every request.
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

export function createGapsRouter(cfg, mca, core, opts = {}) {
  const ttlMs = opts.ttlMs ?? 30000;
  const router = express.Router();
  let cache = null; // { at, body }

  router.get('/api/gaps', (req, res) => {
    try {
      const now = Date.now();
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

      const body = {
        missing_projects: missingProjects,
        stories_missing_target_repo: missingTargetRepo,
        idle_lanes: idleLanes,
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
