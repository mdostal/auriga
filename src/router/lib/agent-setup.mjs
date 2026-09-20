// Agent harness setup — `auriga agent init` / `auriga agent status`.
//
// Node port of Portunus's agent_setup.py (git show
// 9621eb2c:src/portunus/agent_setup.py, read directly during research —
// this mirrors its detect_harnesses()/mcp_registered()/register_mcp()/
// agent_init()/agent_status() shape as closely as Node idiom allows). Skill
// installation (Portunus's install_skills()/skill_names()) is NOT ported —
// out of scope for this story; p5-agent-cli.yaml's files_to_modify names
// only detectHarnesses/mcpRegistered/registerMcp/agentInit/agentStatus.
//
// SUBPROCESS INJECTION: every shell-out in this module goes through an
// execFileSync binding passed in by the caller, rather than importing
// node:child_process directly — mirrors this repo's existing convention
// (lib/adapters/multica/cli-runner.mjs's makeRun(), which takes execFileSync
// as a parameter for the same reason: tests assert exact argv against a
// plain function double, with zero real process spawned and zero
// node:child_process module-mocking). Production callers (bin/auriga.mjs)
// pass the real node:child_process execFileSync.
//
// SAFETY-CRITICAL, read this before touching mcpRegistered(): the Claude
// Code branch MUST use the targeted `claude mcp get auriga` lookup, never
// `claude mcp list`. Portunus already hit and fixed this exact bug — `mcp
// list` health-checks EVERY registered MCP server, which measured 30+
// seconds on a machine with several configured. Codex's `mcp list` was not
// found to be slow the same way (confirmed via research-brief.md), so
// `codex mcp list` is correct as-is — do not "fix" Codex to match Claude's
// targeted-get shape, that would be over-generalizing a Claude-specific bug
// fix Portunus never made for Codex.
//
// Registration (registerMcp()) is a pure CLI shell-out — `claude mcp add
// --scope user auriga -- auriga mcp` / `codex mcp add auriga -- auriga
// mcp` — never a direct config-file write, same as Portunus.

import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter as pathDelimiter, join as pathJoin } from 'node:path';

// Ordered so agentInit()'s default target list (every present harness) has
// a stable, predictable order — matters for tests and for readable output.
export const KNOWN_HARNESSES = ['claude', 'codex'];
export const SERVER_NAME = 'auriga';

// ---- detection: presence on $PATH only, nothing deeper ---------------------

/**
 * shutil.which()-equivalent: is `name` an executable file somewhere on
 * $PATH? Presence only — does not invoke the binary, does not check its
 * version, does not health-check anything. Pure fs/PATH scan, no
 * subprocess spawned.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isOnPath(name, env = process.env) {
  const pathVar = env.PATH || env.Path || '';
  const dirs = pathVar.split(pathDelimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = pathJoin(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // not present / not executable in this dir — keep scanning
    }
  }
  return false;
}

/**
 * Which known agent harness CLIs are actually installed on this machine.
 * Mirrors Portunus's detect_harnesses(): shutil.which-equivalent, nothing
 * deeper.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, boolean>}
 */
export function detectHarnesses(env = process.env) {
  const result = {};
  for (const name of KNOWN_HARNESSES) {
    result[name] = isOnPath(name, env);
  }
  return result;
}

// ---- subprocess helper -----------------------------------------------------

/**
 * Runs argv via the injected execFileSync, capturing stdout and never
 * throwing — any failure (non-zero exit, ENOENT, timeout) collapses to a
 * uniform { ok: false } shape so callers never need try/catch of their own.
 * Mirrors Portunus's _run(): "swallow OSError/TimeoutExpired, return None",
 * adapted to execFileSync's throw-on-nonzero-exit/ENOENT/timeout semantics.
 * @param {(cmd: string, args: string[], opts: object) => string} execFileSync
 * @param {string[]} argv
 * @param {{ timeout?: number }} [opts]
 * @returns {{ ok: boolean, stdout: string }}
 */
function run(execFileSync, argv, opts = {}) {
  const [cmd, ...args] = argv;
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: typeof stdout === 'string' ? stdout : '' };
  } catch (err) {
    // execFileSync throws on non-zero exit / ENOENT / timeout. Node
    // populates err.stdout for the "ran, but exited non-zero" case (e.g.
    // `claude mcp get auriga` against a never-registered server) — surface
    // it in case a caller wants to inspect it, but never treat this branch
    // as success.
    return { ok: false, stdout: typeof err?.stdout === 'string' ? err.stdout : '' };
  }
}

// ---- registration status / registration ------------------------------------

/**
 * Best-effort check — targeted per-server lookup for Claude Code, never
 * the harness's full `mcp list`. False on any failure; never assumes
 * registered when it can't tell.
 * @param {string} harness 'claude' | 'codex'
 * @param {(cmd: string, args: string[], opts: object) => string} execFileSync
 * @returns {boolean}
 */
export function mcpRegistered(harness, execFileSync) {
  let result;
  if (harness === 'claude') {
    result = run(execFileSync, ['claude', 'mcp', 'get', SERVER_NAME]);
  } else if (harness === 'codex') {
    result = run(execFileSync, ['codex', 'mcp', 'list']);
  } else {
    return false;
  }
  if (!result.ok) return false;
  return result.stdout.includes(SERVER_NAME);
}

/**
 * Registers `auriga mcp` with the given harness. Idempotent — a no-op
 * success if already registered (checked first via mcpRegistered(), which
 * itself never uses `claude mcp list`), so re-running init is always safe.
 * @param {string} harness 'claude' | 'codex'
 * @param {(cmd: string, args: string[], opts: object) => string} execFileSync
 * @returns {boolean}
 */
export function registerMcp(harness, execFileSync) {
  if (mcpRegistered(harness, execFileSync)) return true;
  let argv;
  if (harness === 'claude') {
    argv = ['claude', 'mcp', 'add', '--scope', 'user', SERVER_NAME, '--', SERVER_NAME, 'mcp'];
  } else if (harness === 'codex') {
    argv = ['codex', 'mcp', 'add', SERVER_NAME, '--', SERVER_NAME, 'mcp'];
  } else {
    return false;
  }
  const result = run(execFileSync, argv, { timeout: 30000 });
  return result.ok;
}

// ---- combined reports --------------------------------------------------------

/**
 * Combined report: which harnesses are present, and which have the MCP
 * server registered. Read-only, zero side effects — never calls
 * registerMcp(). Harnesses not detected are reported as unregistered
 * without even attempting the lookup (mirrors Portunus's
 * `mcp_registered(name) if present else False`).
 * @param {(cmd: string, args: string[], opts: object) => string} execFileSync
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ harnesses: Record<string, boolean>, mcp_registered: Record<string, boolean> }}
 */
export function agentStatus(execFileSync, env = process.env) {
  const harnesses = detectHarnesses(env);
  const mcp_registered = {};
  for (const name of KNOWN_HARNESSES) {
    mcp_registered[name] = harnesses[name] ? mcpRegistered(name, execFileSync) : false;
  }
  return { harnesses, mcp_registered };
}

/**
 * Idempotent, best-effort setup across every detected (or explicitly
 * requested via opts.only) harness. One harness failing to register never
 * blocks the others — each is attempted and reported independently.
 *
 * Matches Portunus's agent_init() shape exactly: when `only` is given
 * explicitly (e.g. from a CLI `--harness` flag), those targets are
 * attempted regardless of whether detectHarnesses() actually found them —
 * an explicit ask is honored, not silently dropped, and the underlying CLI
 * shell-out will itself fail (captured, not thrown) if the binary truly
 * isn't present.
 * @param {(cmd: string, args: string[], opts: object) => string} execFileSync
 * @param {{ only?: string[], env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ harnesses: Record<string, boolean>, requested: string[], mcp_registered: Record<string, boolean> }}
 */
export function agentInit(execFileSync, opts = {}) {
  const env = opts.env || process.env;
  const harnesses = detectHarnesses(env);
  const targets = opts.only ?? KNOWN_HARNESSES.filter((name) => harnesses[name]);
  const mcp_registered = {};
  for (const name of targets) {
    try {
      mcp_registered[name] = registerMcp(name, execFileSync);
    } catch {
      // Belt-and-suspenders: registerMcp()/run() already swallow subprocess
      // errors internally, but a harness failing here must NEVER stop the
      // loop from attempting the next one.
      mcp_registered[name] = false;
    }
  }
  return { harnesses, requested: targets, mcp_registered };
}
