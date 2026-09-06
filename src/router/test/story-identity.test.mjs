// Tests for lib/story-identity.mjs (t011 decomposition) — the module's own
// direct contract test (core.test.mjs already covers these functions
// extensively via core.mjs's re-export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyKey, slugKey, descStoryDeps, descStoryId } from '../lib/story-identity.mjs';

test('storyKey: extracts a leading "[key-NN]" bracket from a title', () => {
  assert.equal(storyKey({ title: '[m-02-file-layer-implementation] Do the thing' }), 'm-02');
  assert.equal(storyKey({ title: 'No bracket here' }), null);
});

test('storyKey: a longer number never collapses to a shorter one (ct-010 != ct-01)', () => {
  assert.equal(storyKey({ title: '[ct-010-foo] thing' }), 'ct-010');
  assert.notEqual(storyKey({ title: '[ct-010-foo] thing' }), 'ct-01');
});

test('slugKey: extracts the short key from a dependency slug', () => {
  assert.equal(slugKey('m-01-core-recall-interface'), 'm-01');
  assert.equal(slugKey('cm-07-e2e-integration'), 'cm-07');
});

test('slugKey: an epic-tag slug (letter+digit prefix, e.g. p1-...) is NOT treated as a short key', () => {
  assert.equal(slugKey('p1-router-capability-routing'), null);
});

test('descStoryDeps: parses an inline array form, drops hive phase tokens', () => {
  const deps = descStoryDeps({ description: 'depends_on: [a-01-foo, research, b-02-bar]' });
  assert.deepEqual(deps, ['a-01-foo', 'b-02-bar']);
});

test('descStoryDeps: parses a YAML block-list form', () => {
  const deps = descStoryDeps({ description: 'depends_on:\n  - a-01-foo\n  - b-02-bar\n' });
  assert.deepEqual(deps, ['a-01-foo', 'b-02-bar']);
});

test('descStoryDeps: the FIRST depends_on wins, not a later per-phase one inside steps:', () => {
  const desc = 'depends_on: [a-01-foo]\nsteps:\n  - id: implement\n    depends_on: [research]\n';
  assert.deepEqual(descStoryDeps({ description: desc }), ['a-01-foo']);
});

test('descStoryDeps: no depends_on line at all returns []', () => {
  assert.deepEqual(descStoryDeps({ description: 'no deps here' }), []);
  assert.deepEqual(descStoryDeps({}), []);
});

test('descStoryId: reads the YAML front-matter id: line', () => {
  assert.equal(descStoryId({ description: 'id: p1-router-capability-routing\ntitle: x' }), 'p1-router-capability-routing');
  assert.equal(descStoryId({ description: 'no id line' }), null);
});
