import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

const story = ({
  id,
  slug,
  status = 'todo',
  parent = 'EPIC',
  deps = [],
  titleSlug = slug,
}) => ({
  id,
  identifier: id,
  parent_issue_id: parent,
  status,
  title: `[${titleSlug}] ${slug}`,
  description: [
    `id: ${slug}`,
    `depends_on: [${deps.join(', ')}]`,
    'steps:',
    '  - id: test',
    '    depends_on: [implement]',
  ].join('\n'),
});

test('descDepsSatisfied blocks a p1 exact-id dependency that is not done', () => {
  const dep = {
    id: 'PAN-A',
    identifier: 'PAN-A',
    parent_issue_id: 'EPIC',
    status: 'todo',
    title: '[p1-state-machine-auto-unblock] State machine auto unblock',
  };
  const child = story({
    id: 'PAN-B',
    slug: 'p1-router-followup',
    status: 'blocked',
    deps: ['p1-state-machine-auto-unblock'],
  });

  assert.equal(core.descDepsSatisfied(child, [dep, child]), false);
});

test('descDepsSatisfied allows a p1 exact-id dependency once it is done', () => {
  const dep = {
    id: 'PAN-A',
    identifier: 'PAN-A',
    parent_issue_id: 'EPIC',
    status: 'done',
    title: '[p1-state-machine-auto-unblock] State machine auto unblock',
  };
  const child = story({
    id: 'PAN-B',
    slug: 'p1-router-followup',
    status: 'blocked',
    deps: ['p1-state-machine-auto-unblock'],
  });

  assert.equal(core.descDepsSatisfied(child, [dep, child]), true);
});

test('descDepsSatisfied resolves mixed short-key and p1 exact-id dependencies', () => {
  const shortDep = story({
    id: 'PAN-A',
    slug: 'm-02-file-layer-implementation',
    status: 'done',
    titleSlug: 'm-02-file-layer-implementation',
  });
  const p1Dep = story({ id: 'PAN-B', slug: 'p1-state-machine-auto-unblock', status: 'todo' });
  const child = story({
    id: 'PAN-C',
    slug: 'cm-07-consumer',
    status: 'blocked',
    deps: ['m-02-file-layer-implementation', 'p1-state-machine-auto-unblock'],
  });

  assert.equal(core.descDepsSatisfied(child, [shortDep, p1Dep, child]), false);
  assert.equal(core.descDepsSatisfied(child, [shortDep, { ...p1Dep, status: 'done' }, child]), true);
});
