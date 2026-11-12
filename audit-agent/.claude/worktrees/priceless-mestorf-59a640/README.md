# Audit Agent

A graph-engineered multi-agent system that audits a live website (kenresearch.com) against the Ken Design System and reports compliance — visually in Figma and as a complete structured Excel report.

**Status:** architecture (v1.3) and Phase 2 implementation plan approved; **Phase 2 build in progress.** Foundation and the D-layer (D1–D6, read-only against the real Design System) are built and tested — 55 passing tests. T-layer/B-graph/C1–C4/A-graph are next, per `docs/IMPLEMENTATION-PLAN.md` §10's build sequence. C3's screenshot-upload step is deliberately deferred — see §6, image rendering is a confirmed, unresolved Figma-side issue.

## Running an audit — no API key needed

v1 runs in **`AI_MODE=no-api`** by default (ARCHITECTURE.md §5.4, Decision Log #31): every AI node runs a deterministic strategy — Playwright capture, DOM/computed CSS, the Design System's own source, tokens and rules — with **zero model API calls** and no credential. Anything that cannot be proven without semantic judgment is reported as **NEEDS REVIEW** or **UNVERIFIED**, never guessed.

```bash
pnpm audit-page https://www.kenresearch.com/consulting/strategy-consulting/market-entry-consulting
```

The optional Claude path is kept intact but disabled: set `AI_MODE=anthropic-api` and `ANTHROPIC_API_KEY` (in the gitignored `.env`) to use it.

Every run writes its outputs in priority order — **P1 Figma** (`figma-plan.json`/`figma-composite-plan.json`/`figma-ops.json` — the deterministic plan and operation list; NOT a completed Figma deliverable by themselves, see [`docs/FIGMA-PUBLISH-RUNBOOK.md`](docs/FIGMA-PUBLISH-RUNBOOK.md) for the live-session replay that actually publishes), **P2 standalone HTML** (`report.html`, evidence embedded as data URIs, opens with no server), **P3 C2 JSON** (`data.json`, canonical, also read by the local dashboard), **P4 Excel** (`report.xlsx`). Regenerate just the Figma artifacts for an existing run without re-auditing with `pnpm run agent figma-plan <runId>`.

## Where things are

| Path | What |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The system — nodes, edges, contracts, skills, failure/retry, concurrency, output model (v1.3, incl. the C4 Local Audit Dashboard) |
| [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) | The code-level plan — tech choices, dependencies, module layout, schemas, build sequence |
| [`docs/FIGMA-PUBLISH-RUNBOOK.md`](docs/FIGMA-PUBLISH-RUNBOOK.md) | How a live, Figma-MCP-authenticated session actually publishes `figma-ops.json` (`src/figma/publish-ops.ts`) and verifies it (`src/figma/publish-verify.ts`) |
| [`workflows/AUDIT-AGENT-WORKFLOW.md`](workflows/AUDIT-AGENT-WORKFLOW.md) | The runbook — how to invoke it, what each gate asks of a human, where results land |
| [`docs/RESEARCH-REFERENCES.md`](docs/RESEARCH-REFERENCES.md) | 54 authoritative sources the design is grounded in |
| [`docs/VALIDATION-NOTES.md`](docs/VALIDATION-NOTES.md) | Real-page dry-run walkthroughs that shaped several fixes |
| [`src/`](src/) | Implementation — see `docs/IMPLEMENTATION-PLAN.md` §5 for the full module map |
| [`projects/`](projects/) | Audit output — one folder per audit target, one run folder per execution |

## Relationship to Project Aura

This is a standalone repo, a sibling of `/Users/sachin/Project-aura/project_aura1-main/` — not nested in it. It **reads** the Design System at `project_aura1-main/design-system/` through a configurable path and never copies it. Project Aura and Loop Engineering are unaffected by this repo.
