import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

// PAN-7150: only <letters>-<digits> slugs are short keys. Epic-tag slugs such as
// p1-* / s1-* resolve by exact `id:` front matter instead, so siblings never
// collapse onto a shared "p1" key.

test('storyKey/slugKey parse classic <letters>-<digits> keys', () => {
  assert.equal(core.storyKey({ title: '[m-02-file-layer-implementation] Implement file layer' }), 'm-02');
  assert.equal(core.storyKey({ title: '[cm-07-something] x' }), 'cm-07');
  assert.equal(core.storyKey({ title: '[htq-01-multica-backend] x' }), 'htq-01');
  assert.equal(core.storyKey({ title: '[flayr-01-project-scaffold] x' }), 'flayr-01');
  assert.equal(core.storyKey({ title: '[jfpm-01-portal-config-schema] x' }), 'jfpm-01');
  assert.equal(core.slugKey('m-01-core-recall-interface'), 'm-01');
  assert.equal(core.slugKey('lct-03-git-safety-analysis'), 'lct-03');
  assert.equal(core.slugKey('v-04-file-integrations'), 'v-04');
});

test('storyKey/slugKey reject <letters><digits> epic-tag slugs (p1-* / s1-*)', () => {
  assert.equal(core.slugKey('p1-state-machine-auto-unblock'), null);
  assert.equal(core.slugKey('p1-triage-dep-reeval'), null);
  assert.equal(core.storyKey({ title: '[p1-state-machine-auto-unblock] x' }), null);
  assert.equal(core.storyKey({ title: '[s1-domain-models-draft] x' }), null);
});

test('slugKey rejects false-prefix collisions (full number captured)', () => {
  // ct-010 must NOT collapse to ct-01; p10/p1 epic tags are not short keys.
  assert.equal(core.slugKey('ct-010-foo'), 'ct-010');
  assert.equal(core.slugKey('ct-01-foo'), 'ct-01');
  assert.notEqual(core.slugKey('ct-010-foo'), core.slugKey('ct-01-foo'));
  assert.equal(core.slugKey('p10-foo'), null);
  assert.equal(core.slugKey('p1-foo'), null);
});

test('a p1-* dependency now RESOLVES against a sibling and blocks when the dep is not done', () => {
  // parent epic with two p1 stories: p1-state-machine (dep) not done, p1-triage depends on it.
  const dep = {
    id: 'A', identifier: 'PAN-A', parent_issue_id: 'EPIC',
    title: '[p1-state-machine-auto-unblock] build it', status: 'todo',
    description: 'id: p1-state-machine-auto-unblock\ndepends_on: []\n',
  };
  const child = {
    id: 'B', identifier: 'PAN-B', parent_issue_id: 'EPIC', status: 'blocked',
    title: '[p1-triage-dep-reeval] depends on state machine',
    description: 'depends_on: [p1-state-machine-auto-unblock]\nsteps:\n',
  };
  // dep NOT done -> child's description deps are NOT satisfied (correctly blocks; no false-unblock)
  assert.equal(core.descDepsSatisfied(child, [dep, child]), false);
  // dep done -> now satisfied
  assert.equal(core.descDepsSatisfied(child, [{ ...dep, status: 'done' }, child]), true);
});

test('detectUnblocks does NOT false-unblock a p1 child whose p1 dep is unbuilt', () => {
  const dep = {
    id: 'A', identifier: 'PAN-A', parent_issue_id: 'EPIC',
    title: '[p1-state-machine-auto-unblock] x', status: 'todo',
    description: 'id: p1-state-machine-auto-unblock\ndepends_on: []\n',
  };
  const child = {
    id: 'B', identifier: 'PAN-B', parent_issue_id: 'EPIC', status: 'blocked',
    title: '[p1-triage-dep-reeval] x',
    description: 'depends_on: [p1-state-machine-auto-unblock]\nsteps:\n',
  };
  const all = [dep, child];
  const statusById = new Map(all.map((i) => [i.id, i.status]));
  const acts = core.detectUnblocks([child], statusById, all);
  assert.equal(acts.length, 0); // stays blocked — the fix
  // once the dep is done, it unblocks
  const acts2 = core.detectUnblocks([child], new Map([['A', 'done'], ['B', 'blocked']]), [{ ...dep, status: 'done' }, child]);
  assert.equal(acts2.length, 1);
});
