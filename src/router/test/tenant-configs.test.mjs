// s14: loadTenantConfigs() / rotate() -- the two pure pieces mainMultiTenant()
// needs to discover real tenants at runtime instead of one AURIGA_CONFIG file
// baked into a container at build time. See ../lib/tenant-configs.mjs and
// .pHive/epics/pantheon-all-gods-stood-up/docs/s14-consolidation-design.md
// (pantheon-v2 repo) for the full design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTenantConfigs, rotate } from '../lib/tenant-configs.mjs';

function fakeFetch(handler) {
  return async (url) => handler(String(url));
}

const BASE_CFG = {
  CAPS: { verifyDelayMs: 500 },
  PROJECT_IDS: ['default-project'],
  AGENTS: { 'default-agent': { id: 'a1' } },
  HIVE_LANE: ['default-hive'],
  DEFAULT_LANE: ['default-lane'],
  REVIEW_LANE: ['default-review'],
  PROJECT_LANE: {},
  RUNTIME_CAP: { codex: 5 },
};

test('loadTenantConfigs: calls GET /api/tenants/auriga-configs and returns one {tenantId, cfg} per tenant', async () => {
  const fetchImpl = fakeFetch((url) => {
    assert.equal(url, 'http://core-api:3012/api/tenants/auriga-configs');
    return new Response(JSON.stringify({
      tenants: [
        { tenant_id: 'dostal-tech', config: { PROJECT_IDS: ['p1', 'p2'] } },
        { tenant_id: 'personal', config: { PROJECT_IDS: ['p3'] } },
      ],
    }), { status: 200 });
  });

  const result = await loadTenantConfigs({ pantheonApiBaseUrl: 'http://core-api:3012', baseCfg: BASE_CFG, fetchImpl });

  assert.equal(result.length, 2);
  assert.equal(result[0].tenantId, 'dostal-tech');
  assert.deepEqual(result[0].cfg.PROJECT_IDS, ['p1', 'p2']);
  // Non-substrate keys come from the base cfg, untouched -- real, shared global policy.
  assert.equal(result[0].cfg.CAPS, BASE_CFG.CAPS);
});

test('loadTenantConfigs: a tenant config missing a substrate key falls back to the base cfg default (mirrors config-substrate.mjs\'s own _ext.KEY ?? default pattern)', async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({
    tenants: [{ tenant_id: 'firefly-events', config: { PROJECT_IDS: ['p1'] } }], // no AGENTS/HIVE_LANE/etc.
  }), { status: 200 }));

  const [{ cfg }] = await loadTenantConfigs({ pantheonApiBaseUrl: 'http://core-api:3012', baseCfg: BASE_CFG, fetchImpl });

  assert.deepEqual(cfg.AGENTS, BASE_CFG.AGENTS);
  assert.deepEqual(cfg.HIVE_LANE, BASE_CFG.HIVE_LANE);
  assert.deepEqual(cfg.DEFAULT_LANE, BASE_CFG.DEFAULT_LANE);
  assert.deepEqual(cfg.REVIEW_LANE, BASE_CFG.REVIEW_LANE);
});

test('loadTenantConfigs: a tenant WITH its own AGENTS/lanes overrides the base cfg default (auriga_lane_agents passthrough)', async () => {
  const fetchImpl = fakeFetch(() => new Response(JSON.stringify({
    tenants: [{
      tenant_id: 'firefly-events',
      config: { PROJECT_IDS: ['p1'], AGENTS: { 'ffe-dev': { id: 'ffe-1' } }, HIVE_LANE: ['ffe-dev'] },
    }],
  }), { status: 200 }));

  const [{ cfg }] = await loadTenantConfigs({ pantheonApiBaseUrl: 'http://core-api:3012', baseCfg: BASE_CFG, fetchImpl });

  assert.deepEqual(cfg.AGENTS, { 'ffe-dev': { id: 'ffe-1' } });
  assert.deepEqual(cfg.HIVE_LANE, ['ffe-dev']);
  // Untouched key still falls back.
  assert.deepEqual(cfg.REVIEW_LANE, BASE_CFG.REVIEW_LANE);
});

test('loadTenantConfigs: throws with the real status code on a non-ok response', async () => {
  const fetchImpl = fakeFetch(() => new Response('', { status: 503 }));
  await assert.rejects(
    () => loadTenantConfigs({ pantheonApiBaseUrl: 'http://core-api:3012', baseCfg: BASE_CFG, fetchImpl }),
    /503/,
  );
});

test('rotate: no-op on an empty array', () => {
  assert.deepEqual(rotate([], 3), []);
});

test('rotate: shifts the start position by offset, wrapping around', () => {
  assert.deepEqual(rotate(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(rotate(['a', 'b', 'c'], 1), ['b', 'c', 'a']);
  assert.deepEqual(rotate(['a', 'b', 'c'], 2), ['c', 'a', 'b']);
  assert.deepEqual(rotate(['a', 'b', 'c'], 3), ['a', 'b', 'c']);
});

test('rotate: successive calls with an incrementing offset put a different tenant last each time (no single tenant permanently pays the "scanned last" latency penalty)', () => {
  const tenants = ['t1', 't2', 't3'];
  const lastOfEach = [0, 1, 2, 3].map((offset) => rotate(tenants, offset).at(-1));
  assert.deepEqual(lastOfEach, ['t3', 't1', 't2', 't3']);
});
