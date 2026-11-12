---
name: audit-run
description: "Run a Design System audit against a new page or site with this repo's existing, approved pipeline — never redesign the architecture for a routine test. Use whenever the user asks to audit/test a new URL, e.g. 'Audit this page: <URL>' with a mode."
disable-model-invocation: false
---

# audit-run — the one reusable procedure for every future audit

**Read this whole file before doing anything.** It exists so a normal "test this new page" request never turns into an architecture discussion. If you find yourself about to redesign a graph node, rename an output, or change scoring logic to make a run "work," stop — that is out of scope for this skill. File a note for the user instead of improvising.

## What you take from the user

Exactly three things, no more:
1. **`url`** — the exact page (single-page mode) or site root (full-site mode).
2. **`mode`** — `single-page` or `full-site`, **stated explicitly by the user**. Never infer it from the URL's shape (a URL that looks like a homepage is not evidence for `full-site` — ARCHITECTURE.md §0 is explicit that mode is the sole routing source of truth). If the user didn't state a mode, ask — don't guess.
3. **An optional run name** — the exact human-readable string the user gives (e.g. "Brand Perception survey page"), preserved verbatim as the run's display name (see "Project/output path & run naming" below). If the user gives none, one is auto-derived from the URL — never a bare `run-<timestamp>-<random>` id standing in as the visible name.

Everything else — AI mode, Design System path, output locations, Figma team, dashboard port — already comes from `audit-agent.config.json` / environment and needs no per-run input. Do not ask the user for it.

## Project/output path & run naming (locked)

**Output location is fully automatic — never ask the user for a save path.** Every run lands under this standalone repo's own `projects/` directory: `audit-agent/projects/<project-slug>/runs/<run-id>/` (`<project-slug>` = `projectNameFor(url)`, a slugified hostname+path). `mode` alone routes to `audit-page` (single-page) or `audit-site` (full-site) — never inferred from the URL.

**Display name vs. run id — two different strings, never conflated:**
- **Display name** — exactly what the user typed as the run name (or, absent one, a name auto-derived from the URL by `resolveRunName`, e.g. `/brand-perception-survey` → "Brand Perception Survey"). This is what appears as the Figma file name and the friendly report filenames — never slugified, never replaced.
- **Run id** — a filesystem/DB/Figma-node-safe slug derived FROM the display name (`resolveRunName`'s `runId`, e.g. "Brand Perception survey page" → `brand-perception-survey-page`) — this is the folder name and the `--run-id` value.

Pass the user's run name via `--run-name "<name>"` on `audit-page`/`audit-site` (the id is auto-derived; `--run-id` remains available separately as a power-user override of the folder slug only — it never touches the display name). Both names are persisted to `run.json` in the run folder (`writeRunMeta`/`readRunMeta`, `src/output/run-store.ts`) so a later `figma-plan <runId>` regeneration still uses the right display name without asking again.

**Before running, print — then proceed automatically, no approval wait:**
```
Project folder: <paths.projectDir>
Run name:       <displayName>
Run ID:         <runId>
Run folder:     <paths.runDir>
```
This is already wired into `audit-page`/`audit-site`'s CLI output, first thing after the names are resolved — verify it printed, don't just assume.

**Report filenames** — `report.html`/`report.xlsx`/`report.json` etc. stay as the canonical, fixed names the dashboard and zip-package fallback reference internally, but the CLI ALSO writes friendly-named copies alongside them using the display name (e.g. `Brand Perception survey page.html`, `Brand Perception survey page.xlsx` — via `writeFriendlyNamedCopies`), and prints both paths. Never rename the canonical files — copies only.

## Template contracts (locked — read this before touching Figma or HTML code)

**A new audit changes the data, not the approved output templates.** Both the Figma output and the standalone HTML/dashboard output are locked, versioned, reusable templates — not something re-derived per run, and not something this skill (or Claude's memory of a past conversation) should ever reinvent:

| Template | Version constant | Value | Defined in |
|---|---|---|---|
| **Figma Audit Template** | `FIGMA_CONTRACT_VERSION` | `figma-layout-v4` | `src/figma/prompt-contract.ts` |
| **HTML Audit Report Template** | `HTML_TEMPLATE_VERSION` | `html-report-v1` | `src/dashboard/views/render.ts` |

Both are stamped into their own output (`figma-plan.json`'s `contractVersion`; every rendered HTML page's `<!-- html-report-v1 -->` comment) so any shared file is traceable back to the exact template version that produced it — inspect these, don't guess.

**What the templates lock, byte-for-byte across every future run:**
- Figma: the six-page structure (`00 Overview` · `01 Page Audit` · `02 Root Causes` · `03 Component Findings` · `04 Needs Review` · `05 Global Components`, in that order — asserted by `test/unit/figma-publish-ops.test.ts`'s "locked six-page structure" test), the card layouts and colors on every page, the Legend + numbered list directly below it (never duplicated, never after the Footer), marker status colors, hover annotation behavior, root-cause grouping, and the internal marker/component library kept **hidden** (`visible: false`, never visible report content — positioning it far from the Legend was tried and found insufficient) so `01 Page Audit` shows only the screenshot, markers, hover annotations, and the Legend/numbered list.
- HTML: summary cards, severity/status pills, the `STATUS_COLORS` palette (Incorrect=Red `#b01f24`, Deviation=Orange `#d96548`, Needs Review=Amber `#c99a2e`, Unverified=Gray `#6b7280` — genuinely distinct from amber, not just a dashed border, Match=Green `#3f7d58`), the Needs-Review/Unverified dashed-card differentiation, filters/search, evidence screenshots, Actual→Expected, recommendations, and standalone data:-URI packaging.

**What changes from run to run — and ONLY this:** the audited screenshot/content, findings, counts, marker numbers, issue titles, severity/status, Actual→Expected values, affected-element counts, and evidence. Never the structure, colors, layout, or hierarchy around that data.

**If the user explicitly asks for a template change:** bump the relevant version constant (`FIGMA_CONTRACT_VERSION` and/or `HTML_TEMPLATE_VERSION`), update the reusable code it lives in (`src/figma/publish-plan.ts`/`publish-ops.ts` for Figma, `src/dashboard/views/render.ts` for HTML), add/update the regression tests that lock the new shape, and every later audit inherits the change automatically — because it's one shared function/template, never a per-run choice. Absent that explicit request, do not change either template for a routine "audit this page" request.

## The nine-point contract for every `url` + `mode` + optional `run name` request

Given exactly those three inputs, this skill must, in order: (1) use the existing audit architecture (B1–B6 / A1–A4, unchanged) — Step 3 below; (2) use the finalized Design System source (`audit-agent.config.json`'s `designSystemPath`, unchanged) — Step 2; (3) run the audit — Step 2/3; (4) generate C2 canonical data (`data.json`, automatic) — Step 4; (5) publish using the approved reusable **Figma Audit Template** (`FIGMA_CONTRACT_VERSION`) — Step 6; (6) generate using the approved reusable **HTML Audit Report Template** (`HTML_TEMPLATE_VERSION`) — Step 4/5; (7) generate Dashboard and Excel — Step 4; (8) run the existing verification/regression checks — Step 7; (9) never redesign the Figma or HTML output unless the user explicitly requests a template change (see "Template contracts" above). A future request needs nothing beyond the three inputs to get the same approved outputs — if you find yourself needing to ask anything else, or needing to remember details from a past conversation to get the layout right, that is itself a bug in this skill or the underlying code, not a gap to fill from memory.

## Step 1 — Confirm the environment, don't assume it

Before running anything:
- `cd` into the audit-agent repo root (wherever it's checked out on this machine).
- Run `git status --short` — if there are uncommitted source changes, tell the user and ask whether to proceed; never audit against a dirty, unverified tree without saying so.
- Run `npx tsc --noEmit` — must be clean.
- **Silently probe the Figma MCP connector now, once (with retries), upfront** — a single bounded call (e.g. `whoami` on the Figma MCP tools), before anything else runs. Classify whatever comes back into exactly one of three recorded outcomes, then move straight on to Step 2 regardless — **do not pause, do not wait for a response, do not ask the user anything at this point**:
  1. **Authenticated** — record it (team/plan info included). Step 6 will publish automatically from this; no separate "publish to Figma" request is ever needed.
  2. **Transient/tool/session error** (timeout, connector hiccup, an MCP error that is not itself an auth/permission response) — retry the same probe automatically up to 2 more times (3 attempts total, no pause between them, no question to the user). If every attempt fails the same transient way, record "not available this run" — treated identically to never having connected at all. Never block waiting for a transient failure to clear on its own.
  3. **Explicit authentication/permission denial** — the connector itself returns something equivalent to `unauthorized`, `login required`, or `permission revoked` (a real denial, not a generic error) — record the exact signal, verbatim. Unlike outcomes 1 and 2, this is worth a distinct, stronger call-out later (Step 8), because it means access was lost or refused, not simply never set up. It still does not pause anything here — recording it is Step 1's only job.

  Whichever of the three got recorded is what Step 6 acts on and Step 8 reports — Step 1 never does more than record it.

## Step 2 — Create the run

The exact command (verified against this repo's actual CLI, `src/cli/index.ts` — do not invent flags):

```bash
pnpm run agent audit-page "<URL>" --run-name "<optional human-readable run name>"
```
or, for full-site:
```bash
pnpm run agent audit-site "<URL>" --run-name "<optional human-readable run name>"
```

Omit `--run-name` to let the CLI derive a readable one from the URL — never a bare `run-<timestamp>-<random>` id. `--run-id <slug>` remains available separately to override just the folder slug (rare — only when the auto-derived one collides or the user wants a specific one), and never changes the display name. **Never reuse an existing run id** — the CLI already refuses this itself (`Run <id> already exists (<status>) — choose another --run-id`), so if that happens, just let it fail and pick a new id; do not force an overwrite.

`AI_MODE` is **not** something to set per-run — the repo defaults to `no-api` (Decision Log #31: deterministic, zero model calls, no credential needed). Only touch `AI_MODE=anthropic-api` if the user explicitly asks for the model-backed path AND has a credential configured — this is opt-in, never the default for a routine test.

`full-site` pauses at the **Scope Confirmation Gate** before auditing anything, and both modes pause at the **Publish Confirmation Gate** before finishing. Use the existing gate commands to move a paused run forward — never bypass a gate:
```bash
pnpm run agent gates                                   # list what's waiting
pnpm run agent gate approve <runId> scope_confirmation  # or publish_confirmation
pnpm run agent resume <runId>
```

## Step 3 — Let the pipeline run to completion

Don't intervene mid-run. B1→B6 (and A1–A4 for full-site) are the existing, approved graph — nothing here needs a per-page tweak.

## Step 4 — Verify the automatic outputs exist (these four are unconditional, every run — Figma is separate, see Step 6)

All of these are written by the CLI itself, every run, no further action needed — but verify, don't assume:

```bash
ls "projects/<project-name>/runs/<runId>/"
```
Expect: `data.json`, `figma-plan.json`, `figma-composite-plan.json`, `figma-ops.json`, `report.html` (plus `report-package.zip` only if `report.html` exceeded ~25MB), `report.xlsx`, `screenshots/`. `<project-name>` is `projectNameFor(url)` — a slugified hostname+path (see `src/output/run-store.ts` if you need the exact derivation).

Sanity-check `data.json`: `run.aiMode` should be `"no-api"` unless the user explicitly asked otherwise; `websiteSummary`/`statusCounts` should be present and non-degenerate for a page that actually loaded.

**`figma-plan.json`/`figma-composite-plan.json`/`figma-ops.json` are NOT a completed Figma deliverable.** They are the deterministic plan and operation list — real Figma content exists only once Step 6 below has actually run and produced a real file URL. Never report "Figma: done" from these three files' existence alone.

## Step 5 — Verify output integrity (don't just trust file existence)

- Open `report.html` and confirm it starts with `<!doctype html>` and contains `data:image/png;base64,` — never `src="/screenshots/`, never `localhost`, no `<link>`/external `<script src>` (must open and share with zero server, zero network dependency). Regression-tested: `test/integration/c1-html-report.test.ts`, `test/integration/cli-e2e.test.ts`.
- Confirm `figma-plan.json`'s `pageAudits[].markerGroups` is a non-empty array for any page with real INCORRECT/DEVIATION/NEEDS_REVIEW/UNVERIFIED findings, and that `globalComponents` is present.
- Confirm `figma-composite-plan.json` has one entry per page with `headerHeightPx >= 0` and at least one block. If a page is missing (no tiles captured), `figma-ops.json`'s `missingCompositePlanFor` will name it — that page's Figma audit frame is skipped, not faked; re-run `pnpm run agent figma-plan <runId>` after fixing the underlying capture, no full re-audit needed.
- Confirm `figma-ops.json`'s `ops` array is non-empty and includes an `EnsureFile` op; if `coverageGaps` is non-empty, that's expected and reported (a marker whose real element sits inside an uncaptured header band), not a bug.
- Start the dashboard if not already running (`pnpm run agent dashboard` or let `audit-page`/`audit-site` start it) and spot-check the URL loads with real counts.

## Step 6 — Figma: attempted automatically using Step 1's connector result — never blocks, never asks

Figma publishing is attempted on every run **using the connector outcome already recorded back in Step 1** — do not re-probe it here, and never pause or ask the user anything about Figma at this point. Whatever Step 1 recorded is what you act on now:

- **Step 1 recorded "authenticated":**
  1. Load `docs/FIGMA-PUBLISH-RUNBOOK.md` and mechanically replay `figma-ops.json` in order, one real MCP tool call per op — no fresh judgment calls, the ops list already made every decision.
  2. Run every check in `src/figma/publish-verify.ts` against what actually came back (blank-image, hover-card-not-clipped, bounds, marker-traceability, legend-placement, no-match-markers, component-library-hidden) — write `figma-verification.json` and report PASS/FAIL per check, never "looks fine."
  3. Record the real `figmaFileKey`/`figmaFileUrl` into `project.json` only after a passing publish.
  4. This is fully automatic: an authenticated connector means a real Figma publish is simply part of this run's normal output. Never gate it behind a separate "publish to Figma" request from the user.
- **Step 1 recorded "not available"** (no session ever connected, or a transient/tool/session error survived all 3 probe attempts — Figma's write API only accepts a live, interactive, authenticated session, never a headless process, IMPLEMENTATION-PLAN.md §6): skip the publish entirely — do not probe again here, do not prompt the user, do not wait. Report "Figma: NOT PUBLISHED — no authenticated Figma-MCP session available (connect it via your claude.ai connector settings if you want this published); N operations are ready in figma-ops.json for when it is" as one line in Step 8, and move on.
- **Step 1 recorded an explicit authentication/permission denial** (`unauthorized`/`login required`/`permission revoked`/equivalent, recorded verbatim): skip the publish the same way — still no pause here — but give this its own distinct line in Step 8: an explicit call to re-authorize, not the generic not-connected message. This is the one Figma outcome actually worth the user's attention, since it means access was lost or refused, not simply never set up.

**Every branch proceeds straight to Step 7 in the same turn — a Figma outcome, whichever of the three above, is never a stopping point.** Excel/HTML/Dashboard/C2 are independent of Figma entirely; nothing here depends on Step 6 succeeding, and Step 6 itself must never take more than the bounded probe (plus its up-to-2 retries) already spent in Step 1.

## Step 7 — Run the regression suite

```bash
npx tsc --noEmit && npx vitest run
```
This is cheap insurance that nothing about the pipeline itself broke, independent of this specific run. Report the pass count; investigate any failure before declaring the audit done — a red suite means something is actually broken, not just "unrelated."

## Step 8 — Report back to the user

Always include, using the ACTUAL paths this run produced (never invented):
- **HTML path** (`report.html`, its file size, and confirmation it's standalone)
- **C2 JSON path** (`data.json`) and **Dashboard URL**
- **Excel path** (`report.xlsx`)
- **Figma** — always exactly one of three lines, using Step 1/Step 6's recorded outcome, never silent, never a reason the rest of this report was delayed:
  1. **Published:** the real file URL + Step 6's PASS/FAIL table.
  2. **Not connected / transient failure:** "NOT PUBLISHED — no authenticated Figma-MCP session available (connect it via your claude.ai connector settings if you want this published)."
  3. **Access denied/lost:** "ACTION NEEDED — Figma reported '<the recorded signal, e.g. unauthorized / login required / permission revoked>' — re-authorize the connector via your claude.ai connector settings, then re-run to publish."
  Never call `figma-plan.json`/`figma-composite-plan.json`/`figma-ops.json`'s existence a completed publish under any of these three.
- **Run ID**, compliance/finding counts (match/deviation/incorrect/needs review/unverified), coverage notes, and test-suite pass/fail
- **Template versions used** — `FIGMA_CONTRACT_VERSION` and `HTML_TEMPLATE_VERSION` (both inspectable in the outputs themselves: `figma-plan.json`'s `contractVersion`, `report.html`'s `<!-- html-report-v1 -->` comment) — so the user can see at a glance that this run used the locked template, not a redesign

## Hard rules (do not relax these for convenience)

- **Never** redesign A1–A4/B1–B6, the graph, the database schema, or the output contract to make a specific page "work." If a page genuinely breaks the pipeline, that's a bug to report and fix in the underlying code/tests — not a one-off workaround for this run.
- **Never** infer `mode` from the URL. Ask if it's not stated.
- **Never** call `figma-plan.json`/`figma-composite-plan.json`/`figma-ops.json` a completed Figma deliverable — they are the plan; Step 6's real publish + verification is the deliverable.
- **Never** let Figma's connector status turn into a pause or a question back to the user mid-run. It's probed exactly once, in Step 1 — with up to 2 automatic retries for a transient/tool/session error only, never for an explicit auth denial, and never anywhere later in the run — and every later step acts on whatever got recorded there. A never-connected or transient-failure-after-retries connector is a normal, non-blocking outcome. An explicit auth/permission-denial signal (`unauthorized`/`login required`/`permission revoked`/equivalent) is the one outcome that earns a distinct, stronger call-out in Step 8 — but even that is reported at the end, never asked mid-run; the run always completes regardless.
- **Never** require a separate "publish to Figma" request when the connector is authenticated — a real Figma publish is simply part of that run's normal output (Step 6), not an extra step the user has to ask for.
- **Never** hand-curate Figma marker content, positions, geometry, or root-cause grouping again — that logic lives in `src/figma/publish-plan.ts`/`page-composite-plan.ts`/`publish-ops.ts` now. If it looks wrong for a new page, that's a bug in that code (fix it and add a regression test), not something to patch by hand in the Figma file.
- **Never** silently skip a verification step in Step 5, or one of `publish-verify.ts`'s checks in Step 6, to save time — report what you didn't check rather than implying you did.
- **Never** redesign the Figma six-page structure/cards/colors or the HTML template's cards/palette/layout for a routine audit request — a new URL changes the data (findings, counts, screenshots, marker numbers), never the template. A template change happens only on an explicit user request, as one code+version-constant change in `publish-plan.ts`/`publish-ops.ts`/`render.ts` — never as an ad hoc per-run decision, and never by retyping content (e.g. the Legend's color-key line, `legendColorKeyLine()`) from memory instead of calling the function that generates it.
- **Never** let the HTML template's `STATUS_COLORS` drift from the Figma template's status-color meaning (Incorrect=Red, Deviation=Orange, Needs Review=Amber, Unverified=Gray, Match=Green) — this drifted once (Unverified silently reused the amber Needs-Review hue) and is now regression-tested (`test/unit/html-template-palette.test.ts`); don't reintroduce it.
- **Never** ask the user for a save path — output location is fully automatic (`audit-agent/projects/<project-slug>/runs/<run-id>/`, see "Project/output path & run naming" above). If a run somehow lands anywhere else, that's a bug in `DATA_ROOT`/`AUDIT_AGENT_DATA_DIR` resolution to report, not something to route around by asking the user where to save.
- **Never** let the run's display name collapse into its slug anywhere a human reads it (Figma file name, friendly report filenames, the confirm block) — that drifted once too (this exact gap is what `resolveRunName`/`run.json` exist to close); regression-tested in `test/unit/run-naming.test.ts`.
