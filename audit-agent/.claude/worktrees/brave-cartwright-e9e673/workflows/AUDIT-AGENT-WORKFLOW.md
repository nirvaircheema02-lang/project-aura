# Audit Agent — Operating Workflow

**Companion to:** [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) (the system's structure — nodes, edges, contracts, skills). This document is the runbook: how to invoke and operate the Audit Agent, not what it's made of.

## Entry points
- `/audit-site <url>` — full-site mode
- `/audit-page <url>` — single-page mode

Per `ARCHITECTURE.md` §0: `mode` is explicit and is the sole routing source of truth — never inferred from URL shape.

## Full-site sequence
1. Provide `url` (site root) + `mode=full-site`.
2. A1 Site Mapper discovers/canonicalizes URLs → `site-map.json`.
3. A2 Template Classifier groups pages into template families.
4. **Scope Confirmation Gate** — reviewer sees estimated page/template count + B-instance count, approves or adjusts scope before dispatch. Skippable for trusted re-audits.
5. A3 Audit Dispatcher fans out parallel B instances (bounded concurrency, own `BrowserContext` each).
6. Each B instance runs the Page Audit sequence (below).
7. A4 Site Consolidator merges results, dedupes, finds root causes, builds the Master Result.
8. **Publish Confirmation Gate** — reviewer sees the Master Result before C3 writes to Figma.
9. C3 publishes to Figma, C1 writes the Excel report, and C4 serves the run at its local dashboard URL — **all three mandatory**. C2 persists JSON (internal backing data; also what C4 reads).

## Single-page sequence
1. Provide `url` (exact page) + `mode=single-page`. The URL is canonicalized first (`ARCHITECTURE.md` §0).
2. B1–B6 run directly — A1–A4 are never invoked, regardless of `url`.
3. If a previous baseline exists for this URL, diff into NEW ISSUE / STILL OPEN / RESOLVED / REGRESSION.
4. **Publish Confirmation Gate** — same gate as full-site, keyed to "before C3," never to A4 (A4 doesn't run on this path).
5. C3 publishes to Figma, C1 writes the Excel report, and C4 serves the run at its local dashboard URL — **all three mandatory**. C2 persists JSON (internal backing data; also what C4 reads).

## Page Audit sequence (B1–B6, shared by both modes)
B1 Page Analyzer → B2 Component Detector → B3 DS Matcher → conditional:
- match found, confidence ≥ MEDIUM → B4 Compliance Auditor → B5 Visual Verifier
- no match, or confidence LOW → B6 New Component Evaluator

Low-confidence outputs at B3/B5/B6 route to the Escalation Queue instead of publishing directly.

## Gates — what a human actually does

| Gate | When | Reviewer sees | Decision |
|---|---|---|---|
| Scope Confirmation | full-site only, before A3 dispatch | template families, page count, estimated B-instance count | approve / adjust scope |
| Publish Confirmation | both modes, before C3 | the Master Result (full-site) or Current Page Result/re-audit delta (single-page) | approve / hold |
| Failure Threshold | full-site only, if batch failure rate crosses threshold | trial-batch result after automatic half-open retry | approve continued run / abort |

All three time out to a fallback reviewer — never auto-approve, never auto-reject.

## Escalation Queue review
Findings with `reason: LOW_CONFIDENCE` or `reason: NODE_FAILURE` sit in `escalation_queue[]` until reviewed; a `RESOLVED` outcome feeds back into the run's finding set.

Expect to see placeholder-looking dynamic values here too (e.g. a stat counter still reading "0+" after settling) — per `ARCHITECTURE.md` §2.7 the agent can't tell a genuine site bug from an animation it couldn't trigger, so it escalates rather than guessing. That judgment call is yours.

## Re-audit
Providing a `url` with an existing baseline (either mode) triggers the diff sequence against the prior stored result (audit-state history) instead of a fresh first-time audit.

## Projects and runs
Every audit target is a **project** under `projects/<project-name>/`, created on first audit. Every execution or re-audit of that target is a **run** inside it (`projects/<project-name>/runs/<run_id>/`). A project's `project.json` persists its Figma destination (file key/URL) so every run — including future re-audits — updates the *same* Figma file automatically, instead of creating a new one each time.

## Where results land

> **v1 status correction (Decision Log #31/#32) — supersedes the "three mandatory outputs" claim below.**
> Figma is **not** automatic today, and is not gated the way this section originally described. What's actually automatic, from `pnpm run agent audit-page`/`audit-site` alone, with no further steps: **C2 JSON, Excel, the standalone HTML report, and the local Dashboard.** These four are written by the CLI itself, in no-api mode by default, for every run.
> Figma is different because Figma's MCP write access requires a live, authenticated interactive session — a plain CLI process cannot drive it (a headless Claude Code publish is a documented, still-unresolved auth blocker, IMPLEMENTATION-PLAN.md §6). So every run **does** automatically compute and persist `figma-plan.json` (the full page/marker content, `PublishPlan.markerGroups`/`globalComponents` included, `src/figma/publish-plan.ts`) and `figma-composite-plan.json` (the full-page tile geometry, `src/figma/page-composite-plan.ts`) — everything a publish needs — but nothing actually writes to Figma without a Claude Code session with Figma MCP access following `docs/FIGMA-PUBLISH-RUNBOOK.md`. See `.claude/skills/audit-run/SKILL.md` for the full reusable procedure, Figma step included.

**Automatic, every run, no further steps:**
- **C2 (`data.json`)** — the canonical audit truth. Every other output derives from this alone, never a separate calculation.
- **Excel** (`report.xlsx`) — the complete structured report (v1.0 §15's tab set).
- **Standalone HTML** (`report.html`) — a self-contained single-file rendering of the same dashboard content, every screenshot embedded as a `data:` URI (`src/agents/c1-html-reporter/index.ts`) — opens by double-click, no server, portable to another machine. A `report-package.zip` fallback is added only if the embedded file would exceed 25MB.
- **Local Audit Dashboard** — served at `http://localhost:<port>/projects/<project-name>/runs/<run_id>`. Reads the same C2 JSON as everything else — never a separate calculation.

**Persisted automatically, but requires a live Claude Code + Figma-MCP session to actually publish:**
- **`figma-plan.json`** — the full deterministic plan: `00 Overview` … `08 Needs Review` tables, PLUS the approved interactive-marker system per page audit (`pageAudits[].markerGroups` — curated, deduplicated, root-cause-aware; see Decision Log #32) and `globalComponents` (Header/Navbar/Footer representatives).
- **`figma-composite-plan.json`** — per page, the measured sticky-header height and the exact tile crop/placement geometry a live publish should use to assemble the full-page capture without repeating the header or shipping one oversized raster.
- Actually writing these to Figma (creating the file, building pages, uploading real screenshots, wiring the Default/Hover interactive marker components and their hover reactions) is `docs/FIGMA-PUBLISH-RUNBOOK.md`'s job, executed by a Claude Code session with Figma MCP tools — never a bare CLI command, and never mandatory for a run to be considered complete.

**JSON (`data.json`) and raw screenshots are internal/backing data** — not deliverables themselves, though the dashboard and HTML report read them directly. JSON feeds re-audit diffing, Excel, HTML, the dashboard, and both Figma plan artifacts; screenshots back the HTML report's embedded evidence, the dashboard's evidence view, and whatever a live Figma publish uploads.

## Orchestration note
This is a standalone service (its own repo, `/Users/sachin/Project-aura/audit-agent/`) — not run as a Claude Code session workflow, EXCEPT for the Figma-publish step above, which genuinely is one (a live session with Figma MCP access, following the runbook). The graph engine implementing the sequences above is an implementation-time choice (`ARCHITECTURE.md` §2.3); this document describes the sequence any conforming engine must produce, not a specific one.

## Status
Reflects `docs/ARCHITECTURE.md` v1.3 as originally written, PLUS the no-api default execution mode (Decision Log #31) and the interactive-marker Figma system (Decision Log #32) layered on top since. The v1 implementation exists and is tested (`pnpm test`) — the "no implementation code exists yet" framing below is historical, from when this document was first written as a pre-implementation spec.
