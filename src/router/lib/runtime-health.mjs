// Runtime failure-streak gate (PANT-1397).
//
// Why: on 2026-11-17/18 (and again on 11-20) the opencode runtime on dragon
// failed every run it got ("opencode exited with error: exit status 1",
// "Failed to execute statement") because its /home/node tmpfs was full. Heimdall
// still reported the Gemini/OpenRouter/xAI lanes up (the providers were fine),
// so Auriga kept dispatching reviews to the agents on that runtime, burned five
// runs per ticket and parked each ticket blocked. Nothing took the runtime out.
//
// A Multica runtime is one daemon/CLI install; when it is broken every agent on
// it fails the same way, whatever the ticket. So Auriga watches the runs it
// already fetches, per physical `runtime_id`: when the newest N finished runs on
// a runtime all failed (provider-limit failures excluded: those are the lane's
// business, see observedLaneLimits) and they span at least two tickets, every
// agent seen on that runtime is unavailable for a cooldown. When the cooldown
// passes the runtime is let back in; its next run is the probe. A success ends
// the streak at once; another failure re-holds it, each time for twice as long
// (capped). Nothing touches caps, so this can never leave a runtime at 0 (the
// caps-zero trap): a hold always expires on its own.
//
// The state outlives the `--once` process in a file on the auriga-state volume
// (runtime-health.json), which bin/runtime-health-check.sh in pantheon-v2 reads
// on the nurse pass to tell the nurse.
import fs from 'node:fs';
import path from 'node:path';
import { classifyRun, isQueuedNotStarted, isQuotaFailure, runErrorText, runTsMs } from './run-classification.mjs';
import { defaultLaneStateFile } from './lane-state.mjs';

export const RUNTIME_HEALTH_DEFAULTS = Object.freeze({
  streak: 3, // N finished runs in a row that failed
  minIssues: 2, // ...on at least this many distinct tickets (one broken ticket is not a broken runtime)
  cooldownMs: 30 * 60 * 1000, // first hold; doubles per further failure
  maxCooldownMs: 4 * 60 * 60 * 1000,
  keepRuns: 20, // finished runs remembered per runtime
  forgetMs: 24 * 60 * 60 * 1000, // runs older than this are dropped
});

// CAPS may replace the defaults per tenant; runtimeFailureStreak 0 turns the gate off.
export function runtimeHealthOptions(caps = {}) {
  const d = RUNTIME_HEALTH_DEFAULTS;
  const num = (v, dflt) => (Number.isFinite(v) && v >= 0 ? v : dflt);
  return {
    ...d,
    streak: num(caps.runtimeFailureStreak, d.streak),
    minIssues: num(caps.runtimeFailureMinIssues, d.minIssues),
    cooldownMs: num(caps.runtimeFailureCooldownMs, d.cooldownMs),
    maxCooldownMs: num(caps.runtimeFailureMaxCooldownMs, d.maxCooldownMs),
    // PANT-1445: the same gate per Heimdall lane; laneFailureStreak 0 turns it off.
    laneStreak: num(caps.laneFailureStreak, d.streak),
    laneMinIssues: num(caps.laneFailureMinIssues, num(caps.runtimeFailureMinIssues, d.minIssues)),
  };
}

// A cancel without error text is Auriga or an operator stopping a run, not the
// runtime failing it.
function outcome(run, now) {
  const c = classifyRun(run, now);
  if (c.failed) {
    if (isQuotaFailure(run, now)) return null;
    if ((c.status === 'cancelled' || c.status === 'canceled') && !runErrorText(run)) return null;
    return 'failed';
  }
  return c.done ? 'ok' : null;
}

// state: { runtimes: { [runtimeId]: { runs: [{ id, ms, ok, identifier, agentId, error }] } },
//          agentRuntimes: { [agentId]: { runtimeId, ms } } }  (the runtime of the agent's newest run)
// runLists: iterable of [identifier, runs[]]. Returns a new state; never mutates `prior`.
export function recordRuns(prior, runLists, now = Date.now(), opts = RUNTIME_HEALTH_DEFAULTS) {
  const runtimes = {};
  for (const [rid, r] of Object.entries(prior?.runtimes || {})) {
    runtimes[rid] = { runs: Array.isArray(r?.runs) ? r.runs.filter((x) => x && now - x.ms < opts.forgetMs) : [] };
  }
  const agentRuntimes = { ...prior?.agentRuntimes };
  for (const [identifier, runs] of runLists) {
    for (const run of runs || []) {
      const rid = run?.runtime_id;
      if (!rid) continue;
      const ms = runTsMs(run);
      if (run.agent_id && ms != null && !(agentRuntimes[run.agent_id]?.ms > ms)) agentRuntimes[run.agent_id] = { runtimeId: rid, ms };
      if (isQueuedNotStarted(run, now)) continue;
      const o = outcome(run, now);
      if (!o || ms == null || now - ms >= opts.forgetMs) continue;
      const id = run.id || `${identifier}@${ms}`;
      const bucket = (runtimes[rid] ||= { runs: [] });
      const entry = {
        id, ms, ok: o === 'ok', identifier, agentId: run.agent_id || null,
        error: o === 'ok' ? null : (runErrorText(run) || String(run.failure_reason || '')).slice(0, 200),
      };
      const at = bucket.runs.findIndex((x) => x.id === id);
      if (at >= 0) bucket.runs[at] = entry; else bucket.runs.push(entry);
    }
  }
  for (const r of Object.values(runtimes)) {
    r.runs.sort((a, b) => b.ms - a.ms);
    r.runs.length = Math.min(r.runs.length, opts.keepRuns);
  }
  return { runtimes, agentRuntimes };
}

// The failure streak at the head of newest-first `runs`, or null when it doesn't
// make a hold now: { streakRuns, identifiers, failedMs, sinceMs, untilMs }.
function streakHold(runs, now, { streak, minIssues, cooldownMs, maxCooldownMs }) {
  if (!streak) return null;
  const streakRuns = [];
  for (const x of runs) { if (x.ok) break; streakRuns.push(x); }
  if (streakRuns.length < streak) return null;
  const identifiers = [...new Set(streakRuns.map((x) => x.identifier))];
  if (identifiers.length < minIssues) return null;
  const failedMs = streakRuns[0].ms;
  const untilMs = failedMs + Math.min(cooldownMs * 2 ** (streakRuns.length - streak), maxCooldownMs);
  if (untilMs <= now) return null; // cooldown over: let the next run probe it
  return { streakRuns, identifiers, failedMs, sinceMs: streakRuns[streakRuns.length - 1].ms, untilMs };
}

// Map runtimeId -> hold for every runtime currently out of dispatch:
// { runtimeId, streak, sinceMs, failedMs, untilMs, identifiers, agentIds, error }.
// `sinceMs` is the oldest failure in the streak: it stays put while the streak
// grows, so a caller can tell a new hold from one it already reported.
export function runtimeHolds(state, now = Date.now(), opts = RUNTIME_HEALTH_DEFAULTS) {
  const holds = new Map();
  for (const [runtimeId, r] of Object.entries(state?.runtimes || {})) {
    const h = streakHold(r.runs || [], now, opts);
    if (!h) continue;
    const agentIds = Object.entries(state.agentRuntimes || {}).filter(([, v]) => v?.runtimeId === runtimeId).map(([a]) => a);
    holds.set(runtimeId, {
      runtimeId, streak: h.streakRuns.length, sinceMs: h.sinceMs, failedMs: h.failedMs, untilMs: h.untilMs,
      identifiers: h.identifiers, agentIds, error: h.streakRuns[0].error || '',
    });
  }
  return holds;
}

// ---- lane failure streak (PANT-1445, pantheon-v2#527, 2026-11-23) -----------
// A runtime hold misses a provider that fails while the runtime is fine: on
// 2026-11-23 Gemini failed every run from ~10:15 UTC ("opencode exited with
// error: exit status 1") while the same opencode runtime's other lanes kept
// succeeding, so the runtime never had a streak, Heimdall still said `gemini`
// was up, and every finished build went straight to flayr-review-gemini or
// auriga-review-gemini (3 to 5 failed runs per ticket; PANT-706 was parked
// blocked). The same streak rule, applied to the runs of all agents on one
// Heimdall lane (cfg AGENTS[*].laneId), takes the lane out for a cooldown. Built
// from the run history recordRuns already keeps, so it persists the same way.
// Returns Map laneId -> { laneId, streak, sinceMs, failedMs, untilMs, identifiers, agentIds, error }.
export function laneFailureHolds(state, cfg, now = Date.now(), opts = RUNTIME_HEALTH_DEFAULTS) {
  const holds = new Map();
  const streak = opts.laneStreak ?? opts.streak;
  if (!streak) return holds;
  const laneByAgentId = new Map();
  for (const agent of Object.values(cfg?.AGENTS || {})) {
    if (agent?.id && agent.laneId) laneByAgentId.set(agent.id, agent.laneId);
  }
  const byLane = new Map();
  const seen = new Set();
  for (const r of Object.values(state?.runtimes || {})) {
    for (const x of r.runs || []) {
      const laneId = x && laneByAgentId.get(x.agentId);
      if (!laneId || seen.has(x.id)) continue;
      seen.add(x.id);
      if (!byLane.has(laneId)) byLane.set(laneId, []);
      byLane.get(laneId).push(x);
    }
  }
  const laneOpts = { ...opts, streak, minIssues: opts.laneMinIssues ?? opts.minIssues };
  for (const [laneId, runs] of byLane) {
    runs.sort((a, b) => b.ms - a.ms);
    const h = streakHold(runs, now, laneOpts);
    if (!h) continue;
    const agentIds = [...laneByAgentId].filter(([, l]) => l === laneId).map(([a]) => a);
    holds.set(laneId, {
      laneId, streak: h.streakRuns.length, sinceMs: h.sinceMs, failedMs: h.failedMs, untilMs: h.untilMs,
      identifiers: h.identifiers, agentIds, error: h.streakRuns[0].error || '',
    });
  }
  return holds;
}

// Marks every agent on a held lane unavailable (`auriga:<lane>:` so
// laneUnavailable() re-routes their tickets). An agent already out keeps its reason.
export function withLaneFailureHolds(cfg, holds) {
  if (!holds || !holds.size) return { ...cfg, laneFailureHolds: [] };
  const agents = Object.fromEntries(Object.entries(cfg.AGENTS).map(([name, agent]) => {
    const h = agent?.laneId ? holds.get(agent.laneId) : null;
    if (!h || agent.available === false) return [name, agent];
    const why = `auriga:${h.laneId}:${h.streak} runs failed in a row on the lane (${h.identifiers.join(', ')}) until ${new Date(h.untilMs).toISOString()}`;
    return [name, { ...agent, available: false, availabilityReason: why }];
  }));
  return { ...cfg, AGENTS: agents, laneFailureHolds: [...holds.values()] };
}

// Marks every agent on a held runtime unavailable. The `auriga:` prefix makes
// laneUnavailable() treat it like a lane outage, so send-backs and zombies
// assigned to those agents are unassigned and re-routed. An agent already
// unavailable keeps its own reason.
export function withRuntimeHolds(cfg, holds) {
  if (!holds || !holds.size) return { ...cfg, runtimeHolds: [] };
  const byAgent = new Map();
  for (const h of holds.values()) for (const a of h.agentIds) byAgent.set(a, h);
  const agents = Object.fromEntries(Object.entries(cfg.AGENTS).map(([name, agent]) => {
    const h = agent?.id ? byAgent.get(agent.id) : null;
    if (!h || agent.available === false) return [name, agent];
    const why = `auriga:runtime-${h.runtimeId.slice(0, 8)}:${h.streak} runs failed in a row (${h.identifiers.join(', ')}) until ${new Date(h.untilMs).toISOString()}`;
    return [name, { ...agent, available: false, availabilityReason: why }];
  }));
  return { ...cfg, AGENTS: agents, runtimeHolds: [...holds.values()] };
}

export function defaultRuntimeHealthFile(env = process.env) {
  if (env.AURIGA_RUNTIME_HEALTH_FILE) return env.AURIGA_RUNTIME_HEALTH_FILE;
  return path.join(path.dirname(defaultLaneStateFile(env)), 'runtime-health.json');
}

// File shape: { updated_at, runtimes, agentRuntimes, holds: [hold + until/since ISO], laneHolds: [same, per lane] }.
// `holds` is for readers (the nurse check); the router recomputes them from runs.
export function createRuntimeHealthStore(file = defaultRuntimeHealthFile()) {
  return {
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return v && typeof v === 'object' ? v : {};
      } catch { return {}; }
    },
    write(state, holds = [], now = Date.now(), laneHolds = []) {
      try {
        const body = {
          updated_at: new Date(now).toISOString(),
          runtimes: state.runtimes || {},
          agentRuntimes: state.agentRuntimes || {},
          holds: [...holds].map((h) => ({
            ...h, since: new Date(h.sinceMs).toISOString(), until: new Date(h.untilMs).toISOString(),
          })),
          laneHolds: [...laneHolds].map((h) => ({
            ...h, since: new Date(h.sinceMs).toISOString(), until: new Date(h.untilMs).toISOString(),
          })),
        };
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(body));
        fs.renameSync(tmp, file);
      } catch (e) {
        process.stderr.write(`[auriga] could not keep runtime health at ${file}: ${e.message}\n`);
      }
    },
  };
}
