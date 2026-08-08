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

## Job-Hunt Toolkit: Resume Judge

The resume judge evaluates a resume against a job description and emits
dashboard-ready JSON with skill gaps, positioning opportunities, market-cluster
fit, and ideal-market setup prompts.

```sh
npm test
npm run build
node src/tools/resume-judge.ts --resume ./resume.md --job ./job.md --profile ./APPLICATION-KIT.md
```

`--profile` is optional. Use it for a canonical proof bank or positioning file
when one exists; the judge only derives ideal-market recommendations from the
resume/profile text provided at runtime.

The JSON output shape is:

```json
{
  "summary": {
    "fit_score": 0,
    "matched_required_skills": 0,
    "total_required_skills": 0,
    "strongest_market_cluster": null
  },
  "skill_gaps": [],
  "positioning_opportunities": [],
  "market_clusters": [],
  "ideal_market_profile": {
    "strongest_clusters": [],
    "differentiators": [],
    "target_role_keywords": [],
    "setup_questions": []
  }
}
```

## Content File Repository

Draft content persistence uses `FileRepository` from `src/repository`. Each
content item is stored as a separate JSON document under:

```text
.content/
`-- content/
    `-- {id}.json
```

The repository writes files atomically by writing a temporary file in the same
directory and then renaming it into place. Content IDs are limited to
filesystem-safe letters, numbers, dots, underscores, and hyphens.
