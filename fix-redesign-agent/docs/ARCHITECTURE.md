# Fix Redesign Agent — Architecture v4.3

**Status (2026-10-09): the CLI page pipeline is implemented; v4.3 made the React Preview its default deliverable (§0.6, §8c) and v4.4 adds the Resolver (node RV), the design & interaction fidelity verification and the bounded correction loop — §8d, `[built]`.** Everything else in v4.2 below that §0.2 marks `[proposed]` — Source mode, Source Mapper, Page Builder/Composer, the worktree manager — is still a proposal and is NOT implemented. Where §7.1a/§8a/§8b (the proposed *AI-authored* React Preview mode) and §8c (the implemented, *generated-from-captured-evidence* React Preview) differ, **§8c is what the code does**; §8b's Complete-Section contract is kept and is enforced deterministically by §8c.4.

The remainder of this paragraph is v4.2's original header, kept for provenance: ~~**Planning document. Nothing in this version has been implemented yet**~~ (§0.2 marks every item). Supersedes v4.1 (2026-09-29); v4.3 (this edit) adds §0.6/§8c without removing v4.2's text. v3.2 is archived verbatim at `docs/ARCHITECTURE-v3.2-archive.md` — this repository has no git history at all, so an explicit archive file is the only way anything superseded survives. v4.1's full content is reproduced below, unabridged — the same discipline v4.1 itself adopted after finding v4.0 had been summarized away by mistake (§0.1).

**What v4.2 adds over v4.1 — a real gap found by actually building and reviewing the first Selected Sections implementation:** that build (localhost:4310, the `deals-and-ipo-consulting-test-button-rematch-react-preview-20260929` run) rendered each section as only its Fix-marked elements — a heading, two buttons — not the section's real, complete structure. The High-Synergy Deals section is missing its dark gradient/wave decorative background and its actual hero subtitle copy ("Navigate deal scouting, exhaustive due diligence and a clear IPO roadmap..."); "How We Can Help" is similarly reduced to headings-and-links with none of its real supporting structure. Both were reported as PASS/PARTIAL against per-property DS checks, with no check anywhere for whether the *section itself* was actually complete. **§8b (new) closes this gap: a Complete Section Reconstruction contract, plus a section-completeness gate that runs before any PASS is possible, gating on content/layout presence first and DS-property correctness second.** Nothing about §8.8's DS-verification, §7.2's fan-out/fan-in, or the six-role structure changes — this is an added checkpoint and an added responsibility inside Page Composer and Visual Verifier's existing contracts, not new roles.

**v4.1's own summary, reproduced (its full content follows, unabridged, everywhere below):**

1. **A second, clearly labelled operating mode — React Preview mode** (§0.5, §8a) — buildable *today*, without the website's own source repository, so a redesigned Full Page or Selected Sections output can still be composed and visually reviewed on localhost while §0.4's blocker stands. It is never labelled as an edit to the production website's source; it is a recreation, built from audit evidence and the verified Design System, for visual review only. **Source mode** (v4.0's original design) remains the preferred path and the eventual target once the real repo is available — React Preview mode does not replace it.
2. **A DS-verification step in Redesign Planner** (§8.8) — recommended across several prior conversation turns, drafted into the document for the first time here. Redesign Planner now independently re-confirms a finding's `dsComponent`/`dsVariant` against the Design System's *current* source before committing to target values, instead of trusting `data.json`'s recorded match outright. This directly addresses a real, confirmed failure: all 8 "Let's Connect" form-input findings in the `deals-and-ipo-consulting-test-button-rematch` run were matched to `atoms/FilterSearchInput.tsx` by a hardcoded rule table in `audit-agent` that never offered `ui/input.tsx` as an alternative — a wrong target, applied with confidence, never questioned.
3. **A narrowed correction to v4.0's Decision #60** (§8.8, Decision #63) — v4.0 conflated "never import a foreign React component's code into the site's repo" (correct, stays) with "never use the Design System as the reference for correct property values" (an overcorrection, reversed here). Redesign Planner may now name a verified DS component/variant as the semantic edit target and hand downstream building its **complete** governed property set — not just the individual properties a finding's `comparison.mismatches` happened to list.
4. **A lightweight new-component-candidate record** (§8.8) — when no DS component or site convention fits, Redesign Planner now emits a small record for a future Component Agent, instead of the finding simply going `unaddressed` with no trace.

---

## 0. Status, and how to read this document

- **[built]** — code exists in this repo and its tests pass, and is reachable from this document's graph.
- **[contract]** — a typed contract exists; the node is a stub that fails loudly.
- **[proposed]** — designed here, no code yet.

### 0.1 What changed, and a correction about this document's own history

Everything in v4.0 that pivoted away from the HTML-snapshot pipeline (§12), narrowed scope to Fix Redesign only, and specified Source mode's whole design is unchanged and reproduced in full below — this document remains self-contained, the same convention v3.2 and v4.0 both followed. The four points listed under v4.1's own summary above are what v4.1 added over v4.0. **§8b is what v4.2 adds over v4.1** — a Complete Section Reconstruction contract and a section-completeness gate, found necessary by actually building and reviewing the first real Selected Sections implementation (see §8b's opening for the concrete evidence).

**A process note, stated plainly rather than glossed over:** the first draft of this version (v4.1) summarized most of v4.0's content as "unchanged from v4.0" instead of reproducing it, then overwrote the only copy of v4.0 — and this repository has no git history to recover it from (§0 of the archived v3.2 document explains why an explicit archive file is this repo's only safety net). A review pass caught this before it was presented as finished. The fix was to reconstruct v4.0's actual text from this same conversation's own history (where it was originally authored, in full, turns earlier) and rewrite this document with nothing elided. Every section below that says "unchanged from v4.0" in its heading still contains v4.0's real content in full underneath — it is a provenance note, not a placeholder.

### 0.2 Implementation status

Every statement is marked **[built]**, **[contract]**, or **[proposed]** per the legend above.

**Reused as-is — no code change needed, existing tests keep covering it:**

| Area | Evidence |
|---|---|
| config loader + schema, env overrides | `src/config/` |
| tracing (JSONL spans) | `src/tracing/` |
| `audit-link`: `find-run`, `Finding`/`AuditData`/`FixPlan`/`NewComponentPlan` read-side schemas | `src/audit-link/` |
| R1 Resolve & Load (plan/data validation, join, filter to `fix` scope) | `src/agents/r1-resolve-load/` |
| session/decisions/gate-fingerprints (append-only decisions, fingerprint reuse) | `src/session/decisions.ts`, `gate-fingerprints.ts` |
| `resolveScope` / `deriveSectionCandidates` (redesign-only-scope: always auto-derives, never asks for this reason) | `src/session/scope.ts` — changed 2026-09-28, unaffected by this document |
| retry classification, judgment-provider (`claude-session` default) machinery | `src/retry.ts`, `src/judgment/`, `src/llm/` |
| t-layer capture primitives (settle, computed style, screenshot, tiling) — re-pointed at a local URL, logic unchanged | `src/t-layer/` |
| imaging: tile crop-planning + flatten-to-PNG | `src/imaging/` |
| mapping objective checks (geometry/IoU, identity, text similarity, class fingerprint, uniqueness) — Element Mapper's core, re-pointed at the local render | `src/mapping/objective-checks.ts`, `candidates.ts`, `drift.ts` |
| output store paths, run id/meta, project record | `src/output/redesign-store.ts` |

**Reused with modification — the module exists and is a real starting point, but this document changes its contract (Source mode only, unless noted):**

| Area | v3.2 contract | v4.x contract |
|---|---|---|
| R2 Capture (`src/agents/r2-capture-original/`) | politely navigate to the **production** URL | prepare the **isolated worktree** (checkout, install, mock-data wiring), start its **local dev server**, navigate there instead (§6.3, §0.4) |
| C2 / Element Mapper (`src/mapping/index.ts`) | maps findings against the **live production** DOM | Source mode: maps against the local dev-server DOM. React Preview mode: maps against already-captured audit evidence (§6.3, §8a) — same objective-checks mechanism either way |
| R7 Assemble (`src/agents/r7-assemble-output/`, `src/html/serialize.ts`) | clone-and-export a **static, zero-network HTML** document (§8.4/§8.5 of v3.2) | assemble/confirm the final rendered page from a **running dev server** (the site's own, or the freshly-generated preview app's); produce **preview screenshots**, not a frozen document (§9) |
| `src/output/deliverable.ts` (`buildRedesignDeliverable`) | copies exported HTML into `redesign/` | a substantial rewrite, not a small tweak — points at the **worktree path** (Source mode) or the **preview-app path** (React Preview mode) + preview images + a **live dev-server link** instead of copying HTML files (§9); kept as "reused with modification" rather than "new" because it is still R7's own packaging responsibility, not a new node |
| gate-fingerprints (G2) | hashes exported HTML bytes + validation JSON | Source mode: hashes the worktree's **git diff** + validation JSON. React Preview mode: hashes the generated app's own files + validation JSON (§11.3) |
| CLI `serve` (`src/serve/static-server.ts`) | serves static files | gains a **dev-server process manager** (start/health-check/stop) for whichever app is relevant (the site's, or the generated preview's) alongside the existing static file server, kept for serving preview screenshots/reports (§9) |

**Retired from this workflow — code stays in the tree, tests keep passing, but this graph never calls it (reserved for the future Component Agent, per the user's explicit instruction to preserve it) — narrowed in this version, see the correction below:**

| Area | Why it doesn't apply to Fix Redesign's *building* step |
|---|---|
| `src/html/serialize.ts`'s §8.4-of-v3.2 CSS-isolation export rules (clone-whole-document, inline everything as data URIs) | only needed to produce a standalone, openable-from-disk HTML file; a real dev server (either mode) serves its own assets |
| `src/library/`, `src/agents/l1-resolve-plan/` … `l5-publish/`, `src/manifest/`, `src/html/components-index.ts` | Workflow B (components) in full — untouched, unreachable, for the future Component Agent |
| `src/output/deliverable.ts`'s `buildNewComponentDeliverable`, the `new-component/` deliverable | same reason |

**Correction to v4.0's retirement of the DS catalog (D1–D6):** v4.0 additionally retired the Aura DS loader/catalog entirely, reasoning "that catalog is a different repository from the site's own source." That reasoning is still correct for *importing component code into the site*. It is not correct for *reading the DS as ground truth for what the correct values are* — Redesign Planner needs exactly that to do the DS-verification step below (§8.8), and Page Composer (React Preview mode) needs it to render real DS components directly. **D1–D6 and `ds-reference.ts` are reinstated as a live, read-only dependency of Redesign Planner (both modes) and Page Composer (React Preview mode only).** Nothing writes to the DS repo; nothing imports its component code into the site's repo. This is Decision #68.

**New — proposed here, no code yet:**

| Area | Role |
|---|---|
| Operating-mode resolution (`source` \| `react-preview` \| `auto`, §0.5, §5) | R1/CLI, small addition |
| DS-verification sub-step inside Redesign Planner (§8.8) | re-run `ds-reference.ts`'s scoring against the *current* DS source at build time; require ≥2 independent governed-property agreements before treating a match as `confirmed` |
| `new-component-candidate` record (§8.8) | a small, additive output file, distinct from and much lighter than `new-component-plan.json` |
| Worktree/repo manager: clone-or-reuse, isolated branch, dependency install | prerequisite for R2, Source mode |
| Local dev-server lifecycle manager (start, health-check/wait-until-ready, port allocation, stop) generalized beyond the existing zero-dependency static file server | R2, the new `serve` — both modes |
| Mock-data substitution strategy for whatever the app would otherwise fetch from a live backend | R2, Source mode |
| **Source Mapper** (§6.4) | new stage between Element Mapper and Redesign Planner, Source mode only |
| Style-authoring classification (Tailwind / CSS module / inline style / styled-components / global stylesheet / design token) | Source Mapper's output (Source mode), consumed by Page Builder |
| **Page Builder** (Source mode, AI) + **Page Integrate** (deterministic fan-in, mirrors L2b) | replaces R4, Source mode |
| **Page Composer** (React Preview mode, AI, §8a.2) | React Preview mode's equivalent of Page Builder — generates fresh React instead of diffing existing files |
| Content/asset extraction from audit evidence (§8a.1) | React Preview mode only |
| Simulated-interaction + limitations list (§8a.3) | React Preview mode only, a new Visual Verifier output |
| New G2 fingerprint basis (git diff + validation, Source mode; generated-files + validation, React Preview mode) | `gate-fingerprints.ts` addition, §11.3 |
| New deliverable packager (worktree/preview-app path, previews, validation results, dev-server link) | replaces `buildRedesignDeliverable` |

### 0.3 Naming

Unchanged from v3.2/v4.0: user-facing name **Redesign Agent**; repository, package, CLI and every path stay `fix-redesign-agent`.

### 0.4 Blocking prerequisite — the website source repository (Source mode only)

**The actual repository that builds `www.kenresearch.com` (specifically the one serving `/consulting/deals-and-ipo-consulting`, the paused run's target) is not available anywhere on this machine.** This was verified directly, repeatedly, not assumed:

- `fix-redesign-agent.config.json` has no site-source path field (only `auditAgentRepoRoot` and `designSystemPath`, the latter pointing at the **Aura design-system** repo — a different thing from the live site's own source).
- Every project under `project_aura1-main/projects/` (~25 folders) is a separate design-workspace prototype with its own personal GitHub remote (`nirvaircheema02-lang/...`) — none is the deployed site.
- `project_aura1-main/HANDOVER_TRACKER.md`'s own doctrine confirms why: design-side projects are pre-handover candidates; once `handed-over`, "tech team owns it" and design's copy is frozen at handover time. No tracked project matches "consulting" or "deals-and-ipo" at all.
- A machine-wide scan for any other local git repository referencing kenresearch found nothing matching the live site.
- Re-confirmed while investigating the page's actual rendering stack: the one Django backend available locally (`project_aura1-main/projects/ken-research-backend`) has zero routes, templates, or code referencing this page at all — its entire routing is `admin/` and a single `api/health/` endpoint, and it's a bare DRF (Django REST Framework) skeleton with no `TEMPLATES.DIRS` configured. **The actual rendering stack for this specific page — Next.js, Django templates, or a hybrid — remains unconfirmed and is deliberately not inferred from the live URL's rendered markup.**

**What is needed to proceed past R2 in Source mode:** a local filesystem path to a checked-out copy of that repository, or a git remote + branch/ref, with access already usable from this machine. Given this workspace's own "tech owns it after handover" model, this most likely needs to come from the tech team directly.

**This blocks Source mode specifically. It does not block React Preview mode** (§0.5, §8a) — the whole reason for introducing that mode now rather than waiting.

**A second, separate, currently-real gap:** `fix-plan.json` for the *original* run (`deals-and-ipo-consulting-test`, no suffix) — one of this graph's two mandatory inputs (§2.1) — is not present on disk right now, though it was present and readable earlier in the same session it was first checked; it is not in that run's `history/` folder either, and a similarly-named file exists only under a different, sibling run (`deals-and-ipo-consulting-test-button-rematch`). **`deals-and-ipo-consulting-test-button-rematch`'s `fix-plan.json` is present and valid** (26 `fix`-decision entries, all `source: "html-report"`) and is the run used as the concrete example throughout this document.

---

## 0.5 Two operating modes

Every run selects exactly one, alongside the existing design mode (Full Page / Selected Sections, §8.1):

| Operating mode | Requires | Output | Status |
|---|---|---|---|
| **Source mode** (preferred) | the website's own source repo (§0.4) | a real diff to the site's own repository, on an isolated local branch, run via its own dev server | designed, `[proposed]` code, blocked on §0.4 |
| **React Preview mode** (new, this version) | none beyond what already exists locally (`data.json`, evidence screenshots, the Design System source) | a freshly-generated, standalone React app — real, running, editable React source, but **not a checkout of the production repository** | designed here, `[proposed]` code, **not blocked on §0.4** |

**The labelling rule, stated once, applied everywhere in this document and in every file this system writes:** React Preview mode's output is never described, logged, or packaged as an edit to `www.kenresearch.com`'s own source. Every deliverable it produces carries an explicit statement to that effect (§8a.4, §9). Source mode remains the path to an actual, mergeable change; React Preview mode exists so visual review of the redesign doesn't have to wait for §0.4 to resolve.

**Selection logic** (§5): if `siteRepo.path` is configured, Source mode is the default. If it is not configured — the case today — **React Preview mode is the default**, with a printed reason, rather than the run simply refusing to proceed. Either can be forced explicitly via `--operating-mode`. Switching later (once the repo becomes available) starts a *new* run under Source mode; it does not silently upgrade a React Preview run in place, since the two produce structurally different artifacts.

---

## 0.6 v4.3 — React Preview is the default deliverable of every run `[built]`

**Permanent requirements** (user instruction 2026-10-06, confirmed; also in `docs/REDESIGN_RULES.md`, `AGENTS.md`'s rules, the skill and the README):

1. **Startup input is `Run ID/Name + Mode`.** The Fix Plan, audit data, evidence and Design System are resolved automatically. The CLI refuses a real run without `--mode`.
2. **The React Preview is the default deliverable for every page**: runnable React source (`<run>/preview-app/`) and a localhost URL. It is produced by the reusable pipeline (nodes **B1** and **R8**), not built by hand per run, and there is **no silent fallback to static HTML**: if it cannot be generated, built, served or measured, the run fails at R8. The static export remains, labelled *reference only*.
3. **Selected Sections** renders only sections containing a `fix` finding, each complete, in original order, original content and composition preserved, verified DS fixes applied. Unselected sections and the global header/footer are **absent**.
4. **Full Page** renders all page-specific sections; global header/footer stay excluded.
5. **Verification before G2** covers scope, content preservation, each DS fix *measured in the rendered preview*, and interactions. An element merely being present is never proof of a fix.
6. **Out of scope, unchanged:** component creation, shared-DS edits, publishing.

**Why the earlier agreed rule was not enforced** (traced on the survey-detail run, 2026-10-06):

| # | Cause | Where |
|---|---|---|
| 1 | The rule existed only in a conversation, not in `REDESIGN_RULES.md`, `AGENTS.md`, the skill or this document | docs |
| 2 | This document's §8.1 (v4.2) and R7's tests specified the *opposite* for the static export: unselected sections kept and merely marked | `docs/ARCHITECTURE.md` §8.1, `test/integration/r7-assemble-output.test.ts` |
| 3 | React Preview mode was *documented* (§7.1a/§8a/§8b) but no code existed (`grep react-preview src` → nothing); the skill called a preview "optional, session-authored" | skill, `src/` |
| 4 | Section-export failures were isolated and non-blocking, and G2 was reached with a PARTIAL verdict — nothing compared the delivered output to `fix-plan.json` | `src/agents/r7-assemble-output` |
| 5 | A real stamping defect: a section wrapper widened to the page root when a section had no unique container, and a later stamp overwrote an earlier one — so "four sections" collapsed into the whole page | `src/mapping/stamp.ts` |

**What enforces it now** (every row has a regression test):

| Requirement | Enforcement | Tests |
|---|---|---|
| `--mode` required | `src/cli/index.ts` | `test/unit/preview-g2-guard-and-cli.test.ts` (spawns the CLI) |
| Preview is a pipeline stage, no static fallback | `src/pipeline.ts` (B1 before the edit loop, R8 before G2; R8 failure fails the run) | `pipeline.test.ts` — "React Preview is the default deliverable (R8) and B1 captures the original first" (order, no fallback, G2 fingerprint, B1 reuse) |
| G2 sees the preview | G2 reason carries URL + verification; fingerprint hashes `preview/verification.json` + the preview source; `decide G2 approve` refused while verification FAILED unless `--accept-preview-failures` (note: `ACCEPTED FAILED PREVIEW CHECKS`); an INCOMPLETE verdict is approvable and the note records `ACKNOWLEDGED UNVERIFIED REQUIRED CHECKS` with the gap texts (`src/preview/g2-guard.ts`) | `pipeline.test.ts`, `preview-g2-guard-and-cli.test.ts` |
| Scope derived independently of the mapper | `src/preview/plan.ts` `expectedScope` (fix plan + audit only), compared to the pipeline's scope (`scope.matches-run-scope`) | `test/unit/preview-plan.test.ts` |
| Section wrappers cannot span other sections | `src/mapping/stamp.ts` (foreign-member-aware widening, never overwrites) | `test/integration/mapping-stamp-and-candidates.test.ts` |
| Unselected sections absent from the static export; unselected sections never edited | `src/agents/r7-assemble-output`, `src/html/export-validate.ts` (`unselectedUntouchedOnPage`) | `r7-assemble-output.test.ts`, `html-export-validate.test.ts` |
| Preview generation and verification | `src/preview/*`, `templates/react-preview/` | `test/unit/preview-*.test.ts`; `test/integration/preview-extract-verify.test.ts` (real Chromium: scope, CSS selection, edit replay, orphan content, Full Page regions; verification fails on an unselected/missing section, header text inside a shadow root, lost text/links/headings, a non-matching measurement, a Button `primary`, an R1.4 typeface that is still wrong) |
| Multi-iteration runs keep earlier fixes; a fix is measured, not assumed | R5 receives the edits applied in earlier iterations and **measures** R1.4 typeface findings (an applied edit that does not reach the visible text is not a fix); R3 retries are shown what R5 measured, and are told DS custom properties do not exist on the production page | `test/integration/r5-compare.test.ts`, `test/integration/r3-redesign-plan.test.ts` |
| R7 does not stall on hidden elements | `captureElement` fails fast on a zero-size element | `test/integration/t-layer-browser.test.ts` |

---

## 1. Purpose, boundary, and scope

### 1.1 What this system does now

1. resolves the audit run from whatever reference the user gives,
2. **selects an operating mode** — Source (checks out the site's own source into an isolated local worktree, installs it, runs it locally with mock data) or React Preview (composes a fresh React recreation from audit evidence and the Design System, §8a) — §0.5,
3. maps each authorized (`fix`-decision) finding to a rendered element (Element Mapper, §6.3), then — **in Source mode only** — to the source file(s) and styling mechanism that produced it (Source Mapper, §6.4). React Preview mode has no existing source file to map to; content/assets are extracted from audit evidence instead (§8a.1),
4. **independently verifies the correct Design System component and variant** for each finding, rather than trusting the audit's recorded match (Redesign Planner, §8.8 — new in this version, shared by both modes),
5. plans and applies only the authorized edits — in the site's own stack (Source mode, Page Builder) or as freshly-composed React using real DS components (React Preview mode, Page Composer) — preserving everything else,
6. renders the assembled result locally and validates it — per finding, per section, and combined (Visual Verifier),
7. stops for the user's visual approval (G2) — the **only** approval gate in either mode.

There is no step building or publishing Design System components in either mode; that remains a separate, future Component Agent (§12).

### 1.2 Boundary — storages, kept distinct

| Storage | What lives there | Access |
|---|---|---|
| **audit-agent** (sibling repo) | `data.json`, `fix-plan.json`, `new-component-plan.json` (read only, never acted on), evidence, the report | read-only; never copied here |
| **this repo's `projects/` tree** | run artifacts: context, mapping, source-mapping (Source mode) or content-extraction (React Preview mode), plans, validation results, previews | the only durable output of this system's own bookkeeping |
| **the site's own source repository** (Source mode only, §0.4) | the actual page source this graph edits | read always; **write only inside an isolated local worktree, on its own branch**; never the user's main checkout, never pushed, never merged — this system has no push/PR capability in this graph at all (that only exists in the retired Workflow B) |
| **this repo's own output tree** (React Preview mode) | the freshly-generated React app | written entirely within this system's own output tree; **never touches the site's actual repository, which may not even exist** |
| the site's live production URL | — | **never accessed for editing, in either mode.** Source mode's R2 navigates to a local dev server only. React Preview mode may need a single, explicitly-approved, read-only content capture (§8a.1) — never a routine one, never in Source mode |
| the Aura design-system repo (`designSystemPath`) | component/token source | read-only dependency of Redesign Planner (both modes, §8.8) and Page Composer (React Preview mode, §8a.2) — never written to, never a place this graph pushes a candidate component into (the `new-component-candidate` record, §8.8, is a flat file in this repo's own output tree) |

Merge and deployment are outside this system entirely, in either mode.

### 1.3 Operating mode and design mode are independent axes

`--operating-mode source|react-preview|auto` and `--mode full-page|selected-sections` are set independently. Run type is unchanged and orthogonal to both: effectively always `redesign` — the CLI already refuses `--run-type combined`/`--run-type components` as of the 2026-09-28 change, and this document treats that as permanent policy for this graph, not "for now." `combined`/`components` remain valid **only** as the entry point for a future, separate Component Agent that reuses the preserved Workflow B code directly (bypassing this CLI), never through this graph.

### 1.4 Explicit non-goals

- No component building, no Design System work, no publish/push/PR (Workflow B in full).
- No live backend data — local mock data is expected and sufficient for visual review (Source mode); React Preview mode needs no backend at all for anything it can render from audit evidence.
- No production access at any point for editing, in either mode. Source mode never touches production. React Preview mode may need one explicitly-approved, read-only capture (§8a.1) — never an edit, never unapproved, never routine.
- No promise of source-level fidelity without the actual site repository (§0.4) for Source mode — a capability this document cannot manufacture by itself.
- No React Preview output ever presented as if it were, or could be merged as, production source (§0.5, §8a.4).
- No fabricated fix for a finding with no basis (unchanged, hard rule, §8.8) — the one rule this whole system must never break.

---

## 2. Inputs

### 2.1 Fix Plan — unchanged from v3.2/v4.0

`<auditRunDir>/fix-plan.json`, `{ findingId, decision: fix | skip | keep_for_review, decidedAt, decidedBy, note, source }`. Only `decision: fix` entries are in scope. Validated exactly as today (`src/audit-link/fix-plan-schema.ts`, unchanged).

### 2.2 New Component Plan — read, reported, never executed

`<auditRunDir>/new-component-plan.json` is still read and validated by R1 (so a malformed file is still reported, not silently ignored) and its entry count is still shown to the user (so nothing upstream disappears silently) — but **no code path in this graph acts on it**. There is no G3, no component selection, no L1 call, in either operating mode. This is the concrete meaning of "ignore `new-component-plan.json` for execution": visible, honestly reported, inert.

### 2.3 The website source repository — Source mode only, mandatory for that mode

| Field | Meaning |
|---|---|
| a local path or a clone-able remote + ref | the site's actual Next.js/React (or Django, or hybrid — §0.4) repository |
| detected automatically once present | package manager (lockfile), framework/render technology, styling system(s) in use, dev command, and whatever env vars the dev server needs to boot without a live backend |
| **never assumed** | this document does not guess the stack from the rendered page's markup — that was tried earlier and is explicitly insufficient for source-level work |

Not read or required at all in React Preview mode. Until this exists, Source mode's R2 cannot run for real (§0.4).

### 2.4 Supporting context

| Context | Source | Required |
|---|---|---|
| audit data | `<auditRunDir>/data.json` | always |
| fix plan | `<auditRunDir>/fix-plan.json` | always |
| evidence images and boxes | `findings[].quality.evidence[]` — absolute paths into the audit run, page-absolute boxes | for mapping; a missing file is recorded, never fatal |
| reviewer guidance | plan `note` / `decidedBy`; `action.recommendation` | availability varies per finding; absence is recorded, never inferred |
| related findings | findings sharing a `component.signature` | for patterns and instances |
| what the reviewer saw | `<auditRunDir>/report.html` | optional in Source mode; a content source in React Preview mode, §2.5 |
| run metadata | `<auditRunDir>/run.json` | falls back to the run id |
| the Design System's component/token source | `design-system/core-v2`, via D1–D6/`ds-reference.ts` (§0.2, reinstated) | **always, both modes** — required for the DS-verification step (§8.8), not merely a Source-mode nicety as v4.0 had it |

### 2.5 Audit evidence and report — a required input specifically for React Preview mode

`data.json`'s `quality.evidence[]` (element/context screenshots, page-absolute boxes) and `report.html` (already documented above as reviewer context; now also a content source for React Preview mode's extraction, §8a.1). Nothing here is ever treated as the live page's current truth (§6.1) — it is what the audit saw, at audit time, never a substitute for a live capture when one is possible.

---

## 3. Agents, stages, skills, tools

### 3.1 Vocabulary

| Kind | Definition | Test |
|---|---|---|
| **agent** | owns a judgment — a model call with a typed structured output, or a human decision — with its own contract, failure modes and retry policy | "could two competent runs disagree?" |
| **stage (node)** | a step on the execution graph with a typed contract and one traced span per attempt; deterministic stages are tools in a fixed order | "is it on the graph?" |
| **skill** | a reusable procedure: a stateless code module, or a `SKILL.md` a session follows | "used by more than one stage or session?" |
| **tool** | an external capability with no judgment | "does it only execute?" |

### 3.2 The six roles — evaluated for sufficiency, revised for two modes

| # | Role | Kind | Inputs | Outputs | Mode-dependent behavior |
|---|---|---|---|---|---|
| 1 | **Session Agent** | agent, conversational | the user's reference, chat, gate answers | commands, recorded decisions | presents the operating-mode choice/default (§0.5) alongside the existing design-mode choice |
| 2 | **Element Mapper** | agent, hybrid | authorized findings, a rendered capture, evidence boxes | `mapping.json` — element-keyed: stamp, findingIds, confidence class, drift, affordances | Source mode: maps against the local dev-server render. React Preview mode: maps against already-captured audit evidence (screenshots + recorded geometry) — no fresh capture needed unless full-page content beyond what's evidenced is requested (§8a.1) |
| 3 | **Source Mapper** | agent, hybrid | a mapped, stamped element; the running dev server (dev mode); the worktree source tree | per element: source file(s) + line, the JSX call site, a style-authoring classification | **Source mode only.** Not used in React Preview mode — there is no existing source file to resolve to |
| 4 | **Redesign Planner** | agent, ai | a mapped (+ source-mapped, Source mode) finding, its expected value/rule, the Design System's current source (§0.2, §8.8), reviewer `note` | a semantic edit description per finding: property or complete-pattern, or `unaddressed`/`new-component-candidate` | **identical contract in both modes** — this is deliberate: putting DS-verification here rather than in the building step means the two modes never diverge on *what* the correct fix is, only on *how* it gets written |
| 5 | **Page Builder** (Source mode) / **Page Composer** (React Preview mode) | agent, ai | Redesign Planner's edits for one section + (Source mode) Source Mapper's file/mechanism info, or (React Preview mode) extracted content + real DS components + the section's **complete content inventory**, not just its Fix findings (§8b) | Source mode: an actual source diff confined to the section's declared write set. React Preview mode: freshly-generated React files for the section's **complete** real structure — all headings, copy, cards, imagery/backgrounds, layout, CTAs — with the verified DS change applied only to the Fix-marked element(s) (§8b) | Source mode diffs existing files, which are already complete by construction — this failure mode is React-Preview-specific. React Preview mode generates new files from scratch and can under-build if not held to the complete-section contract (§8b, found live) |
| 6 | **Visual Verifier** | agent, hybrid | the plan, the assembled local render, evidence, **the section's content inventory (§8b)** | a **section-completeness verdict first** (COMPLETE/PARTIAL/BLOCKED, §8b), then — only once that passes — per-finding fixed/not-fixed checks, a structural diff, a vision verdict, `PASS`/`PARTIAL`/`FAIL` | React Preview mode adds the simulated-interaction/limitations list (§8a.3) and the completeness verdict (§8b, both modes) |

**Sufficient — no seventh (or eighth) role needed**, evaluated the same way v3.2 and v4.0 evaluated their six:

- **"Validate JSON and derive scope"** is R1 + `resolveScope` — fully deterministic and already built; no judgment survives once "every non-global section with a Fix finding" is the fixed rule.
- **"Capture permitted local page context"** is R2 (Source mode) or Element Mapper reading existing evidence (React Preview mode) — deterministic either way.
- **"Build independent sections in bounded fan-out; integrate shared changes serially"** — the fan-out is many instances of the *same* role (Page Builder or Page Composer), exactly as v3.2 argued for Component Builder: "a bounded batch... is still one role running many times — not a new one." The serial integration step, **Page Integrate**, is deterministic by the same reasoning as v3.2's L2b: merging *declared*, non-overlapping write sets into shared files is a fixed-order mechanical merge once each instance has declared what it touches. If two sections' *undeclared* changes collide, that is a **failure of one of those builds**, not a reason to add a judgment role.
- **Page Builder and Page Composer stay one role, not two** — generating fresh React (React Preview mode) and diffing existing React (Source mode) are the same underlying judgment; the difference is the shape of the write, not the kind of decision being made. This mirrors exactly how v3.2 argued Component Builder's parallel fan-out was "one role running many times," extended here to "one role, two output targets."
- **"Package... and stop at G2"** is R7 (assemble/package, deterministic) → G2 (a human decision, not an agent — Session Agent presents it).
- **§8b's section-completeness gate is not a seventh role either.** "Is this section's real content present" and "is the after-render correct and unregressed" are the same kind of judgment Visual Verifier already owns (comparing a render against evidence) — it is a new *check*, run first, not a new *kind* of judgment. Likewise, "build the complete section, not just the Fix elements" widens Page Composer's existing *scope* (what counts as "done") without changing the *kind* of work it does (turn a plan + content into real code).

A seventh role would only be justified by a genuinely new kind of judgment no existing role or gate covers. None was found, in either mode — re-checked here again after §8b, not assumed closed.

### 3.3 Shared skills and tools

| Skill/tool | Used by | State |
|---|---|---|
| `audit-link` (find-run, schemas) | S0, R1 | **[built]**, unchanged |
| session/decisions/gate-fingerprints | every gate | **[built]**, needs a new hashing basis for G2 (§11.3) |
| mapping objective-checks (geometry/IoU/text/class/uniqueness) | Element Mapper | **[built]**, re-pointed per mode |
| t-layer capture primitives | R2, Element Mapper, Visual Verifier | **[built]**, re-pointed per mode |
| imaging (tile/flatten) | R2, Visual Verifier, preview packaging | **[built]** |
| **D1–D6 / `ds-reference.ts`** (reinstated, §0.2) | Redesign Planner (both modes, §8.8), Page Composer (React Preview mode, §8a.2) | **[built]**, read-only, never a write target |
| worktree/repo manager | R2, Source mode | **[proposed]** |
| dev-server lifecycle manager | R2, `serve`, both modes | **[proposed]** |
| React fiber source-location extraction (`_debugSource`) | Source Mapper, Source mode | **[proposed]** — §6.4 |
| style-authoring classifier | Source Mapper, Source mode | **[proposed]** |
| git diff / write-set enforcement for a worktree | Page Builder, Page Integrate, Source mode | **[proposed]** |
| content/asset extraction from audit evidence | Page Composer's input, React Preview mode | **[proposed]** — §8a.1 |

Tools: Chromium via Playwright (against localhost only, plus one gated exception in React Preview mode, §8a.1); the filesystem; the site's own package manager/dev command (Source mode); `git` (local, worktree-scoped, Source mode); audit-agent's CLI (read-only); the model API or `claude-session` judgment.

---

## 4. Configuration

All existing keys are unchanged and reused. New:

| Key | Meaning | State |
|---|---|---|
| `operatingMode: "source" \| "react-preview" \| "auto"` | which mode a run uses; `"auto"` (default) resolves per §0.5's rule based on whether `siteRepo.path` is set | **[proposed]** |
| `siteRepo.path` | local path to the site's source checkout (or a clone target) | **[proposed]** — §0.4, currently unset because no such path exists |
| `siteRepo.ref` | branch/commit to check out into the worktree | **[proposed]** |
| `siteRepo.devCommand` | override for the detected dev command, if needed | **[proposed]** |
| `siteRepo.mockDataStrategy` | how to satisfy fetches the app would otherwise make to a live backend | **[proposed]** |
| `worktreesRoot` | where isolated per-run worktrees are created (Source mode) | **[proposed]** |

v4.4 adds (`src/config/schema.ts`, with `FIX_REDESIGN_AGENT_*` env overrides): `fidelity.{maxCorrectionCycles=2, maxVerifications=3, maxDurationMinutes=15, maxElementsPerSection=160, maxHoverTargets=20, maxFocusTargets=16}` **[built]** (§8d.4 — the verifier itself cannot be switched off) and `references.{registryPath?, referenceProjectsRoot?, checkServers=false}` **[built]** (§8d.2).

`dsRepo.*` (Workflow B's config) stays as-is, untouched, unused by this graph.

---

## 5. Session startup, discovery, persistence

Name resolution, discovery, and persistence files are unchanged from v3.2/v4.0 — none of that logic depends on which operating mode or deliverable shape a run produces. **§5.2a-equivalent (section scope) is permanently the only behavior**, not a temporary state: `resolveScope` always auto-derives the Selected Sections candidate set from every non-global section containing a Fix-decision finding, and only ever asks for a **mapping/expectation acknowledgement conflict** — never merely because the input JSON carries no section-selection field (that field will never exist upstream; this was removed 2026-09-28 and stays removed here).

**New in this version:** operating-mode resolution happens once, at the point R1 would otherwise need `siteRepo.path`. Instead of refusing when it's absent, R1 checks `operatingMode` (or resolves `"auto"` per §0.5's rule), and only refuses if `"source"` was explicitly forced without a configured repo. `run.json` records which operating mode a run used, alongside its existing `mode`/`runType` fields, so a resume is never ambiguous about which deliverable shape to expect.

---

## 6. Context & Mapping

### 6.1 Authority by concern

There is no global ranking of sources. Each source is authoritative **for its own concern only**, and a source is never consulted outside it.

| Concern | Authority | Everything else |
|---|---|---|
| authorized scope — what may be changed at all | the user's fix plan | nothing may widen it |
| current page state | Source mode: the local dev-server capture. React Preview mode: the audit's recorded evidence (screenshots, geometry, computed styles) — there is no "current page" to capture fresh, since there's no local render of real source | audit evidence is a hint in Source mode; it is the *primary* record in React Preview mode, with the same caveat as always: it is audit-time truth, not necessarily still-accurate truth |
| historical findings, expected values | `data.json` | the live/evidenced page may contradict it; that is recorded as drift, not a correction |
| **correct DS component/variant** *(restored and corrected — v4.0 removed this row entirely)* | **the Design System's source, re-verified at build time by Redesign Planner (§8.8) — never `data.json`'s recorded match alone** | `data.json`'s `dsComponent`/`dsVariant` is a hint that must independently re-confirm, not a fact to execute against blindly — the concrete reason: the real button-rematch run's "Let's Connect" inputs were all matched to the wrong component by a hardcoded upstream rule table |
| reviewer intent | the plans' `note` / `decidedBy`, plus the audit's own recommendation | never inferred from the page |
| what the reviewer was looking at | the audit report | never page truth, never DS truth |

**Conflicts are recorded, never silently resolved**, written to `context/conflicts.json` and surfaced at the next gate:

| Conflict | Handling |
|---|---|
| live/evidenced page contradicts audit evidence for an element | a drift record (§6.5); the live/evidenced state governs current state, the audit still governs what was found |
| `data.json` target URL vs run metadata | `data.json` governs; warning recorded |
| plan `runId` vs the resolved folder | refuse the run |
| a DS match fails re-verification (§8.8) | escalate at G1 — new, never silently applied even if `data.json` recorded high confidence |
| a DS component or token referenced by a finding no longer exists in the current DS source | the finding becomes `unaddressed` with that reason; never substituted |

### 6.2 What is assembled (R1)

Plans, audit data, run metadata, evidence paths, related findings by shared signature. The Design System registry is consulted later, per finding, by Redesign Planner (§8.8) — not read wholesale up front, since reading an entire third-party repo's source up front is neither needed nor scalable.

### 6.3 What is inspected, and how a match is confirmed — Element Mapper

Geometry, content, assets, computed styles, and **observable affordances** — tag, role, `href`, type, `tabindex`, `aria-*`, disabled state, cursor, form association. **Source mode:** these come from the local dev-server capture (never production). **React Preview mode:** these come from the finding's own recorded evidence (screenshot crop, box, computed styles already in `data.json`) — no fresh capture needed for a Selected Sections run, since every selected section has at least one finding, hence evidence; Full Page mode may need more (§8a.1).

**Objective checks** — computed, reproducible, no model involved, unchanged from v3.2 and reproduced here in full rather than only cross-referenced, since both modes actively reuse this mechanism today:

| Check | Passes when |
|---|---|
| geometry | the live/evidenced box overlaps the audit box above `iouFloor` (default 0.6) after scroll normalisation |
| identity | tag and role agree with the audit's record |
| text | normalised text or accessible name similarity is above `textSimilarityFloor`, or both are empty |
| class fingerprint | the element's classes overlap the class list the audit recorded, when one exists |
| uniqueness | exactly one candidate in the document passes the checks above |

**Confidence classes and what each authorizes:**

| Class | Reached when | Authorizes |
|---|---|---|
| `confirmed` | uniqueness holds **and at least two independent checks pass** | edits, previews, specs |
| `probable` | several candidates passed objectively and Element Mapper selected one among them | edits only after acknowledgement at G1 — never on model confidence alone |
| `ambiguous` | several candidates remain and no confident, objectively-passing pick is possible | a human must resolve; otherwise the finding is `unaddressed` |
| `absent` | no candidate passes | `unaddressed`, with the drift record as the reason |

The model's role is strictly to **propose a selection among enumerated candidates that already pass objective checks**. It can never create a `confirmed` mapping, can never override a failed check, and its stated confidence is recorded but is not an authorization input. §8.8's DS-verification step applies this exact same discipline — objective agreement first, a model proposal never sufficient alone — to *component* identity instead of *element* identity.

### 6.4 Source Mapper — new mechanism (Source mode only)

**Primary mechanism: React's own development-mode fiber metadata.** When a page is served by `next dev` (development mode, not a production build), React attaches debug-only information to each fiber node — including `_debugSource` (file + line of the JSX call site that created that element) and `_debugOwner` (the component that rendered it). This is inspectable from a Playwright `page.evaluate` call against the live DOM node, exactly the same way Element Mapper already inspects computed styles — no new browser capability, no source maps, no guessing from class names as the primary path. This is why Source mode's R2 must run the site via its **dev** command specifically, not a production build (`next build && next start` strips this information in most Next.js versions).

**Output per stamped element:** the exact file + line of its JSX call site, and a **style-authoring classification** — read from that file's actual content, not inferred:

| Classification | What it means for Page Builder |
|---|---|
| Tailwind utility classes in `className` | the fix is a class swap, ideally matching an existing value already used elsewhere in the same file/config |
| CSS module (`import styles from './X.module.css'`) | the fix edits a rule in that module file |
| inline `style` prop | the fix edits the literal style object/string |
| styled-components / emotion template literal | the fix edits the template |
| a global stylesheet selector | the fix edits that selector, checking for cascade/specificity conflicts |
| a design-token/theme reference already present in the site's own code | **preferred over a new literal value whenever one already resolves to the target** |

**Confidence tiers, mirroring Element Mapper's own discipline, applied to file/property resolution instead of DOM identity:**

| Class | Reached when | Authorizes |
|---|---|---|
| `confirmed` | `_debugSource` names exactly one file/line and the styling mechanism is unambiguous from that file's content | Page Builder may proceed |
| `probable` | `_debugSource` names a file, but the specific property could plausibly come from more than one place, and Source Mapper (a model call among enumerated candidates) picked one | edit only after acknowledgement at G1, never on model confidence alone |
| `ambiguous` | more than one real candidate remains and no confident pick is possible | escalate at G1; unresolved → `unaddressed` |
| `absent` | no `_debugSource` available at all | `unaddressed`, with the reason recorded |

This is a genuinely new risk surface relative to v3.2 (§13).

### 6.5 Drift

Classes unchanged (`identical`/`moved`/`restyled`/`content-changed`/`absent`/`ambiguous`). **One addition:** local-build drift — a checked-out source, even at the exact configured ref, can render slightly differently from the live production page (a pending deploy, an environment difference, mock data replacing real content). Recorded exactly like any other drift, expected to be *more common* here than production-to-production comparisons (§13). In React Preview mode, the equivalent is: the recreated page can only ever be as faithful as the audit's own evidence — a distinct, honestly-stated limitation (§8a.1), not "drift" in the same sense.

### 6.6–6.7 Capture freshness and resume

Same fingerprint discipline as before (DOM, stylesheets, fonts, assets, viewport, rendering policy), **plus a source fingerprint** in Source mode: the git commit/diff of the worktree at capture time. A resume revalidates capture freshness, mappings, and (Source mode) source mapping — if the worktree's source changed since a source-mapping was recorded, that mapping is invalidated and redone.

---

## 7. Execution graph

### 7.1 Spine — forks after R1

```
Project/Run: <name>   Mode: Full Page | Selected Sections   Operating mode: source | react-preview | auto
        │
        ▼
S0 resolve <name>  ──[G0 — only on ambiguity/staleness]──►  R1 validate JSON + derive scope +
                                                              resolve operating mode (§0.5)
        │
        ├── operating mode = source ────────────────────────────────────────────┐
        │                                                                        │
        │   R2 prepare isolated worktree (checkout, install, mock data) →       │
        │      start local dev server                                          │
        │        │                                                              │
        │        ▼                                                              │
        │   Element Mapper  map each Fix finding → rendered element + section   │
        │        │                                                              │
        │        ▼                                                              │
        │   Source Mapper  map each mapped element → source file(s) +          │
        │                  styling mechanism                                    │
        │        │                                                              │
        │     [G1 — scope half never asks (§5); acknowledgement half only for   │
        │      a genuinely probable/ambiguous element OR source mapping, OR a   │
        │      DS-match verification failure (§8.8)]                            │
        │        │                                                              │
        │        ▼                                                              │
        │   ┌─ loop ≤ maxIterations, exits on PASS ──────────────────────────┐ │
        │   │ Redesign Planner (§8.8) → Page Builder × N (write-set disjoint) │ │
        │   │   → Page Integrate (deterministic fan-in) → render on the       │ │
        │   │   already-running dev server → Visual Verifier                 │ │
        │   └────────────────────────────────────────────────────────────────┘ │
        │        │                                                              │
        │        ▼                                                              │
        │   Package: worktree path, previews, validation results, dev-server   │
        │            link                                                       │
        │                                                                        │
        └── operating mode = react-preview ─────► §7.1a's spine, below          │
        │                                                                        │
        ▼                                                                        ▼
   G2 — visual approval (always asked; the only gate that always asks, in either mode)
```

No Workflow B, no G3/G4/G5, no `components`/`combined` run type reachable from this graph, in either mode.

### 7.1a React Preview mode spine — the PROPOSED AI-authored design; the implemented path is §8c

> **v4.3:** the implemented React Preview does not use Element Mapper-on-evidence, Page Composer or Page Integrate. It reproduces the section from the run's own captured DOM + CSS and verifies the running result (§8c). This diagram remains the design for a future evidence-only mode.

```
R1 (as above, operating mode resolved to react-preview)
        │
        ▼
Element Mapper   map each Fix finding against audit evidence (screenshots + recorded
                 geometry) — no fresh capture; the finding's own evidence IS the
                 "live" render for this mode (§6.3)
        │
     [G1 acknowledgement half only — scope half never asks, same rule as Source mode]
        │
        ▼
   ┌─ loop ≤ maxIterations, exits on PASS ──────────────────────────────────────┐
   │  Redesign Planner   verify DS match, decide semantic edit (§8.8) —         │
   │                     IDENTICAL contract to Source mode (§3.2)               │
   │       │                                                                     │
   │       ▼                                                                     │
   │  Page Composer × N   bounded fan-out, ONE per section, builds the section's │
   │                      COMPLETE real structure — every heading/copy/card/    │
   │                      image/CTA, not just the Fix elements — using real DS  │
   │                      components; ONLY the Fix element(s) get the verified  │
   │                      DS change, everything else is faithfully reproduced,  │
   │                      not redesigned (§8b)                                  │
   │       │                                                                     │
   │       ▼                                                                     │
   │  Page Integrate      same deterministic fan-in as Source mode              │
   │       │                                                                     │
   │       ▼                                                                     │
   │  render on a local dev server for the FRESHLY-GENERATED app (not the site) │
   │       │                                                                     │
   │       ▼                                                                     │
   │  Visual Verifier:                                                          │
   │    1. SECTION-COMPLETENESS GATE (§8b) — content/layout inventory present?  │
   │       fails/partial → report the exact gap, mark PARTIAL/BLOCKED, STOP     │
   │       here for that section — never proceed to step 2 on invented content  │
   │    2. per-finding DS-property checks (§8.8) + structural diff + vision     │
   │    3. simulated-interaction/limitations list (§8a.3)                      │
   └────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
   Package: generated React source, per-section previews, combined preview,
            validation results, LIMITATIONS.md, working localhost link —
            every artifact labelled "React Preview — not production source" (§8a.4, §9)
```

### 7.2 Fan-out / fan-in for Page Builder / Page Composer — reusing L2/L2b's proven pattern

Exactly the mechanism v3.2 built for Component Builder, applied to sections instead of components, in either mode:

- Each section with at least one planned edit is one dispatched **Page Builder** (Source mode) or **Page Composer** (React Preview mode) instance, bounded by a concurrency cap (reuse `buildConcurrency`, default 2).
- Each instance **declares a write set** before building — the file(s) it will touch (Source mode: files it will diff) or create (React Preview mode: files it will generate). A build that touches an undeclared file is rejected; that section fails without affecting the others.
- **Page Integrate is the fan-in**, in both modes: after every dispatched instance completes or fails, it applies any *declared* shared-file changes (a shared layout, a shared Tailwind config entry, a shared global stylesheet rule) in a fixed, deterministic order — no model call.
- If two sections' real (not merely declared) required changes to the same shared file conflict, that is a build failure for the later one, reported and retried, never silently overwritten.

### 7.3 Retry limits — unchanged shape, applies in both modes

| Where | Policy |
|---|---|
| model transport | 6 attempts, exponential backoff (unchanged, vendored) |
| structured output failing schema | one repair re-ask |
| deterministic node (R1, R2, Page Integrate, packaging) | 3 attempts, idempotent by construction |
| ai/hybrid node (Element Mapper, Source Mapper, Redesign Planner, Page Builder/Composer, Visual Verifier) | 2 fresh attempts |
| Redesign Planner → Page Builder/Composer → Visual Verifier loop | `maxIterations` (default 3), early exit on PASS |
| Page Builder/Composer per section | 3 attempts, early exit on that section's PASS; the batch continues regardless |
| S0 resolution | none, always asks on ambiguity |

### 7.4 Failure handling

| Failure | Effect | Resume |
|---|---|---|
| a node throws | run meta records the node, iteration and first line; span marked in error; browser closed | reopen, fix, continue from the last checkpoint after revalidation |
| an input changed since the run started | reported as stale at the next gate | continue only on an explicit answer |
| mapping `absent` or `ambiguous` | that finding is `unaddressed` or escalated; never guessed | resolve at G1 |
| a write-set violation | that unit fails; the batch continues | rebuild after the spec is corrected |
| **the local dev server fails to start** (Source mode: missing env var, a fetch to a live backend with no mock configured, a build error in the checked-out source) | the run is **blocked**, naming the exact command run, its exit code/output, and — if detectable — which fetch/env var is missing | fix the worktree or the mock-data config, then resume; never silently retried against production as a fallback |
| a required plan input is missing | the run or that half is **blocked**, naming both paths checked | provide the export |

### 7.5 Run outcomes — simplified

Per-unit states (`done`/`blocked`/`awaiting-approval`/`failed`) apply to **findings only** — there is no second unit kind (no components), in either mode. Per-run aggregation: the most severe unit state present, in order `failed → blocked → awaiting-approval → completed`. `awaiting-judgment` (claude-session mode) is unchanged and fully reused in both modes.

---

## 8. Fix planning and building — shared logic (Redesign Planner), and Source-mode building

### 8.1 Design modes

| Mode | Scope | Applied | Section reconstruction (§8b) |
|---|---|---|---|
| **Full Page** | every page-specific (non-global) section of the captured page, in page order | every `fix` finding outside the global header and footer | every section is rendered **complete**. v4.3: a content region with no audit findings is rendered unchanged from the capture (an anonymous `region-N`), never replaced by a static crop or fabricated markup; content that belongs to no region is reported as orphan content |
| **Selected Sections** | the auto-derived set of sections containing a Fix finding (§5) — and **only** those | `fix` findings inside those sections only | every selected section is built **complete** (§8b.1) — never just its Fix elements in isolation. **Unselected sections and the global header/footer are absent from the delivered preview and from the static content export** (v4.3, correcting v4.2's "kept and marked"); a finding in an unselected section is never edited |

The real Deals & IPO button-rematch run's own resolved scope is a concrete example: sections "High-Synergy Deals, Delivering Successful IPOs," "How We Can Help," and "Let's Connect" contain the 26 `fix`-decision findings; "Header" is excluded as global. The first real build of this scope is also §8b's concrete failure example (§8b.0) — each section was built as only its Fix elements, not completely.

### 8.2 Section identity

A section id is derived from the audit's own section name, slugified, collision-suffixed (`src/session/scope.ts`, already built). Section ids are stable across runs for as long as the audit names the section the same way.

### 8.3 Global header and footer

Global sections are excluded from scope, full stop — the audit's own findings within them are listed as out-of-scope in the change list. There is no "routed to Workflow B" destination anymore (that workflow is a separate future agent, in both modes); a header/footer finding simply stays out of scope for this graph.

### 8.4 Style-authoring classification

Owned by Source Mapper (Source mode only, §6.4), consumed by Page Builder. React Preview mode has no equivalent step — Page Composer writes fresh files, so there is no existing styling mechanism to classify (§8a.2).

### 8.5 Validation of the assembled local render (Source mode)

| Check | Fails when |
|---|---|
| the dev server still boots and renders after Page Integrate | a build error, a runtime error, a failed fetch with no mock |
| scope | an edit landed outside its section's declared write set, or an unselected section changed at all |
| rendered parity for untouched elements | anything **not** targeted by a Fix finding visibly changed — proves "preserve the existing design" actually held |
| per-finding measured re-check | the targeted property (or complete DS pattern, §8.8) now matches the expected value |
| structural diff | no interactive element or text lost |
| vision comparison | before/after screenshots, per section and combined |

React Preview mode's equivalent validation is described in §8a.3's table (preserved / simulated / listed-unavailable), since "the dev server still boots" and "rendered parity for untouched elements" don't apply the same way to a freshly-composed page.

### 8.6 Nodes

| Node | Kind | Responsibility | State |
|---|---|---|---|
| R1 | deterministic | validate both JSON inputs, filter to `fix` scope, derive default section scope, resolve operating mode | **[built]**, reused; operating-mode resolution is new |
| R2 | deterministic | Source mode: worktree prepare, dev-server start, local capture, capture fingerprint. React Preview mode: not used — Element Mapper reads existing evidence instead | **[reused with modification]**, Source mode only |
| Element Mapper | hybrid agent | map findings → rendered elements | **[reused with modification]**, both modes, different capture target |
| Source Mapper | hybrid agent | map elements → source file + styling mechanism | **[proposed]**, Source mode only |
| Redesign Planner | ai agent | verify DS match, semantic edit per finding, or `unaddressed`/`new-component-candidate` (§8.8) | **[reused with modification]** — same role as v4.0, DS-verification sub-step and complete-pattern branch newly specified here, shared by both modes |
| Page Builder | ai agent | one section's actual source diff | **[proposed]**, Source mode, replaces R4 |
| Page Composer | ai agent | one section's freshly-generated React, using real DS components | **[proposed]**, React Preview mode |
| Page Integrate | deterministic | serial merge of declared shared-file changes | **[proposed]**, mirrors L2b, both modes |
| Visual Verifier | hybrid agent | per-finding/section/combined QA, `PASS`/`PARTIAL`/`FAIL`; React Preview mode also compiles the limitations list | **[reused with modification]**, both modes |
| Package | deterministic | worktree/preview-app path, previews, validation results, dev-server link | **[reused with modification]** — same node as R7; `buildRedesignDeliverable`'s body is substantially rewritten per mode, not newly invented as a separate node |

### 8.7 The Design System's role

Values come from whatever the Design System's *current* source actually specifies (§8.8) — never from a stale, audit-time-only record. In Source mode, values are written into the site's own existing styling mechanism (Source Mapper's classification, §6.4) — the DS's component *code* is never imported into the site's repo. In React Preview mode, the DS's actual component code *is* used directly, because the output is explicitly not the production site's source in the first place (§0.5).

### 8.8 Findings with no measurable mismatch — revised, shared by both modes

**New: a verification step runs before any branch below fires, for every finding, in both modes.** Redesign Planner re-derives the correct `dsComponent`/`dsVariant` using `ds-reference.ts`'s scoring against the Design System's **current** source (§0.2, §6.1) — never simply reading `data.json`'s recorded match and proceeding. A match is treated as `confirmed` only when **at least two independent governed properties** agree between the finding's evidence and the candidate DS component's actual source (a token value it computes, a structural class it applies, a documented state it implements) — mirroring Element Mapper's own `confirmed`-tier rule (§6.3: "uniqueness holds and at least two independent checks pass"). This is not a new judgment invented for this document; it is the same discipline already applied to *element* identity, now applied to *component* identity.

**What "independent" means, made concrete rather than left to a single anecdote:** two properties count as independent evidence only when one's value cannot be derived from the other by construction — e.g., a component's hardcoded gradient token and its hardcoded letter-spacing value are independent (nothing in the component ties one to the other); a component's class name and a CSS rule that class name itself defines are not independent (confirming the class exists doesn't confirm the *visual* match, only that the name matches). The worked example below uses five genuinely independent properties; the practical minimum bar is two, and Redesign Planner records which properties it used so a reviewer can judge the check's strength, not just its pass/fail outcome — a `confirmed` result backed by two weak signals is disclosed as such, not presented identically to one backed by five strong ones.

Concrete illustration from the real button-rematch run: for finding `1e9ca6a8...` ("Submit Now"), the audit recorded `Button · primary · md · light` at 0.5/MEDIUM confidence. Independently checking `atoms/Button.tsx`'s actual source confirms it on five separate, independent properties (the shimmer gradient token, the letter-spacing value, the font-weight, the box-shadow at rest, the radius token) — well above the two-property bar, so it's `confirmed`. For the eight "Let's Connect" input findings, the audit recorded `FilterSearchInput` — but independently checking the DS source finds no such agreement (the padding/shape don't match, and there was never a real alternative scored against it, per the upstream rule-table bug found this session); this fails verification and is treated as `probable`/`ambiguous`, escalated at G1, never silently applied.

| The finding carries | Redesign Planner produces |
|---|---|
| measured mismatches **and** a `confirmed` DS match | an edit that applies the matched variant's **complete governed property set** — not just the properties `comparison.mismatches` happened to list — using the DS source's actual values (Decision #63, narrowing Decision #60) |
| measured mismatches, no DS match at all | a property edit using the expected value (or the site's own matching token, Source mode; or a directly-rendered DS primitive, React Preview mode) |
| rule violations only | a rule-driven edit |
| a DS match that fails verification (`probable`/`ambiguous`, per the step above) | escalate at G1 — new; never silently applied even if `data.json` recorded high confidence |
| no measurable mismatch, but the site's own source (Source mode) or a DS pattern (React Preview mode) has an obviously-corresponding nearby precedent | an edit inferred from that precedent, marked as inferred — never from an unrelated design system's code |
| none of the above | **emit a `new-component-candidate` record** (element + evidence + why nothing fits) to this run's own output tree, and mark the finding `unaddressed` — new; previously this was a dead end with no trace |

**What this still never does (Decision #63, narrowing Decision #60):** never imports a Design System component's React code into the site's own repository (Source mode) — Page Builder only ever writes property-level values via the site's existing styling mechanism. React Preview mode is the one place a DS component's actual code *is* used directly — because its output is explicitly not the production site's source in the first place (§0.5).

### 8.9 Visual validation

Per iteration and within scope: re-measurement of every edited property (or complete pattern) against the expected value; a structural diff proving no interactive element or text was lost; a vision comparison of before and after. The three outcomes stay distinct — a rejected vision verdict is never reported as a pass, and a partially-fixed page is never reported as complete.

---

## 8a. React Preview mode — building (proposed AI-authored design; superseded in code by §8c)

### 8a.1 Content and asset extraction — now a per-SECTION inventory, not a per-finding list

No source file exists to read content from. **Corrected in v4.2**: extraction is no longer just "one entry per Fix finding" — that was the root cause of §8b's failure example (a Page Composer fed only 2 Fix findings had no way to know the section also has a heading, a subtitle, and a background, because it was never told they exist). Extraction now produces, per in-scope section:

- **Every finding recorded in `data.json` for that section** (`location.section`), not only the `fix`-decision ones — this is the actual census of what the audit inspected there. Non-Fix findings are content to reproduce *faithfully as audited*, never redesigned; Fix findings get the verified DS change (§8.8).
- **Text content** — `component.productionLabel` for every one of the above.
- **Non-finding visual content** (background, decorative imagery, layout the audit never scored as an individually-findable component) — sourced from the run's **full-viewport page tiles** (`screenshots/<pageId>/page-tile-*.png`, one per ~900px band at the capture viewport width — real, already-captured pixels, confirmed present in the button-rematch run: 12 tiles covering the full page height). These are **orphaned today** — nothing in `data.json`/`report.html` maps a section's y-range to which tile(s) it falls in. Building that mapping (section y-range → tile crop) is real, required implementation work (§14), not optional polish — without it, Page Composer has no way to know what a section's background/imagery should look like, which is exactly what went wrong live.
- **Layout structure** — section boundaries and element positions from `data.json`'s `location`/geometry fields, the same data Element Mapper already reads, now also used to order and size non-Fix content, not only Fix elements.

**A real, honest limit, stated plainly rather than glossed over:** even with the page-tile mapping built, a *cropped screenshot* of non-Fix content is a reference image for Page Composer to build real markup against — it is not itself the reconstruction (§8b never permits shipping a screenshot crop as "the section"). Where the tile crop doesn't give enough information to build real markup faithfully (e.g., a background gradient direction, or copy too small to read at capture resolution), that is named as a specific, disclosed gap (§8b's PARTIAL/BLOCKED outcome), not guessed at. Full Page mode's zero-finding sections (no findings at all, not even non-Fix ones) rely entirely on the tile-crop mapping, shown as a clearly labeled, non-reconstructed reference image rather than fabricated React markup (§8.1's Full Page row, revised).

Selected Sections mode is materially more tractable than Full Page mode here, precisely because a selected section — by definition, per `resolveScope`'s own rule — contains at least one Fix finding, hence at least some real evidence to build from.

### 8a.2 Page Composer — must build the section's complete structure, not just the Fix elements

**Corrected in v4.2 — see §8b for the full contract.** Given Redesign Planner's semantic edit for the section's Fix finding(s) (identical contract to Source mode, §8.8) and the section's **complete content inventory** (§8a.1, not just its Fix findings), Page Composer writes a **new** React section component per section (fan-out, §7.2) that reproduces **every** heading, supporting copy, card, image/background, and CTA the inventory records — importing the verified DS component(s) directly from `design-system/core-v2` as a real dependency, not re-implementing their classes by hand. Only the Fix-marked element(s) receive the verified DS change; everything else in the inventory is rendered faithfully to the audited original, unredesigned. An isolated CTA, a text-only stand-in for a section that has real supporting structure, or a screenshot crop presented as the section are never acceptable outputs (§8b).

There is no ambiguity about "which styling mechanism does this file already use" (Source Mapper's whole job in Source mode), because Page Composer controls the file it's writing from scratch — this is genuinely simpler than Source mode's equivalent step in that one specific respect, though it is still a real code-generation task subject to the same fan-out/write-set/retry discipline as Page Builder (§7.2, §7.3), now scoped to the whole section rather than its Fix elements alone.

### 8a.3 Preserving or simulating interactions

Per redesigned element, one of three outcomes, always stated explicitly in the deliverable (never left implicit):

| Interaction kind | Handling |
|---|---|
| purely presentational (hover/focus states that are CSS-only, e.g. a DS Button's shimmer/ripple) | **preserved for real** — these come free with the real DS component, since Page Composer uses the actual component, not a recreation of it |
| a client-side-only behavior with no real backend dependency (e.g. a disclosure toggle, a tab switch) | **simulated** — implemented locally in the preview app, working the same way visually, clearly noted as a local simulation |
| a behavior requiring the real backend or site logic (e.g. "Submit Now" actually submitting the Let's Connect form, real search/filtering, personalization, authentication) | **explicitly listed as unavailable** in `LIMITATIONS.md` — never silently faked as if it worked, never a button that appears to submit but does nothing with no explanation |

### 8a.4 Labelling — non-negotiable, checked at every output point

Every file this mode writes — the generated app's own README, `LIMITATIONS.md`, the G2 summary, the CLI's own printed output — states plainly: *"React Preview — a recreation for visual review, built from audit evidence and the verified Design System. This is NOT an edit to www.kenresearch.com's own source, and is not intended to be merged into it. See LIMITATIONS.md for what could not be reproduced."* This is the same discipline this system has applied to every prior deliverable (never claim a static snapshot is React/Next source); the object of the discipline has just moved — now real React code needs the same honesty about what repository it is, and isn't, part of.

---

## 8b. Complete Section Reconstruction — new contract (v4.2)

### 8b.0 The failure this closes, stated concretely rather than abstractly

The first real Selected Sections build (localhost:4310, run `deals-and-ipo-consulting-test-button-rematch-react-preview-20260929`) rendered "High-Synergy Deals, Delivering Successful IPOs" as a breadcrumb, a heading, and two buttons — nothing else. The actual audited section has a dark gradient background with decorative wave line-art, and a hero subtitle ("Navigate deal scouting, exhaustive due diligence and a clear IPO roadmap without overlooking critical risks.") that was never in scope as a Fix finding, so it was never extracted, never built, and never missed by anything that ran. "How We Can Help" had the same shape of gap. Every finding that *was* built passed its own per-property DS check, so the run reported PASS/PARTIAL results with no signal at all that the sections themselves were incomplete. **This is a distinct failure mode from a wrong DS match (§8.8) or a wrong element (§6.3) — it is "the right elements, correctly fixed, inside a section that is otherwise empty" — and nothing before v4.2 checked for it.**

### 8b.1 The rule

For every in-scope section (Selected Sections: every section `resolveScope` derives; Full Page: every section that has at least one finding, Fix or not — §8.1), Page Composer must build the section's **complete real structure**:

- every heading (main and sub-), eyebrow/label text, and supporting/body copy the section actually has,
- every card, sub-element, and grouping structure,
- images, decorative elements, and backgrounds,
- the real layout and spacing relationships between all of the above,
- every CTA, not only the Fix-marked one(s),
- the relevant visible interactions for both fixed and unfixed elements (§8a.3) — a "complete" section that only animates its one fixed button is still incomplete.

**Only the verified DS change (§8.8) is applied to the Fix-marked element(s).** Everything else in the inventory is reproduced *faithfully to the audited original* — this is reconstruction, not redesign, for anything not explicitly authorized as a Fix. This is the same principle §8.1/§8.3 already established for findings outside an unselected section ("never dropped, only listed") and for global header/footer ("routing, never deletion"), now applied one level down: content *within* an in-scope section that isn't itself a Fix target is never dropped either.

**Explicitly, never acceptable, regardless of how well the Fix elements themselves check out:**

1. An isolated CTA or element rendered with no section context around it.
2. A simplified, text-only stand-in for a section that has real supporting structure, imagery, or layout.
3. A screenshot crop presented, packaged, or labelled *as* the reconstructed section — that is Source mode's original static-snapshot problem recurring at section granularity; a crop is reference material for §8a.1's extraction step, never the deliverable itself.

If only one CTA in a section is marked Fix, the section is still built in full, and the verified DS change lands on that one CTA alone — this is the concrete case the correction was written to make unambiguous, not a hypothetical.

### 8b.2 The section-completeness gate — runs inside Visual Verifier, before any PASS

A new, ordered check, gating everything §8.8/§8.9 already do:

| Step | What happens | Failure handling |
|---|---|---|
| 1. Content inventory | Enumerate everything the section should contain: every `data.json` finding in `location.section` (Fix and non-Fix), plus whatever the section's mapped page-tile crop(s) show that no finding individually captures (§8a.1) | if the tile→section mapping doesn't exist yet for this section, that is named explicitly as the gap — the gate does not silently skip to step 2 |
| 2. Render & capture | Screenshot the composed React section at the **same viewport as the audit capture** (this run's `renderingPolicy.viewport`, 1440×900) | — |
| 3. Completeness check | For every item in the step-1 inventory, confirm it is **present** in the render — content, media and layout presence, not pixel-perfect fidelity (fidelity for Fix elements specifically is step 4's job) | any inventoried item that is absent is named exactly (not "looks incomplete" — "missing: hero subtitle copy," "missing: background gradient/wave decoration") |
| 4. DS-verification | Only for sections that pass (or have only explicitly disclosed step-3 gaps): run §8.8's existing per-finding DS-match verification and property checks | unchanged from §8.8 — this step never runs against a section step 3 found meaningfully incomplete, so a well-matched DS component can never mask missing content |

**Outcomes, replacing a bare PASS/PARTIAL/FAIL for the section as a whole:**

| Verdict | Meaning |
|---|---|
| **COMPLETE** | every step-1 inventory item is present, and step 4's DS checks ran and are reported on their own terms (§8.8's own PASS/PARTIAL/FAIL, per finding) |
| **PARTIAL** | some inventory items are present and correct, specific NAMED items are missing (e.g. "missing: hero background — no page-tile mapping built yet for this y-range") — never a vague "mostly done" |
| **BLOCKED** | insufficient evidence exists to even attempt reconstruction (e.g., the tile→section mapping doesn't exist, or evidence resolution is too low to read copy) — reported as the exact missing input, matching this document's standing rule (§0.4, §13) of naming a gap rather than inventing content to route around it |

A section verdict of PARTIAL or BLOCKED is shown at G2 exactly as-is — it is never silently upgraded because the Fix elements within it happened to check out.

### 8b.3 Fan-out / fan-in, unaffected in mechanism

§7.2's fan-out/fan-in is unchanged: one Page Composer instance per section, Page Integrate joins them deterministically in order. What changes is each instance's **scope** — the unit of work is now "build this section's complete inventory," not "build these N Fix elements" — and the completeness gate (§8b.2) runs once per section, inside Visual Verifier, after that section's Page Composer instance and before its per-finding checks. A section's completeness failure does not block the others: exactly the same isolation §7.4's write-set-violation handling already guarantees for a build failure.

### 8b.4 Full Page mode, made consistent

Full Page mode applies §8b.1's rule to **every section that has at least one finding** (Fix or not) — the same complete-reconstruction treatment as Selected Sections, just over a larger set of sections. For a section with **zero findings of any kind** (no audit data exists for it at all), reconstruction is not attempted — the page-tile crop for that y-range (§8a.1) is shown as a clearly labelled, static reference image, explicitly marked as not reconstructed, rather than either fabricating React markup with no evidence behind it or silently omitting the region. This is the same BLOCKED handling §8b.2 already defines, applied at the scale of a whole section instead of a missing item within one.

### 8b.5 Structural fidelity — "complete" is not a license to restyle (v4.2, correction)

**The failure this closes.** The second real Selected Sections build (same run as §8b.0) passed its own §8b.2 completeness gate — every inventoried item was present — and still drifted from the audited original in ways the gate never checked: "How We Can Help"'s real bordered cards were rebuilt as borderless plain columns; the Hero's CTA was left at its audited (but wrong, see below) gray `secondary/dark` match instead of what the live page actually shows; "Let's Connect"'s inputs were forced to flat white-on-black to fix an unrelated transparency bug, reading as "overly bright" against the section's dark design. §8b.2 checks *presence* — is the content there — not *composition* — is it styled the way the original actually styles it. Both checks are needed; neither substitutes for the other.

**The rule.** Building a section's complete inventory (§8b.1) authorizes reproducing that inventory faithfully — it is never authorization to simplify, generify, or substitute an element's original visual treatment. This applies independently of, and in addition to, §8b.1's content-presence rule:

| In scope for a Fix finding | Out of scope, must stay faithful to the audited original |
|---|---|
| The specific property/properties the finding's DS-verified match (§8.8) actually changes | Every other element's card/surface treatment (border, radius, background, shadow) |
| — | Every other element's color, including other CTAs' colors, in the same section |
| — | The section's own background treatment, when a real, verified DS mechanism for it exists (§8b.5.2) |
| — | Layout, spacing, and grouping structure not named by any finding |

A non-Fix element rendered with a *simplified or generic* stand-in treatment (an unstyled `<div>` where the original has a real card component; a flat literal color where the original activates a DS surface variant) is a **structural-fidelity defect**, reportable exactly like a missing-content gap under §8b.2 — it fails the same gate, just on composition instead of presence.

**8b.5.1 — DS-verification applies to every element in scope, not only the ones the user names.** §8.8's independent-verification methodology (re-deriving a finding's correct DS target from the live element's own measured properties, requiring ≥2 independent property agreements, never trusting the audit's recorded match uncritically) is not limited to elements a reviewer explicitly flagged as wrong. This run found the same audit misclassification (a button audited as `secondary/dark`, its own `comparison.mismatches` showing a measured `background-color` of exact Ken red) on **three separate buttons** across two different sections — one flagged by the user, two found only by re-applying the same check to every button in scope once the first instance was known. Finding the first instance of a defect class is a trigger to check every other instance of that class in the run, not just the one reported.

**A property-diff table is not sufficient evidence on its own — a real image is.** The third button above (this run's "Submit Now") did not get caught by re-checking `comparison.mismatches`: that finding's own property table never flagged `background-color` as a mismatch at all, which reads as "no color problem here" — a false negative, not a confirmation. It surfaced only when a real evidence screenshot (an existing, already-local crop the audit itself had captured, not a fresh production visit) was actually opened and looked at. A property-diff table only reports what the audit's own comparison logic happened to check; it is not a substitute for looking at the actual pixels when evidence images already exist locally. Wherever real evidence crops exist for a finding, §8.8's independent verification means opening them, not just reading the derived property table — the table can be clean while the underlying element is still wrong.

**8b.5.2 — a verified DS mechanism beats a hand-approximation, even when nobody flagged the approximation as wrong.** Where a real, token-backed DS pattern exists for a visual treatment the prior pass hand-drew with literal CSS (this run: the Hero's decorative background, approximated with an invented gradient, versus `cinematic-dark.css`'s real `[data-variant-section="cinematic"]` mesh composition), the verified mechanism is preferred once found — it is not "in scope" only because the exact section was named, since replacing a fabricated approximation with the real DS pattern is a fidelity improvement, not a composition change. This does not extend to inventing a treatment with no DS mechanism behind it; §8.8's existing rule (report the mismatch, do not substitute) still governs when no verified pattern exists.

**8b.5.3 — a dark/light surface correction must use the DS's own variant system, not a literal recolor.** A section rendered on the wrong background tone for its content (e.g., a light-mode-default form treatment inside a section the rest of the page renders dark) is corrected by activating the DS's own scoped variant tokens (`cinematic-dark.css` / `editorial-light.css`'s `[data-variant="..."]` mechanism) for that section, not by hand-picking replacement literal colors. **Known integration gap, disclosed rather than worked around silently:** these variant stylesheets are not imported by the DS's own `base.css` — a consuming app must import its chosen variant file itself (documented in `cinematic-dark.css`'s own header comment), and a component that renders through a portal (Radix's `Portal`, used by `Select`'s dropdown content) escapes a variant scope applied via a `data-*` attribute on an ancestor, since scoped CSS custom properties only resolve within their DOM subtree. Where a verified DS component cannot be reached correctly through the scoped-token mechanism for a portaling-related reason, literal values copied verbatim from the variant stylesheet's own declarations are an acceptable, disclosed fallback for that specific element — never a substitute for using the real token system everywhere it does reach.

**8b.5.4 — a plausible-sounding DS component name is not evidence; only a screenshot is.** This run's own first application of §8.5 made exactly the mistake this whole rule exists to prevent: it swapped a section's borderless columns for a bordered DS card component, on the reasoning "the original probably had real card chrome, and this is the closest-named component for an icon+title+content pattern" — without opening the run's own already-local page-tile image to check. It was wrong: pixel inspection of that same image later showed the real section is genuinely borderless. A component's name matching a visual pattern in the abstract (`IconCard` for an icon-led card) is not the same claim as "the audited page actually uses a bordered card here," and only the second claim authorizes building one. **Before applying any §8b.5 structural-fidelity correction — restoring a treatment believed to be "the original," not just fixing a Fix-marked property — the specific evidence image for that element or section must be opened and checked, not inferred from a component's name, its docblock, or how plausible the change sounds.** A `data.json` property-diff table is also not sufficient evidence on its own for this same reason (§8b.5.1): a real screenshot is the only thing that actually shows composition, and wherever one already exists locally, checking it is not optional.

---

## 8c. React Preview — generated from captured evidence, verified before G2 `[built]` (v4.3)

**Nodes.** `B1` (behaviour capture, deterministic) runs after scope/G1 and before the first edit; `R8` (React Preview, deterministic) runs after R7 and `buildRedesignDeliverable`, before G2. Neither calls a model. R8 throws on any failure — the run then fails at R8 rather than degrading to the static snapshot.

```
… C2 → scope/G1 → B1 → RV → [R3 → R4 → R5]×≤3 → R6 → R7 → buildRedesignDeliverable → R8 (+ correction loop, §8d) → G2
                  │                                                              │
                  └ context/behavior.json                                        └ preview-app/ · preview/verification.json ·
                    (how the ORIGINAL page behaves)                                redesign/PREVIEW.md · finding-accounting.md|json
```

### 8c.1 Generation (`src/preview/extract.ts`, `jsx.ts`, `scaffold.ts`)

Input is the run's own `original.html` (the stamped, standalone, **pre-edit** snapshot written by R7), the in-scope section ids, the final applied R4 edits and the design decisions. The snapshot is loaded into an offline stand-in page (all network aborted), the applied edits are replayed, and for each in-scope section the generator extracts: the DOM tree, **only the CSS rules that match it** (state pseudo-classes and pseudo-elements are normalised for matching; rules keep their `@media`/`@layer` wrappers), the `@font-face`/`@keyframes`/`@property` it uses, and its assets (`data:` URIs become files; remote assets are downloaded once at generation time — the running preview contacts nothing but itself).

Each section is rendered as a React component inside a **Shadow DOM host** (`OriginalSection`), with `html`/`body`/ancestors mirrored as `display: contents` stand-ins so the original selectors keep matching and the DS's own Tailwind cannot collide with the page's CSS. The page's custom properties are renamed into a `--pv-*` namespace (found live: the DS's registered `--tw-gradient-from` turned a dark hero transparent). Region discovery: selected sections = the stamped wrappers whose scope is not `excluded`; Full Page = a walk of the common container, with anonymous gap regions `region-N`; content owned by no region is reported as **orphan content** and blocks completeness.

### 8c.2 Design-system islands

Where the audit's own verified match is a **Button** (`brand`, `secondary`, `ghost`) on an `a`/`button`, or a **SectionHeading** on `h1–h6`, the original element is replaced by the real DS component, slotted into the section's shadow tree, wrapped so it keeps the original's `display`, margins, alignment, growth and (in a flex/grid parent) full width. **`primary` — the black CTA — is never mounted**; such findings are skipped with the reason and need a recorded decision. The DS variant (`cinematic-dark`) is never inferred from a detected surface; only the component's own `background` prop from the audit match is used. If a component fails its measurement it is removed, the original element is kept, and the result is re-verified once — never silently.

### 8c.3 Server (`src/preview/server.ts`)

`npm install` (cached by `package.json` hash) → `npm run build` (tsc + vite) → detached `vite preview` on `preview.basePort + hash(runId) % 400`, recorded in `redesign/server.json`. `pnpm run agent preview <id>` restarts or regenerates; `--stop` stops it.

### 8c.4 Verification before G2 (`src/preview/verify.ts`) — `preview/verification.json`

All measured in the running preview in headless Chromium at 1440 px (and 390 px for overflow). Groups:

| Group | Checks |
|---|---|
| **scope** | rendered sections == the set derived from `fix-plan.json` + `data.json` alone (`expectedScope`, independent of the mapper), same order, none forbidden (unselected, header, footer), no excluded-section heading text, no `header/footer/banner/contentinfo`, no orphan content; plus `scope.matches-run-scope` (derived scope == the scope the pipeline resolved) |
| **content** | per section: all original text (whitespace-insensitive), every link and destination, every image present *and loaded*, heading structure, rendered height within 10 % (15 % hand-authored) |
| **ds-fix** | every Fix finding has an outcome; each finding's audit-expected values are read from the rendered element (`propertyMatchesExpected`; expected values resolved by the browser; islands measured at the component) and R1.4 typeface violations are measured on every text-bearing node. Outcomes: `fixed-verified`, `component-verified`, `preserved-by-decision`, `applied-unverified`, `not-represented`, `unresolved`. No Button `primary` mounted |
| **interaction** | the probes recorded by B1 on the original are re-run on the preview and compared **by kind of reaction, not words**; behaviour that is not reproduced is `unavailable` and listed — it does not fail the run but is shown at G2 |
| **resolved targets** (§8d) | every `resolved-target` of `context/resolved-targets.json` is measured on the rendered element in its own state (default, real hover, keyboard focus); met → `verified-resolved-target` / `verified-original-target`, otherwise `failed` or `unverified`. A finding with an open required target is `partially-verified` at best |
| **fidelity** (§8d) | `fidelity.design-state`: the output compared with the immutable baseline of the original — default/hover/focus styles, composition, alignment, sticky. `fail` on any regression, `not-checked` when nothing could be compared |
| **runtime** | no request leaves the preview, no console/page error, no horizontal overflow at 1440/390, every asset local |

The overall `verdict` is **`pass` | `fail` | `incomplete`** (`src/preview/status.ts`, one rule for every surface). `fail`: any verification check failed or any required item failed (fidelity regression, failed resolved target, changed preserve property). `incomplete`: nothing failed but required evidence is missing — a gate that did not run (`interaction.parity`, `contrast.measured`, `ds-fix.preserved-unchanged`, `custom.*`, any unknown not-checked id), the popup-control probe crashing, a section not locatable on the original, no fidelity comparison, fidelity `requiredUnverified > 0`, an unmeasured resolved target, a preserve decision without positive evidence, or (budget stop) the budget gap. `pass` only when none of that exists. `verification.json` carries `status` = {verdict, failedRequired, unverifiedRequired, gaps (failed first; capped at 12 with `gapsTruncated`), disclosed (capped at 12)}; **disclosed** limitations (fidelity `notRequired` and sampling, `statesNotCaptured`, unreproduced/simulated behaviour, unmeasured contrast runs, the informational `scope.no-orphan-content` / `contrast.inherited`, hand-authored sections' not-probed interactions, "N of M Fix findings not measured fixed") never change the verdict. Individual check, finding and target results are never rewritten. The same verdict and gap summary are read by `verification.json`, `pv-status.json`, the preview bar/notes, PREVIEW.md, the CLI, the G2 reason and the G2 note. Unresolved findings are claims, not required checks; G2's reason line shows the counts. An old `verification.json` without `status` derives it from its checks and fidelity summary (never better than its own verdict; an old pass whose fidelity check was `not-checked` is `incomplete`). Nothing in this group claims a finding fixed that was not measured.

### 8c.5 Behaviour capture (B1, `src/agents/b1-capture-behavior`, `src/preview/behavior.ts`, `probe-lib.ts`)

One fresh, politeness-paced load of the production page in an isolated context; **every non-GET request and analytics call aborted; links and submit controls never clicked; forms never submitted**. For each in-scope section (located by structural path + text start + text length ±10 %): hover effects, click reactions (text/height/expanded/overlay/value), edits to inputs/ranges/selects, scroll-linked changes (fingerprint over scroll positions vs. a time baseline), CSS animations (per-element `getAnimations()`, since `document.getAnimations()` misses shadow trees) and sticky elements. Sampling is bounded (24 items/section, 6 reloads). A B1 failure is recorded in `behavior.json` and interaction parity is then reported **not verified**, never passed.

### 8c.6 Decisions and overrides (the escape hatch)

`<run>/context/design-decisions.json`: `findings: { <findingId>: { resolution, note?, island? } }` (the Design Review Resolver's vocabulary) and `overrides: { <sectionId>: "preview-overrides/<File>.tsx" }`. `preserve-existing` is reported as *preserved by decision*, never as fixed. An override is a hand-authored React section for behaviour the generator cannot derive; it is copied into the app, labelled hand-authored in the verification, and may ship `preview-overrides/checks.mjs` for its own behavioural checks. The generator never writes these files. **Override contract:** the module's default export renders ONE root element carrying `data-pv-section="<sectionId>"`; every Fix finding it covers is marked with `data-finding-ids="<id> <id>"` **on the control the finding is about** (a wrapper is measured as a wrapper); a design-system component that the audit's finding targets is wrapped in an element with `data-pv-island="Button"` / `"SectionHeading"` so it is measured at the component; controls are compared by label, and a control rebuilt with a different structure is reported *not probed* (never passed) and left to `checks.mjs`. Verification of an override compares what a visitor can read (`innerText`, ≥ 90 % similarity — closed menus need not render their hidden option lists), headings and links (≥ 90 %), and height (±15 %).

**Reported gaps.** A finding whose audit target was not met is `unresolved`; it is *explained* (and does not fail the measurement check) only when a recorded decision (`unresolved` / `compose-existing` / `propose-variant` / `reuse-existing` with a note) or the planner's own `unaddressed` reason (a recorded conflict, e.g. the audit's Button `primary` target) covers it. An undecided, unexplained mismatch fails `ds-fix.measured`.

### 8c.7 Known limits (stated, not hidden)

- The page's own JavaScript does not run in the preview. Scroll-linked paths, calculators, accordions whose content is only rendered on click, carousels and similar widgets are **reported as not reproduced** unless an override reproduces them. Generic adapters cover anchors, disclosure toggles (`aria-expanded`/`aria-controls`) and form submission (simulated: a notice, nothing sent).
- Controls inside closed panels (dropdown options, menus) have no element in the captured DOM; their findings are `not-represented` with that reason.
- Only Button and SectionHeading are mounted automatically; inputs and other atoms need a recorded decision or are kept as captured and reported `unresolved` when their measurements do not match.
- Behaviour parity is sampled and read-only (B1). Hover and keyboard-focus STYLES are now compared with the baseline (§8d), including mounted DS components; script-driven states are not.
- Resolved targets are measured at 1440 px; the fidelity comparison covers 1440 px and 390 px (default styles, composition, alignment, sticky); hover/focus are captured at 1440 px only.
- `npm install` needs network access the first time a run's preview is generated.
- A resumed run re-captures the page (R2/C2 run again before the checkpointed nodes are reused). C2 reuses its own earlier picks (`context/c2-picks.json`: tag + classes + text of the chosen element, and "none of these" answers) when exactly one objectively passing candidate still matches, so a resume does not ask the same mapping judgment again; R3/R5 bundles are still re-requested when the re-capture changes their prompt (stamp numbering, screenshots).
- Source mode (§0.4) is unchanged and still blocked.

---

## 8d. Resolver, design & interaction fidelity, and the correction loop `[built]` (v4.4)

Three additions to the §8c pipeline, each a code path the pipeline actually runs (tests in `test/`; nothing here exists only in a skill description):

```
… C2 → scope/G1 → B1 ─┬ production behaviour probe (read-only, as §8c.5)
                      └ design baseline of the ORIGINAL (offline, from original.html; write-once)  → context/design-baseline.json
     → RV → context/resolved-targets.json
     → [R3 → R4 → R5]×≤3          (all three consume the resolved targets)
     → R6 → R7 → R8 ── produce(corrections) → verify(targets · fidelity · §8c checks) → feedback → correct ─┐
                  └──────────────────────────── ≤ budget ──────────────────────────────────────────────────┘
        └ planner-only feedback → R3→R4→R5 (constraints) → R6 → R7 → R8   (same budget, replayable)  → G2
```

### 8d.1 RV — the Resolver (`src/agents/rv-resolve-targets`, `src/resolution/*`)

Hybrid: deterministic classification and rendered evidence, plus a judgment only for the residual design questions. For each selected, in-scope Fix finding (`src/session/in-scope.ts`) it reads the audit's per-property record (`comparison.properties`; older audits fall back to `mismatches`) and decides every non-matching property:

| Audit observation (real shapes in the cndp and dealers-voice audits) | Class → outcome |
|---|---|
| `DIFFERENT` with an expected value | `audit-expected-present` → **resolved target** (provenance: the audit's measurement); refused as `policy-conflict` when it contradicts a persistent rule (e.g. a black CTA fill) |
| `UNRESOLVED`, "no verified DS requirement" | `no-ds-requirement` / `inherited-context` (rendered: equal to the parent) → **preserve** |
| `UNRESOLVED`, "length not comparable without layout context (actual normal/auto, expected X)" | `layout-measurement-required`: a gap is **measured** (used spacing from the children's boxes) and compared with the DS value (resolved or preserved); width/height/other dimensions are preserved — only an audit-measured expectation may change them |
| `UNRESOLVED`, "expected token --x is not defined in the DS" | `variant-or-theme-context`: the token is looked up in the page's variant/theme scope (`src/resolution/ds-evidence.ts`) and compared with the rendered value |
| state / responsive notes, unrecognised notes | `state-context` / `responsive-context` / `capture-capability-gap` → **unresolved**, naming the gap |
| selected `NEEDS_REVIEW` / `UNVERIFIED` finding | a judgment (`claude-session` bundle `RV`), whose every claim is re-verified: tokens must exist in the DS in the surface scope, values are built from tokens, composition properties are refused, an audit-measured expectation is never overridden, a reference must be approved and verified. A rejected claim is recorded as unresolved with the reason |

Real-data check (read-only, `test/integration/audit-examples.test.ts`): of 5 628 / 5 548 property records in the two audits, none falls to `capture-capability-gap`; 2 638 / 2 664 are "no DS requirement" (preserved), 348 / 336 need layout measurement, 2 / 2 name a token missing from the unscoped DS.

**Contract** `context/resolved-targets.json` (zod, `src/resolution/schema.ts`; the audit's `data.json` is never edited): per target the source run and finding, property, part, viewport, theme, state, the audit's own observation (copied), `reason`, `outcome`, `target` (value, comparison, token), `provenance` (audit / ds-token / ds-component / rendered-measurement / approved-project-pattern / proposed-local-variant / recorded-decision / original-baseline, with DS file/scope/registry version or reference source path and hashes), `route`, `acceptance` checks, and **three separate statuses** — design (resolved/preserved/unresolved), implementation (not-started/planned/applied/not-applicable/blocked) and verification (`verified-original-target` / `verified-resolved-target` / `preserved-verified` / `failed` / `unverified` / `not-run`). `rollupFinding` never reports a finding as fixed while a required target is open.

**Consumption.** R3 receives the targets (it no longer pre-filters findings the Resolver can decide), plans only authorized properties, derives an edit for a target the model missed (the value comes from the target), and notes targets with no live-DOM representation. R4 and `redesignPolicyViolation` refuse an edit of a property resolved as preserve/unresolved, and lift the composition-property protection only for an authorized property (`src/redesign-policy.ts`). R5 measures reachable targets on the live page; R8 measures every target in the rendered preview in its own state (`src/preview/targets.ts`). `src/resolution/progress.ts` records planned/applied/blocked as the stages report them.

### 8d.2 Approved reference projects (`src/reference/*`, `references/approved-projects.json`)

An exact-name allowlist (agent-owned, read-only): survey-product-detail-page, case-study-v2, ken-auth-redesign, expert-interview-page, report-store-legacy, competition-benchmarking-v2-react (preferred for subtle borders / light card separation), under `/Users/sachin/Project-aura/project_aura1-main/projects`. A reference is resolved by realpath (a similarly named folder, a symlink elsewhere or an unapproved copy is rejected); `inspectionUrl` is an inspection convenience only. Curated patterns are re-read from source on every verification; a pattern is accepted only when project-approved, source present with its declarations still there, purpose/surface/viewport/element kind fit, and every `var()` exists in the configured DS; it is then recorded as an **approved project pattern** (fully DS-grounded) or a **proposed local variant**, with source path, file hash and project hash. Resolution order: persistent rules and scope → DS component/variant → approved pattern for a real DS gap → local composition from valid DS tokens → specific unresolved. The module hashes project source but never writes to it.

### 8d.3 Design & interaction fidelity (`src/fidelity/*`)

Not a single node: coordinated modules, documented as such. **Capture** (`capture.ts`, `lib.ts`): one in-page measuring library evaluated in both the pre-edit stamped snapshot (baseline; B1 stores it once, hash-bound, from the offline snapshot — no extra production access) and the running preview (design-system island wrappers are transparent, elements are keyed by logical path). Per section, at desktop 1440 and mobile 390: ~55 computed properties of up to `maxElementsPerSection` elements, group composition (columns/rows, visual order and stagger, width ratios), geometric alignment, sticky pin traces over section-relative scroll positions; at desktop: real **hover** (settled for the longest transition) on up to `maxHoverTargets` elements and **keyboard focus-visible** on up to `maxFocusTargets`. Unchanged sections are included in Full Page. A state is recorded only once it has **settled**: running transitions/animations on the target, its subtree and its ancestors (an inherited colour animates with an ancestor's transition) are waited out, then the samples must agree (three irregularly spaced samples while an endless animation runs); an element that never stops changing is listed as not compared. **Compare** (`compare.ts`): tolerance-aware (ΔE ≤ 2, 0.5 px), classifies each difference as *intentional* (an exemption = finding + property + part + state from a resolved target; never a whole component or section), *regression* or *not-checkable*. An authorized default-state change carries into a state only where the original state does not alter that property (so a radius fix keeps the black-default / white-hover card). **Consequences of an authorized change are not defects** (each checked on the measured values of both sides): a descendant that *inherits* an authorized inheritable property (same value as the changed element before and after) changes with it; text-decoration/outline/border colours that equalled `color` follow an authorized `color`; `line-height` follows an authorized `font-size` when its ratio is unchanged; an audit R1.4 typeface violation authorizes `font-family` for its finding (the finding's rule check verifies WHICH typeface). A descendant that sets its own value stays compared. Text alignment `full` (the text spans the container) is never compared with left/center/right — a real `text-align` change is caught by the computed value. Verdict: `fail` on any regression; `not-checked` when nothing was compared; `incomplete` when nothing regressed but a REQUIRED check is unverified (§8d.6); otherwise `pass`. States not captured (active, disabled, script-driven, mobile hover/focus) are listed in every report.

**Why a black/white hover used to break:** style edits are replayed as `!important` rules, which beat the page's `:hover`. The correction is state-guarded emission (`[stamp]:not(:hover):not(:focus-within):not(:active)`, `src/fidelity/guard.ts`).

### 8d.4 The correction loop (`src/fidelity/loop.ts`, `feedback.ts`, `src/preview/correct.ts`)

Feedback is one record per defect — element, state, viewport, expected, observed, responsible party. Routes: **preview generator** (state-guard a replayed edit, drop a design-system component that changes something no target authorizes, drop an edit that cannot be made safe), **planner** (re-plan with the measured constraint), **override** (a hand-authored section: reported, not auto-corrected), **none** (blocked with the concrete reason). The loop re-renders and re-verifies after corrections; the baseline is never an input. Stop reasons: `passed` (nothing correctable remains), `blocked`, `no-progress` (a pass removed nothing that was open), `budget-exhausted` (cycles / verifications / wall-clock), `planner-needed`. **One persisted budget** (`config.fidelity`: `maxCorrectionCycles`, `maxVerifications`, `maxDurationMinutes` of ACTIVE time; §8d.7) covers preview corrections, planner re-plans and re-verifications. The pipeline runs a planner pass (R3→R4→R5 with the constraints, then R6→R7→R8) only while the budget allows and only while each pass removes something that was open; decided passes and corrections persist in `context/correction-state.json`, bound to a basis hash of the edits, targets and baseline — a resumed run with the same basis replays them and keeps the spent budget; any change discards them. `passed` is not "verified": `requiredChecksOpen` (failed checks, fidelity regression or NOT verified, unmeasured/failed targets) is reported separately in `correction-log.json` (`required.satisfied`), in PREVIEW.md and in G2's reason line. G2's fingerprint covers the verification, resolved targets, baseline, fidelity report and correction log (clocks and durations excluded), so changing any of them invalidates an approval while a bare re-run does not.

### 8d.5 Limits (stated, not hidden)

- The loop corrects what the preview generator or planner can change; a regression caused by the page's own scripts, or inside a hand-authored override, is reported blocked.
- The claims are as strong as the measurements: sticky is traced at sampled scroll positions, hover/focus at sampled elements (bounded by config, stated in the report), not every element or every state.
- A target for the `active`/`disabled` states, for a part other than `self`/`label`, or on an element with no live-DOM representation is recorded blocked/unverified and reported — never marked met.
- Verification checks that a judgment's claims are grounded in the DS and the approved references, not that a design is good. G2 stays the user's decision.
- No claim is made about an untested page: the first run on a new page is the test.

### 8d.6 Review-finding fixes (v4.5, 2026-10-10) `[built]`

Five defects found in review of §8d, each closed in code with regression tests that failed before the fix.

**1 · Preview failures reopen findings in R3** (`src/preview/plan.ts`, `src/agents/r3-redesign-plan`, `src/fidelity/feedback.ts`, `src/pipeline.ts`). R3 used to re-plan only findings R5 marked unfixed, so a finding R5 measured fixed on the live page but R8 failed in the rendered preview was filtered out and the cycle was spent on a byte-identical edit set. Now planner-routed feedback (`target-not-met`, `default-regression`, `preserve-broken`) becomes structured items (finding ids, failed target id and part, property, state, viewport, expected, observed); `planIteration` passes them to R3 with `editsInForce`. R3 reopens every named in-scope finding whatever R5 said, shows the failing items next to the finding, and accepts only a style edit of the item's property (or a longhand) in the item's state (a default-regression item only the original value); other edits go to `unaddressed` with the scope reason. Earlier successful edits stay; the corrected edit replaces the failing one for the same finding, state and property (part-aware: a label/descendants correction keeps the element's own edit; a null part is not "the element"). A synthesized edit identical to the one in force is never claimed planned (`blocked`: "the cause is not the plan"). Audit-expected colour targets are derived from the target like any other (a refused colour edit never makes one "planned"); R3 and R4 pass the DS index to the edit guard. Gap scoping (`finalPlannerGaps`) keeps an older planner explanation unless every property it names was corrected, with a literal (non-RegExp) match. rem/em values equal only verbatim (no measured root font size reaches R3). Mobile-viewport and preserve-broken items are reported without a model call. Same shared budget and stops; `correction-state.json` gains index-aligned `plannerFeedbacks` (written before the pass; replay keeps the spent budget; old files parse as `[]`).

**2 · Incomplete checks never pass** (`src/fidelity/coverage.ts`, `compare.ts`, `report.ts`). Every check is verified, failed or unverified; `FidelityReport.coverage` holds per family (section, element, hover, focus-visible, composition, sticky) `required = verified + failed + unverified` plus disclosed `notRequired` gaps and reason codes. Verdicts: `fail` > `not-checked` > `incomplete` > `pass`. Required: every in-scope section×viewport, elements with a finding/interactive/group role, every captured hover/focus state, states that could not be captured on a finding's element, baseline groups, non-inert sticky traces. By design not required but always listed: `:active`, disabled, script-driven, validation, mobile hover/focus, island internals, and plain elements outside the sampling cap. A hand-authored override section is a REQUIRED unverified gap. Real pages must not stay permanently incomplete: sticky traces pad the document so the five positions exist on both sides, hover/focus on the preview mirror the baseline's captured keys, finding elements are sampled first, covered hover targets are re-checked at the viewport centre and pointer-events:none targets are hovered through their descendants, endless animations are frozen for default/hover/focus captures, url() targets are normalised, pseudo-elements sized from their owner/containing block are compared relatively, and consequences of an authorized change (inheritance, currentcolor, line-height ratio) are not defects. `requiredChecksOpen`, PREVIEW.md (coverage table, "Required checks not verified", sampling line), `correction-log.json` (`required.satisfied`) and G2's reason line carry the numbers; the loop never treats unverified coverage as correctable and never prints "every required check holds" unless coverage is complete. Old baselines load and yield honest unverified gaps (recapture = deliberately delete `design-baseline.json`; the stored write-once baseline also fixes the sampling cap).

**3 · Reference colours map to verified DS colours** (`src/resolution/ds-colours.ts`, `src/reference/*`, `src/resolution/resolve.ts`, `rendered.ts`, `src/redesign-policy.ts`). A reference colour is read from its source with alpha/state/theme (following `var()` chains) and mapped in the surface's DS scope in the order: exact DS token (exact beats nearer; tie-break same name → sub-role → semantic/role/primitive tier → canonical file → name) → nearest *suitable* DS token for the role (role pool only; ΔE2000 ≤ 2 on every alpha-composited backdrop; same polarity; strength 0.75–1.5×; a border stays ≥ 1.5 ΔE visible; alpha-for-alpha, an opaque colour takes an alpha token only on a measured solid backdrop within ΔE 1; text keeps its WCAG tier; hover/focus stay distinct from default) → `unmapped` with the closest rejected token and the failed constraint (pattern refused for that colour). Box-shadow maps as whole layers to a `--shadow-*` token; gradients, `color-mix()` and unknown expressions are unsupported (refused). Resolution order is unchanged (DS component → approved reference → local DS-token composition → explicit unresolved). A mapped colour becomes ONE target (value = the DS literal for the surface, token = the DS token) with `colour-visible` / `state-distinct` acceptance checks that R5 and R8 measure in the rendered state; invisible or collapsed colours fail, unmeasurable backdrops are unverified. `validateDecision` refuses a raw colour from any hook; the policy value guard (`colourValueViolation`, `classValueViolation`) binds colour *content*, not property names, so planner, applier and verifier carry only the target's value (details in REDESIGN_RULES.md "Current enforcement boundary"). Resolver determinism: settle before reading, scroll-reveal sweep, endless colour animations are unsettled, unmeasurable backdrops (shadow roots, pseudo/out-of-flow/replaced layers, filters, masks) never read as "measured white". `competition-benchmarking-v2-react` stays the preferred source for subtle borders; its colours go through the same mapping.

**4 · Preservation needs positive evidence** (`src/fidelity/preserve.ts`, `accounting.ts`). `preserved-verified` only when the same element, part, property, state and viewport were compared on both pages and agree; `failed` for a measured unauthorized difference or a confirmed removal (output section located, uncapped, no element with the finding id or identical tag+text); `unverified` (stable reason phrase) for anything not comparable: moved/retagged/text-changed element, capped output (cap-dropped part members are tracked so they are never mistaken for wrappers), inside a component, skipped/unlocated/budget-stopped section, an uncaptured state, a part that cannot be mapped, a property the verifier does not measure, a baseline without the evidence, a change under another target's authorization. Width/height use an evidence-only border box. The same accounting feeds verification.json, resolved-targets.json, the correction summary and G2 (`verifyPreview({preserveResults})`; `ds-fix.preserved-unchanged` check; a failed preserve downgrades fixed/component-verified to partially-verified; an unverified preserve stays in `requiredChecksOpen`).

**5 · Reference components are matched by purpose** (`src/reference/element-kind.ts`, `patterns.ts`, `hooks.ts`, `src/resolution/structure-probe.ts`). Patterns name component categories (card, panel, callout, section, row, strip, accordion, input…); the registry rejects tags/roles/unknown names at load. The Resolver infers each residual finding's category once (rules `element-kind-v2`): each evidence origin (audit type/signals, DS match, native tag/role/attributes, rendered structure, class tokens) contributes its strongest vote, a category is accepted at score ≥ 3; hard vetoes (control/text-level tags, non-container audit type, card-title/accordion-trigger signals, invisible, landmark nav/header/footer) apply to container kinds; a conflict withholds every kind. `hooks.find` (candidate selection) and `verifyPattern` share `patternApplicability`/`kindCompatibility`, so an offered candidate is never refused for kind, surface or viewport reasons; with no category nothing is offered. `elementKinds` in `resolved-targets.json` is optional (old files parse; no schema bump).

**Limits (stated, not hidden):** lengths are not mapped to DS tokens (colours and shadows only); R5/R8 measure the stamped element, so a descendant correction cannot satisfy a non-inherited property measured on the stamp (ends as no-progress, reported at G2); a default-regression is satisfied only by restoring the original value (no retraction path); sticky is traced at 5 positions and non-window scroll containers stay unverified; sibling/non-descendant hover effects are not captured (disclosed); preserve decisions on properties the verifier does not measure (margin, z-index, grid-*) stay unverified so `required.satisfied` can stay false; the policy guard is not a CSS interpreter (page-defined classes, script-set colours and later-consumed custom properties rely on the rendered measurement); structure thresholds are calibrated on three real audits and synthetic pages; timer/script-driven reveals make the Resolver's measurement inherently page-dependent; a baseline captured before pseudo-element box evidence existed (`pseudoRef`) cannot judge a pseudo size change (required `pseudo-size-box-unavailable` gap, verdict `incomplete`) until it is deliberately recaptured; the first run on a new page is the test.

### 8d.7 Status and budget fixes (v4.6, 2026-10-12) `[built]`

**Overall preview status** — see §8c.4 for the rule. A preview whose required fidelity checks are incomplete is `INCOMPLETE`, never `PASS`; `FAIL` beats `INCOMPLETE`, and when both exist both are disclosed. Headlines are identical everywhere: `PASS - every required check is verified`, `INCOMPLETE - N required check(s) not verified`, `FAIL - F required check(s) failed[, U not verified]`. `pv-status.json` carries `verdict, failedRequired, unverifiedRequired, gaps, gapsTruncated, disclosed, disclosedTruncated` (the scaffold writes `verdict: null` = pending); the preview bar shows `Verification: <headline>` (green only for pass) and the notes panel lists gaps and disclosed limitations (`templates/react-preview/src/runtime/status.ts` tolerates old files).

**One correction budget** — `context/correction-state.json` holds ONE budget per run and plan (`fidelity.maxCorrectionCycles=2`, `maxVerifications=3`, `maxDurationMinutes=15` of *active* time). `resume`, judgment-submit continuations, planner re-plans and `preview --regenerate` all restore and persist it through one helper (`openCorrectionBudget` / `CorrectionStore`).
- `BudgetTracker`: `canVerify()` (verifications < max and time left, or a reserved verification), `canCorrect()` (cycles < max AND `canVerify()`: an authorized correction or re-plan always gets its reserved re-verification), `exhausted()` (reason).
- The loop checks the budget BEFORE its first verification: at 3/3, or with the active time spent, it does zero verification work and stops `budget-exhausted` (never `passed`); `final` is the retained previous evidence or null.
- Reserve-before-work: a verification, or a cycle together with the verification that re-checks it, is counted and written atomically (temp file + rename) BEFORE the work starts. Counters are written as max(disk, memory); a crash, a judgment pause or a thrown verification cannot refund them.
- Time is ACTIVE time summed across invocations (`elapsedMs`): it counts verification, correction and fresh planner-pass segments, checkpointed every 30 s while a segment runs and when it closes (a hard kill loses at most 30 s). Waiting between invocations (judgment pause, human gate), R6/R7 and replayed planner passes are not counted. Resume and regenerate never restart it.
- The only ways usage goes down: `resume <id> --reset-budget` and `preview <id> --regenerate --reset-budget` (recorded in `budgetResets[]`, `correction-log.json` `budget.resets` and a log line; the decided corrections are kept), or a materially changed plan/targets/baseline (state discarded with the existing log line). An unreadable or unknown-version state file refuses resume/regenerate with an error naming `--reset-budget` (fail closed); it is never read as "nothing spent".
- Budget exhausted at the start of R8: no extraction, generation, build, server start or measurement. The previous verification/fidelity/correction/generation files are kept as measured only when `preview/evidence-basis.json` (plan basis, scope, engine and preview-source hashes) matches; the result gets the open required item `verification budget exhausted: no new verification was allowed (<reason>)` (family `budget`, never cut by the gap cap) and is `INCOMPLETE` (`FAIL` if the kept evidence has a required failure). With no valid evidence every required check is unverified, `budget.retained=false`, and stale files are renamed `*.superseded.json`. Idempotent.
- Reuse: a plain resume of an UNCHANGED plan (same plan, scope, mapping, behaviour capture, original snapshot, design decisions, corrections, engine/DS source and preview source) reuses the earlier verification as measured at no cost, so an approved G2 survives plain resumes; `preview --regenerate` never reuses. G2's fingerprint treats `verifications`/`budget` as volatile (spending budget alone does not invalidate an approval; a budget stop that adds an open item does).
- Test reliability: vitest `testTimeout` is 60 s (the default 5 s timed out Chromium tests that take 1–2.5 s alone); the earlier single timeout was not reproduced.
Limits: reuse presumes `original.html` and the mapping are byte-stable between invocations (otherwise it falls back to the budget check); any code, DS or settings change invalidates reuse; unfixed Fix findings are disclosed, not required checks; the first real end-to-end run on a new page is still the test.

## 9. Output contracts — both modes

```
projects/<project-slug>/redesigns/<runId>/
  run.json  session-state.json  decisions.json  trace.jsonl
  context/  context.json  mapping.json  conflicts.json  scope.json
            source-mapping.json (Source mode) | content-extraction.json (React Preview mode,
            now a per-section inventory of ALL findings + page-tile mappings, §8a.1/§8b)

  # Source mode:
  worktree/                        ← isolated checkout of the site's own repo, on its own branch
  redesign/
    SOURCE.md                      ← states the exact worktree path + git ref/branch, in plain text
    previews/  validation-results.json  server.json

  # React Preview mode:
  preview-app/                     ← freshly-generated React app — real, editable source,
                                       NOT a checkout of the production repository
  redesign/
    PREVIEW.md                     ← states plainly: this is a recreation, not production source;
                                       the exact preview-app path and git ref/branch
    LIMITATIONS.md                 ← every simulated or unavailable interaction, named explicitly
    previews/  validation-results.json  server.json
```

**Implemented layout (v4.3, the React Preview deliverable):**

```
projects/<project>/redesigns/<sourceRunId>-redesign-<stamp>/
  preview-app/                 ← runnable React source (generated; do not edit by hand — use preview-overrides/)
  preview/verification.json    ← §8c.4 (checks, per-finding outcomes, interactions, unavailable, simulated)
  preview/generation.json      ← sections, islands, island fallbacks, asset stats, orphan content
  preview-overrides/           ← optional, hand-authored (§8c.6)
  context/  scope.json  mapping.json  applied-edits.json  behavior.json  design-decisions.json (optional)
  redesign/ PREVIEW.md  finding-accounting.md|json  server.json
  redesign.html  redesign-content.html  sections/*.html  original.html   ← static export: REFERENCE only
```

Whichever mode ran, `redesign/` is still the only deliverable folder — no `new-component/`, ever, in either mode. `server.json` starts whichever dev server is relevant (the site's, Source mode; the generated app's own, React Preview mode). `validation-results.json` now carries a **per-section completeness verdict** (COMPLETE/PARTIAL/BLOCKED, §8b.2) alongside the existing per-finding PASS/PARTIAL/FAIL entries — a section's completeness verdict is never inferred from its findings' verdicts, since §8b.0's whole point is that those can all be correct while the section itself is incomplete.

---

## 10. What source access changes, honestly

| | Source mode (real code) | React Preview mode (recreation) |
|---|---|---|
| preserved | everything real: components, behavior, props, responsive rules, actual production data flow, except live backend data (mocked) | the DS's real visual patterns and CSS-only interactions (they're the real components); page structure/content as far as audit evidence reaches |
| must be inferred / reconstructed | nothing — it's the real file | full-page content beyond what findings evidenced (§8a.1); any behavior needing a real backend |
| unavailable | live personalization/data (mocked locally) | the same, plus anything requiring the real site's own logic — explicitly listed, never silently faked (§8a.3) |
| is it an edit to production source? | yes, on a branch, gated behind G2, never pushed without further approval | **no, never** — a separate, clearly labelled recreation (§8a.4) |
| status | preferred; blocked on §0.4 | available now; not blocked on §0.4 |

---

## 10a. Comparing the two modes, and the recommended preview stack

| | Source mode | React Preview mode |
|---|---|---|
| Buildable today? | No — blocked on §0.4 | **Yes** — needs nothing beyond what's already local |
| Fidelity | exact, except mocked backend data | recreated: real DS components, reconstructed content/layout |
| Developer handoff | direct — a real branch in their own repo, reviewed as a normal PR | a reference/spec for developers to apply to the real repo — not itself mergeable |
| Interactions | fully real except backend calls (mocked) | CSS-only ones real (real components); client-only ones simulated; backend-dependent ones explicitly listed, never faked |
| Production access | none, ever, once §0.4 resolves | none for editing; at most one explicitly-approved, read-only, per-run content capture (§8a.1), only if Full Page mode needs content beyond finding evidence |

**Recommended preview stack for React Preview mode:** a minimal **Vite + React + TypeScript + Tailwind** app, importing the real `design-system/core-v2` package as a workspace dependency rather than re-implementing any of its components. This is the simplest option that satisfies "use the actual, verified DS components": Vite gives the fastest local dev server for a single reviewable page/section output, and avoids Next.js-specific machinery (routing, the App Router, RSC conventions) this narrow use case doesn't need.

Two open points, stated rather than assumed away:

1. **Component-level compatibility** — the DS components inspected so far (`Button.tsx`, `ui/input.tsx`) are plain client components (`'use client'`, no Next-specific APIs), so they should be consumable from a plain Vite app — but not every component a given page might need has been checked. If one turns out to depend on Next-specific tooling, the fallback is a minimal Next.js app instead, matching the DS's own stated stack (`core-v2` is "Next 15 + RSC compat").
2. **Token/CSS pipeline compatibility** — the DS's tokens live in a large, deliberately unlayered `:root` stylesheet (`base.css`) built by Style Dictionary, plus a generated Tailwind safelist regenerated by the DS's own script from its component directories. A Vite consumer would need to import `base.css` directly and run Tailwind against the DS's own config (or a compatible one) so those classes actually resolve — this is a real integration step, not automatic just because the components are plain React. This document does not yet specify exactly how that wiring works; it is flagged here as a concrete open question for Phase R4 (§14), not asserted as solved.

---

## 11. Approvals

### 11.1 Gates

| Gate | When | Asked | Outcomes |
|---|---|---|---|
| G0 | after S0 | only on ambiguous resolution or stale sources | proceed / stop |
| G1 | after Element Mapper (+ Source Mapper, Source mode) | scope half: **never**, for the reason "no section field" (§5); acknowledgement half: only for a `probable`/`ambiguous` element or source mapping, a DS-match verification failure (§8.8), or an expectation-changed conflict | resolve + acknowledge |
| G2 | after Package | **always** | approve / request changes (≤ `maxReviewRounds`) |

No G3/G4/G5 exist in this graph, in either mode.

### 11.2 Checkpoints and resume

Every gate decision is recorded in `decisions.json` (append-only, fingerprinted — `src/session/decisions.ts`, `gate-fingerprints.ts`). Two properties do the actual work of "resume without repeating approved work":

1. **Fingerprint reuse.** A gate's fingerprint is recomputed from the real, on-disk artifacts it covers (not in-memory state), so a fresh process invocation reaches the identical fingerprint if nothing relevant changed, and auto-passes that gate silently.
2. **Per-unit fingerprints inside the loop.** Each **section's** build (Page Builder or Page Composer) + Visual Verifier result is fingerprinted (its plan + its written output + its verdict). On resume, a section whose fingerprint still matches is **not** rebuilt or re-verified — only sections that changed, failed, or are new run again. This applies identically in both modes.

**React Preview mode's one addendum:** its optional full-page content capture (§8a.1, option 2) requires the same fresh, explicit, per-run production-access confirmation this system has required for every other production touch all session — it is never bundled into a general "proceed" answer from an earlier point in the conversation, and it never happens for Selected Sections mode, where finding-level evidence is normally sufficient.

### 11.3 Fingerprint bases

| Fingerprint | Covers |
|---|---|
| G2 (page approval), Source mode | the worktree's git diff + `validation-results.json` |
| G2 (page approval), React Preview mode | the generated app's own files + `validation-results.json` |
| **G2 as implemented (v4.3)** | the static export's validation JSON **+ `preview/verification.json` + a hash of `preview-app/`'s source** — any change to the preview or its verification invalidates a prior approval; `decide G2 approve` is refused while verification has failed checks unless `--accept-preview-failures` (recorded in the note) |
| per-section (inside the loop) | that section's semantic plan + its actual written output (diff or generated files) + its Visual Verifier verdict |
| G1 acknowledgement half | the specific `probable`/`ambiguous` mappings, DS-verification failures, and `expectation-changed` conflicts acknowledged |

---

## 12. Migration from the current HTML-snapshot pipeline

| Stays exactly as-is | Changes shape, same module | Retired from this graph (kept for the future Component Agent) | New |
|---|---|---|---|
| config, tracing, audit-link, R1, decisions/gate-fingerprints store, `resolveScope`, retry, judgment provider, t-layer primitives, imaging, mapping objective-checks | R2 (target: local dev server or evidence, not production), Element Mapper, R7/`buildRedesignDeliverable` (assemble+preview per mode), gate-fingerprints' G2 basis, `serve` (dev-server manager) | `html/serialize.ts`'s CSS-isolation export rules, all of Workflow B (L1–L5, manifest, library, components-index), `new-component/` deliverable | worktree/repo manager, dev-server lifecycle manager, mock-data strategy, Source Mapper, style-authoring classifier, Page Builder, **Page Composer**, Page Integrate, content/asset extraction, new deliverable packager |

The paused Deals & IPO run (built entirely under the pre-v4.0 live-DOM-capture model) is not migrated automatically. Once §0.4 is resolved, the same source audit run can be re-run fresh under Source mode; meanwhile, `deals-and-ipo-consulting-test-button-rematch` can be run under React Preview mode today. Old run artifacts stay untouched as a historical record either way.

---

## 13. Risks

1. **Blocking Source mode only: the site repository is unavailable (§0.4).** Nothing past R2 in Source mode can be proven against reality until this is resolved. React Preview mode is unaffected.
2. **`_debugSource` depends on a true dev build** (Source mode) — if the site's dev command doesn't map cleanly to a standard `next dev`, Source Mapper's primary mechanism may need adjustment once the real repo is inspected.
3. **Live-backend dependencies at dev-server boot** (Source mode) — the actual mocking surface is unknown until the real repo is inspected.
4. **Section-to-file granularity is unverified** (Source mode) — a monolithic single-file page component would make Page Builder's write-set discipline coarser.
5. **These specific 23/26 findings still have no measured basis for most of them** (§8.8) — real source or DS access does not, by itself, manufacture a target value the audit never measured. Expect a meaningful share to still land in `unaddressed`/`new-component-candidate` unless the reviewer adds guidance.
6. **Local-build drift** (Source mode, §6.5) is a new, expected source of lower-confidence mappings relative to comparing production against itself.
7. **Style-authoring diversity** (Source mode) — an unfamiliar real codebase may mix several styling approaches inconsistently; Page Builder must handle each per-file, willing to say `unaddressed` rather than force a mismatched fix.
8. **React Preview mode's content fidelity is bounded by what the audit evidenced.** Full Page mode will have visible gaps unless a full-page capture is separately approved (§8a.1) — a real, stated tradeoff, not a defect to silently paper over.
9. **The Vite+DS compatibility assumption (§10a) is unverified beyond the two components actually inspected this session** — both the component-level assumption and, separately, the token/CSS pipeline wiring (§10a's second open point). A component or a token dependency requiring Next-specific tooling would force the Next.js fallback for that page. (Update: also confirmed live that DS component source physically living inside `core-v2`'s own `node_modules` causes duplicate-React "Invalid hook call" errors in a standalone Vite consumer — fixed via `resolve.dedupe`, but this is now a known, real integration cost, not a hypothetical one.)
10. **The DS-verification "≥2 independent properties" threshold (§8.8) is illustrated by one worked example, not yet a fully general algorithm** — how "governed property" is enumerated per component type, and how independence is judged in the general case, needs further specification before implementation, not just before this document is finished.
11. **(New, v4.2) The section→page-tile y-range mapping (§8a.1, §8b) does not exist yet.** Without it, Page Composer has no source for a section's non-finding visual content at all — this is the direct, confirmed cause of §8b.0's failure example, and is required work, not an edge case.
12. **(New, v4.2) A found-live web-font gap**: this app's minimal CSS setup loaded the DS's token/spacing layer (`base.css`) but never the actual Noto Serif/DM Sans web fonts the DS's typography depends on — headings measured the correct size/weight but the wrong font-family. A real, disclosed gap from the first build, not yet fixed.
13. **(New, v4.2) A recurring, unresolved `display: flex` vs `inline-flex` computed-style anomaly**, found on both `Button` and `CTALink` in the first build — the class list and CSSOM both say `inline-flex`, the browser computes `flex`. Root cause not found; flagged as a standalone-Vite-integration quirk, not a DS defect, but still open.

---

## 14. Implementation sequence

| Phase | Scope | Blocked on §0.4? |
|---|---|---|
| 0 | Resolve the site repository question with the user/tech team | — |
| **R1** | DS-verification step in Redesign Planner (§8.8), including a fully general "governed property"/independence rule (§13 risk 10) — shared by both modes | **No** — pure logic + a read-only DS-source dependency, testable today |
| **R2** | `new-component-candidate` record (§8.8) | **No** |
| **R3** | React Preview mode: content/asset extraction (§8a.1) against the real button-rematch run's `data.json`/evidence | **No** — a per-finding version of this was built and run live; **needs rework** to the per-section, all-findings inventory §8a.1 now specifies |
| **R4** | Page Composer (§8a.2) + the Vite+DS scaffold, resolving §10a's token/CSS pipeline open question | **No** — the scaffold (Vite+DS aliasing, `resolve.dedupe`) was built and works live; Page Composer itself was only ever fed Fix findings, **needs rework** to build complete sections (§8b) |
| **R5** | Visual Verifier's simulated-interaction/limitations output (§8a.3) | **No** — built and run live; **additionally needs** the section-completeness gate (§8b.2), which did not exist when it ran |
| **R5a** *(new)* | The section→page-tile y-range mapping (§8a.1, §13 risk 11) — a genuine prerequisite for §8b.2's content inventory to be checkable at all for non-finding content | **No** |
| **R6** | React Preview mode end-to-end against the real button-rematch run, localhost preview | **No** — ran live for 2, then all 26 Selected Sections findings; **the resulting sections do not meet §8b's contract** (§8b.0) and need to be rebuilt against it, not merely re-verified |
| 1 | Config additions (`siteRepo.*`, `operatingMode`), worktree manager, dev-server lifecycle manager, generalized `serve` | can scaffold against a synthetic fixture repo |
| 2 | R2 retargeted to local dev server; mock-data strategy negotiated once the real repo's fetches are visible | **Yes**, for real validation |
| 3 | Source Mapper: `_debugSource` extraction + style-authoring classifier | **Yes** |
| 4 | Page Builder (fan-out) + Page Integrate (fan-in), per-section fingerprinting | **Yes**, for real codegen quality |
| 5 | Visual Verifier retargeted to local render; new package/deliverable (worktree path, previews, dev-server link) | **Yes** |
| 6 | New G2 fingerprint basis (git diff + validation) | No |
| 7 | End-to-end against the real Deals & IPO source, once available | **Yes** |

React Preview mode's phases (R1–R6) can proceed in full regardless of §0.4 — the concrete, practical reason to build it now rather than waiting.

---

## 15. Remaining user decisions

1. **The site repository's location and access** (§0.4) — the single decision blocking Source mode; nothing about React Preview mode depends on it.
2. **Mock-data strategy** (Source mode) — once the repo is inspected, whether local mocking is trivial or substantial shapes Phase 2's actual size.
3. **Whether to approve a one-time full-page content capture** (React Preview mode, §8a.1) if and when Full Page mode's content gaps turn out to matter, and the page-tile mapping still isn't enough.
4. **(New, v4.2) None required to start §8b's own work** — the page-tile mapping (§13 risk 11) and the rebuild of the existing 3 sections against the complete-section contract are both buildable now, from data already on disk.

---

## Decision log

Entries 1–52 (foundational decisions through the judgment-provider work) and 53–62 (the v4.0 pivot to source-level editing, redesign-only scope, Source Mapper, Page Builder, the fan-out/fan-in reuse, per-section fingerprinting) are unchanged and carried forward in full; see `docs/ARCHITECTURE-v3.2-archive.md` for 1–52's original context and this document's own history (§0.1) for why 53–62 are not re-typeset here verbatim a second time — they are unchanged, not summarized-away, and remain the record of v4.0's own reasoning.

**New this version:**

| # | Question | Decision | Why |
|---|---|---|---|
| 63 | **Narrowing Decision #60** | "Never import a foreign component's code into the site's repo" stays. "Never use the DS as the values/pattern reference" is reversed — Redesign Planner may name a verified DS variant as the target and hand its complete governed property set downstream (§8.8) | v4.0 conflated two different risks under one decision; only the first is real, and the second one being removed was actively producing wrong results (the button-rematch run's Let's Connect inputs) |
| 64 | DS-match verification, not blind trust | Redesign Planner re-derives `dsComponent`/`dsVariant` against the DS's current source, requiring ≥2 independent property agreements, before treating a match as `confirmed` (§8.8) — mirroring Element Mapper's own confirmed-tier rule | `data.json`'s recorded match is an audit-time artifact, computed once by a matcher later found to have a real bug (a hardcoded rule table with no alternative ever offered for plain inputs); executing against it without question propagates that bug silently |
| 65 | `new-component-candidate` record | a small, additive file Redesign Planner can emit when nothing fits, separate from and much lighter than `new-component-plan.json` (§8.8) | the only prior "no match" mechanism (audit-agent's B6/S9) never fires for a wrong-but-present match, and this repo had no equivalent at all before now |
| 66 | React Preview mode introduced | a second operating mode, clearly labelled as a non-production recreation, buildable without the site repo (§0.5, §8a) | §0.4 has no resolution date; visual review of the redesign shouldn't have to wait indefinitely for it |
| 67 | Page Builder/Page Composer stay one role | generating fresh React and diffing existing React are the same underlying judgment, differing only in where the write lands (§3.2) | same reasoning v4.0 used for Component Builder's fan-out being "one role running many times" — a new *output shape* is not a new *judgment* |
| 68 | D1–D6/`ds-reference.ts` reinstated as a read-only dependency | needed by Redesign Planner (verification, both modes) and Page Composer (rendering real components, React Preview mode) (§0.2) | v4.0's blanket retirement of the DS catalog conflated "don't import DS code into the site" with "don't read the DS at all," and the latter is exactly what caused the bug this version fixes |
| 69 | React Preview mode's optional full-page capture stays gated | one explicit, per-run, read-only production approval — same standing rule as every other production touch this session, never bundled into an earlier "proceed" (§11.2) | Full Page mode's content gap is real; filling it with an unapproved live hit would violate the one rule that's never been relaxed all session |

**New this version (v4.2):**

| # | Question | Decision | Why |
|---|---|---|---|
| 70 | Complete Section Reconstruction is a contract, not a suggestion (§8b) | Page Composer must build every in-scope section's full real structure — all content, not just Fix elements — with the verified DS change applied only to the Fix-marked element(s) | found live: a build that only rendered Fix elements passed every per-property check while being obviously incomplete as a section; per-property correctness was never sufficient on its own |
| 71 | Section-completeness gate runs inside Visual Verifier, before §8.8's checks, not as a new role (§3.2, §8b.2) | content/layout inventory presence is checked first; DS-property verification only runs against a section that already passed or has disclosed gaps | same judgment Visual Verifier already owns (compare a render to evidence) at a different granularity — a new check, not a new kind of judgment, matching this document's own "seventh role" test |
| 72 | Non-finding section content is sourced from the run's own full-viewport page tiles, not a fresh capture (§8a.1) | the button-rematch run's 12 `page-tile-*.png` files (real, already-captured, full page height) are the source for background/imagery a section has but no individual finding evidences; the tile→section mapping is real, required work, not yet built | this data already exists locally; building the missing mapping is strictly less work and less risk than approving a fresh production capture for content that's already on disk |

**New this version (v4.3 — React Preview as the default deliverable, 2026-10-06):**

| # | Question | Decision | Why |
|---|---|---|---|
| 73 | Is the React Preview a per-run, session-authored artifact or a pipeline stage? | A pipeline stage: nodes **B1** (behaviour capture, before the first edit) and **R8** (generate · build · serve · verify, before G2) — deterministic, no model call (§8c) | the hand-built preview was the only thing that satisfied the agreed workflow, so every run depended on someone remembering to build one; and a hand-built preview cannot be checked against the rules the pipeline checks |
| 74 | May a run silently fall back to the static HTML export when the preview cannot be produced? | **No.** R8 throws; the run fails at R8 with the reason. The static export stays as a reference snapshot, labelled so | a static page cannot demonstrate interactions, and presenting it as the preview is exactly how the agreed workflow was dropped before |
| 75 | How is the preview produced — AI-authored from audit evidence (v4.2's Page Composer) or generated from the run's captured DOM+CSS? | Generated from the captured, pre-edit snapshot plus the applied edits (§8c.1) | completeness (§8b) becomes deterministic instead of a model's best effort, and the original's content/composition is preserved by construction; v4.2's Page Composer design stays on record for a future evidence-only mode |
| 76 | What counts as proof that a DS fix landed? | Only the audit's expected values (and, for rule findings, the rule's own measurable criterion — R1.4 typeface) **measured on the rendered preview**; existence of an element or a mounted component is not proof (§8c.4) | element presence passed every earlier check while the fix was absent |
| 77 | Selected Sections and unselected sections | Unselected sections and the global header/footer are **absent**, in the preview and in the static content export; a finding in an unselected section is never edited (§8.1) | corrects v4.2's "kept and marked", which R7's tests had also encoded |
| 78 | May the generator choose a DS variant (e.g. `cinematic-dark`) or a `primary` Button on its own? | No. Only the audit's verified Button `brand`/`secondary`/`ghost` and SectionHeading are mounted; `primary` is skipped with a reason; DS variants are never inferred from a detected surface | the DS's own rule ("NEVER auto-pick cinematic-dark") and the project rule against the black CTA |
| 79 | Where do behaviours the generator cannot derive go? | A hand-authored override registered in `context/design-decisions.json`, labelled hand-authored in the verification, plus optional `checks.mjs`; otherwise they are reported **not reproduced** at G2 (§8c.6) | no silent pass for interactions, and no hidden per-run work outside the pipeline's records |
| 80 | Multi-iteration runs | R5 credits edits applied in earlier iterations (found live on the second-run verification: iteration 2 planned nothing new and all 24 findings read 0/24 fixed) | the live page keeps earlier edits; only the verdict was forgetting them |
| 81 | `captureElement` on a hidden/zero-size element | Fails immediately instead of waiting out Playwright's 30 s actionability timeout | found live: R7 spent minutes on closed-panel elements |
| 82 | **Resolver, fidelity verification and the correction loop (v4.4)** | RV derives validated targets (`context/resolved-targets.json`) before any edit; R3/R4/R5/R8 consume the same targets; a design baseline of the original is captured once and compared under equivalent conditions; one bounded budget covers preview corrections and planner re-plans; approvals are bound to targets, baseline, fidelity and correction outcome | A missing expected value was either silently dropped or acted on by guesswork, and a default-state fix could erase a hover design without any check noticing. Verification that only reports is not a loop; a loop without a stop reason or budget is a hazard; "nothing left to correct" is not "verified" |
| 83 | **Review-finding fixes (v4.5)** (§8d.6) | Preview failures reopen findings in R3 through structured, part-aware feedback within the same budget; checks are verified/failed/unverified and an unverified required check can never be `pass`; preservation is claimed only on positive comparison evidence; reference colours are mapped to exact-or-nearest-suitable DS tokens with auditable provenance and one shared derived target (never a raw colour, never a raw-colour "proposed variant"); reference components are matched by inferred purpose, with selection and verification sharing one classification | R3 filtered out findings only the preview could see fail; partial hover/sticky coverage was reported as pass; "nothing changed" was inferred from absence of a difference; a reference colour could reach the page raw or be matched by a tag; each is a way a green report could hide a defect. Rejected: lowering a criterion so real pages pass (instead the capture was made to reach the evidence), and any "verified" claim from a guard that is not a CSS interpreter (rendered measurement remains the proof) |
| 84 | **Preview status and one persisted budget (v4.6)** (§8d.7, §8c.4) | The overall preview verdict is pass/fail/incomplete from one rule (required vs disclosed) shared by every surface; the correction budget is one persisted, reserve-before-work allowance restored by resume and regenerate, with active-time accounting, an explicit `--reset-budget`, and an honest `INCOMPLETE` budget stop that retains valid evidence | Required fidelity checks could be incomplete while the headline said PASS; a tracker at its limit still ran another verification and `--regenerate` reset the counters, so the bound on retries was nominal. Rejected: counting wall-clock including pauses (penalises waiting for a human), refunding a reservation on failure, and treating a damaged state file as an empty budget |
