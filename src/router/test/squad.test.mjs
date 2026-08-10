import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

// The review-squad classifier is config-driven; pass an explicit rules fixture so
// the test is independent of live config.mjs edits. Mirror DEFAULT_SQUAD_RULES shape.
const CFG = { REVIEW_SQUAD_RULES: core.DEFAULT_SQUAD_RULES };

const issue = (title, description = '', labels = []) =>
  ({ identifier: 'PAN-1', title, description, labels });

test('reviewSquadPlan: a user-facing/UI story gets the FULL squad + Playwright', () => {
  const plan = core.reviewSquadPlan(issue('Build the Clients dashboard React component', 'add a new page with a form and button'), CFG);
  assert.equal(plan.tier, 'full');
  assert.deepEqual(plan.perspectives, { product: true, technical: true, qa: true, ux: true });
  assert.equal(plan.playwright, true);
});

test('reviewSquadPlan: a headless backend story drops UX (product+technical+qa, no Playwright)', () => {
  const plan = core.reviewSquadPlan(issue('Add collection filter to KB entries API endpoint', 'new server route + schema migration'), CFG);
  assert.equal(plan.tier, 'backend');
  assert.deepEqual(plan.perspectives, { product: true, technical: true, qa: true, ux: false });
  assert.equal(plan.playwright, false);
});

test('reviewSquadPlan: a docs/chore story gets the LIGHT squad (technical + qa only)', () => {
  const plan = core.reviewSquadPlan(issue('docs: OSS launch — README + VISION', 'documentation only, fix a typo'), CFG);
  assert.equal(plan.tier, 'light');
  assert.deepEqual(plan.perspectives, { product: false, technical: true, qa: true, ux: false });
  assert.equal(plan.playwright, false);
});

test('reviewSquadPlan: no decisive signal defaults to the FULL squad (each-and-every-ticket baseline)', () => {
  const plan = core.reviewSquadPlan(issue('Implement the org-tree context resolver', 'resolve context for a node'), CFG);
  assert.equal(plan.tier, 'standard');
  assert.deepEqual(plan.perspectives, { product: true, technical: true, qa: true, ux: true });
  assert.equal(plan.playwright, true);
});

test('reviewSquadPlan: a UI signal beats a co-occurring backend signal (user surface wins)', () => {
  // Touches an API but also renders a dashboard page -> must still get UX + Playwright.
  const plan = core.reviewSquadPlan(issue('Dashboard page that calls the metrics API', 'react component + server endpoint'), CFG);
  assert.equal(plan.tier, 'full');
  assert.equal(plan.perspectives.ux, true);
  assert.equal(plan.playwright, true);
});

test('reviewSquadPlan: a docs signal alongside a backend signal is NOT light (backend wins over light)', () => {
  const plan = core.reviewSquadPlan(issue('Update API docs and add a new endpoint', 'readme plus a server route'), CFG);
  assert.equal(plan.tier, 'backend');
  assert.equal(plan.perspectives.technical, true);
  assert.equal(plan.perspectives.qa, true);
});

test('reviewSquadPlan: labels contribute signals (label-only UI classification)', () => {
  const plan = core.reviewSquadPlan(issue('Story with no keyword in title', 'plain', [{ name: 'frontend' }, { name: 'ui' }]), CFG);
  assert.equal(plan.tier, 'full');
});

test('reviewSquadPlan: works with the built-in DEFAULT_SQUAD_RULES when cfg has none', () => {
  const plan = core.reviewSquadPlan(issue('New CSS component', 'styling'), {});
  assert.equal(plan.tier, 'full');
  assert.equal(plan.playwright, true);
});

test('squadPlanSummary: renders enabled perspectives + qa/Playwright tag', () => {
  const full = core.reviewSquadPlan(issue('React dashboard page'), CFG);
  const s = core.squadPlanSummary(full);
  assert.match(s, /squad\[full\]/);
  assert.match(s, /product/);
  assert.match(s, /qa\+Playwright/);
  assert.match(s, /ux/);

  const light = core.reviewSquadPlan(issue('docs: readme typo fix'), CFG);
  const sl = core.squadPlanSummary(light);
  assert.match(sl, /squad\[light\]/);
  assert.doesNotMatch(sl, /\bux\b/);
  assert.doesNotMatch(sl, /Playwright/);
});
