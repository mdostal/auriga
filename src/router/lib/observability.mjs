// Container-ready runtime signals for the router (PANT-817): the JSONL log
// sink, the per-cycle `cycle_summary` event, and the heartbeat file a
// container HEALTHCHECK reads. Kept out of auriga-router.mjs so each piece is
// unit-testable without importing the daemon.

import fs from 'node:fs';
import path from 'node:path';
import { ISSUE_STATUS } from './issue-status.mjs';

export const DEFAULT_PIDFILE = '/tmp/auriga-router.pid';
export const HEARTBEAT_BASENAME = 'auriga-router.heartbeat';

// ---- log sink --------------------------------------------------------------
// AURIGA_LOG set   -> append JSONL to that file (stdout stays quiet).
// AURIGA_LOG unset -> JSONL to stdout, so container log collection sees it.
// Env is read per call (not captured at import) so the sink follows the live
// process env; a failed file append falls back to stdout rather than dropping
// the line.
export function createLogger({ env = process.env, stdout = process.stdout } = {}) {
  return function log(event, data) {
    const rec = { ts: new Date().toISOString(), event, ...data };
    if (env.AURIGA_INSTANCE_ID) rec.instance_id = env.AURIGA_INSTANCE_ID;
    if (env.AURIGA_TENANT_ID && !('tenant_id' in rec)) rec.tenant_id = env.AURIGA_TENANT_ID;
    const line = JSON.stringify(rec) + '\n';
    if (env.AURIGA_LOG) {
      try { fs.appendFileSync(env.AURIGA_LOG, line); return; } catch {}
    }
    stdout.write(line);
  };
}

// ---- cycle_summary ---------------------------------------------------------
export const SUMMARY_PASSES = [
  'unblocked', 'parent_rollup', 'in_review', 'verified_done', 'changeback',
  'cascade', 'zombie', 'assigned_idle', 'review', 'routed', 'hand_up',
];

// Maps one cycle() decision event to the pass it belongs to (null = not a
// counted decision). Decisions count whether applied or dry-run; a failed
// write shows up separately as a `*_error` event.
export function passForEvent(event, data = {}) {
  switch (event) {
    case 'advance':
      if (data.kind === 'parent-rollup') return 'parent_rollup';
      if (data.kind === 'verified-done') return 'verified_done';
      if (data.to === ISSUE_STATUS.IN_REVIEW) return 'in_review';
      if (data.from === ISSUE_STATUS.BLOCKED) return 'unblocked';
      if (data.from === ISSUE_STATUS.CHANGES_REQUESTED) return 'changeback';
      return null;
    case 'cascade_dispatch': return 'cascade';
    case 'zombie':
    case 'zombie_give_up': return 'zombie';
    case 'assigned_idle':
    case 'assigned_idle_unassign':
    case 'archived_agent_unassign': return 'assigned_idle';
    case 'review': return 'review';
    case 'route': return 'routed';
    case 'hand_up': return 'hand_up';
    default: return null;
  }
}

// Wraps a cycle's log sink so every event it emits is also tallied into
// per-pass counts and an error count for the closing cycle_summary.
export function createCycleCounter() {
  const passes = Object.fromEntries(SUMMARY_PASSES.map((p) => [p, 0]));
  let errors = 0;
  return {
    wrap(log) {
      return (event, data) => {
        const pass = passForEvent(event, data);
        if (pass) passes[pass] += 1;
        if (event.endsWith('_error')) errors += 1;
        return log(event, data);
      };
    },
    passes: () => ({ ...passes }),
    errors: () => errors,
  };
}

// ---- heartbeat -------------------------------------------------------------
export function defaultHeartbeatFile(env = process.env) {
  if (env.AURIGA_HEARTBEAT_FILE) return env.AURIGA_HEARTBEAT_FILE;
  return path.join(path.dirname(env.AURIGA_PIDFILE || DEFAULT_PIDFILE), HEARTBEAT_BASENAME);
}

// Atomic (write + rename) so a healthcheck never reads a half-written file.
export function writeHeartbeat(file, record) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record) + '\n');
  fs.renameSync(tmp, file);
}

// Returns { ok, reason, ageMs }. Age comes from the file's mtime, which
// writeHeartbeat() refreshes on every cycle.
export function checkHeartbeat(file, maxAgeMs, now = Date.now()) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { ok: false, reason: `no heartbeat at ${file}`, ageMs: null }; }
  const ageMs = Math.max(0, now - stat.mtimeMs);
  if (ageMs > maxAgeMs) return { ok: false, reason: `heartbeat ${file} is ${ageMs}ms old (max ${maxAgeMs}ms)`, ageMs };
  return { ok: true, reason: `heartbeat ${ageMs}ms old`, ageMs };
}
