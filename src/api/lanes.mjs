// GET /api/lanes — live lane state: per-agent inflight/queued counts, runtime
// totals vs caps, and whether the router process itself is alive. Reads the
// board fresh on every call through the injected backlog adapter (Pantheon
// core-api in production, see src/server.mjs); backlog/core are injected so
// this stays testable against fixtures.
//
// Router liveness (PANT-1024): in a container deploy the router runs in a
// different container than this API (often as a `--once` loop that removes
// its pidfile on exit), so a pid check here always says `stopped`. When a
// heartbeat file is configured (AURIGA_HEARTBEAT_FILE) or exists at its
// default path, the router counts as running while the heartbeat is newer
// than AURIGA_RUNNER_STALE_MS (default 3 x AURIGA_CYCLE_MS, the healthcheck's
// threshold). The pidfile check stays as a fallback for same-host runs.
import express from 'express';
import fs from 'node:fs';
import { checkHeartbeat, defaultHeartbeatFile } from '../router/lib/observability.mjs';

const DEFAULT_CYCLE_MS = 75000;

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

// { at, ageMs } of the router's last finished cycle, or null when there is no
// heartbeat. `at` is the heartbeat's own `ts`, else the file's mtime.
function lastCycle(file, now) {
  const hb = checkHeartbeat(file, Infinity, now);
  if (hb.ageMs == null) return null;
  let at = null;
  try {
    const ts = JSON.parse(fs.readFileSync(file, 'utf8')).ts;
    if (Number.isFinite(new Date(ts).getTime())) at = new Date(ts).toISOString();
  } catch {}
  return { at: at || new Date(now - hb.ageMs).toISOString(), ageMs: hb.ageMs };
}

export function createLanesRouter(cfg, backlog, core, opts = {}) {
  const env = opts.env || process.env;
  const pidfile = opts.pidfile || env.AURIGA_PIDFILE || '/tmp/auriga-router.pid';
  const heartbeatFile = opts.heartbeatFile || defaultHeartbeatFile(env);
  const cycleMs = parseInt(env.AURIGA_CYCLE_MS, 10) || cfg.CAPS?.cycleMs || DEFAULT_CYCLE_MS;
  const staleMs = opts.staleMs || parseInt(env.AURIGA_RUNNER_STALE_MS, 10) || 3 * cycleMs;
  const nowFn = opts.now || (() => Date.now());
  const router = express.Router();

  router.get('/api/lanes', (req, res) => {
    try {
      const issues = backlog.listAllIssues(cfg.PROJECT_IDS);
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

      const last = lastCycle(heartbeatFile, nowFn());
      const running = (last != null && last.ageMs <= staleMs) || routerAlive(pidfile);

      res.json({
        lanes,
        runtimeInflight,
        runtimeCap: cfg.RUNTIME_CAP,
        runnerStatus: running ? 'running' : 'stopped',
        runnerLastCycleAt: last ? last.at : null,
      });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return router;
}
