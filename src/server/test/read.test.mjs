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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listEpics,
  getEpic,
  getStory,
  listActivity,
  DEFAULT_PHIVE_ROOT,
  REPO_ROOT,
} from '../lib/read.mjs';

const READ_MJS_PATH = fileURLToPath(new URL('../lib/read.mjs', import.meta.url));

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
  // Every story in p2-adapter-interface is status: shipped on disk (the
  // v0.1.0 release's story-status reconciliation moved every p1-p6 story
  // from done/complete to shipped) — the epic-level rollup treats shipped
  // as terminal too (see read.mjs's TERMINAL_STORY_STATUSES), so the epic
  // itself still reports 'done'.
  assert.equal(p2.status, 'done');
  assert.equal(p2.story_count, 5);
  assert.equal(p2.docs_path, path.join('.pHive', 'epics', 'p2-adapter-interface', 'docs'));

  const p3 = epics.find((e) => e.id === 'p3-auriga-ui');
  // Every story in p3-auriga-ui is status: shipped on disk (same v0.1.0
  // reconciliation as p2 above).
  assert.equal(p3.status, 'done');
  assert.equal(p3.story_count, 4);
});

test('getEpic(id) returns real stories[] and docs for a real epic', () => {
  const epic = getEpic('p2-adapter-interface');
  assert.ok(epic);
  assert.equal(epic.id, 'p2-adapter-interface');
  assert.ok(Array.isArray(epic.stories));
  const backlogStory = epic.stories.find((s) => s.id === 'p2-multica-backlog-adapter');
  assert.ok(backlogStory);
  assert.equal(backlogStory.status, 'shipped');
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
  assert.equal(story.status, 'shipped');
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

test('graceful degradation: genuinely invalid YAML syntax (not just a missing field) is skipped, not a crash', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const epicsDir = path.join(tmpRoot, 'epics');
  fs.mkdirSync(path.join(epicsDir, 'valid-epic', 'stories'), { recursive: true });
  fs.mkdirSync(path.join(epicsDir, 'syntax-broken-epic'), { recursive: true });

  fs.writeFileSync(
    path.join(epicsDir, 'valid-epic', 'epic.yaml'),
    'name: valid-epic\ntitle: A valid epic\n',
  );
  // Genuinely invalid YAML syntax (unclosed flow sequence) — this must
  // throw a real yaml.YAMLParseError from the underlying `yaml` package,
  // not just fail this module's own required-field check. Proves the
  // real library's parse errors are caught per-file exactly like the old
  // hand-rolled parser's errors were.
  fs.writeFileSync(
    path.join(epicsDir, 'syntax-broken-epic', 'epic.yaml'),
    'name: syntax-broken-epic\ntitle: [unclosed flow seq\n',
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

  assert.equal(epics.length, 1, 'the syntactically-broken epic must be skipped, not crash the listing');
  assert.equal(epics[0].id, 'valid-epic');
  assert.ok(
    stderrLines.some((l) => l.includes('syntax-broken-epic')),
    'expected a stderr log naming the skipped file',
  );
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

test('getEpic() returns an empty stories[] array for an epic with zero story files, not a throw/undefined', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const epicDir = path.join(tmpRoot, 'epics', 'zero-story-epic');
  // No stories/ dir at all — the freshest-possible "no stories yet" shape.
  fs.mkdirSync(epicDir, { recursive: true });
  fs.writeFileSync(
    path.join(epicDir, 'epic.yaml'),
    'name: zero-story-epic\ntitle: Zero Story Epic\n',
  );

  const epic = getEpic('zero-story-epic', tmpRoot);
  assert.ok(epic);
  assert.deepEqual(epic.stories, [], 'zero-story epic must yield [], never undefined/throw');
});

test('listEpics() derives "planning" status for a zero-story epic (deriveEpicStatus([]))', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const epicDir = path.join(tmpRoot, 'epics', 'zero-story-epic');
  fs.mkdirSync(path.join(epicDir, 'stories'), { recursive: true }); // present but empty
  fs.writeFileSync(
    path.join(epicDir, 'epic.yaml'),
    'name: zero-story-epic\ntitle: Zero Story Epic\n',
  );

  const epics = listEpics(tmpRoot);
  assert.equal(epics.length, 1);
  assert.equal(epics[0].story_count, 0);
  assert.equal(epics[0].status, 'planning');
});

test('listEpics() derives "done" for an epic whose stories are all status: shipped (not done) — TERMINAL_STORY_STATUSES regression', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const epicDir = path.join(tmpRoot, 'epics', 'shipped-epic');
  const storiesDir = path.join(epicDir, 'stories');
  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(path.join(epicDir, 'epic.yaml'), 'name: shipped-epic\ntitle: Shipped Epic\n');
  fs.writeFileSync(path.join(storiesDir, 's1.yaml'), 'id: s1\ntitle: Story 1\nstatus: shipped\n');
  fs.writeFileSync(path.join(storiesDir, 's2.yaml'), 'id: s2\ntitle: Story 2\nstatus: shipped\n');

  const epics = listEpics(tmpRoot);
  const epic = epics.find((e) => e.id === 'shipped-epic');
  assert.ok(epic);
  assert.equal(epic.status, 'done', 'a fully-shipped epic must roll up to done, not in-progress');
});

test('listEpics() derives "in-progress" for a mix of shipped and pending stories (mixed-terminal regression)', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const epicDir = path.join(tmpRoot, 'epics', 'mixed-epic');
  const storiesDir = path.join(epicDir, 'stories');
  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(path.join(epicDir, 'epic.yaml'), 'name: mixed-epic\ntitle: Mixed Epic\n');
  fs.writeFileSync(path.join(storiesDir, 's1.yaml'), 'id: s1\ntitle: Story 1\nstatus: shipped\n');
  fs.writeFileSync(path.join(storiesDir, 's2.yaml'), 'id: s2\ntitle: Story 2\nstatus: pending\n');

  const epics = listEpics(tmpRoot);
  const epic = epics.find((e) => e.id === 'mixed-epic');
  assert.ok(epic);
  assert.equal(epic.status, 'in-progress');
});

test('getStory() returns a story object with no cross_cutting key when the YAML omits it — never throws, never fabricates a value', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const storiesDir = path.join(tmpRoot, 'epics', 'minimal-epic', 'stories');
  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'epics', 'minimal-epic', 'epic.yaml'),
    'name: minimal-epic\ntitle: Minimal Epic\n',
  );
  // Deliberately minimal: only the required id/title/status fields — no
  // cross_cutting, no risks, no references, no acceptance_criteria.
  fs.writeFileSync(
    path.join(storiesDir, 'minimal-story.yaml'),
    'id: minimal-story\nepic: minimal-epic\ntitle: A minimal story\nstatus: pending\n',
  );

  const story = getStory('minimal-epic', 'minimal-story', tmpRoot);
  assert.ok(story);
  assert.equal(story.id, 'minimal-story');
  assert.equal('cross_cutting' in story, false, 'omitted optional field must stay absent, not become undefined-on-purpose or null');
  assert.equal(story.risks, undefined);
  assert.equal(story.acceptance_criteria, undefined);
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

// ---------------------------------------------------------------------------
// Path traversal (bug #2): id/storyId are joined straight into filesystem
// paths. Each test plants a real "secret" file OUTSIDE the intended root but
// reachable via a computed relative-traversal id, and asserts the read layer
// never reaches it — proving real containment, not just "the crafted id
// happened not to resolve to an existing file".
// ---------------------------------------------------------------------------

test('getEpic(): a traversal-shaped id is rejected and never escapes the epics root', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const epicsDir = path.join(tmpRoot, 'epics');
  fs.mkdirSync(epicsDir, { recursive: true });

  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-secret-'));
  t.after(() => fs.rmSync(secretDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(secretDir, 'epic.yaml'),
    'name: secret-epic\ntitle: Should never be reachable via traversal\n',
  );

  // A real relative path from epicsDir to secretDir — exactly the shape a
  // "../../../..."-style traversal id would need to resolve to it.
  const traversalId = path.relative(epicsDir, secretDir);

  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  let result;
  try {
    result = getEpic(traversalId, tmpRoot);
  } finally {
    process.stderr.write = realWrite;
  }

  assert.equal(result, null, 'a traversal-shaped id must be rejected, never read the secret file outside epics/');
});

test('getStory(): a traversal-shaped storyId is rejected and never escapes the stories dir', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const epicDir = path.join(tmpRoot, 'epics', 'traversal-epic');
  const storiesDir = path.join(epicDir, 'stories');
  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(path.join(epicDir, 'epic.yaml'), 'name: traversal-epic\ntitle: Traversal Epic\n');

  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-secret-'));
  t.after(() => fs.rmSync(secretDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(secretDir, 'secret.yaml'),
    'id: secret\nepic: none\ntitle: Should never be reachable via traversal\nstatus: pending\n',
  );

  // storyId is joined as `${storyId}.yaml`, so compute a relative traversal
  // path with the .yaml extension already stripped off the target filename.
  const traversalStoryId = path.join(path.relative(storiesDir, secretDir), 'secret');

  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  let result;
  try {
    result = getStory('traversal-epic', traversalStoryId, tmpRoot);
  } finally {
    process.stderr.write = realWrite;
  }

  assert.equal(result, null, 'a traversal-shaped storyId must be rejected, never read the secret file');
});

test('getStory(): a traversal-shaped epicId is rejected before ever touching a stories dir', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const epicsDir = path.join(tmpRoot, 'epics');
  fs.mkdirSync(epicsDir, { recursive: true });

  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-secret-'));
  t.after(() => fs.rmSync(secretDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(secretDir, 'stories'), { recursive: true });
  fs.writeFileSync(
    path.join(secretDir, 'stories', 'secret.yaml'),
    'id: secret\nepic: none\ntitle: Should never be reachable via traversal\nstatus: pending\n',
  );

  const traversalEpicId = path.relative(epicsDir, secretDir);

  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  let result;
  try {
    result = getStory(traversalEpicId, 'secret', tmpRoot);
  } finally {
    process.stderr.write = realWrite;
  }

  assert.equal(result, null, 'a traversal-shaped epicId must be rejected, never read the secret story file');
});

// ---------------------------------------------------------------------------
// Bug #6: empty-string required fields must be distinguished from genuinely
// absent (undefined/null) ones in the error/log message — both are still
// rejected the same way, but the message must not lie about which happened.
// ---------------------------------------------------------------------------

test('readEpicYaml (via listEpics): an empty (present but blank) name logs "empty", not "missing"', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const epicsDir = path.join(tmpRoot, 'epics');
  fs.mkdirSync(path.join(epicsDir, 'empty-name-epic'), { recursive: true });
  fs.writeFileSync(
    path.join(epicsDir, 'empty-name-epic', 'epic.yaml'),
    'name: ""\ntitle: Has an empty name field, not an absent one\n',
  );

  const stderrLines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  let epics;
  try {
    epics = listEpics(tmpRoot);
  } finally {
    process.stderr.write = realWrite;
  }

  assert.equal(epics.length, 0, 'an empty name is still rejected, same as before');
  assert.ok(
    stderrLines.some((l) => l.includes('empty') && !l.includes('missing')),
    `expected an "empty" (not "missing") message, got: ${stderrLines.join('')}`,
  );
});

test('readEpicYaml (via listEpics): a genuinely absent name still logs "missing"', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const epicsDir = path.join(tmpRoot, 'epics');
  fs.mkdirSync(path.join(epicsDir, 'no-name-epic'), { recursive: true });
  fs.writeFileSync(path.join(epicsDir, 'no-name-epic', 'epic.yaml'), 'title: Has no name field at all\n');

  const stderrLines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  let epics;
  try {
    epics = listEpics(tmpRoot);
  } finally {
    process.stderr.write = realWrite;
  }

  assert.equal(epics.length, 0);
  assert.ok(stderrLines.some((l) => l.includes('missing')), `expected a "missing" message, got: ${stderrLines.join('')}`);
});

test('readStoryYaml (via getStory): an empty (present but blank) title logs "empty", not "missing"', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const storiesDir = path.join(tmpRoot, 'epics', 'e', 'stories');
  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'epics', 'e', 'epic.yaml'), 'name: e\ntitle: E\n');
  fs.writeFileSync(path.join(storiesDir, 'empty-title.yaml'), 'id: empty-title\ntitle: ""\nstatus: pending\n');

  const stderrLines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  let result;
  try {
    result = getStory('e', 'empty-title', tmpRoot);
  } finally {
    process.stderr.write = realWrite;
  }

  assert.equal(result, null, 'an empty title is still rejected, same as before');
  assert.ok(
    stderrLines.some((l) => l.includes('empty') && l.includes('title') && !l.includes('missing')),
    `expected an "empty"+"title" (not "missing") message, got: ${stderrLines.join('')}`,
  );
});

test('DEFAULT_PHIVE_ROOT resolves to this repo\'s real .pHive directory', () => {
  assert.equal(DEFAULT_PHIVE_ROOT, path.join(REPO_ROOT, '.pHive'));
  assert.ok(fs.existsSync(DEFAULT_PHIVE_ROOT));
});

test('DEFAULT_PHIVE_ROOT honors AURIGA_PHIVE_ROOT when set — a fresh process, since it\'s read once at module load', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phive-read-test-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const out = execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(READ_MJS_PATH)}).then((m) => { process.stdout.write(m.DEFAULT_PHIVE_ROOT); });`],
    { env: { ...process.env, AURIGA_PHIVE_ROOT: tmpRoot }, encoding: 'utf8' },
  );
  assert.equal(out, path.resolve(tmpRoot));
});
