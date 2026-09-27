// PANT-388: mainMultiTenant() used to call buildAdaptersForTenant() inside
// its do...while, so every cycle got a fresh spawn adapter with an empty
// _decisions Map and reportRouteOutcome() silently no-op'd for every
// multi-tenant run. getTenantAdapters() keeps one adapter pair per tenant
// across cycles; these tests pin that a decision recorded by selectRoute()
// in cycle N is still reported in a later cycle, including across a
// config-driven rebuild.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let handler = () => { throw new Error('no handler set'); };
const calls = [];
mock.module('node:child_process', {
  namedExports: {
    execFileSync: (cmd, args) => {
      if (cmd !== 'curl') throw new Error('unexpected exec cmd: ' + cmd);
      const xIdx = args.indexOf('-X');
      const dIdx = args.indexOf('-d');
      const call = { method: args[xIdx + 1], url: args[xIdx + 2], body: dIdx === -1 ? undefined : JSON.parse(args[dIdx + 1]) };
      calls.push(call);
      const result = handler(call);
      return `${JSON.stringify(result.body)}\n${result.status}`;
    },
  },
});

const { getTenantAdapters } = await import('../auriga-router.mjs');

const TENANT_CFG = {
  CAPS: { verifyDelayMs: 0 },
  PROJECT_LANE: {},
  DEFAULT_LANE: ['default-lane'],
  HIVE_LANE: ['hive-lane'],
  REVIEW_LANE: ['review-lane'],
  RUNTIME_CAP: { codex: 5 },
};

function routeHandler({ url }) {
  if (url.includes('/api/route/select')) return { status: 200, body: { decision_id: 'dec-7', chosen_lane: 'build' } };
  if (url.includes('/api/route/dec-7/outcome')) return { status: 200, body: { ok: true } };
  throw new Error('unexpected url: ' + url);
}

function outcomeCalls() {
  return calls.filter((c) => c.url.includes('/api/route/dec-7/outcome'));
}

test('getTenantAdapters: same tenant + unchanged config returns the same adapter instances across cycles', () => {
  const cache = new Map();
  const a = getTenantAdapters(cache, 't1', TENANT_CFG);
  const b = getTenantAdapters(cache, 't1', { ...TENANT_CFG });
  assert.equal(a.spawn, b.spawn);
  assert.equal(a.backlog, b.backlog);
  const other = getTenantAdapters(cache, 't2', TENANT_CFG);
  assert.notEqual(other.spawn, a.spawn);
});

test('getTenantAdapters: decision_id stored in cycle N is reported in cycle N+1', () => {
  calls.length = 0;
  handler = routeHandler;
  const cache = new Map();

  // cycle N: dispatch
  getTenantAdapters(cache, 't1', TENANT_CFG).spawn.selectRoute('PAN-1', 'build');
  // cycle N+1: verified done -> outcome report
  getTenantAdapters(cache, 't1', TENANT_CFG).spawn.reportRouteOutcome('PAN-1', 'success');

  assert.equal(outcomeCalls().length, 1);
  assert.deepEqual(outcomeCalls()[0].body, { outcome: 'success' });
});

test('getTenantAdapters: a tenant config change rebuilds the adapters but keeps pending decisions', () => {
  calls.length = 0;
  handler = routeHandler;
  const cache = new Map();

  const before = getTenantAdapters(cache, 't1', TENANT_CFG);
  before.spawn.selectRoute('PAN-1', 'build');

  const changedCfg = { ...TENANT_CFG, DEFAULT_LANE: ['new-lane'] };
  const after = getTenantAdapters(cache, 't1', changedCfg);
  assert.notEqual(after.spawn, before.spawn, 'changed lane config must rebuild the spawn adapter');
  assert.deepEqual(after.spawn.describeLanes().defaultLane, ['new-lane']);

  after.spawn.reportRouteOutcome('PAN-1', 'success');
  assert.equal(outcomeCalls().length, 1);
});

test('getTenantAdapters: decision stores are per tenant', () => {
  calls.length = 0;
  handler = routeHandler;
  const cache = new Map();

  getTenantAdapters(cache, 't1', TENANT_CFG).spawn.selectRoute('PAN-1', 'build');
  assert.equal(getTenantAdapters(cache, 't2', TENANT_CFG).spawn.reportRouteOutcome('PAN-1', 'success'), null);
  assert.equal(outcomeCalls().length, 0);
});
