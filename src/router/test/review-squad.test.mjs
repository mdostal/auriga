// Tests for lib/review-squad.mjs (t011 decomposition) — the module's own
// direct contract test (core.test.mjs already covers these functions
// extensively via core.mjs's re-export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SQUAD_RULES, reviewSquadPlan, squadPlanSummary } from '../lib/review-squad.mjs';

test('reviewSquadPlan: a UI signal wins -> full squad + Playwright', () => {
  const plan = reviewSquadPlan({ title: 'Add a new dashboard button', description: '' }, {});
  assert.equal(plan.tier, 'full');
  assert.equal(plan.playwright, true);
  assert.equal(plan.perspectives.ux, true);
});

test('reviewSquadPlan: a light-only signal (docs/chore) with no backend signal -> technical+qa only', () => {
  const plan = reviewSquadPlan({ title: 'Update README typo', description: '' }, {});
  assert.equal(plan.tier, 'light');
  assert.equal(plan.perspectives.product, false);
  assert.equal(plan.perspectives.ux, false);
});

test('reviewSquadPlan: a backend signal with no UI -> product+technical+qa, no ux', () => {
  const plan = reviewSquadPlan({ title: 'Add a new API endpoint', description: '' }, {});
  assert.equal(plan.tier, 'backend');
  assert.equal(plan.perspectives.ux, false);
  assert.equal(plan.perspectives.product, true);
});

test('reviewSquadPlan: no decisive signal -> standard (full four, safe default)', () => {
  const plan = reviewSquadPlan({ title: 'Some vague ticket', description: '' }, {});
  assert.equal(plan.tier, 'standard');
  assert.equal(plan.perspectives.ux, true);
});

test('reviewSquadPlan: works with the built-in DEFAULT_SQUAD_RULES when cfg has none', () => {
  const plan = reviewSquadPlan({ title: 'ui component work' }, {});
  assert.deepEqual(Object.keys(plan.perspectives).sort(), ['product', 'qa', 'technical', 'ux']);
  assert.ok(DEFAULT_SQUAD_RULES.ui.includes('ui'));
});

test('squadPlanSummary: renders enabled perspectives + qa/Playwright tag', () => {
  const plan = reviewSquadPlan({ title: 'new UI page' }, {});
  const summary = squadPlanSummary(plan);
  assert.match(summary, /squad\[full\]/);
  assert.match(summary, /qa\+Playwright/);
});
