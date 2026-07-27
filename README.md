# Auriga

Auriga is a **Pantheon plugin** — the routing / dispatch god. It lives in its
own repo (`mdostal/auriga`) and is bound into the framework by Pantheon
(`mdostal/pantheon-v2`). Every plugin owns its own repo; Pantheon is the
framework that binds plugins together.

> Note: `mdostal/pantheon-orchestrator` is **LEGACY**. Auriga code that used to
> live there has been moved here.

## Layout

- `src/router/` — the **auto-router**: the running decide+assign layer that
  self-drains the Multica board by routing unassigned todos to Pantheon swarm
  agents. This is the process that runs live on the hive. See
  `src/router/README.md`.
- `src/engine/` — the **routing engine** (`auriga/` module recovered from
  `pantheon-orchestrator`): board-state consumer, adapters (Multica / DB),
  escalation, cross-instance lock, observability counters, verifier pool. Lives
  on the `feat/routing-engine` branch until integrated with the router.

## Role

Auriga = the PM/router of the Pantheon pipeline: it senses board state and
routes/dispatches work to the right lane and agents.
