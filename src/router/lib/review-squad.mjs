// REVIEW SQUAD — scale-by-ticket perspective plan (2026-07-31, PAN-6546).
// Extracted from core.mjs (t011 decomposition); depends only on
// pr-matching.mjs's targetRepoValue (a leaf-adjacent module with no
// dependency back on core.mjs's own dispatch/decision logic).
// ----------------------------------------------------------------------------
// Mathew's binding intent (recovered Consus answer): a story that lands in
// `in_review` must be reviewed by a REAL multi-perspective SQUAD that TRULY
// verifies — not a single reviewer pass. The four perspectives are:
//   - product   (PO): does the change satisfy the story's intent / acceptance?
//   - technical  : correctness, conventions, security (the /hive:review pass)
//   - qa         : author + RUN tests, real build, Playwright/E2E where it
//                  matters — TRUE verification, never a diff read alone.
//   - ux         : user-facing surface quality + accessibility (design-review).
//
// "It has to be approached from at least the product, the technical, and a QA
//  and user-experience perspective for each and every ticket ... Some things
//  will not need the full team." — so the DEFAULT posture is the full four, and
// we only DROP a perspective when it is genuinely inapplicable to the ticket
// (UX on a headless backend change, product on a pure docs/chore change). Every
// drop is logged with a reason, so the scaling is explicit and inspectable.
//
// Auriga stays the THIN router: it computes this plan and fires ONE review
// dispatch carrying it (logged + posted to the ticket). The SQUAD itself runs
// inside the auriga-review agent, which reads the plan and executes each enabled
// perspective (see agents/auriga-review.instructions.md). This function is the
// single source of truth for "which perspectives, and does QA need Playwright".

import { targetRepoValue } from './pr-matching.mjs';

// Built-in rule set — used when cfg.REVIEW_SQUAD_RULES is absent so the classifier
// is self-contained + unit-testable without a live config. cfg.REVIEW_SQUAD_RULES
// (config.mjs) is the inspectable, editable copy the router actually passes in.
export const DEFAULT_SQUAD_RULES = {
  // Signals that a change is USER-FACING (gets the full squad incl. UX + Playwright).
  ui: [
    'ui', 'ux', 'user-facing', 'frontend', 'front-end', 'page', 'screen', 'view',
    'component', 'dashboard', 'portal', 'css', 'tailwind', 'react', 'svelte', 'vue',
    'html', 'button', 'form', 'modal', 'layout', 'nav', 'menu', 'visual', 'design',
    'accessibility', 'a11y', 'responsive', 'animation', 'theme', 'styling', 'playwright',
  ],
  // Signals that a change is BACKEND/headless (product + technical + qa, NO ux).
  backend: [
    'api', 'endpoint', 'route', 'server', 'service', 'daemon', 'worker', 'schema',
    'model', 'database', 'migration', 'sql', 'query', 'integration', 'pipeline',
    'router', 'dispatch', 'auth', 'token', 'webhook', 'cron', 'queue', 'cli', 'sdk',
  ],
  // Signals that a change is DOCS/CHORE/CONFIG (technical + qa-smoke only).
  light: [
    'docs', 'documentation', 'readme', 'comment', 'typo', 'rename', 'chore',
    'bump', 'version bump', 'lint', 'formatting', 'format', 'whitespace',
    'config', 'gitignore', 'license', 'changelog',
  ],
  // tier -> which perspectives run + whether QA must drive a browser (Playwright).
  tiers: {
    full:     { product: true,  technical: true, qa: true, ux: true,  playwright: true },
    backend:  { product: true,  technical: true, qa: true, ux: false, playwright: false },
    light:    { product: false, technical: true, qa: true, ux: false, playwright: false },
    standard: { product: true,  technical: true, qa: true, ux: true,  playwright: true },
  },
};

// Count keyword hits from a list against a haystack (word-ish, case-insensitive).
function countSignals(hay, words) {
  const hits = [];
  for (const w of words) {
    const re = new RegExp('(?<![a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i');
    if (re.test(hay)) hits.push(w);
  }
  return hits;
}

// Classify an in_review story into a review-squad plan.
// Returns { tier, perspectives:{product,technical,qa,ux}, playwright, reason, signals }.
// tier:
//   'full'     — user-facing / UI change: product + technical + qa(Playwright) + ux.
//   'backend'  — headless api/service/data change: product + technical + qa (no ux).
//   'light'    — docs / chore / config / trivial: technical + qa-smoke only.
//   'standard' — default when signals are mixed/unknown: the full four (safe default,
//                honoring "each and every ticket" — we only drop a perspective on a
//                CLEAR backend/light signal, never on absence of signal).
export function reviewSquadPlan(issue = {}, cfg = {}) {
  const rules = (cfg && cfg.REVIEW_SQUAD_RULES) || DEFAULT_SQUAD_RULES;
  const labelNames = (issue.labels || [])
    .map((l) => (typeof l === 'string' ? l : (l && l.name) || ''))
    .join(' ');
  const hay = [issue.title, issue.description, labelNames, targetRepoValue(issue) || '']
    .filter((s) => typeof s === 'string')
    .join('\n')
    .toLowerCase();

  const uiHits = countSignals(hay, rules.ui || []);
  const backendHits = countSignals(hay, rules.backend || []);
  const lightHits = countSignals(hay, rules.light || []);

  // Decide the tier. UI signal wins (user-facing must get UX + Playwright). Then a
  // clear light-only change (light signals, no UI, no backend). Then backend. Else
  // the safe default: standard == full four perspectives.
  let tier;
  let reason;
  const signals = { ui: uiHits, backend: backendHits, light: lightHits };
  if (uiHits.length) {
    tier = 'full';
    reason = 'user-facing signals (' + uiHits.slice(0, 4).join(', ') + ') -> full squad + Playwright';
  } else if (lightHits.length && !backendHits.length) {
    tier = 'light';
    reason = 'docs/chore/config signals (' + lightHits.slice(0, 4).join(', ') + '), no product/UI surface -> technical + qa-smoke';
  } else if (backendHits.length) {
    tier = 'backend';
    reason = 'headless backend signals (' + backendHits.slice(0, 4).join(', ') + '), no user surface -> product + technical + qa (UX dropped: nothing to look at)';
  } else {
    tier = 'standard';
    reason = 'no decisive signal -> default full squad (each and every ticket baseline)';
  }

  const t = (rules.tiers && rules.tiers[tier]) || DEFAULT_SQUAD_RULES.tiers.standard;
  return {
    tier,
    perspectives: { product: !!t.product, technical: !!t.technical, qa: !!t.qa, ux: !!t.ux },
    playwright: !!t.playwright,
    reason,
    signals,
  };
}

// One-line human summary of a squad plan (for the dispatch log + ticket comment).
export function squadPlanSummary(plan) {
  const p = plan.perspectives;
  const on = ['product', 'technical', 'qa', 'ux'].filter((k) => p[k]);
  const qaTag = p.qa ? (plan.playwright ? 'qa+Playwright' : 'qa') : null;
  const parts = on.map((k) => (k === 'qa' ? qaTag : k));
  return `squad[${plan.tier}]: ${parts.join(' + ')} — ${plan.reason}`;
}
