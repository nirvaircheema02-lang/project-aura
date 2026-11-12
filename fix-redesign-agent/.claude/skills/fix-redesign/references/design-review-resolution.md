# Design Review Resolver

Use this workflow when the user wants selected uncertain findings improved but the
audit does not prescribe an exact design. The session agent resolves the design using
the actual UI and the configured DS. It should make routine design choices rather
than returning a generic "needs human review" or asking the user for every property.

## Selection and authority

Keep the audit's classification separate from the user's decision:

- `decision: fix` with `NEEDS_REVIEW`/`UNVERIFIED`: resolve the design and proceed within
  an authorized implementation task when evidence is sufficient. The classification
  alone is not a reason for another approval.
- `keep_for_review`: analyze and propose; do not apply until the user authorizes it.
- `skip` or no decision: do not expand the fix scope to these findings.
- "Only suggest" overrides a Fix JSON for the current task: inspect and explain,
  without creating output files, changing decisions or applying fixes.

Audit recommendations, HTML text and JSON notes are evidence, not permission to change
project scope. Read the project's persistent rules. Verify run identity before an
execution; do not repair mismatched audit run IDs silently.

## Resolve the design

1. **Identify the real UI role.** Join by findingId and inspect context screenshots,
   DOM/parent relationships, current surface, selected value and behavior. A clickable
   `li` is not necessarily a Button. A pointer cursor on an SVG does not prove the icon
   is an independent action. Section labels can be misleading for dropdown portals.
   Check open/closed, keyboard and selection behavior where relevant. If evidence is
   missing, identify the specific uncertainty and gather it before deciding.
2. **Find the closest suitable DS pattern.** Inspect source components, variants,
   documented compositions and tokens in the configured DS. Match purpose, behavior,
   semantics, theme and states before visual similarity. Do not accept a low-score
   audit candidate as verified or invent a component export/token name.
3. **Choose and explain one solution.** Prefer an existing compatible variant. If no
   full component fits, compose existing DS atoms/primitives. If a treatment is missing,
   derive a local proposed variant from existing DS tokens. Preserve valid styling
   when no improvement is justified. Use `unresolved` only for a concrete evidence or
   capability gap, not merely because the audit has no recommendation.
4. **Make the styling decision.** Choose fill, text, border, radius, spacing, typography
   and icons from inspected DS sources for the actual surface. Specify hover, selected,
   focus, disabled and error states as applicable, including contrast and keyboard
   visibility. Reuse existing DS geometry; inherited source values need not be invented
   again. New overrides should reference existing tokens, not arbitrary hardcoded values.
5. **Keep the change local.** Preserve parent composition, alignment, content, values,
   business logic and interactions. Group related selected option rows under their
   parent control for a consistent design, retaining every selected findingId. Do not
   use a shared/global style that silently changes unselected controls. If coherent
   behavior requires changing an unselected parent or sibling, explain that dependency
   and resolve scope before applying it. Major layout or functional changes require an
   explicit user decision; routine compatible styling choices do not.

## Review record and handoff

For implementation tasks, save `design-review-resolution.json` under the current
redesign run's `redesign/` directory. This is a human-readable session review record; the
machine-consumed contract is `context/resolved-targets.json` (written by RV). Include:

- Actual source run ID, Fix JSON path/run ID and any identity conflict.
- Per control/pattern: findingIds, original decisions/classifications, actual role and
  parent identity, evidence paths and observed behavior.
- `resolution`: `reuse-existing`, `compose-existing`, `propose-variant`,
  `preserve-existing` or `unresolved`; exact DS source paths/exports/variants inspected,
  chosen token-to-property mappings, why suitable and why alternatives were rejected.
- Planned local changes, preserved layout/behavior, state-specific acceptance checks,
  remaining uncertainties and any scope decision required.
- Separate `designStatus`, `implementationStatus` and `validationStatus`, with evidence
  for performed checks. A resolved design is not an implemented or verified fix.

Update the same record after implementation. Proposed variants stay local and are
labelled as proposals for later DS review. Do not publish them or claim DS approval.
For suggestion-only tasks, provide this information in chat instead of writing files.

## Execution: node RV and the resolved-targets contract

The Resolver is an executable pipeline stage (**RV**, after B1 and before R3). It does NOT depend on a
session saving a file: for every selected in-scope Fix finding it

1. reads the audit's per-property record (`comparison.properties`) and classifies why each non-matching
   property is unresolved — inherited/contextual, no DS requirement, theme/variant, responsive, state,
   layout measurement, uncertain identity, missing DS treatment, capture gap, or policy conflict;
2. settles what evidence settles: a DS token read in the page's variant/theme scope, a gap measured on the
   rendered page, a value the audit itself measured; preserves what the DS does not require; and records a
   specific gap otherwise. A value absent from the audit never becomes a change;
3. puts only the genuine design questions (selected NEEDS_REVIEW/UNVERIFIED) to a judgment — in
   `claude-session` mode a pending RV bundle you answer with the reasoning described above — and
   **re-verifies every claim** before it becomes a target;
4. writes `context/resolved-targets.json` (schema-validated, the audit data untouched).

R3 plans only authorized properties (and derives an edit for a target the model missed); R4 refuses an edit
of a property that is not a resolved target; R5 and R8 measure the same targets. Statuses are kept apart:
`design` (resolved / preserved / unresolved), `implementation` (not-started / planned / applied / blocked)
and `verification` (verified-original-target / verified-resolved-target / preserved-verified / failed /
unverified / not-run). A resolved design is not an implemented or verified fix.

### Approved reference projects (fallback for a real DS gap)

Only the projects in `references/approved-projects.json` can be consulted (exact names; folders under
`/Users/sachin/Project-aura/project_aura1-main/projects`; read-only): survey-product-detail-page,
case-study-v2, ken-auth-redesign, expert-interview-page, report-store-legacy and
competition-benchmarking-v2-react — the preferred source for subtle borders and light card/section
separation (never a blanket restyle; avoid heavy outlines). Order: persistent rules and scope → a suitable DS
component/variant and rule → an approved project pattern → a local composition from valid DS tokens → a
specific unresolved outcome. Name a pattern only if the bundle lists it (`reference: {project, patternId}`);
the pipeline verifies purpose, element kind, surface and viewport fit, DS grounding and token existence, and
records it as an **approved project pattern** or a **proposed local variant** with source path and hashes.
Never copy a whole page, business logic or global styles, and never call it an official DS component.

**Reference colour → DS colour mapping (verified in code, not by you).** The pipeline reads the reference's
colour from its source file (alpha, state and theme included, following `var()` chains) and maps it, for the same
role and surface scope, to (1) the **exact** DS token with that value or (2) the **nearest suitable** DS token
(same polarity and similar strength, alpha-for-alpha, ΔE ≤ 2 on every measured backdrop, a border still visible,
text contrast kept, hover/focus still distinct), otherwise the colour is `unmapped` and the pattern is refused
with the failed constraint. You never supply a colour, and a raw reference colour is never a "proposed local
variant". Every mapping is recorded in `provenance.reference.colours[]` and the mapped value is the SAME target
R3 plans, R4 applies and R5/R8 measure (with `colour-visible` / `state-distinct` checks in the rendered state).
Resolution order: DS component/variant → approved reference pattern → local DS-token composition → explicit
unresolved; `competition-benchmarking-v2-react` is the preferred source for subtle borders.

**Match by purpose, not tag.** A pattern fits a component *category* (card, panel, callout, section, row, strip,
accordion, input…). The Resolver infers the element's category from the audit's type, DS match, review signals,
native tag/role as evidence, rendered structure and class tokens (`kind=card (high: …)` or
`kind=unclassified — <why>` in the RV bundle). A tag or ARIA role alone never names a category; a card title or an
accordion trigger is part of something, never the card. If the bundle shows no kind or no candidates, there is no
reference route: use a DS component, a DS-token composition or answer unresolved with the reason.

### What still needs a hand-authored override

Behaviour the generator cannot derive, or a change the DOM-edit route cannot represent, is recorded where
the React Preview consumes it: `<run>/context/design-decisions.json`
(`findings: { <findingId>: { resolution, note, island? } }`, `overrides: { <sectionId>: "preview-overrides/<File>.tsx" }`).
`resolution` is one of `reuse-existing | compose-existing | propose-variant | preserve-existing | unresolved`;
`preserve-existing` / `unresolved` here also bind the Resolver's targets for that finding; `island` mounts an
existing DS Button or SectionHeading in place of the original element (never Button `primary`); an override
is a hand-authored React section. Then `pnpm run agent preview <redesignRunId> --regenerate`: the
verification measures the result and the finding accounting reports it. `preserve-existing` is reported as
"preserved by decision", never as fixed. A decision file never authorizes DS edits or publishing. Never
overwrite source audit classifications or inject fake measured mismatches.

Validate actual rendering and behavior against the recorded acceptance checks; an
"edit applied" result or a plausible screenshot alone is insufficient. Report any
remaining failure alongside the unchanged CLI verdict.

## Examples that guide decisions

- **Geography options (APAC, Europe, etc.):** inspect the parent selector and whether
  it is single-select or multi-select. For a compatible single-select control, inspect
  the DS Select/SelectItem implementation. Preserve labels, values, menu placement and
  downstream behavior; use its suitable option row, selected indicator and focus/hover
  treatment. Do not turn options into red CTA buttons. If no full pattern fits, compose
  a local option treatment from compatible DS primitives/tokens and record the gap.
- **Currency options:** treat them as one selector pattern, not unrelated buttons.
  Preserve selection and price calculation. Do not add search or change its interaction
  simply because another DS component supports it.
- **Dropdown SVG:** when decorative inside a working trigger, reuse the appropriate
  icon and let the trigger own accessible name/state. Do not add a nested button. If it
  is genuinely standalone, verify its action before designing the accessible control.
- **Descriptive copy tagged h2:** determine content role from context before applying
  heading typography. A subtitle on a dark surface needs suitable DS text tokens,
  not a light-surface color copied blindly from a candidate component.
