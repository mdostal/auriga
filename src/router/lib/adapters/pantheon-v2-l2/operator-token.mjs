// Pantheon operator token (PANT-1078). core-api checks a token on every write
// under /api (pantheon-v2 core/api/middleware/operator-token.ts, PANT-1028):
// warn mode logs a missing or wrong one, enforce mode answers 401. Auriga is
// the dispatcher -- assign, status, metadata, comments, route/select all go
// through this adapter -- so http-runner.mjs sends the token on every
// mutating core-api call.
//
// The token is resolved the sanctioned way, through Pantheon's secrets facade
// (PANT-256): POST /api/secrets/inject writes it to a fresh file in the shared
// secrets volume, this process reads the value after the first `=` and
// deletes the file. It is held only in memory, never logged, never put in
// curl's argv (http-runner.mjs hands the header to curl on stdin), and never
// read from Portunus directly or from a compose env var. Janus's
// server/llm/credential-init.mjs + server/mode/operator-token.mjs is the same
// flow; this is its synchronous twin, since every adapter method here is
// synchronous (see index.mjs's header comment).
//
// Lookup is lazy: the first write does it. A miss (standalone Auriga with no
// core-api, core-api not up yet, no shared volume) is logged once, the write
// goes out without the token and core-api's mode decides, and the next write
// retries -- at most once per RETRY_MS, so a down core-api never costs a cycle
// more than one extra call. Nothing here ever throws into a cycle.
//
// Env:
//   PANTHEON_OPERATOR_TOKEN        explicit token (local dev); wins over the facade.
//   AURIGA_OPERATOR_TOKEN_SOURCE   "pantheon" (default) or "none" (never look it up).
//   AURIGA_OPERATOR_TOKEN_TAGS     Portunus tag selector; default below.
//   PANTHEON_SECRETS_SHARED_DIR    shared secrets volume; default /pantheon-secrets.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const OPERATOR_TOKEN_HEADER = 'x-pantheon-operator-token';
// pantheon-v2 OPERATOR_TOKEN_TAGS (PANT-1028).
export const DEFAULT_OPERATOR_TOKEN_TAGS = 'provider=pantheon,kind=operator-token';
export const DEFAULT_SECRETS_SHARED_DIR = '/pantheon-secrets';
export const RETRY_MS = 60_000;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const INJECT_TIMEOUT_SECONDS = 10;

export function isMutatingMethod(method) {
  return MUTATING_METHODS.has(String(method || 'GET').toUpperCase());
}

/**
 * @param {{
 *   exec: (cmd: string, args: string[], opts: object) => string,
 *   baseUrl: string,
 *   env?: Record<string, string | undefined>,
 *   now?: () => number,
 *   generateId?: () => string,
 *   log?: (line: string) => void,
 * }} cfg
 *   exec is execFileSync, injected for the same reason http-runner.mjs's is.
 *   baseUrl is core-api's base URL with no tenant query: the operator token is
 *   install-wide, not per-tenant.
 * @returns {{ tokenFor: (method: string) => string | null, invalidate: () => void }}
 *   tokenFor returns the token for a mutating method (looking it up if
 *   needed) or null; it never throws. invalidate drops a facade-sourced token
 *   after core-api rejected it, so a later write looks it up again.
 */
export function createOperatorTokenSource({
  exec,
  baseUrl,
  env = process.env,
  now = Date.now,
  generateId = randomUUID,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const envToken = typeof env.PANTHEON_OPERATOR_TOKEN === 'string' ? env.PANTHEON_OPERATOR_TOKEN.trim() : '';
  const source = (env.AURIGA_OPERATOR_TOKEN_SOURCE || 'pantheon').toLowerCase();
  const tags = env.AURIGA_OPERATOR_TOKEN_TAGS || DEFAULT_OPERATOR_TOKEN_TAGS;
  const sharedDir = env.PANTHEON_SECRETS_SHARED_DIR || DEFAULT_SECRETS_SHARED_DIR;

  let token = envToken || null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let missLogged = false;

  // POST /api/secrets/inject -> read the shared-volume file -> delete it.
  // Same request shape as Janus's injectSecretFromPantheon and pantheon-v2's
  // TenantSecretsClient. Returns { ok, value } or { ok: false, reason }; the
  // value is never part of `reason`.
  function lookup() {
    const filePath = join(sharedDir, `auriga-operator-token-${generateId()}.secret`);
    try {
      const body = { tags, target: 'file', path: filePath, format: 'env', key: 'PANTHEON_OPERATOR_TOKEN' };
      const out = exec('curl', [
        '-sS',
        '--max-time', String(INJECT_TIMEOUT_SECONDS),
        '-X', 'POST',
        `${baseUrl}/api/secrets/inject`,
        '-w', '\n%{http_code}',
        '-H', 'content-type: application/json',
        '-d', JSON.stringify(body),
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const splitIdx = out.lastIndexOf('\n');
      const status = Number(splitIdx === -1 ? out : out.slice(splitIdx + 1));
      if (!(status >= 200 && status < 300)) {
        const text = splitIdx === -1 ? '' : out.slice(0, splitIdx);
        let message = `HTTP ${status}`;
        try { const parsed = JSON.parse(text); if (parsed && parsed.error) message = `HTTP ${status}: ${parsed.error}`; } catch { /* not JSON */ }
        return { ok: false, reason: `secrets/inject failed: ${message}` };
      }
      if (!existsSync(filePath)) {
        return { ok: false, reason: `secrets/inject succeeded but ${sharedDir} has no file for it (is the pantheon-secrets volume mounted?)` };
      }
      const content = readFileSync(filePath, 'utf8').trim();
      const eqIdx = content.indexOf('=');
      const value = eqIdx === -1 ? '' : content.slice(eqIdx + 1).trim();
      if (!value) return { ok: false, reason: 'injected file was empty' };
      return { ok: true, value };
    } catch (e) {
      // curl's own failure (connection refused, timeout): first line only,
      // so a log line never carries more than the transport error.
      const message = String(e && e.message ? e.message : e).split('\n')[0];
      return { ok: false, reason: `secrets/inject failed: ${message}` };
    } finally {
      try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* best-effort cleanup */ }
    }
  }

  function tokenFor(method) {
    if (!isMutatingMethod(method)) return null;
    if (token) return token;
    if (source !== 'pantheon') return null;
    if (now() - lastAttemptAt < RETRY_MS) return null;
    lastAttemptAt = now();
    const result = lookup();
    if (result.ok) {
      token = result.value;
      missLogged = false;
      log('pantheon-v2-l2: operator token resolved via Pantheon secrets facade');
    } else if (!missLogged) {
      missLogged = true;
      log(`pantheon-v2-l2: operator token unavailable (${result.reason}); core-api writes go out without it, retrying on a later write`);
    }
    return token;
  }

  function invalidate() {
    if (!token || token === envToken) return;
    token = null;
    log('pantheon-v2-l2: core-api rejected the operator token; looking it up again on a later write');
  }

  return Object.freeze({ tokenFor, invalidate });
}
