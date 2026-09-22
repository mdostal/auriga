// s14: loads every real tenant's config at RUNTIME from Pantheon's own
// GET /api/tenants/auriga-configs facade (core/api/tenants.ts, pantheon-v2),
// instead of a single AURIGA_CONFIG file baked into one container at build
// time. This is what lets one Auriga process serve every tenant.
//
// Merge semantics mirror config-substrate.mjs's own existing
// `_ext.<KEY> ?? default` pattern exactly -- a tenant's fetched config only
// ever overrides the substrate keys it actually returns (PROJECT_IDS/AGENTS/
// HIVE_LANE/DEFAULT_LANE/REVIEW_LANE/PROJECT_LANE); every other key (CAPS,
// MODEL_PREFERENCES, HUMAN_NAMES, REVIEW_SQUAD_RULES, ...) is real, shared
// GLOBAL policy and is never tenant-specific -- taken from the base `cfg`
// module unchanged, not duplicated per tenant.

/**
 * @param {object} opts
 * @param {string} opts.pantheonApiBaseUrl
 * @param {object} opts.baseCfg - the base config module (cfg), providing every
 *   non-substrate default (CAPS, MODEL_PREFERENCES, etc.) plus fallback
 *   substrate defaults for any tenant that omits a given key.
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {Set<string> | null} [opts.allowlist] - when set, only tenant_ids in
 *   this set are returned; every other real tenant the facade reports is
 *   silently skipped. Real safety gap found live during s14's own first
 *   deploy (2026-09-21): the facade returns EVERY tenant with
 *   auriga_project_ids set, including ones an existing standalone
 *   container is already actively dispatching (firefly-events) -- running
 *   this loop against one of those risks a genuine double-dispatch race
 *   with that other process. `null` (the default) means "every tenant the
 *   facade returns" -- the deliberate, later, full-rollout mode once the
 *   standalone containers for a given tenant have actually been retired.
 * @returns {Promise<Array<{tenantId: string, cfg: object}>>}
 */
export async function loadTenantConfigs({ pantheonApiBaseUrl, baseCfg, fetchImpl = fetch, allowlist = null }) {
  const res = await fetchImpl(`${pantheonApiBaseUrl}/api/tenants/auriga-configs`);
  if (!res.ok) {
    throw new Error(`loadTenantConfigs: GET /api/tenants/auriga-configs -> ${res.status}`);
  }
  const body = await res.json();
  const allTenants = Array.isArray(body.tenants) ? body.tenants : [];
  const tenants = allowlist ? allTenants.filter((t) => allowlist.has(t.tenant_id)) : allTenants;
  return tenants.map(({ tenant_id: tenantId, config }) => {
    const c = config ?? {};
    return {
      tenantId,
      cfg: {
        ...baseCfg,
        PROJECT_IDS: c.PROJECT_IDS ?? baseCfg.PROJECT_IDS,
        AGENTS: c.AGENTS ?? baseCfg.AGENTS,
        HIVE_LANE: c.HIVE_LANE ?? baseCfg.HIVE_LANE,
        DEFAULT_LANE: c.DEFAULT_LANE ?? baseCfg.DEFAULT_LANE,
        REVIEW_LANE: c.REVIEW_LANE ?? baseCfg.REVIEW_LANE,
        PROJECT_LANE: c.PROJECT_LANE ?? baseCfg.PROJECT_LANE,
      },
    };
  });
}

/**
 * Rotates the start of an array by one position per call, so a fixed
 * iteration order doesn't always put the same tenant last (s14 design
 * doc §4 -- the "last tenant scanned" gets the worst effective redispatch
 * latency in a sequential per-cycle loop; rotating spreads that penalty
 * instead of pinning it to one tenant every single cycle).
 * @template T
 * @param {T[]} arr
 * @param {number} offset
 * @returns {T[]}
 */
export function rotate(arr, offset) {
  if (arr.length === 0) return arr;
  const n = ((offset % arr.length) + arr.length) % arr.length;
  return [...arr.slice(n), ...arr.slice(0, n)];
}
