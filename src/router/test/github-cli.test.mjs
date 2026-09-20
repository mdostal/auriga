// Tests for lib/adapters/github-cli.mjs -- the shared gh-CLI helper
// primitives factored out of multica/backlog.mjs and pantheon-v2-l2/index.mjs
// (t008 dedupe). Exercises the pure factory functions directly against a
// fake execFn/ghRun, not against a real adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeGhRun,
  makeGhListRepos,
  makeGhPrs,
  gatherReviewRepos,
  makeListCandidatePullRequests,
} from '../lib/adapters/github-cli.mjs';

test('makeGhRun: passes args/env/timeout through and JSON-parses stdout', () => {
  const calls = [];
  const execFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return JSON.stringify([{ ok: true }]);
  };
  const ghRun = makeGhRun(execFn, 'gh-test');
  const result = ghRun(['pr', 'list']);

  assert.deepEqual(result, [{ ok: true }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh-test');
  assert.deepEqual(calls[0].args, ['pr', 'list']);
  assert.equal(calls[0].opts.timeout, 15000, 'GH #70/PANT-24: every call must carry the shared 15s timeout');
  assert.deepEqual(calls[0].opts.env, process.env, 'default env thunk returns process.env unchanged');
});

test('makeGhRun: an injected env thunk overrides the default (e.g. cleanEnv-style scrubbing)', () => {
  const scrubbed = { PATH: process.env.PATH };
  const execFn = (cmd, args, opts) => {
    assert.equal(opts.env, scrubbed);
    return '[]';
  };
  const ghRun = makeGhRun(execFn, 'gh-test', { env: () => scrubbed });
  ghRun(['pr', 'list']);
});

test('makeGhRun: empty stdout resolves to [] rather than a JSON.parse crash', () => {
  const ghRun = makeGhRun(() => '', 'gh-test');
  assert.deepEqual(ghRun(['pr', 'list']), []);
});

test('makeGhListRepos: maps nameWithOwner and degrades to [] on failure', () => {
  const ghRunOk = () => [{ nameWithOwner: 'acme/widgets' }, { nameWithOwner: null }];
  assert.deepEqual(makeGhListRepos(ghRunOk)('acme'), ['acme/widgets']);

  const ghRunThrows = () => { throw new Error('boom'); };
  assert.deepEqual(makeGhListRepos(ghRunThrows)('acme'), []);
});

test('makeGhPrs: passes repo/state through and degrades to [] on failure', () => {
  const calls = [];
  const ghRunOk = (args) => { calls.push(args); return [{ number: 1 }]; };
  const prs = makeGhPrs(ghRunOk)('acme/widgets', 'open');
  assert.deepEqual(prs, [{ number: 1 }]);
  assert.ok(calls[0].includes('--state'));
  assert.ok(calls[0].includes('open'));

  const ghRunThrows = () => { throw new Error('boom'); };
  assert.deepEqual(makeGhPrs(ghRunThrows)('acme/widgets'), []);
});

test('gatherReviewRepos: unions owner-discovered repos with explicit search repos, deduplicated', () => {
  const ghListRepos = (owner) => (owner === 'acme' ? ['acme/widgets', 'acme/gadgets'] : []);
  const repos = gatherReviewRepos(ghListRepos, 'acme', ['acme/widgets', 'other/repo']);
  assert.deepEqual([...repos].sort(), ['acme/gadgets', 'acme/widgets', 'other/repo']);
});

test('gatherReviewRepos: a null owner contributes nothing beyond the explicit search repos', () => {
  const ghListRepos = () => { throw new Error('must not be called when owner is null'); };
  const repos = gatherReviewRepos(ghListRepos, null, ['other/repo']);
  assert.deepEqual([...repos], ['other/repo']);
});

test('makeListCandidatePullRequests: tags every PR with its source repo across the gathered set', () => {
  const ghListRepos = () => ['acme/widgets'];
  const ghPrs = (repo) => (repo === 'acme/widgets' ? [{ number: 1 }] : [{ number: 2 }]);
  const list = makeListCandidatePullRequests(ghListRepos, ghPrs, 'acme', ['other/repo']);
  const prs = list();
  assert.deepEqual(
    prs.map((p) => [p.number, p._repo]).sort(),
    [[1, 'acme/widgets'], [2, 'other/repo']],
  );
});
