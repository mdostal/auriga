# Research Brief: UI for Auriga

**Epic:** p3-auriga-ui
**Requirement:** "UI for auriga" — informed by the recorded north_star vision
(`.pHive/project-profile.yaml` and memory `project_future_ui_vision.md`): a v0.dev-style,
LLM-in-browser, shadcn/ui-based, self-building queue UI, standalone-capable.

## 1. Current state — there is no UI, and no build tooling of any kind

Confirmed via direct inspection:
- Root `package.json` and `src/router/package.json` declare zero dependencies. `node
  --version` on this machine is v24.18.1 (built-in `fetch`, `node:http`, `node:test`
  available with no install).
- No React, Vite, Next.js, Express, or any frontend/HTTP-server tooling exists anywhere
  in the repo. `grep`ing for these across `src/` and both `package.json`s returns
  nothing.
- `.pHive/` already holds real, structured state a dashboard would read: `epics/`
  (research briefs, design discussions, story YAMLs with `status:`), `audits/post-run/`
  (plan + execute run records), `cycle-state/`, `episodes/`. All flat YAML/Markdown on
  disk — no database, no API today.
- This is Auriga's FIRST departure from the "zero build tooling" convention documented
  in `.pHive/CONTEXT.md` if a real frontend framework/bundler is adopted — that decision
  needs to be explicit in the design discussion, not assumed.

## 2. What "v0.dev-style" actually means (verified, not marketing language)

Per dedicated research (web + prior-art search): v0.dev generates real React/Tailwind
source code from chat, rendered in a sandboxed live-preview environment (à la
CodeSandbox/StackBlitz). A **separate, more constrained, and far more buildable**
pattern exists — Vercel AI SDK's "generative UI" (`streamUI`/RSC): the LLM makes tool
calls that select from a **fixed palette of pre-built components + props**; it does not
write arbitrary code. This is a server-side component registry driven by LLM tool
calls, not code generation.

Three real implementation patterns exist, in increasing order of ambition/risk:
1. **Component registry + LLM tool-calling** — LLM picks component + props from a fixed
   set; zero code-execution risk; realistically shippable in one epic.
2. **Sandboxed iframe eval** — LLM emits JSX/HTML/JS rendered client-side via
   `iframe.srcdoc`; no disk writes; needs an in-browser JSX compiler (esbuild-wasm,
   Sucrase).
3. **Generate-to-disk + hot reload** — LLM writes real files, a dev server (Vite
   middleware mode) rebuilds/HMRs. This is what the recorded vision (and tools like
   Dyad) actually do — but requires a full frontend build toolchain.

## 3. shadcn/ui — confirmed mechanics and the hard constraint

shadcn/ui is **not an npm package** — its CLI copies component source directly into the
consuming repo (you own/edit the files; `npm update` never touches them). It **requires
Tailwind CSS** (a real CSS build step — PostCSS or a bundler plugin) plus a React
project with path aliases. **There is no way to adopt shadcn/ui without a build
pipeline.** This directly conflicts with Auriga's current zero-build-tooling backend
philosophy and is the single biggest architectural fork this epic's design discussion
must resolve explicitly: accept a separate frontend build package (Vite + Tailwind +
shadcn, isolated from the zero-dep Node backend), or defer shadcn/ui and start with
plain server-rendered HTML + a lighter design approach.

## 4. Real prior art (verified projects, not vague categories)

- **Dyad** (`github.com/dyad-sh/dyad`) — closest architectural match: Electron desktop
  app, Vite + React + shadcn/ui + Tailwind, a sandbox-worker for executing/previewing
  generated apps, BYOK across multiple LLM providers. Genuinely standalone/local — the
  best single reference for the full long-term vision's shape.
- **Onlook** (`github.com/onlook-dev/onlook`) — visual editor for React; iframe preview
  of a running sandbox with DOM-to-source instrumentation for click-to-edit. Useful
  reference for the "sandbox + iframe + bidirectional sync" mechanism specifically.
- **v0.diy** (`github.com/SujalXplores/v0.diy`) — weak prior art: it's a self-hosted
  wrapper UI around Vercel's own hosted v0 API (needs a v0.app key, not a general LLM
  key), not a self-contained generator.
- **Open WebUI, LibreChat, LobeChat** — not UI-generators, but solid prior art for the
  "local self-hosted chat panel with multi-provider BYOK" half of an MVP.

## 5. BYOK / LLM API key handling — the established pattern

Every real self-hosted tool surveyed (Dyad, Warp's agent platform docs, etc.) proxies
LLM calls **server-side** — the browser never holds the API key directly (trivially
exfiltrated otherwise). Key stored in local config/env/OS keychain, server-side process
makes the actual Anthropic/OpenAI call, browser talks only to the local server.

## 6. A sane MVP cut (the research's own recommendation)

Ship two decoupled pieces in one epic, explicitly NOT the full self-building vision:
(a) a live dashboard reading `.pHive/` state (epics/stories/audit log — the actual
"what did Auriga do" log the operator asked about), and (b) a chat panel, LLM calls
proxied server-side (BYOK), using **tool-calling against Auriga's own read surface**
(pattern 1 above — component-registry/genUI, not code generation). Explicitly defer
code-gen/hot-reload/self-modifying UI (pattern 3, the "real" v0-style mechanism) to a
follow-on epic. The shadcn/ui-vs-build-tooling fork must be resolved before stories are
written — it's the epic's central architectural decision.

## Open items for design discussion

- Resolve the build-tooling fork: adopt a separate frontend package (Vite + Tailwind +
  shadcn) vs. stay build-free with server-rendered HTML for v1.
- Decide the LLM provider/key-handling approach for the chat panel (which provider(s),
  where the key lives, how it's configured).
- Decide the "self-building" scope for THIS epic specifically: full deferral to pattern
  1 (component registry) only, or something in between.
- Decide how the dashboard's data layer works: does Auriga need a real HTTP server now
  (first departure from being a pure background daemon), and if so, does it run
  alongside the existing supervised router process or as a separate process?
- Per the epic's own adapter-boundary-integrity principle
  (`.pHive/cross-cutting-concerns.yaml`): does the UI talk to Auriga's core through the
  `backlogAdapter`/`spawnAdapter` interfaces already built in `p2-adapter-interface`, or
  does it read `.pHive/` state files directly? (Likely both — state files for the "log
  of what happened" view, adapters for anything that triggers action — needs an explicit
  decision.)
