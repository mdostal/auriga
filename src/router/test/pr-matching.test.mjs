// Tests for lib/pr-matching.mjs (t011 decomposition) — the module's own
// direct contract test (core.test.mjs already covers these functions
// extensively via core.mjs's re-export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasTargetRepo, prReferencesIssue, prMatchesStory, prIdentityMatchesStory,
  repoFromPrUrl, prIsOpen, hasOpenPrForIssue, normalizeRepoSlug, targetRepoValue,
} from '../lib/pr-matching.mjs';

test('hasTargetRepo: true only when a target_repo: line is present in the description', () => {
  assert.equal(hasTargetRepo({ description: 'target_repo: mdostal/auriga' }), true);
  assert.equal(hasTargetRepo({ description: 'nothing here' }), false);
});

test('prReferencesIssue: matches the identifier anywhere in branch/title/body, case-insensitively', () => {
  assert.equal(prReferencesIssue({ headRefName: 'feat/pan-1234-thing' }, 'PAN-1234'), true);
  assert.equal(prReferencesIssue({ title: 'unrelated' }, 'PAN-1234'), false);
  assert.equal(prReferencesIssue({}, ''), false);
});

test('prMatchesStory: falls back to the story\'s short key when the raw identifier isn\'t present', () => {
  const pr = { headRefName: 'feat/m-01-service' };
  const issue = { identifier: 'PAN-9999', title: '[m-01-core] service work' };
  assert.equal(prMatchesStory(pr, issue), true);
});

test('prMatchesStory: a short key never matches a longer-numbered false-prefix (m-01 vs m-010)', () => {
  const pr = { headRefName: 'feat/m-010-other-thing' };
  const issue = { identifier: 'PAN-1', title: '[m-01-core] service work' };
  assert.equal(prMatchesStory(pr, issue), false);
});

test('prIdentityMatchesStory: only checks branch/title, never body (false-positive trap)', () => {
  const pr = { title: 'unrelated', body: 'builds on PAN-6659' };
  assert.equal(prIdentityMatchesStory(pr, { identifier: 'PAN-6659' }), false);
  const prWithBranch = { headRefName: 'feat/pan-6659-fix' };
  assert.equal(prIdentityMatchesStory(prWithBranch, { identifier: 'PAN-6659' }), true);
});

test('repoFromPrUrl: parses owner/repo from a real github PR url', () => {
  assert.equal(repoFromPrUrl({ url: 'https://github.com/mdostal/auriga/pull/81' }), 'mdostal/auriga');
  assert.equal(repoFromPrUrl({}), null);
});

test('prIsOpen: re-exported from github-pr-state.mjs, real gh-shaped state works', () => {
  assert.equal(prIsOpen({ state: 'OPEN' }), true);
  assert.equal(prIsOpen({ state: 'MERGED' }), false);
});

test('hasOpenPrForIssue: true only when a matching PR is both open and references the identifier', () => {
  const prs = [{ state: 'OPEN', headRefName: 'feat/pan-1' }, { state: 'MERGED', headRefName: 'feat/pan-2' }];
  assert.equal(hasOpenPrForIssue('PAN-1', prs), true);
  assert.equal(hasOpenPrForIssue('PAN-2', prs), false);
});

test('normalizeRepoSlug: handles bare slug, https url, ssh url, trailing .git', () => {
  assert.equal(normalizeRepoSlug('mdostal/auriga'), 'mdostal/auriga');
  assert.equal(normalizeRepoSlug('https://github.com/mdostal/auriga'), 'mdostal/auriga');
  assert.equal(normalizeRepoSlug('git@github.com:mdostal/auriga.git'), 'mdostal/auriga');
  assert.equal(normalizeRepoSlug('/local/path/not/a/slug/at/all'), null);
});

test('targetRepoValue: prefers metadata.target_repo over a description line', () => {
  assert.equal(targetRepoValue({ metadata: { target_repo: 'mdostal/auriga' } }), 'mdostal/auriga');
  assert.equal(targetRepoValue({ description: 'target_repo: mdostal/heimdall' }), 'mdostal/heimdall');
  assert.equal(targetRepoValue({}), null);
});
