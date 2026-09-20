// Model selection routing strategy — decides which model backend (Claude,
// Codex, Gemini, ...) a task should be dispatched to.
//
// Decision order:
//   1. Lane override (explicit operator intent) always wins, no fallback.
//   2. Task type affinity (MODEL_PREFERENCES), if the preferred model is
//      healthy.
//   3. Linear fallback chain (MODEL_FALLBACK_CHAINS) for the preferred
//      model, first healthy entry wins.
//   4. NoAvailableModelError if nothing in the chain is healthy.
//
// PURE decision logic aside from the injected health checker, which is the
// one piece of real-world state (a model backend being up or down).

import { modelRegistry as defaultModelRegistry } from '../../auriga/model-registry.ts';
import { MODEL_PREFERENCES, MODEL_FALLBACK_CHAINS } from './config.mjs';

export class NoAvailableModelError extends Error {
  constructor(message = 'No available model found in fallback chain') {
    super(message);
    this.name = 'NoAvailableModelError';
  }
}

const HEALTH_CACHE_TTL_MS = 60_000;

// Caches model health so repeated selectModel() calls don't re-probe every
// backend on every task. Design decision: 60s TTL balances freshness vs
// overhead of constant health pings (see s2-routing-strategy story).
export class ModelHealthChecker {
  constructor(probe = () => true, ttlMs = HEALTH_CACHE_TTL_MS) {
    this.probe = probe;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // modelName -> { healthy, checkedAt }
  }

  isAvailable(modelName, now = Date.now()) {
    const cached = this.cache.get(modelName);
    if (cached && now - cached.checkedAt < this.ttlMs) {
      return cached.healthy;
    }
    const healthy = !!this.probe(modelName);
    this.cache.set(modelName, { healthy, checkedAt: now });
    return healthy;
  }

  // Drop a cached result so the next isAvailable() call re-probes.
  invalidate(modelName) {
    this.cache.delete(modelName);
  }
}

// Shared default checker. Probe defaults to "always healthy" since this
// repo has no live model backends wired in yet; callers doing real dispatch
// should construct their own ModelHealthChecker with a real probe.
export const defaultHealthChecker = new ModelHealthChecker();

function requireKnownModel(name, modelRegistry) {
  if (!modelRegistry.hasModel(name)) {
    const known = modelRegistry.listModels().map((m) => m.name).join(', ');
    throw new Error(`Unknown model "${name}" in routing configuration. Known models: ${known}`);
  }
  return name;
}

// Preferred model name for a task type, falling back to the "default" entry.
export function getPreferredModel(taskType) {
  return MODEL_PREFERENCES[taskType] || MODEL_PREFERENCES.default;
}

// Select which model to dispatch a task to.
//   task: { type, ... } — task.type drives MODEL_PREFERENCES lookup.
//   laneOverride: explicit model name (e.g. from a lane's MODEL= env var),
//     or falsy to use task-type affinity.
//   modelRegistry: ModelRegistry instance (see src/auriga/model-registry.ts).
//   healthChecker: object with isAvailable(modelName): boolean.
export function selectModel(
  task,
  laneOverride,
  modelRegistry = defaultModelRegistry,
  healthChecker = defaultHealthChecker
) {
  // 1. Lane override wins — explicit operator intent overrides heuristics,
  // and is not subject to fallback.
  if (laneOverride) {
    return requireKnownModel(laneOverride, modelRegistry);
  }

  // 2. Task type affinity.
  const taskType = task && task.type;
  const preferred = requireKnownModel(getPreferredModel(taskType), modelRegistry);
  if (healthChecker.isAvailable(preferred)) {
    return preferred;
  }

  // 3. Linear fallback chain.
  const chain = MODEL_FALLBACK_CHAINS[preferred] || [];
  for (const fallback of chain) {
    if (!modelRegistry.hasModel(fallback)) continue;
    if (healthChecker.isAvailable(fallback)) {
      return fallback;
    }
  }

  // 4. Nothing in the chain is healthy.
  throw new NoAvailableModelError(
    `No available model for task type "${taskType}". Preferred "${preferred}" and fallbacks [${chain.join(', ')}] are all unavailable.`
  );
}
