// Container-ready runtime signals for the router (PANT-817): the JSONL log
// sink, the per-cycle `cycle_summary` event, the heartbeat file a container
// HEALTHCHECK reads, and the bounded decision-records file auriga-api serves
// (PANT-1024). Kept out of auriga-router.mjs so each piece is
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
// AURIGA_RECORDS_FILE set -> RECORD_EVENTS are ALSO appended to that file
// (bounded, see appendRecord), whichever sink the full log goes to.
export function createLogger({ env = process.env, stdout = process.stdout } = {}) {
  const records = createRecordsSink(env);
  return function log(event, data) {
    const rec = { ts: new Date().toISOString(), event, ...data };
    if (env.AURIGA_INSTANCE_ID) rec.instance_id = env.AURIGA_INSTANCE_ID;
    if (env.AURIGA_TENANT_ID && !('tenant_id' in rec)) rec.tenant_id = env.AURIGA_TENANT_ID;
    const line = JSON.stringify(rec) + '\n';
    if (RECORD_EVENTS.has(event)) records(line);
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

// ---- decision records file (PANT-1024) -------------------------------------
// The routing records Janus Insights reads through auriga-api's
// GET /api/decisions, so it never has to scrape `docker logs`. The router and
// auriga-api run in separate containers and share this file over a volume.
export const RECORD_EVENTS = new Set(['decision', 'verify_ok', 'advance', 'zombie', 'review', 'scan']);
export const DEFAULT_RECORDS_MAX_LINES = 5000;

function countLines(file) {
  try {
    const buf = fs.readFileSync(file);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n += 1;
    return n;
  } catch { return 0; }
}

// Keeps only the last `maxLines` lines. Atomic (write + rename) so a reader
// never sees a half-trimmed file.
export function trimRecords(file, maxLines) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.slice(-maxLines).map((l) => l + '\n').join(''));
  fs.renameSync(tmp, file);
}

// Returns an append(line) for AURIGA_RECORDS_FILE (a no-op when unset). The
// file is trimmed back to AURIGA_RECORDS_MAX_LINES once it grows 20% past it,
// so it stays bounded without a rewrite on every append. The line count is
// read once per process (the router may run as a `--once` loop) and then
// tracked in memory. A failed write never breaks the log call.
export function createRecordsSink(env = process.env) {
  const file = env.AURIGA_RECORDS_FILE;
  if (!file) return () => {};
  const maxLines = parseInt(env.AURIGA_RECORDS_MAX_LINES, 10) || DEFAULT_RECORDS_MAX_LINES;
  const trimAt = Math.ceil(maxLines * 1.2);
  let count = null;
  return function append(line) {
    try {
      if (count === null) count = countLines(file);
      fs.appendFileSync(file, line);
      count += 1;
      if (count > trimAt) {
        trimRecords(file, maxLines);
        count = maxLines;
      }
    } catch {}
  };
}

// Reads the records file, oldest first. `since` (ISO) keeps records strictly
// newer than it. With `since` the first `limit` matches are returned, so a
// caller can page forward from the last ts it saw; without it, the newest
// `limit`. Unparseable lines are skipped. A missing file is no records.
export function readRecords(file, { since = null, limit = 2000 } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const sinceMs = since ? new Date(since).getTime() : null;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (sinceMs != null && !(new Date(rec.ts).getTime() > sinceMs)) continue;
    out.push(rec);
  }
  return sinceMs != null ? out.slice(0, limit) : out.slice(-limit);
}
