// s14: loads every real tenant's config at RUNTIME from Pantheon's own
// GET /api/tenants/auriga-configs facade (core/api/tenants.ts, pantheon-v2),
// instead of a single AURIGA_CONFIG file baked into one container at build
// time. This is what lets one Auriga process serve every tenant.
//
// Merge semantics mirror config-substrate.mjs's own existing
// `_ext.<KEY> ?? default` pattern exactly -- a tenant's fetched config only
// ever overrides the substrate keys it actually returns (PROJECT_IDS/AGENTS/
// HIVE_LANE/DEFAULT_LANE/REVIEW_LANE); every other key (CAPS,
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
 * @returns {Promise<Array<{tenantId: string, cfg: object}>>}
 */
export async function loadTenantConfigs({ pantheonApiBaseUrl, baseCfg, fetchImpl = fetch }) {
  const res = await fetchImpl(`${pantheonApiBaseUrl}/api/tenants/auriga-configs`);
  if (!res.ok) {
    throw new Error(`loadTenantConfigs: GET /api/tenants/auriga-configs -> ${res.status}`);
  }
  const body = await res.json();
  const tenants = Array.isArray(body.tenants) ? body.tenants : [];
  return tenants.map(({ tenant_id: tenantId, config }) => ({
    tenantId,
    cfg: {
      ...baseCfg,
      PROJECT_IDS: config.PROJECT_IDS ?? baseCfg.PROJECT_IDS,
      AGENTS: config.AGENTS ?? baseCfg.AGENTS,
      HIVE_LANE: config.HIVE_LANE ?? baseCfg.HIVE_LANE,
      DEFAULT_LANE: config.DEFAULT_LANE ?? baseCfg.DEFAULT_LANE,
      REVIEW_LANE: config.REVIEW_LANE ?? baseCfg.REVIEW_LANE,
    },
  }));
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
