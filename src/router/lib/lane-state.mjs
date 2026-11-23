import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isQueuedNotStarted, isQuotaFailure, quotaResetAtMs, runErrorText, runTsMs } from './run-classification.mjs';

const DEFAULT_AGENT_LANES_FILE = new URL('../config/agent-lanes.json', import.meta.url);

// Shipped agent->lane map (src/router/config/agent-lanes.json, `lanes: { laneId:
// { agentId: label } }`), flattened to { agentId: laneId }. A missing or malformed
// file yields {} with a warning: no mapping means no gating, never a stopped router.
export function loadAgentLanesFile(file = process.env.AURIGA_AGENT_LANES_FILE || DEFAULT_AGENT_LANES_FILE) {
  try {
    const { lanes } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = {};
    for (const [laneId, agents] of Object.entries(lanes || {})) {
      for (const agentId of Object.keys(agents || {})) map[agentId] = laneId;
    }
    return map;
  } catch (e) {
    process.stderr.write(`[auriga] agent lane map ${file} unreadable, lane gating off for unmapped agents: ${e.message}\n`);
    return {};
  }
}

// PANT-1385: where the last successful GET /lanes is kept. The live router runs
// as a `--once` loop (a fresh process every cycle), so the last known state has
// to outlive the process: it sits next to the heartbeat on the shared
// auriga-state volume when there is one.
export function defaultLaneStateFile(env = process.env) {
  if (env.AURIGA_LANE_STATE_FILE) return env.AURIGA_LANE_STATE_FILE;
  if (env.AURIGA_HEARTBEAT_FILE) return path.join(path.dirname(env.AURIGA_HEARTBEAT_FILE), 'heimdall-lanes.json');
  return path.join(os.tmpdir(), 'auriga-heimdall-lanes.json');
}

function validLanes(lanes) {
  return Array.isArray(lanes) && lanes.every((lane) => lane && typeof lane.lane_id === 'string');
}

function readCache(file) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fetchedMs = new Date(cached.fetched_at).getTime();
    if (!validLanes(cached.lanes) || !Number.isFinite(fetchedMs)) return null;
    return { lanes: cached.lanes, fetchedAt: cached.fetched_at, fetchedMs };
  } catch { return null; }
}

function writeCache(file, lanes, fetchedAt) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetched_at: fetchedAt, lanes }));
    fs.renameSync(tmp, file);
  } catch (e) {
    process.stderr.write(`[auriga] could not keep last known Heimdall lane state at ${file}: ${e.message}\n`);
  }
}

// A bounded read each cycle. Stale-while-error (PANT-1385): every successful read
// is kept in `cacheFile`; when Heimdall can't be reached the last successful read
// is used instead (`source: 'cache'`, with its age), so a lane Heimdall last
// reported as limited stays out of dispatch through an outage. Only a router that
// has never had a successful read fails open (`source: 'none'`, no lanes).
export async function readLaneState({
  baseUrl = process.env.HEIMDALL_URL || 'http://heimdall:4870', fetchImpl = fetch,
  cacheFile = defaultLaneStateFile(), now = Date.now(),
} = {}) {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/lanes`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`GET /lanes: HTTP ${res.status}`);
    const lanes = await res.json();
    if (!validLanes(lanes)) throw new Error('GET /lanes: expected array of lane records');
    const fetchedAt = new Date(now).toISOString();
    if (cacheFile) writeCache(cacheFile, lanes, fetchedAt);
    return { lanes, error: null, source: 'live', fetchedAt, ageMs: 0 };
  } catch (error) {
    const cached = cacheFile ? readCache(cacheFile) : null;
    if (cached) {
      return { lanes: cached.lanes, error: error.message, source: 'cache', fetchedAt: cached.fetchedAt, ageMs: Math.max(0, now - cached.fetchedMs) };
    }
    return { lanes: [], error: error.message, source: 'none', fetchedAt: null, ageMs: null };
  }
}

// Disabled per the lane record itself: a boolean `effective_enabled` wins, older
// responses allow `status: "up"` only.
function laneEnabled(lane) {
  return typeof lane.effective_enabled === 'boolean' ? lane.effective_enabled : lane.status === 'up';
}

// Through an outage (a cached snapshot), a limited lane whose `reset_at` (or
// operator `manual_reset_at`) has passed is let back in: the reset is the one
// thing we know happened since the read. Without a reset time it stays as read.
function resetPassed(lane, now) {
  const at = lane.manual_reset_at || lane.reset_at;
  const ms = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(ms) && ms <= now;
}

export function laneStateAgeS(snapshot) {
  return Number.isFinite(snapshot?.ageMs) ? Math.round(snapshot.ageMs / 1000) : null;
}

// Map keys are configured agent names or Multica agent IDs (a name entry wins),
// values are exact Heimdall lane IDs. Unknown agents/lanes retain their existing
// eligibility, never guessed by name. A snapshot with `error` and no lanes (no
// successful read ever) gates nothing.
export function withLaneState(cfg, snapshot, now = Date.now()) {
  const lanes = new Map((snapshot.lanes || []).map((lane) => [lane.lane_id, lane]));
  const stale = Boolean(snapshot.error);
  const ageS = laneStateAgeS(snapshot);
  const agents = Object.fromEntries(Object.entries(cfg.AGENTS).map(([name, agent]) => {
    const laneId = cfg.AGENT_LANES?.[name] ?? (agent?.id ? cfg.AGENT_LANES?.[agent.id] : undefined);
    const lane = lanes.get(laneId);
    const unavailable = Boolean(lane) && !laneEnabled(lane) && !(stale && resetPassed(lane, now));
    const why = unavailable
      ? `heimdall:${laneId}:${lane.reason || lane.status || 'disabled'}${stale ? ` (last known state, ${ageS ?? '?'}s old; heimdall unreachable)` : ''}`
      : null;
    return [name, { ...agent, available: agent.available !== false && !agent.archived && !agent.archived_at && !unavailable,
      laneId: laneId ?? null,
      availabilityReason: why ?? agent.availabilityReason }];
  }));
  return { ...cfg, AGENTS: agents, laneState: snapshot };
}

// ---- observed lane limits (PANT-1445, pantheon-v2#527) ----------------------
// Heimdall only knows a lane hit its limit once something tells it. Auriga
// already fetches the runs of every ticket its agents hold, so a run that failed
// on a provider limit ("You've hit your weekly limit") is first-hand evidence
// that the whole lane (one provider account) is out, not just that agent. Until
// the stated reset (or the cooldown) every agent on that lane is unavailable, so
// ready work goes to the next agent in its lane list without operator action.
//
// Per lane, only the most recent run that actually started counts: a later run
// that started (or finished) on the lane proves it is serving again. A queued
// run that never started proves nothing. A limit on one model ("Opus limit")
// does not cap the account and is left to the per-ticket quota hold.
const MODEL_SCOPED_LIMIT_RE = /\b(opus|sonnet|haiku|fable)\b[^.\n]{0,40}\blimit\b/i;

// runLists: iterable of [identifier, runs[]]. Returns Map laneId ->
// { laneId, untilMs, identifier, agentId, error }.
export function observedLaneLimits(runLists, cfg, now = Date.now(), cooldownMs = 15 * 60 * 1000) {
  const laneByAgentId = new Map();
  for (const agent of Object.values(cfg.AGENTS || {})) {
    if (agent?.id && agent.laneId) laneByAgentId.set(agent.id, agent.laneId);
  }
  const latest = new Map();
  for (const [identifier, runs] of runLists) {
    for (const run of runs || []) {
      const laneId = laneByAgentId.get(run?.agent_id);
      if (!laneId || isQueuedNotStarted(run, now)) continue;
      const ms = runTsMs(run);
      if (ms == null) continue;
      const cur = latest.get(laneId);
      if (!cur || ms > cur.ms) latest.set(laneId, { run, ms, identifier });
    }
  }
  const limits = new Map();
  for (const [laneId, { run, ms, identifier }] of latest) {
    if (!isQuotaFailure(run, now)) continue;
    const error = runErrorText(run) || String(run.failure_reason || '');
    if (MODEL_SCOPED_LIMIT_RE.test(error)) continue;
    const untilMs = quotaResetAtMs(run) ?? ms + cooldownMs;
    if (untilMs <= now) continue;
    limits.set(laneId, { laneId, untilMs, identifier, agentId: run.agent_id, error: error.slice(0, 200) });
  }
  return limits;
}

// Marks every agent on an observed-limited lane unavailable. The reason starts
// with `auriga:` (Heimdall's own are `heimdall:`) so decision records say which
// source took the lane out, and why. An agent already unavailable keeps its reason.
export function withObservedLaneLimits(cfg, limits) {
  if (!limits || !limits.size) return { ...cfg, observedLaneLimits: [] };
  const agents = Object.fromEntries(Object.entries(cfg.AGENTS).map(([name, agent]) => {
    const limit = agent?.laneId ? limits.get(agent.laneId) : null;
    if (!limit || agent.available === false) return [name, agent];
    const why = `auriga:${limit.laneId}:provider limit observed on ${limit.identifier} until ${new Date(limit.untilMs).toISOString()}`;
    return [name, { ...agent, available: false, availabilityReason: why }];
  }));
  return { ...cfg, AGENTS: agents, observedLaneLimits: [...limits.values()] };
}

