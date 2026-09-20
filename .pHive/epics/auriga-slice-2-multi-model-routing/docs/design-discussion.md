# Design Discussion: Auriga Slice-2 — Multi-Model Routing

## Goal

Enable Auriga router to dispatch work to heterogeneous model backends (Claude, Codex, Gemini) based on task characteristics, agent capabilities, and lane configuration. This extends the current single-backend routing to support multi-provider infrastructure per Heimdall's model selection strategy.

## Current State Assessment

**What's delivered on dev:**
- Basic router with human-todo filtering, tree-aware routing
- Content integration API and file repository
- Project registry + state assessor
- Bulk triage scripts for codex-blocked stories and seed rerouting
- Single-backend dispatch (Claude-only assumed)

**What's missing (slice-1 vision lost):**
- Multi-model backend selection logic
- Model capability metadata (which models can handle which task types)
- Lane-to-model mapping configuration
- Dispatch adapter abstraction layer
- Cost/latency aware routing decisions

## Proposed Approach

### 1. Model Registry

Add `src/auriga/model-registry.ts` defining:
- Available models (Claude Sonnet/Opus, Codex, Gemini 2.0)
- Capability profiles (code generation, reasoning, speed, cost)
- Rate limits and availability status

### 2. Routing Strategy Layer

Extend `src/router/lib/core.mjs` with model selection:
- Task type → model affinity mapping (e.g., "generate tests" → Codex preferred)
- Fallback chains (primary model unavailable → secondary)
- Lane overrides (specific lanes force specific models)

### 3. Dispatch Adapter Interface

Create `src/router/adapters/` with:
- `IDispatchAdapter.ts` — common interface
- `ClaudeAdapter.ts` — existing Claude dispatch
- `CodexAdapter.ts` — OpenAI Codex dispatch
- `GeminiAdapter.ts` — Google Gemini dispatch

Each adapter handles auth, rate limiting, request formatting for its provider.

### 4. Configuration Surface

Add to `src/router/lib/config.mjs`:
- `MODEL_PREFERENCES` — per-lane model selection rules
- `MODEL_FALLBACK_CHAINS` — cascading fallback when primary unavailable
- `COST_LIMITS` — budget constraints per model/lane

### 5. Observability

Extend existing metrics with:
- Model selection decisions logged per dispatch
- Success/failure rates by model
- Cost tracking by model

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Auth token sprawl (3 providers) | Medium | Centralize credential management in config, support env-var injection |
| Increased complexity in dispatch path | High | Keep adapter interface minimal, extensive unit tests per adapter |
| Model availability flapping | Medium | Implement circuit breaker pattern, fallback chains |
| Cost explosion from incorrect routing | High | Add cost tracking, alerts when spend exceeds thresholds |

## Dependencies

- Heimdall model selection strategy (external reference)
- Auth credentials for Codex and Gemini (setup required)
- Existing router infrastructure (delivered in slice-1)

## Open Questions

1. **Q:** Should model selection be deterministic or allow ML-based routing optimization?
   **A:** Start deterministic (rule-based), reserve ML for future slice

2. **Q:** How to handle partial failures (some models unavailable)?
   **A:** Fallback chain with logging; human escalation if all models in chain fail

3. **Q:** Should we support parallel dispatch to multiple models for verification?
   **A:** Out of scope for slice-2; add in future observability epic

## Scale Assessment

**Recommendation: Medium**

- Multi-file changes across router, adapters, config
- Multiple layers (registry, strategy, adapters, config)
- Cross-stack (TypeScript + existing mjs modules)
- Needs H/V planning to slice correctly

## Success Criteria

1. Router successfully dispatches to Claude, Codex, or Gemini based on task type
2. Fallback chain works when primary model unavailable
3. Cost tracking observable per model
4. Zero regressions in existing single-backend dispatch
5. All three adapters have ≥80% test coverage
