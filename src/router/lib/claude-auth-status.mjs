import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_AUTH_STATUS_PATH = path.join(os.homedir(), '.claude', 'daemon-auth-status.json');
const DEFAULT_PROBE_PROMPT = 'Reply with ok if Claude auth is available.';
const VALID_STATUSES = new Set(['ok', 'auth_required']);

export function authStatusPath(env = process.env) {
  return env.AURIGA_CLAUDE_AUTH_STATUS_PATH || DEFAULT_AUTH_STATUS_PATH;
}

export function buildAuthStatus(status, now = new Date()) {
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid auth status: ${status}`);
  return {
    status,
    checked_at: now.toISOString(),
  };
}

export function writeAuthStatus(status, { statusPath = authStatusPath(), now = new Date() } = {}) {
  const rec = buildAuthStatus(status, now);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const tmp = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, statusPath);
  return rec;
}

export function writeAuthOk(opts = {}) {
  return writeAuthStatus('ok', opts);
}

export function writeAuthRequired(opts = {}) {
  return writeAuthStatus('auth_required', opts);
}

export function probeClaudeAuth({
  runner = execFileSync,
  command = process.env.AURIGA_CLAUDE_COMMAND || 'claude',
  prompt = process.env.AURIGA_CLAUDE_AUTH_PROMPT || DEFAULT_PROBE_PROMPT,
  timeoutMs = Number(process.env.AURIGA_CLAUDE_AUTH_TIMEOUT_MS || 15000),
  statusPath = authStatusPath(),
  now = new Date(),
} = {}) {
  try {
    runner(command, ['-p', prompt], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return writeAuthOk({ statusPath, now });
  } catch (e) {
    const rec = writeAuthRequired({ statusPath, now });
    return {
      ...rec,
      error: e && e.message ? e.message : String(e),
    };
  }
}

