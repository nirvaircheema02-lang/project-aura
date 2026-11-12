---
name: fix-plan-review
description: Import a reviewer's Fix/Skip/Keep-for-Review decisions (an exported fix-plan.json) into an existing audit run, validate them against that run's data.json, and stop. Use whenever someone says they have reviewed an audit's findings and wants their decisions imported or validated — e.g. "I've reviewed the findings, import my decisions", "Fix Plan is ready, use run Deals and IPO Consulting Test", "validate my fix-plan.json". Never re-audits, never modifies data.json, and never starts a redesign.
---

# fix-plan-review — import and validate one run's fix plan

**Read this whole file before doing anything.** This skill is triggered by a *later, separate*
request than an audit — never as a sub-step of a running audit. `audit-run` is untouched by it.

Its entire job: turn a reviewer's exported decisions into a **validated `fix-plan.json`** sitting
next to that run's `data.json`, then stop and report. Everything after that belongs to a
different system.

## What you take from the reviewer

**One identifier — Run ID or Run Name, never both required.** Never ask for `report.html`,
`data.json` or `fix-plan.json` paths individually; every one of them is just a file inside the
run's own folder once the run is resolved.

## Step 0 — Resolve the run

```bash
pnpm run agent find-run --run-name "<the name they gave>"
# or
pnpm run agent find-run --run-id <the id they gave>
```

- **Exit 0, one JSON line** → resolved. Use `runId` and `runDir` from it for everything below.
- **Exit 2 (ambiguous)** → show the candidate list the command printed and ask which Run ID they
  mean. Never pick one yourself: two runs sharing a name are two different audits, and guessing
  imports decisions into the wrong one.
- **Exit 1 (not found)** → say so and ask for the exact Run ID. Do not search harder, and do not
  offer to re-audit — this skill never audits.

## Step 1 — Look in the run's own folder first

The reviewer is expected to save or move their browser export straight into the run folder, so
that is the preferred path. Check for `fix-plan.json` in `runDir` — **one `existsSync`-style
check, once, now.** Never watch the folder, never poll, never leave anything running.

- **Present** → use it. That is the common case, and `fix-plan-import` defaults to it with no
  file argument.
- **Absent** → only then ask the reviewer for the file's path, as a fallback rather than the
  default expectation.

Being at the canonical path is never itself sufficient to be trusted: a file already sitting in
the right folder still goes through the full schema and findingId validation below.

## Step 2 — Dry run first, always

```bash
pnpm run agent fix-plan-import <runId> --dry-run          # folder default
pnpm run agent fix-plan-import <runId> <file> --dry-run   # explicit path
```

Surface whatever it reports — a runId mismatch, dropped unknown findingIds, a schema error — to
the reviewer **before** importing for real. Never pass `--ignore-run-id-mismatch` on your own
initiative; that flag exists for a reviewer who has looked at the mismatch and decided anyway.

## Step 3 — Import

```bash
pnpm run agent fix-plan-import <runId> [file]
```

**Merge is the default and the right choice** — entries already on disk that this file does not
mention are preserved, which is what makes multiple reviewers and multiple partial exports safe.

`--replace` only on explicit request. Say plainly what it costs: merge semantics cannot represent
retraction, so `--replace` is the only way to drop a previously-imported decision — and it drops
every entry not in the file being imported.

## Step 4 — Report, and stop

Report the CLI's own summary verbatim, including the line stating `data.json` was untouched.

**This skill's responsibility ends here.** Do not ask whether to apply the fixes, update the page,
regenerate anything, or start a redesign. A validated `fix-plan.json` plus the untouched
`data.json` is the complete, final deliverable. Anything past it belongs to the separate Fix &
Redesign Agent, which is not designed, referenced, or triggered here.

## Hard rules

- **Never re-run the audit.** This skill only resolves and reads an existing run, exactly as
  `figma-plan` and `fix-plan-import` already do.
- **Never modify `data.json`.** Decisions live entirely in the sidecar; there is no code path here
  that opens `data.json` for writing, and the CLI prints its untouched path as proof.
- **Never guess between two candidate runs.** Ambiguity goes back to the reviewer.
- **Never watch or poll** for the export to appear — one check, at invocation, then ask.
- **Never continue past the validation summary**, however natural the next step seems.

## Where the reviewer's decisions come from

The run's `report.html` (`html-report-v19` — the stamp moves whenever a locked template changes; the review layer below is unchanged by it) and the live Dashboard render from the same template
and both carry the review layer: per-finding checkboxes, multi-select, **Mark as Fix** / **Mark as
Skip** / **Mark as Keep for Review**, **Clear Decision**, and **Export Fix Plan (N)**, which
downloads `fix-plan.json` client-side with no server involved. Every bulk action clears the
checkbox selection immediately afterward — a still-checked row from one action is never silently
re-decided by the next one — and the bar shows live counts (`Fix X · Skip Y · Review Z ·
Undecided N`) alongside it. In-progress decisions are kept in a per-run `localStorage` draft,
which is explicitly **not** canonical — the exported and imported file is.

**The Findings view is compact, not a wide table.** Its filters are exactly Status, Severity,
Section, and Search (Confidence and Review-State filters were deliberately removed, and a Decision
filter was deliberately never added — the filter row stays intentionally short). Section is built
from the section names actually present in this run; findings render grouped under one header per
section (`Header · 10 findings · 7 Incorrect · 3 Review · Fix 4`) rather than one long flat list —
selecting a section shows only its group, "View All" (the filter's default) shows every group.
Each finding is a compact card by default (checkbox, decision, severity, status, component name,
DS component, a 1-2 line summary, an evidence thumbnail, and a **Details** toggle) — nothing is
removed, the full property/actual/expected, confidence, review state, re-audit state, full
recommendation, and full-size evidence are all still there, just collapsed until a reviewer
expands that one card. A small **Sort** control (Severity / Status / Confidence, plus an
Asc/Desc toggle) re-sorts each section's own rows independently — never a global flatten that
would scramble rows out of their sections.

A finding that also appears as a "Needs review" card carries a small note pointing there
(`· also in Needs review below`) rather than repeating that card's full content a second time —
the duplication itself is intentional (both views serve a different purpose) and is not removed.

## The separate New Component Plan (never part of the Fix Plan above)

The "New components & DS candidates" section has its **own**, independent selection area — its
own checkboxes, its own **Select all visible** / **Add New Component** / **Export New Component
Plan (N)** actions, its own `new-component-plan.json` export. It is never driven by the Fix Plan's
bulk bar and never shows Mark as Fix/Skip/Keep-for-Review — selecting a candidate here is not a
Fix Plan decision. **B6 (`src/agents/b6-new-component-evaluator`) remains the sole classifier of
NEW_COMPONENT/DS_CANDIDATE** — this UI only records which already-classified candidates a
reviewer chose to hand off (findingId + classification only, same discipline as the Fix Plan),
never re-classifies anything itself. A reviewer can select 2 of 5 suggested candidates and export
only those 2 — nothing is auto-included. **This skill does not import or validate
`new-component-plan.json`** — only `fix-plan.json` is in scope for `find-run`/`fix-plan-import`
today; treat an exported `new-component-plan.json` as something to leave alone, not something to
process here.

Each candidate is a compact, expandable card (same shape as a Findings row) carrying a thumbnail —
the same evidence screenshot already captured during the original audit, never a new capture;
clicking it opens the full-size image in a new tab. **Add New Component** clears the temporary
checkbox selection as before, but a staged candidate now stays visibly marked on its own row (a
persistent `✓ Added` badge and a left-border highlight) so a reviewer can always tell what is
already in the plan — re-adding an already-staged candidate never inflates the staged count. A
small `×` inside that badge unstages it again (the staged count drops, the badge/highlight clear,
and the candidate is free to be selected and added again) — this only ever touches the staged map,
never the Fix Plan.
`.ncp-bar` (this section's own toolbar) becomes the sticky one once a reviewer scrolls into this
section; the Fix Plan's own bar is sticky everywhere above it and never both at once.

Some cards in that same list are marked **"Potential — after fixes"** (a dashed pill, visually
distinct from a real candidate's solid pill) — a **Post-Fix Component Opportunity**
(`src/agents/b6-new-component-evaluator/post-fix-opportunity.ts`): a repeated, currently-unmatched
pattern whose only known blocker is a measured foundation-rule violation on B6's own `INCORRECT`
findings, with no existing DS component close enough to call it a match. This is a separate,
render-time hypothesis layered on top of B6's output — **never a B6 reclassification, never a
`data.json` field** — computed fresh from already-persisted findings every time the report is
rendered. It uses the exact same checkbox/Add/Export flow as a real candidate, never the Fix Plan's.
The only schema difference in the exported file is additive: `candidateSource: "current_state" |
"post_fix"` (defaults to `current_state`, so a plan exported before this field existed still
parses) and, for a `post_fix` entry, an optional `relatedFindingIds` naming the pattern's other
repeated instances — never duplicated finding content, same discipline as `findingId` itself.
