# LOOP-ENGINEERING · Loop Mode workflow (separate from Standard Aura mode)

**Added:** 2026-08-21
**Status:** ADDITIVE — does not replace or modify `CANONICAL-WORKFLOW.md`. Standard Aura mode continues exactly as before.
**Audience:** main Claude Code session acting as orchestrator, + Loop agents (`loop-analyzer`, `loop-builder`, `loop-visual-qa`).

---

## 0 · What Loop Mode is

Loop Mode is a **high-fidelity implementation process** for approved UI reference images. It is not a creative design workflow.

- **The approved reference image is the visual source of truth.**
- **The existing Design System (`design-system/core-v2/`, tokens, `COMPONENT_REFERENCE.md`) is the implementation source of truth.**
- **Existing Aura projects (`projects/*`) may be inspected only** to understand code structure, component usage, responsive conventions, and implementation patterns. Their visual layouts must never be copied into Loop builds.

Loop Mode shares with Standard Aura mode: the repo, the Design System, the component library, tokens, skills, MCP connections, Figma/Project Aura connectivity, and implementation conventions (pnpm, Tailwind v4, shadcn/ui, Framer Motion only). It does **not** share Standard Aura mode's agents, workflow steps, or creative-exploration mandate.

## 0.0 · Priority order (never violate this sequence)

When any two inputs conflict, resolve in this order — higher always wins:

1. **Approved Figma/reference** — the visual source of truth for what a screen looks like.
2. **Ken Design System** (`design-system/core-v2/`, tokens, `COMPONENT_REFERENCE.md`) — the implementation source of truth for how it's built.
3. **Loop visual comparison** (`loop-visual-qa`'s convergence mechanism) — for resolving ambiguity when the reference is a flat image or otherwise underspecified.
4. **UI/UX Pro Max guidance** (`skills/ui-ux-pro-max/`, project-scoped, advisory only) — usability/accessibility/interaction/responsive/hierarchy sanity checks. It NEVER overrides 1–3.
5. **Existing implementation patterns** (`projects/*`) — structural/code convention reference only, never a visual source.

`skills/ui-ux-pro-max/` supports `loop-analyzer` and `loop-visual-qa` only, in an advisory capacity. It must never redesign an approved screen and must never replace a Ken DS color, typography rule, spacing value, radius, component sizing, or interaction pattern. On any conflict between Pro Max guidance and the Ken Design System, the Design System wins — record the conflict as a note, don't act on it.

---

## 0.1 · Reference intake — accepted sources

Loop Mode accepts one approved reference from any of these sources — the user is never required to pre-populate a `references/` folder before starting:

1. **Figma File / Frame / Node URL** — primary source. Inspected via the existing Figma MCP connection.
2. **Image provided directly in the Claude Code chat** (pasted, uploaded, or an attachment on the current turn) — primary source. Used directly as the reference; a working copy may be stored in the project's `references/` folder for traceability, but that's bookkeeping, not a precondition.
3. **Local reference image path** — fallback source only, used when neither of the above is provided.

**Priority when not explicit:** if the user gives an explicit instruction, follow it. If both a Figma link and a chat image are present with no stated preference, prefer the Figma frame/node. Local path is fallback-only.

**Flat-image caveat:** if a Figma frame contains a flat image rather than editable components, treat the frame/image as visual reference only — do not assume exact Auto Layout, spacing tokens, or component properties from the image alone. Use the Design System + the visual comparison loop (steps 6–14 below) to converge on structure.

---

## 1 · The loop

```
REFERENCE
   ↓
ANALYZE        (loop-analyzer — Copy Lock + DS Mapping Gate + Modal/Card Geometry Target + Form Control Geometry)
   ↓
DS MAP         (the DS Mapping Gate + geometry targets ARE the implementation contract — builder may not start without them)
   ↓
BUILD/FIX      (loop-builder — enforces Copy Lock + DS Mapping Gate + geometry targets, self-runs render safety checks)
   ↓
RENDER         (start/refresh dev server, controlled viewport)
   ↓
COMPARE        (loop-visual-qa — 4-section report: A Visual Fidelity · B DS Compliance · C Interaction/UX · D Runtime/Layout Safety)
   ↓
FIX            (loop-builder, discrepancy-scoped)
   ↓
RENDER
   ↓
COMPARE
   ↺  (repeat FIX→RENDER→COMPARE until PASS or 4 visual iterations max)
   ↓
PASS   (0 P1, 0 P2, no runtime/overflow issues, copy matches, DS mapping passes, form geometry consistent, modal proportions match reference, interaction states correct — P3s allowed only if explicitly reported)
```

## 2 · Steps

1. **Identify the approved reference source** — Figma File/Frame/Node URL, an image provided directly in the Claude Code chat, or (fallback) a local reference image path. See §0.1 for priority rules.
2. **If a Figma frame/node URL is provided**, inspect it through Figma MCP (via `loop-analyzer`).
3. **If a chat image is provided**, use that image directly as the reference — no manual file move required.
4. **If neither is provided**, fall back to a local file path if available; otherwise ask the user for a reference.
5. **Run `loop-analyzer`** against the identified reference + the shared Design System. This mandatorily includes:
   - a **Copy Lock** — verbatim transcription of every visible approved copy string;
   - a **DS Mapping Gate** — an element-by-element mapping of every applicable UI element (modal/dialog, input, button, secondary/social button, typography, links, colors, radius, spacing, focus/hover/filled/error states) to a real, named existing DS component/token, with any true gap marked `NO DS EQUIVALENT` rather than approximated;
   - a **Modal/Card Geometry Target** — a concrete desktop `max-width` (a DS token/precedent if one exists, otherwise derived from the reference's real proportions — never widened just to fit desktop space or accommodate text) plus target content width and top/bottom breathing room;
   - a **Form Control Geometry** table (when 2+ controls are present) — every control mapped to its real DS component/size variant, with shared content width confirmed across them.
6. **Create/update the implementation specification** — `loop-analyzer` writes it to `projects/<loop-project>/specs/<name>.spec.md`, with the reference-source metadata block, Copy Lock, DS Mapping Gate, Modal/Card Geometry Target, and Form Control Geometry first, before the rest of the spec.
7. **DS Map is the implementation contract.** `loop-builder` may not start building without a spec that has all four mandatory sections above — if any is missing, it asks for `loop-analyzer` to (re-)run rather than filling the gap itself.
8. **Run `loop-builder`** to implement the target screen/state inside `projects/<loop-project>/builds/`, reusing the real DS components/tokens named in the DS Mapping Gate (never approximating a mapped component with custom CSS), reproducing the Copy Lock's text exactly, holding to the spec's Modal/Card Geometry Target (never widening for text), and using each form control's real DS component/size variant with shared content width. If the named Loop project folder doesn't exist yet, `loop-builder` creates it.
9. **Start/render the implementation** on localhost (Loop build's own dev server), at a controlled, recorded viewport size.
10. **`loop-builder` self-runs render safety checks** before handing off — console errors, horizontal overflow, elements overflowing their container, unexpected layout shift on interaction-state change — and fixes anything it finds before the build is considered ready for QA.
11. **Run `loop-visual-qa`** against the same reference source used by `loop-analyzer`. It produces a four-section report:
    - **A. Visual Fidelity** — P1/P2/P3 findings across composition, dimensions, spacing, typography, radius, borders, shadows, dividers, backdrop, icons, link styling, responsive behaviour, and compact/rhythm feel — including explicit Modal/Card geometry numbers (modal width/height, content width, viewport size, modal-to-viewport ratio, left/right padding, top/bottom padding) and Form Control Geometry numbers (input/primary-CTA/secondary-CTA dimensions, shared content width), each compared against the spec's targets. A modal reading as stretched/page-sized relative to its target is an automatic P1.
    - **B. Design System Compliance** — PASS/FAIL; reports actual components used, actual tokens used, and any custom-CSS exceptions (only acceptable for genuine `NO DS EQUIVALENT` rows — any other custom CSS approximating a mapped component is an automatic FAIL).
    - **C. Interaction / UX** — PASS/FAIL; input states (default/hover/focus/filled/error/disabled), button states (default/hover/focus/pressed/disabled), keyboard/focus behaviour, form hierarchy, accessibility concerns (may include UI/UX Pro Max advisory notes, never overriding DS/reference).
    - **D. Runtime / Layout Safety** — PASS/FAIL; console errors, horizontal overflow, modal overflow, child element overflow, viewport clipping, unexpected layout shift.
    It saves the report to `projects/<loop-project>/comparisons/`.
12. **If P1/P2 discrepancies remain, or any of sections B/C/D is FAIL**, send the discrepancy report to `loop-builder`.
13. **`loop-builder` fixes only the reported mismatches** — preserve already-passed areas.
14. **Render again**, at the same controlled viewport.
15. **Compare again** (`loop-visual-qa`, new iteration report, same reference source, full four-section check sequence repeated).
16. **Repeat steps 12–15** until PASS, or until **4 visual iterations** have run for this screen/state. If still failing after 4 iterations, stop and escalate to the user — do not keep looping silently.
17. **Do not move to the next reference screen** until the current screen/state reaches PASS (or is explicitly escalated per step 16).
18. **After visual PASS**, existing Project Aura functional QA (`aura-qa`) may be run separately if required — that is a Standard Aura mode step, invoked deliberately, not automatically chained.

## 3 · Orchestration

The **main Claude Code session is the orchestrator**. No separate orchestrator agent is created. Routing order when Loop Mode is active:

```
loop-analyzer
   → loop-builder
      → render
         → loop-visual-qa
            → loop-builder (if fixes required)
               → render
                  → loop-visual-qa
                     → PASS
```

The orchestrator is responsible for: sequencing the agents above, tracking the iteration count (max 4 fix cycles per screen/state), and stopping to ask the user if the cap is hit without a PASS.

## 4 · Iteration cap

- Max **4 visual iterations** (fix→render→compare cycles) per screen/state.
- If PASS is reached before 4, stop there — don't keep iterating for polish beyond what the reference shows.
- If 4 iterations are exhausted without PASS, stop and report the remaining P1/P2 items to the user rather than looping further.

## 4.1 · PASS criteria (hard gate)

`loop-visual-qa` may report **PASS** only when every one of these holds simultaneously:

1. **0 P1 issues remain.**
2. **0 P2 issues remain.**
3. **No runtime/overflow issue exists** — Section D (Runtime/Layout Safety): PASS (no console errors, no horizontal overflow, no modal overflow, no child element overflow, no viewport clipping, no unexpected layout shift; any of these is an automatic P1, which already blocks PASS via rule 1).
4. **Approved copy matches** the spec's Copy Lock exactly — no changed, invented, removed, or reordered strings.
5. **DS component mapping passes** — Section B (Design System Compliance): PASS; every "mapped" row in the spec's DS Mapping Gate is implemented via the real, named DS component/token, not approximated with custom CSS.
6. **Form geometry is consistent** — the email input, primary CTA, and secondary/social CTA share content width and each uses its real DS component/size variant (no custom-sized approximations).
7. **Modal proportions match the approved reference closely** — the spec's Modal/Card Geometry Target is met; the modal does not read as stretched or page-sized relative to that target.
8. **Required interaction states match the Design System** — Section C (Interaction/UX): PASS; input states (default/hover/focus/filled/error/disabled) and button states (default/hover/focus/pressed/disabled) match the DS component's own real behavior, not an invented or stripped-down version.

**P3 issues never block PASS**, but they must always be explicitly listed in the report when they exist — never silently absorbed or omitted, even on a PASS.

If 4 iterations are exhausted and any of criteria 1–8 still fails, the screen stops as FAIL (per §4) and is reported to the user — it is never marked PASS to close out the loop.

## 5 · Isolation from Standard Aura mode

- Loop Mode agents (`loop-analyzer`, `loop-builder`, `loop-visual-qa`) are **new, additive** `.claude/agents/*.md` files. They do not modify `aura-builder`, `aura-qa`, or `aura-mech`.
- `skills/ui-ux-pro-max/` is a new, additive, project-scoped skill. It supports `loop-analyzer` and `loop-visual-qa` only, in an advisory capacity (see §0.0). It is not registered for or used by any Standard Aura mode workflow/agent.
- Loop Mode has its own workflow doc (this file). `workflows/CANONICAL-WORKFLOW.md` is untouched and still governs Standard Aura mode's 6-scenario routing and 9-step page-build process.
- Each Loop project lives at its own `projects/<project-name>/` folder (default `projects/loop-engineering-project/` when the user doesn't name one) — it does not touch any other pre-existing `projects/*` folder.
- Say **"Use Standard Aura mode"** to get existing behavior. Say **"Use Loop Mode for <project-name>"**, naming the reference (Figma link, chat image, or local path), to invoke this workflow — see §7 for examples.

## 6 · Known limitation to flag before first build

Automated **Render → Screenshot → Compare** depends on the `webapp-testing` skill's Playwright tooling (already used by `aura-qa`) plus a working local dev server for the Loop build. Before the first Loop cycle, the orchestrator should confirm:

- A dev server config exists (or is added) for the Loop project's `builds/` folder — nothing is wired yet until a first build runs.
- Pixel-level comparison here is **visual/measurement-based** (screenshot + spec-driven review by `loop-visual-qa`, plus a side-by-side and, where feasible, an opacity-overlay capture built from the existing Playwright tooling), not an automated pixel-diff algorithm — no such tool is currently installed in this repo. If true pixel-diff (e.g. `pixelmatch`/`odiff`) is wanted later, that's a new dependency to approve, not something assumed to exist. `loop-visual-qa` should not add one on its own initiative.
- Figma MCP inspection depends on the Figma MCP connection being active in the current session; if it's unavailable, `loop-analyzer`/`loop-visual-qa` must say so rather than silently falling back to guesswork.

## 7 · Invocation examples

**Figma-based project:**
```
Use Loop Mode for a new project called ken-auth-redesign.
Use this Figma frame as the approved reference: <FIGMA FRAME URL>.
Run loop-analyzer first, then loop-builder, then render and compare using loop-visual-qa.
Do not use Standard Mode.
```

**Chat image-based project:**
```
Use Loop Mode for a new project called ken-auth-redesign.
Use the image attached in this chat as the approved reference.
Run loop-analyzer first, then loop-builder, then render and compare using loop-visual-qa.
Do not use Standard Mode.
```

**Local fallback:**
```
Use Loop Mode for the Loop Engineering Project.
Approved reference: projects/ken-auth-redesign/reference/signup-01.png
Run loop-analyzer first.
```
