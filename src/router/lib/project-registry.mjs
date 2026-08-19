// Standalone project registry (p6-registry-core) — read/write/derive logic for
// src/router/projects.json, the committed file that replaces
// config-substrate.mjs's formerly-hardcoded PROJECT_NAMES/PROJECT_IDS/
// PROJECT_LANE object literals. See projects.json's own header comment for the
// file's shape and design-discussion.md (epic p6-project-registry) for the
// full reconciliation-with-Minerva/operator background.
//
// FILE I/O INJECTION: every function that touches the real filesystem takes
// the read/write function as an explicit first parameter, exactly mirroring
// lib/agent-setup.mjs's injected-execFileSync pattern (see that file's header
// comment) — tests pass a plain function double (an inline closure reading
// from an in-memory string, or recording writes into an array) so this
// module's logic is fully unit-tested with ZERO real filesystem access.
// Production callers (config-substrate.mjs, and later bin/auriga.mjs's
// `project` subcommands) pass the real node:fs readFileSync/writeFileSync.
//
// GRACEFUL DEGRADE (grill finding H2): config-substrate.mjs reads this
// registry at ES module IMPORT TIME — a missing or malformed projects.json
// must never throw and crash that import, because an unrelated existing test
// (test/spawn-adapter.test.mjs) imports PROJECT_LANE etc. from that module
// directly. loadRegistryConfig() below is the one function config-substrate.mjs
// calls; it mirrors this codebase's own established degrade-gracefully
// convention (lib/adapters/multica/backlog.mjs's listAllProjectIds()/
// listAllProjects(): try/catch, log a loud stderr warning, return an empty
// result — never throw).

import { readFileSync as realReadFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// src/router/projects.json — sibling to package.json, a router-level concern
// (operator sign-off, design-discussion.md Open Question 1), not buried under
// lib/adapters/. This file lives at src/router/lib/project-registry.mjs, so
// the registry is one directory up from here.
export const DEFAULT_REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'projects.json');

// Test-only path override, same convention as this repo's existing
// AURIGA_PIDFILE/AURIGA_LOG/AURIGA_PHIVE_ROOT env-var overrides (see
// auriga-router.mjs / test/support fixtures). Lets a graceful-degrade test
// point loadRealRegistryConfig() at a private missing/corrupt fixture path
// WITHOUT ever touching the real, committed src/router/projects.json —
// mutating that shared file directly is unsafe under node --test's default
// parallel-file execution (concurrently-running test files/processes read
// the same file on disk; a rename/corrupt in one process is visible to every
// other process reading that same path at the same moment). Unset in normal
// (production) operation, so DEFAULT_REGISTRY_PATH above is what actually runs.
const REGISTRY_PATH_ENV_VAR = 'AURIGA_PROJECTS_REGISTRY_PATH';

// Empty-but-well-shaped result, returned by loadRegistryConfig() on any
// missing/malformed-file failure. Matches PROJECT_NAMES/PROJECT_IDS/
// PROJECT_LANE's real shapes (dict, array, dict) so a caller (core.mjs) never
// sees `undefined` where it expects one of these three.
const EMPTY_CONFIG = Object.freeze({ PROJECT_NAMES: {}, PROJECT_IDS: [], PROJECT_LANE: {} });

/**
 * Reads and JSON-parses the registry file. Throws on any failure (file
 * missing, unreadable, invalid JSON) — callers that need graceful degrade
 * (config-substrate.mjs, via loadRegistryConfig below) catch this themselves;
 * this function stays a plain, honest read+parse with no swallowed errors, so
 * a caller that DOES want to know about a bad file (e.g. a future `auriga
 * project` CLI command) can.
 * @param {(path: string, encoding: string) => string} readFileSync
 * @param {string} [path]
 * @returns {{ dispatch_order?: string[], projects?: object[] }}
 */
export function readRegistryFile(readFileSync, path = DEFAULT_REGISTRY_PATH) {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

/**
 * Serializes and writes the registry file (pretty-printed, trailing newline —
 * matches this repo's other committed JSON files). Mirrors readRegistryFile's
 * injected-dependency shape. Not called by config-substrate.mjs (read-only at
 * import time) — this exists for a future `auriga project add/remove` CLI
 * (p6-project-cli) to mutate the registry without duplicating this shape.
 * @param {(path: string, data: string, encoding: string) => void} writeFileSync
 * @param {{ dispatch_order?: string[], projects?: object[] }} data
 * @param {string} [path]
 */
export function writeRegistryFile(writeFileSync, data, path = DEFAULT_REGISTRY_PATH) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---- pure derivation: registry data -> config-substrate.mjs's three shapes ----

/**
 * Project UUID -> display name, over every registered project (mirrors
 * today's PROJECT_NAMES — cosmetic only, always has a safe raw-UUID fallback
 * at every real read site in core.mjs, so an entry with no/blank name simply
 * falls back to its id here too).
 * @param {{ projects?: object[] }} data
 * @returns {Record<string, string>}
 */
export function deriveProjectNames(data) {
  const names = {};
  for (const p of (data && data.projects) || []) {
    if (!p || !p.id) continue;
    names[p.id] = p.name || p.id;
  }
  return names;
}

/**
 * The real, order-sensitive dispatch-eligibility gate (mirrors today's
 * PROJECT_IDS exactly — see core.mjs's selectAssignments/detectCascadeDispatch,
 * both of which filter to this exact set, and order it by
 * PROJECT_IDS.indexOf(...) for dispatch priority). Sourced from
 * `dispatch_order`, NOT from `projects` — a project can be registered
 * (known, has a lane) without being dispatch-eligible, e.g. Minerva. Filtered
 * defensively to ids that are actually registered, so a stale/typo'd
 * dispatch_order entry can never gate dispatch on an unregistered id.
 * @param {{ dispatch_order?: string[], projects?: object[] }} data
 * @returns {string[]}
 */
export function deriveProjectIds(data) {
  const known = new Set(((data && data.projects) || []).map((p) => p && p.id).filter(Boolean));
  return ((data && data.dispatch_order) || []).filter((id) => known.has(id));
}

/**
 * Project UUID -> ordered candidate agent lanes, over every registered
 * project that HAS a lane assignment (mirrors today's PROJECT_LANE exactly,
 * including its unconditional core.mjs fallback: `cfg.PROJECT_LANE[id] ||
 * cfg.DEFAULT_LANE` — a project with no/empty `lane` here is simply absent
 * from the result, degrading to DEFAULT_LANE downstream exactly as an
 * unmapped project does today). Independent of dispatch eligibility — Minerva
 * has a lane here despite being absent from deriveProjectIds().
 * @param {{ projects?: object[] }} data
 * @returns {Record<string, string[]>}
 */
export function deriveProjectLane(data) {
  const lane = {};
  for (const p of (data && data.projects) || []) {
    if (!p || !p.id) continue;
    if (Array.isArray(p.lane) && p.lane.length) lane[p.id] = p.lane;
  }
  return lane;
}

/**
 * All three derived shapes at once — the one function config-substrate.mjs
 * needs at import time, wrapping readRegistryFile()'s throw-on-failure with
 * this codebase's own graceful-degrade convention (see this file's header
 * comment). NEVER throws: a missing or malformed registry file logs a loud
 * stderr warning and returns EMPTY_CONFIG (empty PROJECT_NAMES/PROJECT_IDS/
 * PROJECT_LANE) instead of crashing the importing module.
 * @param {(path: string, encoding: string) => string} readFileSync
 * @param {string} [path]
 * @returns {{ PROJECT_NAMES: Record<string,string>, PROJECT_IDS: string[], PROJECT_LANE: Record<string,string[]> }}
 */
export function loadRegistryConfig(readFileSync, path = DEFAULT_REGISTRY_PATH) {
  try {
    const data = readRegistryFile(readFileSync, path);
    return {
      PROJECT_NAMES: deriveProjectNames(data),
      PROJECT_IDS: deriveProjectIds(data),
      PROJECT_LANE: deriveProjectLane(data),
    };
  } catch (e) {
    process.stderr.write(
      'project-registry: FAILED to load ' + path + ' (' + e.message + ') — '
      + 'derived PROJECT_NAMES/PROJECT_IDS/PROJECT_LANE are ALL EMPTY, no projects '
      + 'are dispatch-eligible until this is fixed. Never fabricating routing data '
      + 'for a missing/malformed registry file.\n'
    );
    return { PROJECT_NAMES: { ...EMPTY_CONFIG.PROJECT_NAMES }, PROJECT_IDS: [...EMPTY_CONFIG.PROJECT_IDS], PROJECT_LANE: { ...EMPTY_CONFIG.PROJECT_LANE } };
  }
}

// Real-fs convenience wrapper — the shape a production caller (config-substrate.mjs)
// actually calls: real readFileSync, real path (honoring the test-only
// AURIGA_PROJECTS_REGISTRY_PATH override above, unset in production), same
// never-throws guarantee. Kept separate from loadRegistryConfig so tests that
// want full isolation always inject their own readFileSync double too, and
// never accidentally exercise the real filesystem.
/**
 * @returns {{ PROJECT_NAMES: Record<string,string>, PROJECT_IDS: string[], PROJECT_LANE: Record<string,string[]> }}
 */
export function loadRealRegistryConfig() {
  const path = process.env[REGISTRY_PATH_ENV_VAR] || DEFAULT_REGISTRY_PATH;
  return loadRegistryConfig(realReadFileSync, path);
}
