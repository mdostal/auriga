#!/usr/bin/env node
// The `auriga` CLI — subcommand dispatch for:
//   auriga agent init [--harness claude|codex]
//   auriga agent status [--harness claude|codex]
//   auriga mcp
//   auriga project scan
//   auriga project add <id> [--name "..."] [--notes "..."] [--lane <agent>[,<agent>...]]
//   auriga project remove <id>
//   auriga project list
//
// This file owns ONLY argv parsing + output formatting. It does not
// duplicate any detection/registration logic (that's lib/agent-setup.mjs,
// kept separate so it's independently unit-testable against a mocked
// subprocess layer — see test/agent-setup.test.mjs), does not duplicate any
// MCP server logic (that's lib/mcp/server.mjs's startMcpServer(), invoked
// directly below — see that module's header comment: "the CLI's `mcp`
// subcommand ... does not duplicate any server logic, it just invokes
// this"), and does not duplicate any project-registry logic (that's
// lib/project-registry.mjs's scan/upsert/remove functions, p6-project-cli —
// same split, mirrored precisely).
//
// Note on repo convention: auriga-router.mjs (the existing bin in this
// package) uses flat manual process.argv flag parsing with no subcommand
// concept — not a fit for this file's nested `agent init`/`agent
// status`/`mcp` shape, so this is a fresh, small dispatcher rather than an
// extension of that file's pattern (see p5-agent-cli.yaml's key_files note).

import { execFileSync } from 'node:child_process';
import { agentInit, agentStatus, KNOWN_HARNESSES } from '../lib/agent-setup.mjs';
import { startMcpServer, selectBacklogAdapter } from '../lib/mcp/server.mjs';
import {
  readRealRegistryFile,
  writeRealRegistryFile,
  scanUnregisteredProjects,
  isKnownBoardProject,
  upsertProject,
  removeProject,
} from '../lib/project-registry.mjs';

function usage() {
  return [
    'usage: auriga agent init [--harness claude|codex]',
    '       auriga agent status [--harness claude|codex]',
    '       auriga mcp',
    '       auriga project scan',
    '       auriga project add <id> [--name "..."] [--notes "..."] [--lane <agent>[,<agent>...]]',
    '       auriga project remove <id>',
    '       auriga project list',
  ].join('\n');
}

/**
 * Parses an optional `--harness <name>` flag out of argv. Returns null if
 * absent. Exits the process with an error if present but not one of the
 * known harness names — this is the CLI's own input-validation boundary,
 * agent-setup.mjs's functions are not responsible for validating it.
 * @param {string[]} argv
 * @returns {string|null}
 */
function parseHarnessFlag(argv) {
  const idx = argv.indexOf('--harness');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value || !KNOWN_HARNESSES.includes(value)) {
    process.stderr.write(`error: --harness must be one of: ${KNOWN_HARNESSES.join(', ')}\n`);
    process.exit(1);
  }
  return value;
}

/**
 * Prints a harness-by-harness report line for the given harness names.
 * Shared by both `agent init` and `agent status` output — same shape,
 * different verb in the label.
 * @param {string} label
 * @param {string[]} names
 * @param {{ harnesses: Record<string, boolean>, mcp_registered: Record<string, boolean> }} report
 */
function printReport(label, names, report) {
  process.stdout.write(`${label}\n`);
  for (const name of names) {
    const present = report.harnesses[name];
    if (!present) {
      process.stdout.write(`  ${name}: not found on $PATH\n`);
      continue;
    }
    const registered = report.mcp_registered[name];
    process.stdout.write(`  ${name}: detected, mcp ${registered ? 'registered' : 'not registered'}\n`);
  }
}

// ---- project subcommand family: argv parsing + output formatting ----------
// All real logic (scan/upsert/remove, board validation) lives in
// lib/project-registry.mjs — see this file's header comment. The functions
// below own argv extraction and result formatting only, and take an
// optional `deps` bag so tests can inject an in-memory backlog adapter
// double / registry reader / writer with zero real filesystem or subprocess
// access, exactly mirroring agentInit/agentStatus's injected-execFileSync
// pattern above. Production callers (main(), below) call these with no
// `deps` override, so the real backlog adapter (selectBacklogAdapter(),
// honoring AURIGA_BACKLOG_ADAPTER=stub) and the real registry file
// (readRealRegistryFile/writeRealRegistryFile, honoring
// AURIGA_PROJECTS_REGISTRY_PATH) are used.

/**
 * Generic `--flag value` extractor — returns undefined if the flag is
 * absent, mirroring parseHarnessFlag's shape but for any flag name (project
 * add's --name/--notes/--lane, none of which need harness-style validation).
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string|undefined}
 */
function parseFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

/**
 * `--lane a,b,c` -> ['a','b','c']. Absent flag -> undefined (distinct from
 * an explicit empty list — upsertProject() only overwrites `lane` on update
 * when this is not undefined).
 * @param {string[]} argv
 * @returns {string[]|undefined}
 */
function parseLaneFlag(argv) {
  const value = parseFlagValue(argv, '--lane');
  if (value === undefined) return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolves the backlog adapter for `project scan`/`project add`'s board
 * validation. Delegates to lib/mcp/server.mjs's selectBacklogAdapter() for
 * every real case (same AURIGA_BACKLOG_ADAPTER=stub switch the MCP server
 * already uses). The one addition, scoped entirely to THIS file: when
 * AURIGA_BACKLOG_ADAPTER=stub AND a test-only AURIGA_STUB_PROJECT_IDS
 * (comma-separated ids) is also set, the stub is seeded with those ids
 * instead of createStubBacklogAdapter()'s always-empty default. This is what
 * lets test/project-cli.test.mjs exercise `project add`'s real board-
 * validation path via an actual spawned `auriga` CLI process without ever
 * calling the live Multica CLI (standing rule: no live Multica testing —
 * verify with in-memory fixtures only). Unset in normal operation, so
 * production behavior is identical to calling selectBacklogAdapter() alone.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
function resolveProjectBacklog(env = process.env) {
  if (env.AURIGA_BACKLOG_ADAPTER === 'stub' && env.AURIGA_STUB_PROJECT_IDS) {
    const ids = env.AURIGA_STUB_PROJECT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
    return { listAllProjectIds: () => ids };
  }
  return selectBacklogAdapter(env);
}

/**
 * `auriga project scan` output — read-only, shows unregistered candidates.
 * @param {{id: string, name: string}[]} candidates
 * @returns {string}
 */
function formatScanOutput(candidates) {
  if (!candidates.length) {
    return 'auriga project scan\n  no unregistered projects found\n';
  }
  const lines = ['auriga project scan', `  ${candidates.length} unregistered project(s):`];
  for (const c of candidates) lines.push(`  ${c.id}  ${c.name}`);
  return lines.join('\n') + '\n';
}

/**
 * `auriga project list` output — read-only, every registered project's
 * id/name/notes/lane.
 * @param {{ projects?: object[] }} data
 * @returns {string}
 */
function formatListOutput(data) {
  const projects = (data && data.projects) || [];
  if (!projects.length) {
    return 'auriga project list\n  (empty — no projects registered)\n';
  }
  const lines = ['auriga project list'];
  for (const p of projects) {
    const lane = Array.isArray(p.lane) && p.lane.length ? p.lane.join(',') : '(default)';
    lines.push(`  ${p.id}  ${p.name || p.id}  lane=${lane}  notes="${p.notes || ''}"`);
  }
  return lines.join('\n') + '\n';
}

/**
 * `auriga project scan` — READ-ONLY, never mutates the registry.
 * @param {{ backlog?: object, readRegistry?: () => object }} [deps]
 * @returns {string}
 */
export function runProjectScan(deps = {}) {
  const backlog = deps.backlog || resolveProjectBacklog();
  const readRegistry = deps.readRegistry || readRealRegistryFile;
  const data = readRegistry();
  return formatScanOutput(scanUnregisteredProjects(backlog, data));
}

/**
 * `auriga project add <id> [--name] [--notes] [--lane]` — idempotent:
 * registers a new id, or updates name/notes/lane on an already-registered
 * one. Validates a NEW id against a fresh scan (never validates an update —
 * an already-registered project doesn't need re-proving it's real).
 * @param {string|undefined} id
 * @param {{ name?: string, notes?: string, lane?: string[] }} flags
 * @param {{ backlog?: object, readRegistry?: () => object, writeRegistry?: (data: object) => void }} [deps]
 * @returns {{ ok: boolean, message: string }}
 */
export function runProjectAdd(id, flags, deps = {}) {
  if (!id) return { ok: false, message: 'error: auriga project add requires <id>\n' };
  const backlog = deps.backlog || resolveProjectBacklog();
  const readRegistry = deps.readRegistry || readRealRegistryFile;
  const writeRegistry = deps.writeRegistry || writeRealRegistryFile;

  const data = readRegistry();
  const alreadyRegistered = ((data && data.projects) || []).some((p) => p && p.id === id);
  if (!alreadyRegistered && !isKnownBoardProject(backlog, id)) {
    return {
      ok: false,
      message: `error: '${id}' is not a known project on the board (fresh scan found no match) — check for a typo\n`,
    };
  }

  const updated = upsertProject(data, { id, name: flags.name, notes: flags.notes, lane: flags.lane });
  writeRegistry(updated);
  return { ok: true, message: `${alreadyRegistered ? 'updated' : 'registered'} project ${id}\n` };
}

/**
 * `auriga project remove <id>` — deletes the entry entirely (identity,
 * notes, lane assignment together).
 * @param {string|undefined} id
 * @param {{ readRegistry?: () => object, writeRegistry?: (data: object) => void }} [deps]
 * @returns {{ ok: boolean, message: string }}
 */
export function runProjectRemove(id, deps = {}) {
  if (!id) return { ok: false, message: 'error: auriga project remove requires <id>\n' };
  const readRegistry = deps.readRegistry || readRealRegistryFile;
  const writeRegistry = deps.writeRegistry || writeRealRegistryFile;

  const data = readRegistry();
  const { removed, data: updated } = removeProject(data, id);
  if (!removed) return { ok: false, message: `error: '${id}' is not registered\n` };
  writeRegistry(updated);
  return { ok: true, message: `removed project ${id}\n` };
}

/**
 * `auriga project list` — READ-ONLY, zero side effects.
 * @param {{ readRegistry?: () => object }} [deps]
 * @returns {string}
 */
export function runProjectList(deps = {}) {
  const readRegistry = deps.readRegistry || readRealRegistryFile;
  return formatListOutput(readRegistry());
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, sub] = argv;

  if (cmd === 'mcp') {
    await startMcpServer();
    return;
  }

  if (cmd === 'agent' && sub === 'init') {
    const harness = parseHarnessFlag(argv);
    const report = agentInit(execFileSync, harness ? { only: [harness] } : {});
    printReport('auriga agent init', harness ? [harness] : KNOWN_HARNESSES, report);
    return;
  }

  if (cmd === 'agent' && sub === 'status') {
    const harness = parseHarnessFlag(argv);
    const report = agentStatus(execFileSync);
    printReport('auriga agent status', harness ? [harness] : KNOWN_HARNESSES, report);
    return;
  }

  if (cmd === 'project' && sub === 'scan') {
    process.stdout.write(runProjectScan());
    return;
  }

  if (cmd === 'project' && sub === 'add') {
    const id = argv[2];
    const flags = {
      name: parseFlagValue(argv, '--name'),
      notes: parseFlagValue(argv, '--notes'),
      lane: parseLaneFlag(argv),
    };
    const result = runProjectAdd(id, flags);
    (result.ok ? process.stdout : process.stderr).write(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'project' && sub === 'remove') {
    const id = argv[2];
    const result = runProjectRemove(id);
    (result.ok ? process.stdout : process.stderr).write(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'project' && sub === 'list') {
    process.stdout.write(runProjectList());
    return;
  }

  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exitCode = 1;
});
