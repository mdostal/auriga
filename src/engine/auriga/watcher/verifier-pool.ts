import type { VerifierPoolEntry } from "./verification-swarm.ts";

/**
 * Dedicated live Multica verifier identities for project Auriga.
 *
 * Provisioned 2026-07-27 for PAN-5578:
 * - auriga-verifier-a: d2097159-285c-43b8-86c7-4a2a5cb1d5d9
 * - auriga-verifier-b: 25238152-6c2f-4959-bd05-7e53532c3969
 *
 * `VerificationSwarmDispatcher` defaults N to `verifierPool.length`, so this
 * two-entry pool creates N=2 staged sub-issues with distinct agent assignees.
 */
export const AURIGA_VERIFIER_POOL = [
  { id: "d2097159-285c-43b8-86c7-4a2a5cb1d5d9", type: "agent" },
  { id: "25238152-6c2f-4959-bd05-7e53532c3969", type: "agent" },
] as const satisfies readonly VerifierPoolEntry[];
