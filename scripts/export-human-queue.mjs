#!/usr/bin/env node
// Human queue export — writes the issues that the router's priority-1
// human-todo filter (lib/core.mjs isHumanTodo) excludes from the agent
// dispatch pool to .pHive/human-queue.yaml, so a human can triage them.
//
// Run: node scripts/export-human-queue.mjs
// Env overrides: AURIGA_HUMAN_QUEUE (output path)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cfg from '../src/router/lib/config.mjs';
import * as core from '../src/router/lib/core.mjs';
import * as mca from '../src/router/lib/multica.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.AURIGA_HUMAN_QUEUE || path.join(__dirname, '..', '.pHive', 'human-queue.yaml');

function yamlScalar(value) {
  const s = String(value ?? '');
  return /[:#\-\[\]{}"'\n]|^\s|\s$|^$/.test(s) ? JSON.stringify(s) : s;
}

function toYaml(entries, generatedAt) {
  const lines = [`# generated: ${generatedAt}`, `# source: scripts/export-human-queue.mjs (priority-1 human-todo filter)`];
  if (!entries.length) {
    lines.push('human_todos: []');
    return lines.join('\n') + '\n';
  }
  lines.push('human_todos:');
  for (const e of entries) {
    lines.push(`  - identifier: ${yamlScalar(e.identifier)}`);
    lines.push(`    id: ${yamlScalar(e.id)}`);
    lines.push(`    title: ${yamlScalar(e.title)}`);
    lines.push(`    project: ${yamlScalar(e.project)}`);
    lines.push(`    reason: ${yamlScalar(e.reason)}`);
    lines.push(`    waiting_on: ${yamlScalar(e.waitingOn)}`);
  }
  return lines.join('\n') + '\n';
}

// Candidate pool minus human-todo filter, INTERSECTED with the human-todo
// filter — i.e. exactly what selectAssignments would otherwise exclude.
// Mirrors the router's own scan scope (cfg.PROJECT_IDS) so the queue only
// ever contains issues that would have reached the dispatch pool.
export function buildHumanQueue(issues, cfg_) {
  return issues
    .filter((i) => (i.status || '').toLowerCase() === 'todo')
    .filter((i) => !i.assignee_id)
    .filter((i) => !core.isSmokeScratch(i.title))
    .filter((i) => cfg_.PROJECT_IDS.includes(i.project_id))
    .filter((i) => core.isHumanTodo(i, cfg_))
    .map((i) => ({
      identifier: i.identifier,
      id: i.id,
      title: i.title,
      project: cfg_.PROJECT_NAMES[i.project_id] || i.project_id,
      reason: core.humanTodoReason(i),
      waitingOn: (i.metadata && i.metadata.waiting_on) || '',
    }));
}

function main() {
  const issues = mca.listAllIssues(cfg.PROJECT_IDS);
  const entries = buildHumanQueue(issues, cfg);
  const generatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, toYaml(entries, generatedAt));
  console.log(`[export-human-queue] wrote ${entries.length} human-todo(s) to ${OUT}`);
}

// Only run when invoked directly (`node scripts/export-human-queue.mjs`), not
// when buildHumanQueue is imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
