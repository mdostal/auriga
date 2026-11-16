// PANT-1383: the review gate. Live 2026-11-16, parent epic FFE-1598 (no PR,
// three open child stories) went in_progress -> in_review three times in six
// minutes, each time dispatching a full review squad. These drive the REAL
// cycle() against an in-memory board (same shape as router-cycle.e2e's mock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycle } from '../auriga-router.mjs';
import * as cfg from '../lib/config.mjs';
import * as core from '../lib/core.mjs';
import { createLogSink } from './support/mock-mca.mjs';
import { linkedOpenPr } from './support/linked-pr.mjs';

const NOOP_SLEEP = async () => {};
const BUILDER_ID = cfg.AGENTS['auriga-dev'].id;
const REVIEWER_ID = cfg.AGENTS['auriga-review'].id;

function fixtureCfg(project, caps = {}) {
  return {
    ...cfg,
    PROJECT_IDS: [...cfg.PROJECT_IDS, project],
    PROJECT_LANE: { ...cfg.PROJECT_LANE, [project]: ['auriga-dev'] },
    REVIEW_LANE: ['auriga-review'],
    CAPS: { ...cfg.CAPS, reviewMaxAttempts: 10, reviewFairnessMaxAttempts: 10, ...caps },
  };
}

let seq = 9000;
function makeIssue(overrides = {}) {
  const n = seq++;
  return {
    id: `gate-${n}`, identifier: `GATE-${n}`, number: n, title: `story ${n}`, description: '',
    labels: ['not-a-seed'], status: 'todo', assignee_id: null, parent_issue_id: null, metadata: {},
    ...overrides,
  };
}

const iso = (ms) => new Date(ms).toISOString();
const doneRun = (at = Date.now() - 60_000) => ({ status: 'completed', created_at: iso(at - 60_000), dispatched_at: iso(at - 60_000), completed_at: iso(at), agent_id: BUILDER_ID });

// prs: { [identifier]: pr[] }, mutable by the test between cycles.
function board(issues, prs = {}) {
  const calls = { assign: [], rerun: [], status: [], comment: [], metadata: [] };
  const runs = {};
  const find = (id) => issues.find((i) => i.identifier === id);
  const backlog = {
    listAllProjectIds: () => [],
    listAllIssues: (ids) => issues.filter((i) => ids.includes(i.project_id)),
    getIssueRuns: (id) => runs[id] || [],
    getIssuePullRequests: (id) => prs[id] || [],
    setIssueStatus: (id, status) => { calls.status.push({ identifier: id, status }); const i = find(id); if (i) i.status = status; },
    commentOnIssue: (id, body) => { calls.comment.push({ identifier: id, body }); },
    setIssueMetadata: (id, md) => { calls.metadata.push({ identifier: id, md }); const i = find(id); if (i) i.metadata = { ...i.metadata, ...md }; },
  };
  const live = () => ({ status: 'in_progress', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() });
  const spawn = {
    assignIssue: (id, agent) => { calls.assign.push({ identifier: id, agent }); const i = find(id); if (i) i.assignee_id = cfg.AGENTS[agent]?.id; runs[id] = [...(runs[id] || []), live()]; },
    rerunIssue: (id) => { calls.rerun.push({ identifier: id }); runs[id] = [...(runs[id] || []), live()]; },
    unassignIssue: (id) => { const i = find(id); if (i) i.assignee_id = null; },
    describeLanes: () => ({}),
  };
  return { backlog, spawn, calls, runs, prs };
}

const run = (b, c, extra = {}) => cycle({ backlog: b.backlog, spawn: b.spawn, cfg: c, log: extra.log || createLogSink(), sleep: NOOP_SLEEP, ...extra });
const statusesFor = (b, id, status) => b.calls.status.filter((s) => s.identifier === id && s.status === status);
const assignsFor = (b, id) => b.calls.assign.filter((a) => a.identifier === id);
// Hold comments only (a review dispatch also posts its squad plan).
const commentsFor = (b, id) => b.calls.comment.filter((x) => x.identifier === id && !x.body.startsWith('REVIEW SQUAD PLAN'));

test('PANT-1383 (FFE-1598): an in_progress epic with open children and no PR is never promoted or reviewed; one comment over many cycles', async () => {
  const P = 'gate-epic-proj';
  const c = fixtureCfg(P);
  const epic = makeIssue({ project_id: P, status: 'in_progress', assignee_id: BUILDER_ID, title: 'Epic: Firefly Events workspace' });
  const kids = [0, 1, 2].map(() => makeIssue({ project_id: P, status: 'backlog', parent_issue_id: epic.id, labels: ['human-todo'] }));
  const b = board([epic, ...kids]);
  // The builder commented, unassigned itself and its run finished; stale enough
  // that the old zombie pass would also have re-run it.
  b.runs[epic.identifier] = [doneRun(Date.now() - 2 * 60 * 60 * 1000)];

  const log = createLogSink();
  for (let k = 0; k < 4; k += 1) await run(b, c, { log });

  assert.equal(epic.status, 'in_progress', 'the epic waits where it is');
  assert.equal(statusesFor(b, epic.identifier, 'in_review').length, 0, 'never promoted to in_review');
  assert.equal(assignsFor(b, epic.identifier).length, 0, 'no review squad, no builder reassign');
  assert.equal(b.calls.rerun.filter((r) => r.identifier === epic.identifier).length, 0, 'no zombie rerun on a waiting parent');
  const comments = commentsFor(b, epic.identifier);
  assert.equal(comments.length, 1, 'exactly one comment saying why');
  assert.match(comments[0].body, /open child issue/);
  for (const k of kids) assert.ok(comments[0].body.includes(k.identifier), 'the comment names the open children');
  assert.equal(epic.metadata.review_hold, 'open-children');
  assert.equal(log.byEvent('review_hold').length, 4, 'every cycle logs the hold');
});

test('PANT-1383: an in_review epic with open children gets no review squad and holds no review slot', async () => {
  const P = 'gate-inreview-epic-proj';
  const c = fixtureCfg(P, { perCycleReview: 1 });
  const epic = makeIssue({ project_id: P, status: 'in_review', assignee_id: BUILDER_ID });
  const kid = makeIssue({ project_id: P, status: 'in_progress', parent_issue_id: epic.id, labels: ['human-todo'] });
  const story = makeIssue({ project_id: P, status: 'in_review', assignee_id: BUILDER_ID });
  const b = board([epic, kid, story], { [epic.identifier]: [linkedOpenPr(epic.identifier)], [story.identifier]: [linkedOpenPr(story.identifier)] });

  await run(b, c);
  await run(b, c);

  assert.equal(assignsFor(b, epic.identifier).length, 0, 'epic never dispatched for review');
  assert.equal(epic.status, 'in_review', 'status untouched');
  assert.equal(commentsFor(b, epic.identifier).length, 1);
  assert.equal(assignsFor(b, story.identifier).length, 1, 'the reviewable story still gets the slot');
});

test('PANT-1383: no linked PR or branch = no review; reviewRequiresLinkedPr=false turns that leg off', async () => {
  const P = 'gate-nopr-proj';
  const held = makeIssue({ project_id: P, status: 'in_review', assignee_id: BUILDER_ID });
  const b = board([held]);
  await run(b, fixtureCfg(P));
  await run(b, fixtureCfg(P));
  assert.equal(assignsFor(b, held.identifier).length, 0);
  assert.equal(commentsFor(b, held.identifier).length, 1);
  assert.match(commentsFor(b, held.identifier)[0].body, /no pull request or branch/);

  const P2 = 'gate-nopr-off-proj';
  const free = makeIssue({ project_id: P2, status: 'in_review', assignee_id: BUILDER_ID });
  const b2 = board([free]);
  await run(b2, fixtureCfg(P2, { reviewRequiresLinkedPr: false }));
  assert.equal(assignsFor(b2, free.identifier).length, 1);

  const P3 = 'gate-branch-proj';
  const branched = makeIssue({ project_id: P3, status: 'in_review', assignee_id: BUILDER_ID, metadata: { branch: 'pant-1-x' } });
  const b3 = board([branched]);
  await run(b3, fixtureCfg(P3));
  assert.equal(assignsFor(b3, branched.identifier).length, 1, 'a recorded branch counts as linked');
});

test('PANT-1383: the same issue promoted to review twice with no new commit stops and comments once', async () => {
  const P = 'gate-loop-proj';
  const c = fixtureCfg(P);
  const story = makeIssue({ project_id: P, status: 'in_progress', assignee_id: BUILDER_ID });
  const b = board([story], { [story.identifier]: [linkedOpenPr(story.identifier, 'sha-1')] });
  b.runs[story.identifier] = [doneRun()];

  // Round 1: promoted and reviewed.
  await run(b, c);
  assert.equal(statusesFor(b, story.identifier, 'in_review').length, 1, 'first promotion goes through');
  assert.equal(assignsFor(b, story.identifier).length, 1, 'first review squad dispatched');
  assert.equal(story.metadata.review_promoted_head, core.reviewHeadKey(story, b.prs[story.identifier]));

  // The review sends it back, the builder runs again and pushes nothing.
  let tick = 0;
  const sendBack = () => {
    story.status = 'in_progress';
    story.assignee_id = BUILDER_ID;
    // The builder's new run is the latest one, and it finished.
    // (Earlier runs dropped: the mock's synthetic review run is stamped "now" and would otherwise stay latest.)
    b.runs[story.identifier] = [doneRun(Date.now() - 1000 * ++tick)];
  };
  sendBack();
  await run(b, c);
  sendBack();
  await run(b, c);

  assert.equal(statusesFor(b, story.identifier, 'in_review').length, 1, 'no second promotion on the same head');
  assert.equal(assignsFor(b, story.identifier).length, 1, 'no second review squad');
  assert.equal(story.status, 'in_progress');
  const comments = commentsFor(b, story.identifier);
  assert.equal(comments.length, 1, 'one comment for the loop, not one per cycle');
  assert.match(comments[0].body, /no new commit/);

  // A new commit lands: review resumes.
  b.prs[story.identifier] = [linkedOpenPr(story.identifier, 'sha-2')];
  await run(b, c);
  assert.equal(statusesFor(b, story.identifier, 'in_review').length, 2, 'a new head is promoted again');
  assert.equal(story.metadata.review_hold, '', 'the hold is cleared once it no longer applies');
});

test('PANT-1383: an issue back in in_review for a fresh review on the head already reviewed is stopped', async () => {
  const P = 'gate-review-loop-proj';
  const c = fixtureCfg(P);
  const story = makeIssue({ project_id: P, status: 'in_review', assignee_id: BUILDER_ID });
  const b = board([story], { [story.identifier]: [linkedOpenPr(story.identifier, 'sha-1')] });

  await run(b, c);
  assert.equal(assignsFor(b, story.identifier).length, 1);
  assert.equal(story.assignee_id, REVIEWER_ID);

  // While the reviewer holds it, the same head is the normal case, not a loop.
  await run(b, c);
  assert.equal(commentsFor(b, story.identifier).filter((x) => /no new commit/.test(x.body)).length, 0);

  // The builder puts it back in review with no new commit.
  story.assignee_id = BUILDER_ID;
  await run(b, c);
  await run(b, c);
  assert.equal(assignsFor(b, story.identifier).length, 1, 'no second review squad');
  assert.equal(commentsFor(b, story.identifier).filter((x) => /no new commit/.test(x.body)).length, 1);

  b.prs[story.identifier] = [linkedOpenPr(story.identifier, 'sha-2')];
  await run(b, c);
  assert.equal(assignsFor(b, story.identifier).length, 2, 'a new commit gets reviewed');
});

test('PANT-1383: dry run logs the hold but writes nothing', async () => {
  const P = 'gate-dry-proj';
  const epic = makeIssue({ project_id: P, status: 'in_progress', assignee_id: BUILDER_ID });
  makeIssue();
  const kid = makeIssue({ project_id: P, status: 'todo', parent_issue_id: epic.id, labels: ['human-todo'] });
  const b = board([epic, kid]);
  b.runs[epic.identifier] = [doneRun()];
  const log = createLogSink();
  await run(b, fixtureCfg(P), { log, dryRun: true });
  assert.equal(log.byEvent('review_hold').length, 1);
  assert.equal(b.calls.comment.length, 0);
  assert.equal(b.calls.metadata.length, 0);
});

test('PANT-1383: reviewHoldReason / reviewHeadKey / detectZombies units', () => {
  const parent = { id: 'p', identifier: 'P-1', status: 'in_progress', metadata: {} };
  const open = { id: 'c1', identifier: 'C-1', parent_issue_id: 'p', status: 'todo' };
  const closed = { id: 'c2', identifier: 'C-2', parent_issue_id: 'p', status: 'done' };
  const pr = linkedOpenPr('P-1', 'abc');

  assert.equal(core.reviewHoldReason(parent, [parent, open, closed], [pr], cfg).reason, 'open-children');
  assert.deepEqual(core.reviewHoldReason(parent, [parent, open, closed], [pr], cfg).children.map((x) => x.identifier), ['C-1']);
  assert.equal(core.reviewHoldReason(parent, [parent, closed], [pr], cfg), null, 'only open children hold');
  assert.equal(core.reviewHoldReason(parent, [parent], [], cfg).reason, 'no-linked-pr');
  assert.equal(core.reviewHoldReason({ ...parent, metadata: { pr_url: 'https://github.com/a/b/pull/1' } }, [parent], [], cfg), null);

  const key = core.reviewHeadKey(parent, [pr]);
  assert.equal(key, core.reviewHeadKey(parent, [{ ...pr }]), 'stable');
  assert.notEqual(key, core.reviewHeadKey(parent, [{ ...pr, headRefOid: 'def' }]), 'moves with the head');
  const seen = { ...parent, metadata: { review_promoted_head: key } };
  assert.equal(core.reviewHoldReason(seen, [seen], [pr], cfg, { metaKey: 'review_promoted_head' }).reason, 'review-loop');
  assert.equal(core.reviewHoldReason(seen, [seen], [pr], cfg), null, 'loop check only when asked');

  const staleRun = [{ status: 'completed', created_at: iso(Date.now() - 5 * 3600_000), completed_at: iso(Date.now() - 5 * 3600_000) }];
  const epic = { ...parent, assignee_id: BUILDER_ID, project_id: 'x', labels: [] };
  assert.equal(core.detectZombies([epic], { 'P-1': staleRun }, cfg, Date.now(), [epic, open]).length, 0, 'parent with open children is not a zombie');
  assert.equal(core.detectZombies([epic], { 'P-1': staleRun }, cfg, Date.now(), [epic, closed]).length, 1, 'control: without open children it is');
});
