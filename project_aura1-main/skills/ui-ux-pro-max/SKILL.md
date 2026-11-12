---
name: ui-ux-pro-max
description: |
  Project-scoped (not global) advisory skill for Loop Engineering Mode. Provides `loop-analyzer` and `loop-visual-qa` a searchable database of UX guidelines, accessibility patterns, interaction conventions, and responsive/usability heuristics (via the vendored `ui-ux-pro-max` search tool at `skills/_external/ui-ux-pro-max-skill/`). Advisory only — it NEVER overrides the approved Figma/reference or the Ken Design System, never redesigns an approved screen, and never replaces Ken DS colors, typography, spacing, radius, component sizing, or interaction patterns. Not used by Standard Aura mode or by loop-builder.

  Use when:
  - `loop-analyzer` wants a usability/accessibility/interaction/responsive sanity check while writing a spec
  - `loop-visual-qa` wants an accessibility/interaction-quality/form-usability/responsive-usability/hierarchy sanity check while writing a comparison report

  Do NOT use for:
  - Standard Aura mode work of any kind
  - `loop-builder` (it builds from the spec + DS; it does not consult this skill directly)
  - Generating new visual designs, redesigning an approved reference, or picking colors/fonts/spacing that aren't already in the Ken Design System

user-invocable: false
---

# ui-ux-pro-max — Loop Mode advisory skill (project scope)

This is a **project-local** install (this repo only — never installed globally) of the MIT-licensed `ui-ux-pro-max` design-intelligence skill, already vendored read-only at [skills/_external/ui-ux-pro-max-skill/](../_external/ui-ux-pro-max-skill/). This wrapper scopes its use strictly to Loop Engineering Mode's two read-only agents.

## Priority order (never violate — same as `workflows/LOOP-ENGINEERING.md` §0.0)

1. **Approved Figma/reference** — visual source of truth.
2. **Ken Design System** — implementation source of truth.
3. **Loop visual comparison** (`loop-visual-qa`'s convergence mechanism).
4. **UI/UX Pro Max guidance (this skill)** — advisory only. Never overrides 1–3.
5. **Existing implementation patterns** — structural convention only.

If this skill's guidance conflicts with the approved reference or an existing Ken DS component/token/color/typography/spacing/radius/sizing/interaction pattern, **the reference and the Design System win, always**. Record the conflict as a note for the user; do not act on it.

## Who may use this skill

- **`loop-analyzer`** — for form usability sanity checks, accessibility considerations, interaction recommendations, and responsive considerations while drafting a spec. Findings go in the spec's "UI/UX Pro Max Notes" section, clearly separated from Copy Lock / DS Mapping Gate / geometry facts.
- **`loop-visual-qa`** — for accessibility review, interaction-state quality, form usability, responsive usability, and hierarchy sanity checks while comparing a render. Findings go in Section C (Interaction/UX) of the four-section report, clearly labeled as advisory where they go beyond a hard DS/reference-conformance check.

**Not for `loop-builder`** (it implements from the spec + DS, it doesn't need a second opinion mid-build) and **not for any Standard Aura mode agent/workflow**.

## What this skill must never do

- Never suggest replacing an existing Ken DS component, token, color, typography rule, spacing value, radius, or component sizing.
- Never suggest a different interaction pattern than what the Ken DS component already implements.
- Never become grounds to fail a result that already matches the approved reference and the Design System.
- Never redesign or reinterpret the approved screen.
- Never be treated as a data source for Copy Lock, DS Mapping Gate, Modal/Card Geometry Target, or Form Control Geometry — those come only from the reference and the DS.

## How to consult it

Run its bundled search CLI (read-only, no network, pinned to the vendored copy in this repo):

```bash
python3 skills/_external/ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/search.py "<query>" --domain ux -n 5
```

Available domains: `product`, `style`, `typography`, `color`, `landing`, `chart`, `ux` (the one you'll use almost exclusively — usability/accessibility/interaction/anti-pattern guidance). Omit `--domain` for auto-detection. Example queries: `"modal focus trap accessibility"`, `"form input error state usability"`, `"button hover interaction convention"`, `"responsive modal breakpoint behavior"`.

Treat every result as one advisory data point, not an instruction — weigh it against the priority order above before recording it as a note.
