# Audit Agent — Visual Walkthrough

Open **[dist/index.html](dist/index.html)** in a browser. This is the complete deliverable: one self-contained HTML file with embedded screenshots, saved findings, source excerpts, styles and scripts. It works offline and requires no server, install or API key. Share the HTML file itself.

Nine chapters explain purpose, starting a new session, the page/site pipelines, real findings, approved reference fallback, workflow skills and runtime rules, graph engineering and loops, output statuses, and limitations. All guide copy, interactive explanations and generated session messages are in English. The product name is Audit Agent; Project-aura is the workspace folder and Aura projects supply reference evidence.

The new-session message builder takes mode, URL and run name, using the configured Audit Agent path. It produces a copyable session message and safely quoted CLI command; it never executes an audit. Interactive recovery examples explain missing elements, missing properties and unresolved items, alongside bounded retries and re-audits. User-facing outputs are standalone HTML and verified Figma boards; JSON remains supporting data. Excel is not presented as a current output.

“How agents connect” has three tabs: **System overview**, **Single page**, and **Full site**. The overview preserves the shared system connections. Single page shows setup, capture, every B1–B7 agent, recovery and reporting. Full site shows A1–A4, both review gates, every named B1–B7 agent in each of three illustrative workers, recovery, consolidation and reporting. Shared D1–D6 responsibilities and runtime rules are identified in both detailed views. The performance explanation covers bounded page workers, a shared DS snapshot, page-level resume, eligible cross-run reuse and targeted recovery. An interactive six-page queue illustrates capacity without claiming measured timings or a speed multiplier. On small screens, diagrams scroll inside their own labelled region.

The build embeds the configured Design System's `tokens/build/tokens.css`. UI typography uses DM Sans, with smaller DS heading sizes, semantic text and border colors, neutral graph surfaces and brand-red primary actions. The Latin variable font is bundled locally and embedded in the standalone HTML, so the preview still works offline. Its source is the existing `competition-benchmarking-v3` build's DM Sans font asset (`5c285b27cdda1fe8-s.p.0yo6-5yoeeudq.woff2`); no external font request is made.

## Source snapshot

- Implementation inspected: 31 October 2026; audit engine revision 12; report template `html-report-v19`. The date, revision and template version are read from the code at build time, not typed in.
- Saved run: `dealers-voice-survey-page-audit-v3` (engine revision 10, 12 October 2026). The first version of this guide used `…-v2` (engine revision 9); that run was removed from the repository, so the same three teaching examples were re-selected from v3 (the heading finding keeps its finding id).
- Approved reference catalog measured: 7 October 2026 (unchanged in the repository since).
- Three saved findings, their screenshots, coverage counts and 27 source excerpts are embedded. Five of the embedded files had changed since the 8 October snapshot; two needed new line ranges in the 31 October update (`evaluate.ts`, `s0-result-contract.ts`) and the other three (the engine log, the audit-run skill and the fix-plan-review skill) kept theirs.
- The 31 October update added a “What changed” panel (first page) and an “Agents at a glance” panel (How agents connect), refreshed the B2, B4 and B7 stage descriptions for engine revisions 10–12, described the MATCH basis and the current HTML report, made the coverage numbers data-driven, and fixed the dark first-page box whose heading was dark ink on a dark fill. The page and site graphs themselves are unchanged (A1–A4, B1–B7). The previous version is kept in `audit-agent-backups/2026-10-31-audit-agent-walkthrough-before-update/`.
- Source paths are displayed relative to the workspace for portability; full file SHA-256 values identify the source snapshot.
- A separate evidence caveat documents a saved screenshot/heading-label mismatch discovered while building the guide. The guide does not fix or re-verify the source audit.
- This is a learning guide, not a live audit interface. Mode/scenario controls change explanations only.
- Printing includes all chapters with the currently selected interactive stage/example/scenario.

## Files

- `guide.template.html`: copy, styles and interactive behaviour.
- `build.mjs`: reads the local audit snapshot and embeds data/assets into `dist/index.html`.
- `graphs.mjs`: generates the complete Single page and Full site SVG diagrams.
- `assets/dm-sans-latin.woff2`: bundled Design System UI font.
- `verify.cjs`: offline browser interaction/responsive verification using the existing audit repo's Playwright dependency.
- `verification.json`: result of the latest successful local browser verification.

Rebuild from the workspace root:

```sh
node audit-agent-walkthrough/build.mjs
node audit-agent-walkthrough/verify.cjs
```

Rebuilding refreshes embedded source/data, the engine revision, the report template version and the date — not explanatory prose. Review narrative and hard-coded example descriptions when changing the selected run or pipeline. Source excerpts are fixed line ranges in `build.mjs`: after the audit code changes, check that each range still starts and ends at the intended code (the embedded SHA-256 of each file shows which files changed). A missing expected finding/source/screenshot fails the build instead of substituting fabricated evidence. `SHOT_DIR=<folder> node audit-agent-walkthrough/verify.cjs` keeps the verification screenshots out of `/private/tmp`.

Used the Sites building skill for narrative presentation, responsive behaviour, accessibility and static delivery. No hosting or external publishing was required for the requested standalone artifact. The audit and redesign repositories were not modified.
