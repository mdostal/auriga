// GET /api/lanes — live lane state: per-agent inflight/queued counts, runtime
// totals vs caps, and whether the router process itself is alive. Reads the
// board fresh on every call (mca/core are injected so this stays testable
// against fixtures instead of the live Multica CLI).
import express from 'express';
import fs from 'node:fs';

function routerAlive(pidfile) {
  if (!fs.existsSync(pidfile)) return false;
  const pid = parseInt(fs.readFileSync(pidfile, 'utf8').trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createLanesRouter(cfg, mca, core, opts = {}) {
  const pidfile = opts.pidfile || process.env.AURIGA_PIDFILE || '/tmp/auriga-router.pid';
  const router = express.Router();

  router.get('/api/lanes', (req, res) => {
    try {
      const issues = mca.listAllIssues(cfg.PROJECT_IDS);
      const inflight = core.computeInflight(issues, cfg.AGENTS);
      const queued = core.computeAssignedQueued(issues, cfg.AGENTS);
      const runtimeInflight = core.computeRuntimeInflight(inflight, cfg.AGENTS);

      const lanes = {};
      for (const name of Object.keys(cfg.AGENTS)) {
        lanes[name] = {
          inflight: inflight[name] || 0,
          queued: queued[name] || 0,
          maxInflight: cfg.AGENTS[name].maxInflight,
          runtime: cfg.AGENTS[name].runtime,
        };
      }

      res.json({
        lanes,
        runtimeInflight,
        runtimeCap: cfg.RUNTIME_CAP,
        runnerStatus: routerAlive(pidfile) ? 'running' : 'stopped',
      });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return router;
}
