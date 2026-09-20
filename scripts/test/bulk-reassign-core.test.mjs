import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/bulk-reassign-core.mjs';

const CODEX = new Set(['CODEX-A', 'CODEX-B']);
const LANES = {
  'mdostal/auriga': { lane: 'auriga-build', agentId: 'AGT-AURIGA' },
  'mdostal/mnemosyne': { lane: 'mnemosyne-dev', agentId: 'AGT-MNEMOSYNE' },
};

const issue = (overrides = {}) => ({
  id: 'i1',
  identifier: 'PAN-1',
  status: 'blocked',
  assignee_id: 'CODEX-A',
  title: 'a story',
  description: '',
  metadata: {},
  ...overrides,
});

test('mentionsHiveUnavailable matches plugin-hive/hive-execute unavailability phrasing', () => {
  assert.ok(core.mentionsHiveUnavailable('plugin-hive execute/review/test is unavailable in this Codex runtime'));
  assert.ok(core.mentionsHiveUnavailable('Hive execute cannot run this story directly without starting the parent epic'));
  assert.ok(core.mentionsHiveUnavailable('plugin-hive is required by standing policy, but no plugin-hive tool or CLI is callable'));
  assert.ok(!core.mentionsHiveUnavailable('Waiting for prerequisite inventory-both-sites to complete'));
  assert.ok(!core.mentionsHiveUnavailable('waiting_on: Mathew'));
});

test('isCodexSelfBlocked requires blocked status + codex assignee + hive-unavailable reason', () => {
  assert.ok(core.isCodexSelfBlocked(
    issue({ metadata: { blocked_reason: 'plugin-hive execute/review/test is unavailable in this Codex runtime' } }),
    CODEX,
  ));
  // Not blocked.
  assert.ok(!core.isCodexSelfBlocked(issue({ status: 'todo' }), CODEX));
  // Not a codex agent (e.g. already claude+hive, or a human).
  assert.ok(!core.isCodexSelfBlocked(
    issue({ assignee_id: 'auriga-build', metadata: { blocked_reason: 'plugin-hive execute/review/test is unavailable in this Codex runtime' } }),
    CODEX,
  ));
  // Codex-assigned but blocked for an unrelated reason (dependency wait).
  assert.ok(!core.isCodexSelfBlocked(
    issue({ metadata: { blocked_reason: 'Waiting for PAN-99 to complete' } }),
    CODEX,
  ));
});

test('extractRepoMentions pulls every mdostal/<repo> mention, deduped', () => {
  const i = issue({
    description: 'Targets mdostal/clients and mdostal/janus. See also mdostal/clients again.',
  });
  assert.deepEqual(core.extractRepoMentions(i), ['mdostal/clients', 'mdostal/janus']);
});

test('resolveHiveLane resolves an unambiguous aligned repo mention', () => {
  const i = issue({ description: 'Implementation lives in mdostal/auriga.' });
  assert.deepEqual(core.resolveHiveLane(i, LANES), { lane: 'auriga-build', agentId: 'AGT-AURIGA' });
});

test('resolveHiveLane returns null when no mention is aligned (needs-agent case)', () => {
  const i = issue({ description: 'Implementation lives in mdostal/clients.' });
  assert.equal(core.resolveHiveLane(i, LANES), null);
});

test('resolveHiveLane returns null when mentions span more than one aligned repo (ambiguous)', () => {
  const i = issue({ description: 'Touches both mdostal/auriga and mdostal/mnemosyne.' });
  assert.equal(core.resolveHiveLane(i, LANES), null);
});

test('resolveHiveLane ignores repo mentions that only appear in blocked_reason (regression: PAN-6499)', () => {
  // Real target is mdostal/clients (no repo named in title/description at all);
  // blocked_reason merely lists repos a prior agent tried and failed to check out,
  // including an aligned one it never actually targets. Must NOT resolve a lane.
  const i = issue({
    title: 'Vault panel UI (iframe embed)',
    description: 'Build VaultPanel.tsx component that embeds Portunus vault UI in an iframe.',
    metadata: { blocked_reason: 'mdostal/clients and mdostal/auriga repos not configured for checkout; plugin-hive execute/review/test unavailable' },
  });
  assert.equal(core.resolveHiveLane(i, LANES), null);
});

test('planReassignment returns null for non-candidates', () => {
  assert.equal(core.planReassignment(issue({ status: 'todo' }), { codexAgentIds: CODEX, repoLaneAgents: LANES }), null);
});

test('planReassignment plans a reassign when the target repo has an aligned lane', () => {
  const i = issue({
    description: 'mdostal/auriga',
    metadata: { blocked_reason: 'plugin-hive execute/review/test is unavailable in this Codex runtime' },
  });
  const decision = core.planReassignment(i, { codexAgentIds: CODEX, repoLaneAgents: LANES });
  assert.deepEqual(decision, {
    issueId: 'i1', identifier: 'PAN-1', action: 'reassign', lane: 'auriga-build', agentId: 'AGT-AURIGA',
  });
});

test('planReassignment plans needs-agent when no aligned lane exists for the target repo', () => {
  const i = issue({
    description: 'Targets mdostal/clients.',
    metadata: { blocked_reason: 'plugin-hive execute/review/test is unavailable in this Codex runtime' },
  });
  const decision = core.planReassignment(i, { codexAgentIds: CODEX, repoLaneAgents: LANES });
  assert.equal(decision.action, 'needs-agent');
  assert.match(decision.reason, /needs-agent: no claude\+hive lane provisioned for mdostal\/clients/);
});

test('planReassignment plans needs-agent with an honest note when no repo is identifiable at all', () => {
  const i = issue({
    description: 'No repo mentioned anywhere.',
    metadata: { blocked_reason: 'plugin-hive execute/review/test is unavailable in this Codex runtime' },
  });
  const decision = core.planReassignment(i, { codexAgentIds: CODEX, repoLaneAgents: LANES });
  assert.equal(decision.action, 'needs-agent');
  assert.match(decision.reason, /no target repo identified/);
});

test('planBulk filters non-candidates and summarizes by action', () => {
  const issues = [
    issue({ id: 'a', identifier: 'PAN-A', description: 'mdostal/auriga', metadata: { blocked_reason: 'plugin-hive execute/review/test is unavailable in this Codex runtime' } }),
    issue({ id: 'b', identifier: 'PAN-B', description: 'mdostal/clients', metadata: { blocked_reason: 'plugin-hive execute/review/test is unavailable in this Codex runtime' } }),
    issue({ id: 'c', identifier: 'PAN-C', status: 'todo' }),
  ];
  const { decisions, summary } = core.planBulk(issues, { codexAgentIds: CODEX, repoLaneAgents: LANES });
  assert.equal(decisions.length, 2);
  assert.deepEqual(summary, { reassign: 1, 'needs-agent': 1 });
});
