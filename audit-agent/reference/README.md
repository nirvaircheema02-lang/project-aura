# Approved Project Aura reference evidence

`approved-reference-patterns.json` records how the **same semantic role** (an eyebrow on a light surface, the description under a heading, …) is actually styled on the approved Project Aura pages — Report Store, Case Study, Competition Benchmarking. It is **supporting evidence only**: it never replaces the Design System and never decides a finding.

**When the audit reads it.** Matching order (Decision Log #46): exact DS component/pattern → closest valid DS family/variant → **this evidence** → `NEEDS_REVIEW` → B6 only for a genuine no-family/no-pattern. B3 consults the file **only when its Design System search was undecided for the element's role**; a role the DS defines (an eyebrow → OverheadText / SectionLabel, a heading → SectionHeading, body text → the foundation rules) never reads it. What comes back is a verdict — `consistent` (≥ 2 pages, nothing differing → a reference-backed pattern proposed for DS governance), `single-source`, `divergent` (the pages' own values are listed) — never a forced component.

**Shape.** `pages[]` (id, name, folder under `project_aura1-main/projects/`, note) and `patterns[]`: `{ role, surface: light | dark | any, observations: [{ page, source, properties }] }`. `role` is one of B2's role names (`eyebrow`, `description`, …), never a component name. Every observation carries the **source file and line** the values were resolved from and the measured properties as that page's own source resolves them (`font-size: "12.8px"`, `text-transform: "uppercase"`, `color: "#b01f24"`). Measure from the approved page's source or its rendered computed style — never estimate, never copy a Design System value in.

**Maintaining it.**
1. Change a value or add an observation/pattern only from the approved page itself, and update `measuredOn`.
2. Any change here changes what an audit can report, so it is an **engine change**: the file is content-hashed and fingerprinted by `test/unit/engine-revision.test.ts` — bump `AUDIT_ENGINE_REVISION` (with its `ENGINE_REVISION_LOG` line, `src/graph/run-metadata.ts`) and re-pin, so a full-site run does not reuse findings an older catalog produced.
3. Add a regression test for a new role (`test/unit/reference-patterns.test.ts`, `test/unit/b3-reference-fallback.test.ts`).
4. **Competition Benchmarking = `competition-benchmarking-v2-react`** (served at `http://localhost:3095` when running) — confirmed as the approved page by the design lead on 2026-10-07 (engine revision 6). `competition-benchmarking-v3` was measured earlier and is **not** used; do not re-introduce it. Its values were read from `src/globals.css` (`.label` 198-207, `.sub` 208-213) and checked against the rendered page's computed styles; it has no dark-surface eyebrow, so that pattern still holds only the Report Store and the Case Study.

Full rule: `.claude/skills/audit-run/SKILL.md` → "Design System first, approved Project Aura reference second".
