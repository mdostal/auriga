#!/usr/bin/env node
// The `auriga` CLI — subcommand dispatch for:
//   auriga agent init [--harness claude|codex]
//   auriga agent status [--harness claude|codex]
//   auriga mcp
//
// This file owns ONLY argv parsing + output formatting. It does not
// duplicate any detection/registration logic (that's lib/agent-setup.mjs,
// kept separate so it's independently unit-testable against a mocked
// subprocess layer — see test/agent-setup.test.mjs) and does not duplicate
// any MCP server logic (that's lib/mcp/server.mjs's startMcpServer(),
// invoked directly below — see that module's header comment: "the CLI's
// `mcp` subcommand ... does not duplicate any server logic, it just invokes
// this").
//
// Note on repo convention: auriga-router.mjs (the existing bin in this
// package) uses flat manual process.argv flag parsing with no subcommand
// concept — not a fit for this file's nested `agent init`/`agent
// status`/`mcp` shape, so this is a fresh, small dispatcher rather than an
// extension of that file's pattern (see p5-agent-cli.yaml's key_files note).

import { execFileSync } from 'node:child_process';
import { agentInit, agentStatus, KNOWN_HARNESSES } from '../lib/agent-setup.mjs';
import { startMcpServer } from '../lib/mcp/server.mjs';

function usage() {
  return [
    'usage: auriga agent init [--harness claude|codex]',
    '       auriga agent status [--harness claude|codex]',
    '       auriga mcp',
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

  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exitCode = 1;
});
