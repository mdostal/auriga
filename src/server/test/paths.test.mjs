// Unit tests for lib/paths.mjs's isPathContained() — the shared
// containment guard used by both index.mjs's static file server and
// read.mjs's getEpic/getStory. Covers exactly the gap an independent
// review found in the OLD naive `startsWith(root)` check: a sibling
// directory that merely shares root's name as a string prefix (e.g.
// "dist-evil" vs "dist") must NOT be treated as contained.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathContained } from '../lib/paths.mjs';

test('isPathContained: root itself is contained', () => {
  assert.equal(isPathContained('/a/b/dist', '/a/b/dist'), true);
});

test('isPathContained: a real descendant is contained', () => {
  assert.equal(isPathContained('/a/b/dist/assets/x.js', '/a/b/dist'), true);
  assert.equal(isPathContained(path.join('/a/b/dist', 'index.html'), '/a/b/dist'), true);
});

test('isPathContained: a sibling directory sharing the root name as a string prefix is NOT contained', () => {
  // This is the exact bug: "/a/b/dist-evil/secret" naive-startsWith-passes
  // against root "/a/b/dist" because the STRING "/a/b/dist-evil/secret"
  // starts with the STRING "/a/b/dist" — but it is a completely different
  // directory, not a descendant.
  assert.equal(isPathContained('/a/b/dist-evil/secret.txt', '/a/b/dist'), false);
  assert.equal(isPathContained('/a/b/distant-file.txt', '/a/b/dist'), false);
});

test('isPathContained: a plain sibling is NOT contained', () => {
  assert.equal(isPathContained('/a/b/other', '/a/b/dist'), false);
});

test('isPathContained: ".." escapes are resolved before comparing, and rejected', () => {
  assert.equal(isPathContained('/a/b/dist/../../etc/passwd', '/a/b/dist'), false);
  assert.equal(isPathContained(path.join('/a/b/dist', '..', '..', 'etc'), '/a/b/dist'), false);
});

test('isPathContained: relative candidates/roots are resolved against cwd before comparing', () => {
  const root = path.resolve('.');
  assert.equal(isPathContained('.', root), true);
  assert.equal(isPathContained('..', root), false);
});
