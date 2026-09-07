// Orchestrator topology registry (t010) — read/write/derive logic for
// src/router/orchestrator-topology.json, a committed file recording which
// OTHER Auriga instance (if any) this one hands work up to, and which
// instances (if any) hand work down to this one.
//
// PURE DATA, NO ORCHESTRATION LOGIC. Per the operator's own framing
// (2026-09-06): "we don't actually create the logic or the setup or the
// orchestration of many levels, we just purely make this as if a node in a
// tree and we can manually set up a node to aim to another and have a
// parent or many children. Then when the implementation uses those, it
// just sets up the parts in config correctly." This module does not dial,
// discover, validate, or reach another Auriga instance in any way — `id` is
// a free-form operator-supplied string (a tenant id, a URL, a hostname,
// whatever the operator finds meaningful for a future consumer to resolve).
// Adding real handoff/escalation behavior on top of this registry was
// explicitly future, separate work as of t010 — that work is t015 (see
// .pHive/epics/t015-orchestrator-hand-up/design-discussion.md), which adds
// the OPTIONAL baseUrl/projectId reachability fields below plus
// resolveParentBoardConfig(). This module STILL does not dial, discover, or
// validate reachability itself — it only stores/resolves the config a
// caller (auriga-router.mjs's cycle()) uses to instantiate a real adapter
// pointed at another board. `id` remains a free-form operator-supplied
// string when reachability isn't set.
//
// Mirrors project-registry.mjs's own conventions exactly (same injected
// read/write I/O, same env-var path override, same graceful-degrade
// contract) — see that file's header comment for the fuller rationale
// behind each of these choices; not re-explained here.

import { readFileSync as realReadFileSync, writeFileSync as realWriteFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEFAULT_TOPOLOGY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'orchestrator-topology.json');

const TOPOLOGY_PATH_ENV_VAR = 'AURIGA_ORCHESTRATOR_TOPOLOGY_PATH';

const EMPTY_TOPOLOGY = Object.freeze({ parent: null, children: [] });

/**
 * @param {(path: string, encoding: string) => string} readFileSync
 * @param {string} [path]
 * @returns {{ parent: {id: string, notes?: string}|null, children: {id: string, notes?: string}[] }}
 */
export function readTopologyFile(readFileSync, path = DEFAULT_TOPOLOGY_PATH) {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

/**
 * @param {(path: string, data: string, encoding: string) => void} writeFileSync
 * @param {{ parent: object|null, children: object[] }} data
 * @param {string} [path]
 */
export function writeTopologyFile(writeFileSync, data, path = DEFAULT_TOPOLOGY_PATH) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Real-filesystem readTopologyFile, honoring AURIGA_ORCHESTRATOR_TOPOLOGY_PATH. */
export function readRealTopologyFile() {
  const path = process.env[TOPOLOGY_PATH_ENV_VAR] || DEFAULT_TOPOLOGY_PATH;
  return readTopologyFile(realReadFileSync, path);
}

/** Real-filesystem writeTopologyFile, honoring AURIGA_ORCHESTRATOR_TOPOLOGY_PATH. */
export function writeRealTopologyFile(data) {
  const path = process.env[TOPOLOGY_PATH_ENV_VAR] || DEFAULT_TOPOLOGY_PATH;
  writeTopologyFile(realWriteFileSync, data, path);
}

/**
 * Graceful-degrade read for CLI display paths (`orchestrator list`): a
 * missing or malformed file must never crash the CLI — returns
 * EMPTY_TOPOLOGY and logs a stderr warning instead, same convention as
 * project-registry.mjs's loadRealRegistryConfig.
 * @returns {{ parent: object|null, children: object[] }}
 */
export function loadRealTopology() {
  try {
    return readRealTopologyFile();
  } catch (e) {
    process.stderr.write(`loadRealTopology: ${e.message} — degrading to empty topology\n`);
    return { ...EMPTY_TOPOLOGY };
  }
}

/**
 * Sets (or replaces) this instance's parent. Pure function — returns a new
 * data object, does not mutate `data`. `baseUrl`/`projectId` (t015) are
 * OPTIONAL cross-board reachability fields — set them when the operator
 * wants this topology entry itself to carry connection info for the
 * hand-up write; omit them when reachability instead comes from
 * AURIGA_CONFIG's `parentBoard` block (see resolveParentBoardConfig below,
 * which prefers that block when present).
 * @param {{ parent: object|null, children: object[] }} data
 * @param {{ id: string, notes?: string, baseUrl?: string, projectId?: string }} parent
 */
export function setParent(data, parent) {
  const entry = { id: parent.id, notes: parent.notes || '' };
  if (parent.baseUrl) entry.baseUrl = parent.baseUrl;
  if (parent.projectId) entry.projectId = parent.projectId;
  return { ...data, parent: entry };
}

/**
 * Clears this instance's parent (it becomes a root node).
 * @param {{ parent: object|null, children: object[] }} data
 */
export function clearParent(data) {
  return { ...data, parent: null };
}

/**
 * Adds a child, or updates its notes/reachability if already present
 * (idempotent by id — same upsert convention as project-registry.mjs's
 * upsertProject). `baseUrl`/`projectId` (t015) are the same optional
 * cross-board reachability fields setParent accepts — see that function's
 * doc comment.
 * @param {{ parent: object|null, children: object[] }} data
 * @param {{ id: string, notes?: string, baseUrl?: string, projectId?: string }} child
 */
export function addChild(data, child) {
  const children = [...(data.children || [])];
  const idx = children.findIndex((c) => c && c.id === child.id);
  const existing = idx !== -1 ? children[idx] : null;
  const entry = { id: child.id, notes: child.notes || (existing && existing.notes) || '' };
  const baseUrl = child.baseUrl || (existing && existing.baseUrl);
  const projectId = child.projectId || (existing && existing.projectId);
  if (baseUrl) entry.baseUrl = baseUrl;
  if (projectId) entry.projectId = projectId;
  if (idx === -1) children.push(entry);
  else children[idx] = entry;
  return { ...data, children };
}

/**
 * Removes a child by id.
 * @param {{ parent: object|null, children: object[] }} data
 * @param {string} id
 * @returns {{ removed: boolean, data: object }}
 */
export function removeChild(data, id) {
  const children = data.children || [];
  const idx = children.findIndex((c) => c && c.id === id);
  if (idx === -1) return { removed: false, data };
  const next = [...children.slice(0, idx), ...children.slice(idx + 1)];
  return { removed: true, data: { ...data, children: next } };
}

/**
 * Resolves the effective cross-board reachability config for THIS
 * instance's parent (t015) — the thing hand-up needs to actually
 * instantiate a real adapter pointed at the parent's board. Pure function,
 * no I/O of its own (both inputs are already-loaded data):
 *
 *   1. `externalConfig.parentBoard` wins when it supplies BOTH `baseUrl`
 *      and `projectId` — this is AURIGA_CONFIG's per-tenant override file
 *      (see lib/config-loader.mjs), letting an operator manage parent
 *      reachability alongside every other per-tenant setting (CAPS,
 *      PROJECT_LANE, ...) rather than hand-editing topology.json per
 *      instance.
 *   2. Else, `topology.parent`'s OWN `baseUrl`/`projectId` fields (set via
 *      setParent) are used when both are present.
 *   3. Else `null` — no real destination is configured. Per the operator's
 *      own framing, this is NOT an error case for the caller to guess
 *      around: a hand-up candidate with no resolvable parent board falls
 *      through to the existing human-todo path unchanged.
 *
 * @param {{ parent: {id: string, notes?: string, baseUrl?: string, projectId?: string}|null }} topology
 * @param {{ parentBoard?: { baseUrl?: string, projectId?: string } }} [externalConfig]
 * @returns {{ baseUrl: string, projectId: string } | null}
 */
export function resolveParentBoardConfig(topology, externalConfig = {}) {
  const fromConfig = externalConfig && externalConfig.parentBoard;
  if (fromConfig && fromConfig.baseUrl && fromConfig.projectId) {
    return { baseUrl: fromConfig.baseUrl, projectId: fromConfig.projectId };
  }
  const parent = topology && topology.parent;
  if (parent && parent.baseUrl && parent.projectId) {
    return { baseUrl: parent.baseUrl, projectId: parent.projectId };
  }
  return null;
}
