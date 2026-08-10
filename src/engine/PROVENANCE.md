# Auriga routing-engine — provenance

This is the Auriga **routing engine** (the `auriga/` module), recovered from
`mdostal/pantheon-orchestrator` (now **LEGACY**) and moved here to its rightful
home, `mdostal/auriga`. Recovered from the durability bundles at
`~/durability-recovery/20260727-090009/` and the `recovered/*` branches on
`mdostal/pantheon-orchestrator`.

## `auriga/` — primary engine snapshot

Full 46-file snapshot from commit **93eee10** (`PAN-5578: provision Auriga
verifier pool`), the richest self-consistent line (P2 board-state-machine +
verifier pool + auto-dispatch wiring + observability). Recovered branch:
`recovered/93eee10`. Bundle:
`pantheon-orchestrator__86349eac__agent_auriga-dev_86349eac-pan-5578-verifier-pool.bundle`.

Contents: `consumer/` (board-state consumer), `adapters/{multica,db}/`,
`escalation/`, `lock/` (cross-instance), `observability/` (counters, death
detection, attribution), `run.ts` (composition root), `README.md`.

## `recovered-patches/` — the 5 parallel PAN commits

These five commits are single-commit siblings off shared base `fb9fc93`; they
touch overlapping files (`run.ts`, `consumer/index.ts`), so each is captured as
its exact diff (verbatim, lossless) rather than force-merged. Apply against the
`fb9fc93` `auriga/` base when integrating.

| PAN | SHA | Subject | recovered branch |
|-----|-----|---------|------------------|
| 5575 | bc9ef04 | add health-aware lane routing | recovered/bc9ef04 |
| 5576 | f16ce8b | subscribe Auriga to board transitions | recovered/f16ce8b |
| 5577 | 085b7ca | add role-tree Multica dispatch | recovered/085b7ca |
| 5579 | fb5dd6b | document cross-instance lock boundary | recovered/fb5dd6b |
| 5580 | b903bec | emit dispatch decisions and metrics | recovered/b903bec |

(PAN-5578 = 93eee10 is materialized as the full `auriga/` snapshot above.)

## Status

Not yet wired into `src/router/`. Integration (unify engine + running router)
is future work; the priority of this move was durable custody in `mdostal/auriga`.
