// createMnemosyneMemoryAdapter(cfg) — the real, Mnemosyne-backed
// implementation of MemoryAdapter (see ../memory-adapter.mjs). Mirrors the
// proven client contract the mnemosyne repo's own hooks already use
// (hooks/lib/mnemo-client.mjs): HTTP service first (default
// http://127.0.0.1:8477), `swarm-memory` CLI fallback second, NEVER throws —
// a memory miss or a fully-down service degrades to an empty/failed result,
// it must never break the caller's own real work.
//
// DIRECT INTEGRATION, FOR NOW — flagged explicitly, mirroring
// multica/backlog.mjs's own history before the pantheon-v2-l2 cutover
// (PR #65): this repo's own standing architecture rule is "no direct
// god-to-god calls, everything routes through Pantheon" (see
// lib/adapters/pantheon-v2-l2/README.md's "NO ONE INTEGRATES DIRECTLY TO
// MULTICA" framing). Checked live (2026-09-06): pantheon-v2's core-api has
// NO memory-proxy route today (no /api/memory, nothing wrapping Mnemosyne) —
// only a persona_root_scope_id field on the tenant registry anticipating
// per-tenant Mnemosyne scoping, not a working proxy. Rather than block this
// epic on Pantheon-side work that doesn't exist yet, this adapter talks to
// Mnemosyne directly, exactly like multica/backlog.mjs did before
// pantheon-v2-l2 existed — a future story cuts this over to a real Pantheon
// proxy the same mechanical way, once one exists. Do not treat this file's
// existence as license to build other direct god-to-god integrations
// pre-emptively; this one is grounded in the same real, load-bearing
// precedent.
//
// execFile/fetch are INJECTED (never imported directly), matching this
// codebase's established dependency-injection convention (see
// multica/cli-runner.mjs's header comment for the fullest explanation) so
// tests can substitute fakes without a real network/process call.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_URL = 'http://127.0.0.1:8477';
const DEFAULT_CLI = 'swarm-memory';
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
const DEFAULT_CLI_TIMEOUT_MS = 90_000;

/**
 * @param {{
 *   url?: string, cli?: string, fetchFn?: typeof fetch,
 *   execFile?: typeof nodeExecFile, httpTimeoutMs?: number, cliTimeoutMs?: number,
 * }} [cfg]
 *   url/cli default to today's MNEMOSYNE_URL/SWARM_MEMORY_BIN env-var
 *   behavior (see mnemosyne's own hooks/lib/mnemo-client.mjs). fetchFn/
 *   execFile are injected rather than imported (see file header) — default
 *   to the real global fetch / node:child_process execFile.
 * @returns {import('../memory-adapter.mjs').MemoryAdapter}
 */
export function createMnemosyneMemoryAdapter(cfg = {}) {
  const URL_BASE = cfg.url || process.env.MNEMOSYNE_URL || DEFAULT_URL;
  const CLI = cfg.cli || process.env.SWARM_MEMORY_BIN || DEFAULT_CLI;
  const fetchFn = cfg.fetchFn || fetch;
  const execFileP = promisify(cfg.execFile || nodeExecFile);
  const HTTP_TIMEOUT_MS = cfg.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const CLI_TIMEOUT_MS = cfg.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;

  async function httpJson(method, path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetchFn(URL_BASE + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const json = await res.json();
      if (!res.ok) {
        const e = new Error(json.error || `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  async function cli(args, timeout = CLI_TIMEOUT_MS) {
    const { stdout } = await execFileP(CLI, args, { timeout, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }

  // recall(): semantic search. Service path preferred; CLI fallback mirrors
  // the real `swarm-memory recall <query> --json` invocation mnemo-client.mjs
  // already proves works. Never throws — a total failure returns
  // { total_hits: 0, scopes: [], via: 'none' }, the same "no memory" shape a
  // genuine empty result has, so callers don't need a separate error path.
  async function recall(query, scope, opts = {}) {
    const hits = opts.hits || 5;
    try {
      const r = await httpJson('POST', '/recall', { query, scope, hits });
      return { ...r, via: 'service' };
    } catch (serviceErr) {
      try {
        const args = ['recall', String(query), '--json', '--hits', String(hits)];
        if (scope) args.push('--scope', String(scope));
        const stdout = await cli(args);
        return { ...JSON.parse(stdout), via: 'cli' };
      } catch (cliErr) {
        return {
          total_hits: 0,
          scopes: [],
          via: 'none',
          service_error: String(serviceErr.message || serviceErr),
          cli_error: String(cliErr.message || cliErr),
        };
      }
    }
  }

  // remember(): write-back. Service path preferred; CLI fallback is
  // deliberately NOT ported here (mnemo-client.mjs's own CLI-fallback write
  // path shells out to a real `swarm-memory config`/`index` sequence and
  // writes a local note file under the OPERATOR's home directory — a real,
  // meaningful side effect this router-side adapter should not silently
  // reproduce without its own story; see the no-pre-emptive-integrations
  // rule). A remember() call with the service down returns `remembered:
  // false` rather than a false, note-file-based success.
  async function remember(text, scope, opts = {}) {
    const tag = opts.tag || 'note';
    try {
      const r = await httpJson('POST', '/remember', { text, scope, tag });
      return { ...r, via: 'service' };
    } catch (serviceErr) {
      return { remembered: false, via: 'none', service_error: String(serviceErr.message || serviceErr) };
    }
  }

  return Object.freeze({ recall, remember });
}
