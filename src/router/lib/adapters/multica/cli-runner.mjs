// Shared execFileSync-wrapper-with-clean-env pattern, factored out of
// backlog.mjs and spawn.mjs (which each carried their own byte-identical
// private cleanEnv()/run() before this dedupe — see the p2-adapter-interface
// epic's follow-up cleanup notes). lib/multica.mjs also carries a third,
// pre-adapter copy of this exact pattern; it is NOT ported to use this module
// by this cleanup — it is still imported by real, non-adapter callers
// (reroute-hive-off-codex.mjs, scripts/bulk-unblock.mjs), and touching it is
// out of scope here. Its cleanEnv()/run() bodies must stay in sync with this
// module's by inspection if either ever changes.
//
// `run()` itself is intentionally NOT exported directly: `execFileSync` must
// be INJECTED (via makeRun) rather than imported here, because backlog.mjs's
// and spawn.mjs's own unit tests rely on node:test's `t.mock.module` +
// a cache-busting dynamic import (`?t=<n>`) per test to get a fresh
// `execFileSync` binding for each test (see backlog-adapter.test.mjs's /
// spawn-adapter.test.mjs's header comments). A relative, non-cache-busted
// `import { execFileSync } from 'node:child_process'` living in THIS module
// would only ever resolve against whichever mock (or the real module) was
// active the first time any test happened to load cli-runner.mjs — every
// later test's own execFileSync mock would be silently ignored. Callers
// (backlog.mjs/spawn.mjs) already import execFileSync themselves (as part of
// their own cache-busted module instance) and hand it to makeRun().

/**
 * The three env vars must be UNSET (stale values 404). execFileSync inherits
 * process.env, so we delete them from a cloned env instead of `env -u`.
 * SECURITY-RELEVANT — preserved verbatim from lib/multica.mjs; do not drop.
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanEnv() {
  const e = { ...process.env };
  delete e.MULTICA_TOKEN;
  delete e.MULTICA_PAT_TOKEN;
  delete e.MULTICA_WORKSPACE_ID;
  return e;
}

/**
 * Builds the `multica --profile <profile> <args...>` execFileSync wrapper
 * shared by createMulticaBacklogAdapter and createMulticaSpawnAdapter —
 * same CLI invocation shape, same maxBuffer, same stdio, same JSON-parse-or-
 * raw-string behavior, same error-propagation (never catches — a caller that
 * wants read-degrades-gracefully behavior wraps its own try/catch around the
 * returned run(), exactly as backlog.mjs/spawn.mjs already do per method).
 *
 * @param {(cmd: string, args: string[], opts: object) => string} execFileSync
 *   Injected rather than imported by this module — see file header comment.
 * @param {string} cli
 * @param {string} profile
 * @returns {(args: string[], opts?: { json?: boolean }) => any}
 */
export function makeRun(execFileSync, cli, profile) {
  return function run(args, { json = true } = {}) {
    const out = execFileSync(cli, ['--profile', profile, ...args], {
      env: cleanEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!json) return out;
    return out.trim() ? JSON.parse(out) : null;
  };
}
