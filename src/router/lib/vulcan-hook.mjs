// Auriga → Vulcan hook (separable; NEW file so it never conflicts with the
// router core's other passes).
//
// The orchestrator only routes — it never provisions. When a routed story carries
// a `target_repo:` whose repo does not yet exist / is not provisioned, dispatching
// it wastes a run (the agent clones a missing or empty repo and fails — the exact
// money-lab / PAN-6605 failure mode). This hook lets the router ensure the target
// repo is buildable via Vulcan BEFORE it dispatches.
//
// Wiring (single guarded line) — in auriga-router.mjs, inside the todo-dispatch
// loop, right before an assignment is fired for a story `i`:
//
//     import { ensureTargetRepo } from './lib/vulcan-hook.mjs';
//     ...
//     const slug = core.normalizeRepoSlug(core.targetRepoValue(i) || '');
//     if (slug && !DRY) ensureTargetRepo(slug, { log });   // idempotent; no-op if already provisioned
//
// ensureTargetRepo is idempotent and fast when the repo is already provisioned
// (Vulcan probes state and runs only missing steps), so calling it on every
// dispatch is safe.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const VULCAN_BIN = process.env.VULCAN_BIN
  || path.join(os.homedir(), 'Documents/work/dostal/code/vulcan/bin/vulcan.mjs');

/**
 * Ensure `slug` (owner/repo) is provisioned so a build story can land.
 * Returns true on success. Never throws — a provisioning hiccup must not abort
 * the router cycle; it logs and lets the normal dispatch/verify path proceed.
 */
export function ensureTargetRepo(slug, { log = () => {}, noSeed = false } = {}) {
  if (!slug) return false;
  try {
    const args = [VULCAN_BIN, 'provision', slug];
    if (noSeed) args.push('--no-seed');
    const out = execFileSync('node', args, { encoding: 'utf8', timeout: 180000 });
    log('vulcan_provision', { slug, ok: true });
    return true;
  } catch (e) {
    log('vulcan_provision_error', { slug, error: String(e.message || e).slice(0, 300) });
    return false;
  }
}
