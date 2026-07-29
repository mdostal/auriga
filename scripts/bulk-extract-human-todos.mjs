#!/usr/bin/env node
// Bulk human-todo extraction (p1-triage-human-queue) — a workspace-WIDE sweep
// (not scoped to the router's 3 "aligned" cfg.PROJECT_IDS projects) that finds
// every issue a human — not an agent — must complete, and reports them so a
// human can triage before anything is mutated.
//
// Why "broad" detection: lib/core.mjs's isHumanTodo (label `human-todo` or
// `waiting_on: <human>`) is the router's PRIORITY-1 dispatch filter and its
// contract is depended on elsewhere — we do not touch it. But the concrete
// motivating example for this story, PAN-6644 ("HUMAN TODO (Mathew): ..."),
// has neither a label nor waiting_on metadata set — it is only identifiable
// by its title. isHumanTodoBroad below layers a title check on top of
// core.isHumanTodo without changing core.mjs's existing behavior/signature.
//
// Default mode is report-only / dry-run: it NEVER mutates an issue. Per the
// story's own risk mitigation ("Broad query + manual review before run"), a
// human should review .pHive/human-todo-extraction-report.yaml before any
// label is applied. Pass --apply (or set AURIGA_HUMAN_QUEUE_APPLY=1) to
// opt in to applying the `human-todo` label to eligible entries.
//
// Run (report-only):  node scripts/bulk-extract-human-todos.mjs
// Run (apply labels):  node scripts/bulk-extract-human-todos.mjs --apply
// Env overrides: AURIGA_HUMAN_TODO_REPORT (output path), AURIGA_HUMAN_QUEUE_APPLY=1

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cfg from '../src/router/lib/config.mjs';
import * as core from '../src/router/lib/core.mjs';
import * as mca from '../src/router/lib/multica.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.AURIGA_HUMAN_TODO_REPORT || path.join(__dirname, '..', '.pHive', 'human-todo-extraction-report.yaml');
const APPLY = process.argv.includes('--apply') || process.env.AURIGA_HUMAN_QUEUE_APPLY === '1';

const HUMAN_TODO_LABEL = 'human-todo';

// Titles like "HUMAN TODO (Mathew): ..." / "human-todo: ..." — the real-world
// gap core.isHumanTodo misses (see PAN-6644). Anchored to the start of the
// title (allowing leading whitespace) so it doesn't false-positive on titles
// that merely mention "human todo" mid-sentence.
const TITLE_HUMAN_TODO_RE = /^\s*human[\s-]?todo\b/i;

// core.isHumanTodo (label/waiting_on) OR a title starting with "HUMAN TODO".
// Deliberately kept OUT of lib/core.mjs: core.isHumanTodo's signature/behavior
// is depended on by the live router (selectAssignments) and export-human-queue.mjs;
// this is a strictly-broader, script-local superset for a one-off triage sweep.
export function isHumanTodoBroad(issue, cfg_) {
  if (core.isHumanTodo(issue, cfg_)) return true;
  return TITLE_HUMAN_TODO_RE.test(issue.title || '');
}

// 'label' | 'waiting_on' | 'title'. Delegates to core.humanTodoReason for the
// first two cases so the reasoning stays in one place.
export function humanTodoReasonBroad(issue, cfg_) {
  if (core.isHumanTodo(issue, cfg_)) return core.humanTodoReason(issue);
  return 'title';
}

function isAlreadyLabeled(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l?.name || '').toLowerCase());
  return labels.includes(HUMAN_TODO_LABEL);
}

// Pure, unit-testable core: workspace-wide human-todo sweep -> report shape.
// issues: every issue on the board (no status pre-filter — a status filter is
// applied only when *bucketing*, not when scanning, so already-blocked
// human-todos are still surfaced for visibility).
export function buildExtractionReport(issues, cfg_) {
  const entries = issues
    .filter((i) => !core.isSmokeScratch(i.title))
    .filter((i) => isHumanTodoBroad(i, cfg_))
    .map((i) => {
      const status = (i.status || '').toLowerCase();
      const reason = humanTodoReasonBroad(i, cfg_);
      const alreadyLabeled = isAlreadyLabeled(i);
      return {
        identifier: i.identifier,
        id: i.id,
        title: i.title,
        project: (cfg_.PROJECT_NAMES && cfg_.PROJECT_NAMES[i.project_id]) || i.project_id,
        status: i.status,
        assignee_id: i.assignee_id || null,
        reason,
        // Only entries actually sitting in an agent-dispatchable state right
        // now, not yet labeled, are candidates for --apply's label mutation.
        applyEligible: status === 'todo' && reason !== undefined && !alreadyLabeled,
      };
    });

  const already_excluded_count = entries.filter((e) => {
    const st = (e.status || '').toLowerCase();
    return st === 'blocked' || st === 'cancelled' || st === 'canceled';
  }).length;

  const needs_attention_count = entries.filter((e) => {
    const st = (e.status || '').toLowerCase();
    return st === 'todo' || st === 'in_progress';
  }).length;

  return { entries, already_excluded_count, needs_attention_count };
}

function yamlScalar(value) {
  const s = String(value ?? '');
  return /[:#\-\[\]{}"'\n]|^\s|\s$|^$/.test(s) ? JSON.stringify(s) : s;
}

function toYaml(report, generatedAt) {
  const { entries, already_excluded_count, needs_attention_count } = report;
  const lines = [
    `# generated: ${generatedAt}`,
    `# source: scripts/bulk-extract-human-todos.mjs (broad label+waiting_on+title workspace sweep)`,
    `already_excluded_count: ${already_excluded_count}`,
    `needs_attention_count: ${needs_attention_count}`,
  ];
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
    lines.push(`    status: ${yamlScalar(e.status)}`);
    lines.push(`    assignee_id: ${yamlScalar(e.assignee_id)}`);
    lines.push(`    reason: ${yamlScalar(e.reason)}`);
    lines.push(`    applyEligible: ${e.applyEligible}`);
  }
  return lines.join('\n') + '\n';
}

function main() {
  const issues = mca.listAllWorkspaceIssues();
  const report = buildExtractionReport(issues, cfg);
  const generatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, toYaml(report, generatedAt));
  console.log(
    `[bulk-extract-human-todos] found ${report.entries.length} human-todo(s) across the workspace — ` +
      `${report.already_excluded_count} already excluded (blocked/cancelled), ` +
      `${report.needs_attention_count} still exposed to dispatch (todo/in_progress). Report: ${OUT}`
  );

  if (!APPLY) return;

  for (const e of report.entries) {
    if (!e.applyEligible) continue;
    mca.attachHumanTodoLabel(e.identifier);
    console.log(`[bulk-extract-human-todos] applied human-todo label to ${e.identifier}`);
  }
}

// Only run when invoked directly (`node scripts/bulk-extract-human-todos.mjs`),
// not when buildExtractionReport/isHumanTodoBroad are imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
