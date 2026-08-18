// Tests for lib/read.mjs's pure read functions.
//
// Two kinds of fixtures, per the story's explicit acceptance bar:
//   1. THIS repo's REAL .pHive/ epics (not mocks) — proves the read layer
//      actually parses real epic/story/audit YAML shapes, not synthetic
//      stand-ins that might not match reality.
//   2. A synthetic, on-the-fly malformed-YAML fixture (built with
//      fs.mkdtempSync, cleaned up after) — proves the non-negotiable
//      graceful-degradation acceptance criterion: one bad file must never
//      abort the rest of a listing, and must log to stderr instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listEpics,
  getEpic,
  getStory,
  listActivity,
  DEFAULT_PHIVE_ROOT,
  REPO_ROOT,
} from '../lib/read.mjs';

// ---------------------------------------------------------------------------
// 1. Against this repo's REAL .pHive/ state
// ---------------------------------------------------------------------------

test('listEpics() returns real epics from .pHive/epics/*/epic.yaml', () => {
  const epics = listEpics();
  assert.ok(Array.isArray(epics));
  const ids = epics.map((e) => e.id);
  assert.ok(ids.includes('p2-adapter-interface'), `expected p2-adapter-interface in ${ids}`);
  assert.ok(ids.includes('p3-auriga-ui'), `expected p3-auriga-ui in ${ids}`);

  const p2 = epics.find((e) => e.id === 'p2-adapter-interface');
  assert.equal(p2.title, 'P2: Adapter-Interface Extraction — backlogAdapter + spawnAdapter + pantheon-v2-l2 stub');
  // Every story in p2-adapter-interface is status: done on disk.
  assert.equal(p2.status, 'done');
  assert.equal(p2.story_count, 5);
  assert.equal(p2.docs_path, path.join('.pHive', 'epics', 'p2-adapter-interface', 'docs'));

  const p3 = epics.find((e) => e.id === 'p3-auriga-ui');
  // Every story in p3-auriga-ui is status: pending on disk (this story's own
  // status doesn't flip to done until this epic's own integrate step lands).
  assert.equal(p3.status, 'pending');
  assert.equal(p3.story_count, 4);
});

test('getEpic(id) returns real stories[] and docs for a real epic', () => {
  const epic = getEpic('p2-adapter-interface');
  assert.ok(epic);
  assert.equal(epic.id, 'p2-adapter-interface');
  assert.ok(Array.isArray(epic.stories));
  const backlogStory = epic.stories.find((s) => s.id === 'p2-multica-backlog-adapter');
  assert.ok(backlogStory);
  assert.equal(backlogStory.status, 'done');
  assert.equal(backlogStory.complexity, 'medium');
  assert.deepEqual(backlogStory.depends_on, ['p2-adapter-interfaces-and-stubs']);

  assert.ok(Array.isArray(epic.docs));
  assert.ok(epic.docs.includes('design-discussion.md'), `expected design-discussion.md in ${epic.docs}`);
});

test('getEpic(id) returns null for a nonexistent epic', () => {
  assert.equal(getEpic('does-not-exist-epic'), null);
});

test('getStory(epicId, storyId) returns full real YAML content', () => {
  const story = getStory('p2-adapter-interface', 'p2-multica-backlog-adapter');
  assert.ok(story);
  assert.equal(story.id, 'p2-multica-backlog-adapter');
  assert.equal(story.epic, 'p2-adapter-interface');
  assert.equal(story.status, 'done');
  assert.ok(Array.isArray(story.acceptance_criteria));
  assert.ok(story.acceptance_criteria.length >= 5);
  assert.ok(Array.isArray(story.risks));
  assert.ok(Array.isArray(story.files_to_modify));
});

test('getStory(epicId, storyId) returns null for a nonexistent story', () => {
  assert.equal(getStory('p2-adapter-interface', 'does-not-exist-story'), null);
});

test('listActivity() merges real git log with real post-run audit records, sorted by time', () => {
  const activity = listActivity();
  assert.ok(Array.isArray(activity));
  assert.ok(activity.length > 0);

  const commits = activity.filter((a) => a.type === 'commit');
  const audits = activity.filter((a) => a.type === 'audit');
  assert.ok(commits.length > 0, 'expected at least one real git log commit');
  assert.ok(audits.length > 0, 'expected at least one real post-run audit record');
  assert.ok(audits.some((a) => a.run_id === 'p2-adapter-interface-execute-20260816T161309Z'));

  for (const c of commits) assert.ok(c.hash && c.subject);
  for (const a of audits) assert.ok(a.run_id);

  // sorted by time, most recent first
  for (let i = 1; i < activity.length; i++) {
    assert.ok(activity[i - 1].time >= activity[i].time, 'activity must be sorted by time descending');
  }
});

// ---------------------------------------------------------------------------
// 2. Synthetic malformed-YAML fixture — graceful per-file degradation
// ---------------------------------------------------------------------------

test('graceful degradation: a malformed epic.yaml is skipped, not a crash', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const epicsDir = path.join(tmpRoot, 'epics');
  fs.mkdirSync(path.join(epicsDir, 'valid-epic', 'stories'), { recursive: true });
  fs.mkdirSync(path.join(epicsDir, 'broken-epic'), { recursive: true });

  fs.writeFileSync(
    path.join(epicsDir, 'valid-epic', 'epic.yaml'),
    'name: valid-epic\ntitle: A valid epic\nstories:\n  - id: valid-story\n    title: A valid story\n',
  );
  fs.writeFileSync(
    path.join(epicsDir, 'valid-epic', 'stories', 'valid-story.yaml'),
    'id: valid-story\nepic: valid-epic\ntitle: A valid story\nstatus: pending\n',
  );
  // Malformed: missing the required 'name' field entirely.
  fs.writeFileSync(
    path.join(epicsDir, 'broken-epic', 'epic.yaml'),
    'title: This epic has no name field\n',
  );

  const stderrLines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { stderrLines.push(String(chunk)); return true; };
  let epics;
  try {
    epics = listEpics(tmpRoot);
  } finally {
    process.stderr.write = realWrite;
  }

  assert.equal(epics.length, 1, 'the broken epic must be skipped, not crash the listing');
  assert.equal(epics[0].id, 'valid-epic');
  assert.ok(stderrLines.some((l) => l.includes('broken-epic')), 'expected a stderr log naming the skipped file');
});

test('graceful degradation: a malformed story yaml is skipped within an otherwise valid epic', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const storiesDir = path.join(tmpRoot, 'epics', 'mixed-epic', 'stories');
  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'epics', 'mixed-epic', 'epic.yaml'),
    'name: mixed-epic\ntitle: Mixed epic\n',
  );
  fs.writeFileSync(
    path.join(storiesDir, 'good-story.yaml'),
    'id: good-story\nepic: mixed-epic\ntitle: Good story\nstatus: done\n',
  );
  // Malformed: missing both id and title.
  fs.writeFileSync(path.join(storiesDir, 'bad-story.yaml'), 'status: pending\n');

  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  let epics;
  let epic;
  let missing;
  try {
    epics = listEpics(tmpRoot);
    epic = getEpic('mixed-epic', tmpRoot);
    missing = getStory('mixed-epic', 'bad-story', tmpRoot);
  } finally {
    process.stderr.write = realWrite;
  }

  assert.equal(epics[0].story_count, 2, 'story_count counts files on disk, including the malformed one');
  assert.equal(epics[0].status, 'done', 'rollup must ignore the unreadable story rather than throwing');

  assert.ok(epic);
  assert.equal(epic.stories.length, 1, 'the malformed story must be excluded from stories[]');
  assert.equal(epic.stories[0].id, 'good-story');

  assert.equal(missing, null, 'getStory on a malformed story returns null, never throws');
});

test('listEpics()/listActivity() degrade to [] rather than throwing on a missing root', () => {
  const nonexistentRoot = path.join(os.tmpdir(), 'phive-does-not-exist-' + Date.now());
  assert.deepEqual(listEpics(nonexistentRoot), []);
  // listActivity still returns real git commits even if the audits dir is
  // missing — only the audits half degrades to [].
  const activity = listActivity(nonexistentRoot, REPO_ROOT);
  assert.ok(Array.isArray(activity));
  assert.ok(activity.every((a) => a.type === 'commit'));
});

test('DEFAULT_PHIVE_ROOT resolves to this repo\'s real .pHive directory', () => {
  assert.equal(DEFAULT_PHIVE_ROOT, path.join(REPO_ROOT, '.pHive'));
  assert.ok(fs.existsSync(DEFAULT_PHIVE_ROOT));
});
