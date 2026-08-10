import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

test('descStoryDeps parses the inline array form', () => {
  assert.deepEqual(core.descStoryDeps({ description: 'depends_on: [m-03-vector-layer, m-02-file]' }), ['m-03-vector-layer', 'm-02-file']);
});

test('descStoryDeps parses the YAML block-list form (rsh-03/PAN-5830 case)', () => {
  const desc = 'id: rsh-03\nepic: routing\ndepends_on:\n  - rsh-01-policy-contract\nfiles_to_modify:\n  - file: x\n';
  assert.deepEqual(core.descStoryDeps({ description: desc }), ['rsh-01-policy-contract']);
});

test('descStoryDeps block-list with multiple deps, stops at the next key', () => {
  const desc = 'depends_on:\n  - a-01-foo\n  - b-02-bar\nsteps:\n  - id: research\n';
  assert.deepEqual(core.descStoryDeps({ description: desc }), ['a-01-foo', 'b-02-bar']);
});

test('descStoryDeps drops hive phase tokens in both forms', () => {
  assert.deepEqual(core.descStoryDeps({ description: 'depends_on: [research, implement]' }), []);
  assert.deepEqual(core.descStoryDeps({ description: 'depends_on:\n  - research\n  - test\n' }), []);
});

test('descDepsSatisfied blocks a block-list dep whose sibling is not done', () => {
  const dep = { id: 'A', parent_issue_id: 'E', title: '[rsh-01-policy-contract] x', status: 'blocked' };
  const child = { id: 'B', parent_issue_id: 'E', status: 'blocked', title: '[rsh-03-decision-ledger] x', description: 'depends_on:\n  - rsh-01-policy-contract\n' };
  assert.equal(core.descDepsSatisfied(child, [dep, child]), false);
  assert.equal(core.descDepsSatisfied(child, [{ ...dep, status: 'done' }, child]), true);
});

test('descStoryDeps ignores later phase depends_on (steps block) — real story dep at top wins', () => {
  // The rsh-03/PAN-5830 shape: real block-list dep at top, phase deps in steps below.
  const desc = [
    'id: rsh-03-decision-ledger',
    'depends_on:',
    '  - rsh-01-policy-contract',
    'files_to_modify:',
    '  - file: x.ts',
    'steps:',
    '  - id: research',
    '    depends_on: [research]',
    '  - id: test',
    '    depends_on: [implement]',
  ].join('\n');
  assert.deepEqual(core.descStoryDeps({ description: desc }), ['rsh-01-policy-contract']);
});

test('descStoryDeps ignores later phase depends_on when the top dep is inline', () => {
  const desc = 'depends_on: [m-03-vector-layer]\nsteps:\n  - id: test\n    depends_on: [implement]\n';
  assert.deepEqual(core.descStoryDeps({ description: desc }), ['m-03-vector-layer']);
});
