// Unit tests for createMulticaBacklogAdapter (../lib/adapters/multica/backlog.mjs)
// against MOCKED multica/gh CLI output — no live CLI is ever invoked. Extends
// test/support/mock-mca.mjs's call-tracking pattern, but at the transport
// layer: rather than mocking the adapter's own methods (as mock-mca.mjs does
// for cycle()-level tests), this file mocks node:child_process's
// execFileSync itself and asserts the adapter parses/aggregates/merges CLI
// stdout exactly the way lib/multica.mjs did.
//
// Module-mocking mechanics (see standalone-smoke.test.mjs's header comment
// for the fuller explanation): node:test's `t.mock.module('node:child_process', ...)`
// intercepts at the loader level and only affects modules imported AFTER the
// mock is registered. Because this file runs MANY tests (each wanting its
// OWN execFileSync mock), and ESM caches a module by resolved URL on first
// import, every test below dynamically imports the adapter module through a
// unique cache-busting query string (`?t=<n>`) so each test's import freshly
// re-resolves its `import { execFileSync } from 'node:child_process'` against
// THAT test's mock, rather than reusing a previous test's cached instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;
async function freshAdapterModule() {
  importCounter++;
  return import(`../lib/adapters/multica/backlog.mjs?t=${importCounter}`);
}

const MULTICA_CLI = 'multica-test-cli';
const GH_CLI = 'gh-test-cli';

// Builds an execFileSync mock that dispatches on the invoked binary (cmd) and
// records every call (including the `env` option) so tests can assert both
// on parsed output AND on cleanEnv()'s scrubbing behavior.
// The real adapter always prepends ['--profile', PROFILE] to every multica
// CLI call (never to gh calls). Strip that pair before handing args to a
// test's `multica` handler so handlers can assert on the LOGICAL command
// (e.g. args[0] === 'issue') without every handler having to know about the
// profile-prefix implementation detail.
function stripProfile(args) {
  const i = args.indexOf('--profile');
  return i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 2)];
}

function makeExecMock(t, { multica = () => null, gh = () => [] } = {}) {
  const calls = [];
  const fn = t.mock.fn((cmd, args, options) => {
    calls.push({ cmd, args, options });
    let result;
    if (cmd === MULTICA_CLI) {
      result = multica(stripProfile(args));
    } else if (cmd === GH_CLI) {
      result = gh(args);
    } else {
      throw new Error('unexpected exec cmd: ' + cmd);
    }
    if (result instanceof Error) throw result;
    return JSON.stringify(result);
  });
  t.mock.module('node:child_process', { exports: { execFileSync: fn } });
  return calls;
}

// ---- listIssues: pagination ------------------------------------------------

test('listIssues paginates via --offset until a short page is returned (multi-page project)', async (t) => {
  // pageSize=2: page0 (offset=0) is a FULL page (2 items) so the loop must
  // continue; page1 (offset=2) is SHORT (1 item) so the loop must stop there.
  // Total 3 issues across 2 CLI calls — matches lib/multica.mjs's existing
  // pagination loop exactly (this is the real PAN-6952 regression case).
  const calls = makeExecMock(t, {
    multica: (args) => {
      const offset = Number(args[args.indexOf('--offset') + 1]);
      if (offset === 0) return { issues: [{ identifier: 'PAN-1' }, { identifier: 'PAN-2' }] };
      if (offset === 2) return { issues: [{ identifier: 'PAN-3' }] };
      throw new Error('unexpected offset ' + offset);
    },
  });

  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });

  const issues = backlog.listIssues('proj-1', 2);
  assert.deepEqual(issues.map((i) => i.identifier), ['PAN-1', 'PAN-2', 'PAN-3']);

  const listCalls = calls
    .map((c) => ({ ...c, args: stripProfile(c.args) }))
    .filter((c) => c.args[0] === 'issue' && c.args[1] === 'list');
  assert.equal(listCalls.length, 2, 'should stop after the short page — exactly 2 CLI calls');
  assert.ok(listCalls[0].args.includes('--offset') && listCalls[0].args[listCalls[0].args.indexOf('--offset') + 1] === '0');
  assert.ok(listCalls[1].args[listCalls[1].args.indexOf('--offset') + 1] === '2');
});

test('listIssues returns [] for a project with zero issues (single short/empty page)', async (t) => {
  makeExecMock(t, { multica: () => ({ issues: [] }) });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  assert.deepEqual(backlog.listIssues('empty-proj'), []);
});

// ---- cleanEnv(): security-relevant token scrubbing -------------------------

test('cleanEnv(): MULTICA_TOKEN/MULTICA_PAT_TOKEN/MULTICA_WORKSPACE_ID are absent from the child process env', async (t) => {
  const prevToken = process.env.MULTICA_TOKEN;
  const prevPat = process.env.MULTICA_PAT_TOKEN;
  const prevWs = process.env.MULTICA_WORKSPACE_ID;
  process.env.MULTICA_TOKEN = 'stale-token';
  process.env.MULTICA_PAT_TOKEN = 'stale-pat';
  process.env.MULTICA_WORKSPACE_ID = 'stale-workspace';
  t.after(() => {
    if (prevToken === undefined) delete process.env.MULTICA_TOKEN; else process.env.MULTICA_TOKEN = prevToken;
    if (prevPat === undefined) delete process.env.MULTICA_PAT_TOKEN; else process.env.MULTICA_PAT_TOKEN = prevPat;
    if (prevWs === undefined) delete process.env.MULTICA_WORKSPACE_ID; else process.env.MULTICA_WORKSPACE_ID = prevWs;
  });

  const calls = makeExecMock(t, {
    multica: () => ({ projects: [] }),
    gh: () => [],
  });

  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({
    cli: MULTICA_CLI, ghCli: GH_CLI, reviewRepoOwner: 'acme',
  });

  backlog.listAllProjectIds();
  backlog.getIssuePullRequests('PAN-1'); // also exercises the gh (ghListRepos) path

  assert.ok(calls.length >= 1, 'expected at least one execFileSync call');
  for (const call of calls) {
    const env = call.options && call.options.env;
    assert.ok(env, 'execFileSync must be called with an env option');
    assert.equal('MULTICA_TOKEN' in env, false, `MULTICA_TOKEN leaked into child env for ${call.cmd} ${call.args.join(' ')}`);
    assert.equal('MULTICA_PAT_TOKEN' in env, false, `MULTICA_PAT_TOKEN leaked into child env for ${call.cmd} ${call.args.join(' ')}`);
    assert.equal('MULTICA_WORKSPACE_ID' in env, false, `MULTICA_WORKSPACE_ID leaked into child env for ${call.cmd} ${call.args.join(' ')}`);
  }
});

// ---- read methods: degrade gracefully on CLI failure ------------------------

test('listAllProjectIds degrades to [] (does not throw) on CLI failure', async (t) => {
  makeExecMock(t, { multica: () => new Error('multica: unauthorized') });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  assert.deepEqual(backlog.listAllProjectIds(), []);
});

test('listAllProjectIds parses either a bare array or a {projects:[...]} envelope', async (t) => {
  makeExecMock(t, { multica: () => [{ id: 'p1' }, { id: 'p2' }] });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  assert.deepEqual(backlog.listAllProjectIds(), ['p1', 'p2']);
});

test('getIssueRuns degrades to [] (does not throw) on CLI failure', async (t) => {
  makeExecMock(t, { multica: () => new Error('multica: not found') });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  assert.deepEqual(backlog.getIssueRuns('PAN-404'), []);
});

test('listAllIssues (ported extra): one project failing does not abort the whole scan', async (t) => {
  makeExecMock(t, {
    multica: (args) => {
      const proj = args[args.indexOf('--project') + 1];
      if (proj === 'bad-proj') throw new Error('multica: 500');
      return { issues: [{ identifier: `${proj}-1` }] };
    },
  });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  const all = backlog.listAllIssues(['good-proj', 'bad-proj']);
  assert.deepEqual(all.map((i) => i.identifier), ['good-proj-1']);
});

// ---- write methods: propagate errors (asymmetric from reads) ---------------

test('setIssueStatus propagates a CLI failure (writes do not degrade gracefully)', async (t) => {
  makeExecMock(t, { multica: () => new Error('multica: conflict') });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  assert.throws(() => backlog.setIssueStatus('PAN-1', 'in_review'), /conflict/);
});

test('setIssueStatus returns the CLI\'s parsed JSON result on success', async (t) => {
  makeExecMock(t, { multica: () => ({ ok: true, status: 'done' }) });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  assert.deepEqual(backlog.setIssueStatus('PAN-1', 'done'), { ok: true, status: 'done' });
});

test('commentOnIssue degrades to null (best-effort — a comment failure must never abort dispatch)', async (t) => {
  makeExecMock(t, { multica: () => new Error('multica: rate limited') });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  assert.equal(backlog.commentOnIssue('PAN-1', 'hello'), null);
});

// ---- getIssuePullRequests: gh-backed PR discovery (high-risk per story) ----

test('getIssuePullRequests: non-empty gh-mocked response is discovered and returned (repo-discovery fallback)', async (t) => {
  // Multica's native issue<->PR linkage is empty (matches "empty in practice"
  // per lib/multica.mjs/auriga-router.mjs's own comments) — the PR is found
  // ONLY via the gh-backed fallback: ghListRepos(owner) discovers the repo,
  // then ghPrs(repo, 'all') returns a PR whose branch mentions the identifier.
  const calls = makeExecMock(t, {
    multica: (args) => {
      if (args[0] === 'issue' && args[1] === 'pull-requests') return { pull_requests: [] };
      throw new Error('unexpected multica args ' + args.join(' '));
    },
    gh: (args) => {
      if (args[0] === 'repo' && args[1] === 'list') return [{ nameWithOwner: 'acme/widgets' }];
      if (args[0] === 'pr' && args[1] === 'list') {
        const repo = args[args.indexOf('--repo') + 1];
        if (repo === 'acme/widgets') {
          return [
            { number: 7, title: 'feat: PAN-1234 widget', headRefName: 'feat/PAN-1234-widget',
              baseRefName: 'dev', body: '', url: 'https://github.com/acme/widgets/pull/7', state: 'OPEN', mergedAt: null },
            { number: 8, title: 'unrelated', headRefName: 'chore/cleanup',
              baseRefName: 'dev', body: '', url: 'https://github.com/acme/widgets/pull/8', state: 'OPEN', mergedAt: null },
          ];
        }
        return [];
      }
      throw new Error('unexpected gh args ' + args.join(' '));
    },
  });

  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({
    cli: MULTICA_CLI, ghCli: GH_CLI, reviewRepoOwner: 'acme',
  });

  const prs = backlog.getIssuePullRequests('PAN-1234');
  assert.equal(prs.length, 1, 'only the PR whose branch matches the identifier should be returned');
  assert.equal(prs[0].number, 7);
  assert.equal(prs[0]._repo, 'acme/widgets');

  // Prove gh really was invoked (the risk this test exists to cover: silently
  // returning empty because the gh-fallback wiring was dropped/broken).
  assert.ok(calls.some((c) => c.cmd === GH_CLI && c.args[0] === 'repo'), 'ghListRepos should have been called');
  assert.ok(calls.some((c) => c.cmd === GH_CLI && c.args[0] === 'pr'), 'ghPrs should have been called');
});

test('getIssuePullRequests: merges native Multica linkage with gh-discovered PRs, de-duplicated by url', async (t) => {
  makeExecMock(t, {
    multica: (args) => {
      if (args[0] === 'issue' && args[1] === 'pull-requests') {
        return { pull_requests: [{ number: 7, title: 'native', url: 'https://github.com/acme/widgets/pull/7', state: 'OPEN' }] };
      }
      throw new Error('unexpected multica args ' + args.join(' '));
    },
    gh: (args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        // Same PR #7 rediscovered via gh (should de-dupe to one), plus a
        // genuinely new merged PR #9 gh alone can see.
        return [
          { number: 7, title: 'feat: PAN-9 widget', headRefName: 'feat/PAN-9', body: '',
            url: 'https://github.com/acme/widgets/pull/7', state: 'OPEN', mergedAt: null },
          { number: 9, title: 'feat: PAN-9 followup', headRefName: 'feat/PAN-9-followup', body: '',
            url: 'https://github.com/acme/widgets/pull/9', state: 'MERGED', mergedAt: '2026-08-01T00:00:00Z' },
        ];
      }
      return [];
    },
  });

  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({
    cli: MULTICA_CLI, ghCli: GH_CLI, reviewSearchRepos: ['acme/widgets'],
  });

  const prs = backlog.getIssuePullRequests('PAN-9');
  assert.equal(prs.length, 2, 'de-duped by url: 2 unique PRs (#7, #9), not 3');
  const numbers = prs.map((p) => p.number).sort();
  assert.deepEqual(numbers, [7, 9]);
  const merged = prs.find((p) => p.number === 9);
  assert.equal(merged.mergedAt, '2026-08-01T00:00:00Z');
});

test('getIssuePullRequests: degrades to [] when both multica and gh lookups fail (never throws)', async (t) => {
  makeExecMock(t, {
    multica: () => new Error('multica: down'),
    gh: () => { throw new Error('gh: down'); },
  });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({
    cli: MULTICA_CLI, ghCli: GH_CLI, reviewSearchRepos: ['acme/widgets'],
  });
  assert.deepEqual(backlog.getIssuePullRequests('PAN-1'), []);
});

test('getIssuePullRequests: with no reviewRepoOwner/reviewSearchRepos configured, only the native lookup runs', async (t) => {
  const calls = makeExecMock(t, {
    multica: () => ({ pull_requests: [] }),
    gh: () => { throw new Error('gh should never be called with no repos configured'); },
  });
  const { createMulticaBacklogAdapter } = await freshAdapterModule();
  const backlog = createMulticaBacklogAdapter({ cli: MULTICA_CLI, ghCli: GH_CLI });
  assert.deepEqual(backlog.getIssuePullRequests('PAN-1'), []);
  assert.ok(calls.every((c) => c.cmd === MULTICA_CLI));
});
