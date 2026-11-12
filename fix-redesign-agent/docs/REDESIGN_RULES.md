# Persistent redesign rules — 2026-09-30

These user-approved rules apply to every page in fix-redesign-agent, not just the
Deals and IPO preview. They take precedence over conflicting audit recommendations
and generic design preferences. A later explicit user instruction may revise them.

## CTA variants

- Never choose the DS Button `primary` variant: it is the black/dark shimmer CTA.
- Use the existing DS Button `brand` variant for a primary action (including hero
  and form submission). Its fill comes from `--composition-gradient-brand-red-shimmer`.
- Do not recreate the prohibited black CTA through inline colors, utility classes,
  or `--composition-gradient-brand-dark-shimmer`.
- Other existing DS variants remain available where appropriate, including
  secondary, ghost and link variants. Do not turn every button or link red.
- Black text, dark section backgrounds and suitable on-dark variants are allowed.
  The restriction is on the black primary CTA, not the entire dark palette.

## Finding scope and original design

- Join fix JSON decisions to audit findings by findingId. Only fix selected findings
  in the authorized sections. Read the actual mismatch properties and report evidence;
  a selected finding does not authorize redesigning its entire section.
- Preserve section order, columns, card grouping/stagger, original content and assets,
  heading/form alignment, widths and responsive behavior unless the selected finding
  or an explicit user instruction requires that specific change.
- In particular, do not change a centered heading/form to left aligned or rebuild a
  section's composition just to make it fit a DS component.
- Preserve sticky pin/release behavior, scroll behavior, hover/focus reveals, links,
  dropdowns, keyboard use and form behavior. Capture the original interaction before
  editing it. A static screenshot cannot prove sticky or keyboard behavior works.

## Output scope and the React Preview — added 2026-10-06 (made permanent)

- The startup input is `Run ID/Name + Mode`. The Fix Plan, audit data, evidence and Design System are resolved
  automatically.
- **Selected Sections** delivers only the sections that contain `decision: fix` findings in `fix-plan.json`
  (the set in `context/scope.json`), each rendered complete with its original content, composition and order,
  with the verified DS fixes applied. Unselected sections, and the global header and footer, are absent from
  the delivered output, not hidden or merely marked. A finding in an unselected section is never edited.
- **Full Page** delivers every page-specific section; the global header and footer stay excluded.
- **The React Preview is the default deliverable of every run, every page and both modes:** runnable React
  source and a localhost URL. The pipeline generates and verifies it (node R8); it is not hand-built per run
  and it never silently falls back to static HTML. The static HTML export is a reference snapshot only.
- Before G2 the pipeline verifies, in the running preview, scope, content preservation, each Fix finding's
  audit-expected values (measured in the rendered page — an element merely being present is not proof of a
  fix) and interaction parity with the original page captured before any edit. Anything simulated (form
  submission, geolocation, third-party calls) or not reproduced is labelled before visual approval is asked.
- A finding is reported fixed only when it was measured fixed. Unresolved findings and findings with no
  counterpart in the preview are listed with their reason. G2 is always the user's decision.
- Component creation, shared-DS edits and publishing are out of scope.

## Missing expectations and resolved targets — added 2026-10-09

- `expected: null`, "Not resolved", UNRESOLVED, NEEDS_REVIEW and UNVERIFIED are never a reason to change
  anything, and never a reason to drop a finding silently. Node RV classifies why a property is unresolved
  (inherited/contextual, no DS requirement, theme/variant, responsive, state, layout measurement, uncertain
  identity, missing DS treatment, capture gap) and records one outcome per property: **resolved target**,
  **preserve existing**, or **unresolved** with the specific gap.
- A value absent from the audit never authorizes a change. Width, height, alignment, columns, order and
  other composition properties change only to an audit-MEASURED expectation; an unknown one is preserved
  (or reported unresolved). Spacing the audit could not compare (`gap: normal`) is measured on the rendered
  page and compared with the DS value.
- Resolution order: (1) these rules and the authorized scope; (2) a suitable DS component/variant, token and
  rule, read in the page's variant/theme scope; (3) an approved reference-project implementation for a real
  DS gap; (4) a local composition built only from valid DS tokens (a **proposed local variant**); (5) a
  specific unresolved outcome. A value is built only from DS tokens, plus `none`/`transparent`/`currentcolor`,
  0 and a 1px hairline; no hardcoded colours or magic lengths.
- Derived targets live in `context/resolved-targets.json` (source run and finding, property, part, viewport,
  theme, state, the audit's own observation, reason, target, provenance, route, acceptance checks, and
  SEPARATE design / implementation / verification statuses). The audit's `data.json` is never edited. R3
  plans, R4 applies and R5/R8 measure the SAME targets; an edit of a property that is not a resolved target
  is refused. A finding is reported fixed only when every required target is verified; `verified-original-target`
  (the audit's expectation), `verified-resolved-target`, `preserved-verified` and `unresolved` stay distinct.
- Approved reference projects are an exact-name allowlist (`references/approved-projects.json`, read-only):
  survey-product-detail-page, case-study-v2, ken-auth-redesign, expert-interview-page, report-store-legacy,
  competition-benchmarking-v2-react (the preferred source for subtle borders and light card/section
  separation, never a blanket restyle). Any other project, a similarly named folder or an unapproved copy is
  rejected; URLs are inspection conveniences, identity is the source path and its hash. A pattern is reused
  only after its purpose, element kind, surface and viewport fit, its parent layout and states are
  compatible, and its tokens exist in the configured DS. It is recorded as an **approved project pattern**
  or a **proposed local variant** with project, source path, file and project hashes, and tokens — never as
  an official DS component. Whole pages, business logic and global styles are never copied.
- **A reference's colours are never used raw — they are mapped to DS colours — added 2026-10-10.** The colour is
  read from the reference source (alpha, state and theme included, following its `var()` chains) and mapped,
  for the same role on the same surface scope, to (1) the **exact** DS token with that value (an exact primitive
  beats a nearer semantic token; ties: same name, sub-role, semantic > role > primitive tier, canonical file) or
  (2) the **nearest suitable** DS token: same polarity and similar strength, alpha-for-alpha, ΔE ≤ 2 on every
  measured backdrop, a border still visibly a border, text keeping its contrast, hover/focus still distinct from
  default. Nothing suitable → the colour is `unmapped` and the pattern is refused for it (a specific unresolved
  reason), never a raw value and never a "proposed local variant" built from a raw colour. Every mapping is
  auditable in `provenance.reference.colours[]` (reference value/chain/rgba, role, state, backdrops, outcome
  exact/nearest/unmapped, DS token/value/file/scope, distance, rejected candidates, design-time and rendered
  verification). Planner, applier and verifier read the SAME derived target (the DS token's value). Only
  an exact mapping with nothing hard-coded is an **approved project pattern**; any nearest colour or literal
  length makes it a **proposed local variant**. `competition-benchmarking-v2-react` is the preferred source for
  subtle borders, and its colours go through this mapping like every other reference.
- **A reference is matched by what the element IS, not by its tag or role.** Patterns name component categories
  (card, panel, callout, section, row, strip, accordion, input…). The element's category is inferred once from
  the audit's type, DS match and review signals, native tag/role/attributes as evidence, rendered structure and
  class tokens; a tag or an ARIA role alone never names a category (a clickable card stays a card, a card title
  or an accordion trigger is part of something, never the card). Conflicting evidence withholds every category
  (fail closed). Selection and verification use the same classification, so a candidate offered is never
  refused for kind, surface or viewport reasons.

## Design and interaction fidelity, and the correction loop — added 2026-10-09

- Before any edit the original's design is captured from the pre-edit snapshot (write-once, hash-bound
  baseline): default styles, hover and keyboard-focus styles, section order, columns and grouping, alignment,
  and sticky pin/release at desktop and mobile, for every section in scope, unchanged ones included. The
  output is compared under the same conditions (viewport, scroll, hover/focus target, settling).
- The only differences allowed are those a resolved target authorizes, identified by finding + property +
  state (+ part). Nothing exempts a whole component or section. A card that is black by default and white on
  hover keeps both when only its radius is fixed: a default-state edit is emitted so it does not apply while
  the element is hovered, focused or active, unless a target for that state says so.
- Verification is DOM/style measurement plus behaviour probes plus rendered comparison, not one pixel
  threshold. Anything that could not be captured or compared is listed as NOT checked and can never become a
  pass; states this verifier does not capture are named in every report.
- Feedback is actionable (element, state, viewport, expected, observed) and goes to the party that can fix
  it: the preview generator (state guard, drop a component or edit), the planner (re-plan with the measured
  constraint), or an authored override. The baseline is never changed by a correction. One configurable
  budget (`fidelity.*`: correction cycles, verifications, ACTIVE time — see below) covers preview corrections, planner
  re-plans and re-verifications together. The loop stops on pass, on a concrete blocker, when a pass removes
  nothing that was open, or when the budget is exhausted — and whatever is open is reported at G2, never
  hidden. It never lowers a criterion to finish.
- Approvals are bound to the resolved targets, the baseline, the fidelity report and the correction outcome:
  changing any of them invalidates a G2 approval. Original-site access stays read-only; simulations are
  labelled.

### Preview failures reopen findings; incomplete checks never pass; preservation needs evidence — added 2026-10-10

- **A rendered-preview failure reopens the finding even when the live page measured it fixed.** R8's structured
  feedback (finding, failed target and part, property, state, viewport, expected, observed) goes back to R3,
  which re-plans exactly the named properties/states, keeps every earlier successful edit, and is verified again
  by R6→R7→R8. It uses the SAME shared budget and the same no-progress / blocker stops; a pass is replayable on
  resume. A corrected edit replaces the failing one only for the same finding, state and property (part-aware:
  a label/descendant correction never retires the element's own edit). Mobile-viewport and preserve-broken
  items that no targeted edit can represent are reported, not planned. The planner can never widen authorization
  through feedback.
- **Every check the verifier sets out to run is verified, failed or unverified, and the three stay distinct all
  the way to G2.** `pass` requires that no *required* check is unverified; a visibly effective hover that could
  not be captured, a sticky trace with unreachable positions, a section the budget stopped, a hand-authored
  override section, an element dropped by the sampling cap, a hover target covered by an overlay, a baseline
  captured by an older version — each is an explicit `unverified` gap with a reason and is `incomplete`, never
  `pass`. Gaps that are by design (the `:active`/disabled/script-driven/mobile-hover states, island internals,
  decorative or unhoverable elements) are listed in every report but do not block. Correction summaries,
  PREVIEW.md and the G2 reason line carry the verified/failed/unverified numbers and the first gap; G2 approval
  stays the user's decision and its note records any unverified required check.
- **"Preserved" is claimed only on positive comparison evidence.** A preserve decision is `preserved-verified`
  only when the same element, part, property, state and viewport were compared on both pages and agree. A
  confirmed removal, or a measured unauthorized difference, is `failed`. Anything the verifier could not compare
  (moved or retagged element, capped output, a state or part it cannot capture, a property it does not measure,
  a change that really happened under another target's authorization, an older baseline without the evidence)
  is `unverified` with a stable reason — and counts as an open required check, never as a pass. The same
  accounting feeds verification.json, resolved-targets.json, the correction summary and G2.

### Overall preview status and the one persisted budget — added 2026-10-12

- **The preview's overall status is `PASS`, `FAIL` or `INCOMPLETE`, and it is the same everywhere** (verification.json, pv-status.json, the preview UI, PREVIEW.md, the CLI, the G2 reason and note). `PASS` only when every required check is verified; `FAIL` when a required check failed (when something is also unverified, both are disclosed); `INCOMPLETE` when nothing failed but required evidence is missing (an unreachable sticky trace, an unverified required preserve or state check, a gate that did not run, no fidelity comparison, an unmeasured target). Optional or by-design limitations are listed separately as *disclosed* and never change the status. Individual verified results are never rewritten. G2 stays the user's decision: a FAIL needs `--accept-preview-failures`; an INCOMPLETE is approvable but the recorded note names the accepted unverified requirements.
- **There is ONE correction budget per run and plan, persisted in `context/correction-state.json`.** Verification and time allowance are checked before expensive work; a verification (and a correction together with its re-check) is reserved and saved before it starts, so a crash, pause or failure never refunds it. Resume, judgment continuation and `preview --regenerate` restore the same usage. Time is *active* time summed across invocations; waiting for a judgment or a human gate is not counted. Usage is reset only by an explicit `--reset-budget` (recorded) or by a materially changed plan, targets or baseline. When the budget is exhausted the agent does no new verification, keeps valid previous evidence, adds the open item "verification budget exhausted", and reports INCOMPLETE (or FAIL) — never PASS.

## DS-first design — added 2026-10-14 (explicit user instruction, revises the "keep the original" bias below)

User instruction: the redesign must follow the Design System properly — CTAs from the DS Button, FAQ rows from the DS AccordionItem —
instead of the production markup with CSS patches. Enabled per project by `preview.dsFirst` (on in this project's config).

- Where the page has a design-system component for an element, the component REPLACES the element and its own design wins:
  CTAs → `Button` (`brand` for a primary action, never `primary`; the audit's `ghost` / `secondary` as matched), headings →
  `SectionHeading`, FAQ rows (a list item with a question heading and a collapsed answer panel) → `molecules/AccordionItem`
  with the ORIGINAL question and answer content. The component keeps its own states and behaviour.
- A mounted component is no longer dropped because it differs from the original in properties the audit did not name. Those
  differences are classified `intentional` (target `ds-first:component`) and stay listed in the fidelity report with the reason;
  they are never hidden and never counted as fixes.
- A component whose measured values differ from the audit's expected values stays mounted; the finding is reported with the
  values that differ and is NOT claimed fixed.
- Unchanged: section order, content, links, widths of the layout slot (the replaced element's wrapper keeps its display, margins,
  alignment and growth), sticky/scroll behaviour, keyboard use, and everything outside a replaced element — still compared
  against the original. Elements that are not a mounted component keep the original-preserving rules.
- Component creation, shared-DS edits and publishing remain out of scope; only EXISTING DS components are mounted.
- **Standing instruction (user, 2026-10-14):** everything marked `fix` in the Fix JSON is redone with the Design System, and the page's
  structure, layout and composition stay as they are. An element with no design-system counterpart is listed in the run report with the
  specific reason (what it is, what the DS lacks); it is never silently left as production markup and never counted as fixed.

## Existing components and missing variants

- Inspect DS source and reuse the appropriate existing component/variant first.
  Do not invent button variants when suitable ones already exist.
- If an appropriate input variant is genuinely missing (for example on a dark
  surface), a local proposed variant is allowed without another routine approval.
  Derive fill, border, text, placeholder, radius, spacing and state treatments from
  existing DS tokens. Do not invent arbitrary colors or copy token values as magic numbers.
- Check default, hover, focus, error and disabled states for visibility and contrast
  on the actual surface. Keep visible field boundaries and keyboard focus.
- Record the proposal, source component, each token and its role, states, reason and
  validation evidence in the run artifacts. Label it proposed; do not claim it already
  exists in the shared DS. Publishing to the DS is a separate action.

## Verification and conflicts

### Selected uncertain findings — added 2026-10-05

- A selected `fix` finding classified NEEDS_REVIEW/UNVERIFIED requires a design
  decision, not an automatic rejection or arbitrary component swap. Identify the
  actual UI purpose and parent behavior, inspect the closest suitable DS pattern,
  then choose an existing variant, composition of DS primitives or proposed local
  variant using existing DS tokens. Make routine choices within authorized scope
  without asking the user to specify each color, border or spacing value.
- Missing-variant permission applies to suitable selected controls generally, not
  only inputs. Preserve surrounding layout and business behavior. Record source
  components, token choices, states, rationale and validation separately from the
  audit's measured mismatches; do not invent audit evidence or claim DS approval.
- `keep_for_review` remains proposal-only until authorized. Suggestion-only requests
  remain read-only regardless of Fix JSON decisions. Ask only when functionality or
  scope is genuinely unclear, or an actual execution gate requires a decision.
- The Design Review Resolver is an executable pipeline stage (node RV, see the next section), run
  before any edit is planned; its judgment is re-verified in code and its targets are consumed by R3,
  R4, R5 and R8. The session procedure in
  [Design Review Resolver](../.claude/skills/fix-redesign/references/design-review-resolution.md)
  describes how a session answers the residual design questions. Authored `design-decisions.json`
  entries (`preserve-existing` / `unresolved`) bind the Resolver. Proposals that change something the
  CLI cannot represent stay unaddressed, and component-building agents remain disabled.

### Validation

- Compare the original and output on desktop and mobile. Verify selected findings,
  unchanged composition/alignment, CTA variant, input states and original interactions.
- Keep the audit and DS source immutable. If an audit explicitly demands the prohibited
  CTA, record the conflict and red-brand replacement intent. If the current validator
  cannot verify that replacement against the audit, report the finding as unaddressed;
  do not apply black or falsely mark it fixed.
- Report unverified behavior and limitations. Never promise perfect output for an
  untested new page.

## Current enforcement boundary

RV derives the targets before any plan. R3 receives these rules and the resolved targets, plans only
authorized properties, derives an edit for a target the model missed (the value comes from the target), and
records which targets cannot be represented as a live-DOM edit. R4 repeats the edit guard (including target
authorization) for resumed/manual plans. R5 receives the rules, measures resolved targets it can reach on the
live page and will not mark a policy-refused edit fixed. R8 measures every resolved target in the rendered
preview in its own state, compares design/state/composition with the immutable baseline, and runs the bounded
correction loop before G2. The guard checks explicit Button primary metadata, known dark-shimmer token usage,
obvious black CTA fills, and direct layout/interaction style changes without a matching selected property or
resolved target. **Colour value guard (2026-10-10):** for a finding that has resolved targets, a colour-bearing
style edit (colour roles, `*-color`, shadows, borders/outlines, backgrounds, gradients, custom properties holding
colours, class and component-swap edits) is accepted only as the target's own value (compared canonically,
gradients included), `var(<target token>)`, or a DS token the DS index shows to be the same colour; raw colours,
named/system/vendor colours, unknown `var()`s, `attr()`/`env()`, Tailwind arbitrary-value and default-palette
colour utilities are refused. A preserve/unresolved property blocks every shorthand/longhand that would
overwrite it. Injected structure (`;`, `{`, `}`, comments, backslashes, `url(`, `<`, `>`) in a value, property or
selector is refused, and the injected stylesheet is mirrored so it cannot break out of the exported HTML. It is
still not a CSS interpreter: classes defined by the page's own CSS, colours set by page scripts, custom
properties the page consumes later and token aliases need the rendered measurement (R5/R8), which is the real
proof. Dynamic behaviour still requires rendered review. Not covered: states a script drives, hover/focus on mobile, the
`active`/`disabled` states, exact pixel identity, and any behaviour the page's own scripts produce (B1's
production probe reports those separately). Manual previews must follow these same rules and run their
browser checks.

## Step labels — added 2026-10-23

- "Step NN" labels (DS `SectionLabel` matches) are **not upper-cased** and stay **small** (DS `--typography-size-2xs`, 0.6875rem), with no added
  letter-spacing. This revises the SectionLabel's all-caps / 0.2em default for step labels by explicit user instruction; colour and weight keep
  the audit's DS values. Implemented in `withUserTypographyOverrides` (src/resolution/resolve.ts).

## Stat numerals and counters — added 2026-10-26

- Stat numerals (e.g. "300000+") use the DS type-scale step (R1.3: 36px → 2.441rem) and a neutral ink (`--black-900`, the DS StatPair value colour),
  never the brand-red gradient (R1.2 / ANTI_PATTERNS #1: brand red is for CTAs only).
- They do **not** change colour or turn into a gradient on hover (the original's `group-hover:text-transparent` + gradient is removed).
- A numeral that is only digits (+ `,`, `+`, `%`) counts up once when it scrolls into view (`templates/react-preview/src/runtime/counters.ts`);
  the final text equals the original and `prefers-reduced-motion` shows it at once.
- **Generalised 2026-10-26 (no per-run CSS):** the Resolver derives the targets from the audit — a finding with the stat-numeral R1.2 violation gets
  `color` = `--black-900` and, from its R1.3 violation, `font-size` = the audit's closest DS type-scale step (`withStatNumeralTargets` in
  `src/resolution/resolve.ts`; a value the audit already resolved is never overridden, a size that is not a DS step is not invented).
  The React Preview runtime detects stat numerals itself (leaf, digits only, ≥30px): `runtime/stats.ts` pins the ink (`--pv-black-900`, `--pv-white`
  on a dark surface) against the page's hover/state rules and removes the gradient; `runtime/counters.ts` does the count-up. Both come with the
  template, so a regenerated preview needs no hand-written `scoped.css` override.

## Deterministic judgments — added 2026-10-26

- `deterministicJudgments: true` (config) lets the pipeline answer RV, R3, R5 and C2 from the prompt itself (`src/judgment/deterministic.ts`) instead of
  pausing for a Session Agent: R3 applies every resolved target verbatim as a style edit on the finding's own stamp; R5 reports every finding UNCERTAIN
  (the rendered-preview measurement in R8 is the verdict); RV adds no design decision; C2 leaves ambiguous candidates unmapped. L2/L3 still pause.
- It never invents a design decision, and every answer says it came from this mode. Findings it cannot resolve are listed as unaddressed, not fixed.

## Structural DS rules and user style rules — added 2026-10-27

Both apply to the React Preview generator (`src/preview/structural.ts`, `src/preview/user-style-rules.ts`) and survive `preview --regenerate`. They are listed in
PREVIEW.md ("Rules applied beyond the audit's fixes") so a reviewer can tell them from the audit's fixes. They never change content, links or section order.

- **Arrow links are the DS `CTALink` (DS-first, user instruction 2026-10-27).** A link whose label is "Read/Learn/View/Explore more|all|details" and that carries an
  arrow svg, with **no audit finding mapped to it**, is mounted as `CTALink size="md"` with its original `href` (`onDark` on a dark surface) in the original's slot
  (display, margins, own-content alignment, padding). A mapped link keeps its finding's route (`planIslands`). This closes the case where the audit recorded no
  element-screenshot box, C2 could not map "Read More", and the production markup was left in place.
- **Eyebrow labels lose their decorative icon and take the DS SectionLabel style (user instruction 2026-10-27, "as on the Dealer Voice page").** An eyebrow is a short
  ALL-CAPS label (≤16px, ≤40 characters) whose only sibling in its row is an icon-only svg; "Step NN" labels are excluded (they follow "Step labels"). The icon is dropped, the
  label gets `--brand-red`, `--text-xs`, weight 700, 0.15em tracking, uppercase. Applies to every eyebrow label, not one page.
- **User style rules** — `projects/<project>/user-style-rules.json`, for a page-specific instruction that is not a general rule ("these cards have square corners — only these").
  Each rule: `id`, `section`, `match` (tag and/or class substrings — never "everything"), `style`, optional `descendants` (direct children), and a required `reason` naming who asked
  and what. Values are limited to `0`, `none`, `transparent`, `currentcolor`, `1px` or `var(--design-system-token)`; a malformed file is an error, a rule that matches nothing is
  reported as such. For the properties a rule names, R8 measures the **user's** value instead of the audit's target and says so in the measurement note (`verify.ts`, `targets.ts`),
  and the fidelity comparison records the difference as `intentional` (target `user-style-rule`) — only for the properties the rule names; anything else on that element is still a
  regression. What FOLLOWS from a ruled property is authorized like a target's consequences (2026-10-30, `userConsequence` in `src/fidelity/compare.ts`): a descendant that inherits the
  ruled `color` (same value as the ruled element before and after) and the currentcolor properties that equalled it (`text-decoration-color`, `outline-color`, border colours, an embedding
  shadow or gradient stop) — each checked on the measured values of both sides, so a descendant with its own colour is still compared. The structural eyebrow rule is authorized the same way (`structural:eyebrow`, limited to the label's colour, type, display and width share). The audit and the Fix
  Plan are never edited. Verification and fidelity otherwise apply unchanged.

- **Section spacing is the original's (2026-10-27).** The ancestors of a section are mirrored as `display: contents` wrappers (no box), which silently dropped the vertical padding and margin of a
  section's own container (`py-20`): FAQs lost the 80px above its heading and below its last row and ran into the neighbouring sections. The extractor now reads the vertical padding + margin of
  every ancestor that wraps **only that section** (`outerSpacing`, desktop 1440 and phone 390) and the generator gives it back to the section's host (`global.css`, `max-width: 767px` for the
  phone value). An ancestor shared by several sections gives none (it would be counted twice). A section that was removed from the scope does not leave its spacing behind.

- **Pill badges are the DS `Badge` (DS-first, user instruction 2026-10-27, "as on the Dealer Voice page").** A small translucent (alpha ≤ 0.6) or bordered pill chip (radius ≥ half its height, ≤ 40px high, ≤ 220px wide, ≤ 14px type) holding a 3–30 character label, not inside a link/button and with **no audit finding mapped**, is mounted as `Badge variant="pill" size="sm" theme="neutral"`; on a dark surface `mode="dark"` with the DS image-overlay treatment through the Badge's own `style` prop (`--border-on-dark-card`, `--semantic-ink-on-dark-strong`, blur 8px). Numbers, controls and opaque pills are not badges.
- **Carousel indicators use DS colours (same instruction, 2026-10-27).** A row of 3–12 small empty bars of one size, one of them drawn differently, is an indicator group. The extractor keeps the class tokens that tell the active bar apart, and the generator writes CSS keyed on them (so the colours follow the carousel script): light surface active `--black-900` / rest `--black-300`, dark surface active `--semantic-ink-on-dark-strong` / rest `--semantic-ink-on-dark-faint`; bars are 28px wide, height and shape are kept. The original's purple is not a DS indicator colour.

- **A section that is the same on several pages has the same design on every page (user instruction 2026-10-27).** Two layers: the structural DS rules above are general; a design instruction for a named
  section that is not a general rule goes in the repo-level `user-style-rules.shared.json` (same format as the project file; applies to every project whose page has that section id, and is silent where it has none).
  `projects/<project>/user-style-rules.json` stays for what is true of one page only. An id may not be defined in both. Shared today: Our Resources "Read now" takes the DS on-dark link ink (not purple),
  FAQs have no fill behind or on the question rows, testimonial author name and role take `--text-xs` and `--black-900`, Our Impact's "Read More ↗" is right-aligned (justify-end) as on the original.
  A stat numeral that is a decimal or a multiplier ("1.5x", "4.8%") takes the same neutral ink with no hover gradient (`STAT_NUMERAL` in `runtime/counters.ts`); only digit-only numerals count up. The measured value of a rule-styled property is the rule's value, with `var(--token)` resolved by the browser.

- **Locked for every page, added 2026-10-31 (user instructions from the survey pages, now in the agent so a new project gets them without a chat):**
  - *Text ink `#141016` is the DS ink `--black-900`.* The site's own ink is not a DS colour; shared rule `page-ink-141016-ds-black-900` (`section: "*"` = every section of the page) restyles every `text-[#141016]` element. Descendants that inherit the colour follow it (`userConsequence`). Not covered, reported rather than guessed: `#141016` with alpha (hover text `…/60%`) and `#141016` as a background.
  - *Numbered cards (01–0N) have square corners and their hover overlay too* (`what-sets-us-apart`, `what-makes-our-way-different`; cards `border-[#EDECFB]` + `h-[140px]`) — asked on Brand Perception, CSAT, Employee Engagement and CNDP, so it is a shared rule and no longer a per-project file.
  - *Numbered-card hover group:* while the pointer is on a card the other cards fade to 20% (`templates/react-preview/src/runtime/cardFocus.ts`, mouse only), as on the live site. It is part of the template, so every regenerated preview has it.
  - Shared rules may name `section: "*"`; the project file may not. An element named by several rules keeps all of them (ids joined, styles merged; the CSS keys on `~=`).

- **Unmapped brand-red CTA links are the DS `Button brand` (user instruction 2026-10-27, as on the Dealer Voice page).** A link with no mapped finding that is drawn as a brand-red filled (or red-bordered) box, 30–72px high, holding a 3–60 character label (not a "Read more" arrow link) is mounted as `Button variant="brand" size="md"` with its `href` (`animatedArrow` when it carries an arrow svg), in the original's slot; a right-aligned CTA keeps `margin-left: auto`. The DS Button brings the brand shimmer on hover.
- **A heading finding is only ever a heading.** C2's text-identity pairing refuses to pair a `section-heading` finding with a non-heading element (`tagCompatible`): the same label is often a card's h2, its button and a tab, and "the one free element left" must not take the h2's DS size.
- **Swiper indicator bullets keep their spacing**: 24×3px square bars 8px apart (the live CSS's nested `margin: 0 4px` is lost in the flattened CSS, which merged them into one rail), with the DS colours of the indicator rule above.

## Figma export (exact copy of the React Preview)

Added 2026-10-29. The React Preview stays the deliverable; a Figma file is an optional add-on generated from it, for every page, with one command:

```
pnpm run figma-export projects/<project>/redesigns/<run> [--page "06 Fix Redesign"] [--wrapper "<frame name>"]
```

- It serves the run's built `preview-app/dist`, reads the rendered page (each `[data-pv-section]` scrolled into view), and writes `<run>/figma-export/`: `install.js`,
  `chunks/NN.js`, `assets/` + `assets.json`, `manifest.json`, `FIGMA_EXPORT.md`. About 20 s, no pipeline rerun.
- Fidelity rules: real pictures (not placeholders; SVG pictures rasterised), editable layers with auto-layout where the measured geometry reproduces it, DS Button for
  brand-gradient CTAs, opacity/blur/blend/grayscale/masks (masks as gradient overlays), line-clamp as truncation, scroll-draw SVG paths fully drawn, hidden (sr-only) text skipped.
- The pipeline cannot call Figma: the session runs the generated files through `use_figma` / `upload_assets` (steps in `FIGMA_EXPORT.md`). The builder is stored in the Figma
  file's plugin data (`fra/builder`, `fra/post`, `fra/hashes`), so only the first page of a file installs it and pictures already in the file are not uploaded again.
- Target: the design-system Figma file. Colours bind to `Ken / Colors` (exact hex + alpha only), spacing/radius/font size to the Spacing/Radius/Typography variables when the value is on the scale, text links to the file's text styles when font, size, line height and tracking match exactly, brand CTAs are `Button / Brand` instances. Values that are not tokens stay raw (reported as such), never snapped.
- Fix differences in `scripts/figma-export/` (extract.mjs, tree.mjs, builder.js, post.js), never by hand in Figma. Hover/animation states are not part of the export.
- Pictures that are not an `<img>` are drawn from the rendered page (2026-10-30): a `<video>` becomes the most detailed frame of its clip (the extractor's server answers byte ranges, so Chromium can seek), and a
  tiled `radial-gradient(#fff 1px, transparent 0)` dot pattern becomes a transparent PNG. WebP pictures are sent to Figma as PNG (its plugin API cannot read a WebP's size). Full-bleed pictures stack by
  z-index, a `cover` picture keeps its `object-position`, and the post step keeps every uploaded picture alive in a `fra pictures (<wrapper>)` frame (an unreferenced picture is purged on an in-place rebuild)
  and reports `needUpload` when a stored picture is gone.

- **Colour binding is locked (user, 2026-10-30, applies to every page).** Every Figma colour binds to a `Ken / Colors` token: (1) exact hex + alpha; (2) exact RGB with the paint at partial opacity (token bound, opacity kept); (3) nearest suitable token (dE76 <= 2, same alpha, same role); (4) otherwise the CLOSEST token of the same alpha within dE76 <= 15 (user, 2026-10-30: text may also take the neutral ramps, icons any non-text token), so nothing stays untokenized where a close DS colour exists. A bound paint takes its variable's alpha at the first assignment, so a paint whose alpha no token carries is bound to the CLOSEST full-alpha token (an exact RGB match is dE 0) and its own opacity is set in a SECOND assignment, which sticks (`post.js`, "last tier"); a text colour that is a full-alpha token at partial opacity is shown through the node's opacity. Nothing stays raw where a token within dE 15 exists. `builder.js` and `post.js` (generator version in `prepare.mjs`, 2026-10-30.16) do all three; never bind by hand. Colours with no token in range stay raw and are listed in `figma-export/DS_GAPS.md` with the nearest token and distance; the DS file is never edited. Colours the DS code defines (e.g. `#141016` = `variant-cinematic-bg-navbar`) are kept in `scripts/figma-export/ds-tokens.json`, so every page's `tokens.js` carries them.

- **Font sizes and CTA labels (2026-10-30, builder .16).** Exact DS size variables only: 18px = `button-font-lg`, 11px = `badge-sm-font` (plus the `text-*` scale); 12/32/42px stay unbound (never snapped). A `Button / Brand` label is the CTA's own text, not its frame name (the extractor cuts names at 40 characters with an ellipsis).
- **Scroll-effect state in the export.** The extractor loads the preview with `?scrollfx=live`; a run whose `preview-app` predates that runtime (`scrollEffects.ts` without `scrollfx`) captures a frozen heading 70px low (survey home, section 2: heading hidden under the dashboard picture). Regenerate the preview first (`--reset-budget` only with the user's yes), then export.

- **Scroll runway (user, 2026-10-30).** A pinned/sticky section with thousands of px of blank padding (survey home: Our Differentiators, 8100 px) is built as ONE viewport: `builder.js` (version 2026-10-30.9) drops the runway padding so the section is the pinned block's height. The pinned state is shown; list items that only appear while scrolling stay clipped and are noted in the report.

**Figma target and tokens (standing rule).** The export goes into the run's own *audit* Figma file: `prepare.mjs` reads `figmaFileKey` from the audit project's `project.json`
(via `auditProjectDir`) and writes it into `figma-export/manifest.json` and `FIGMA_EXPORT.md`; if it is missing the session asks the user for the link. The page is always named
**`Fix & redesign page`**. Never build inside the Design System file (`1Vb8PFA1diOTDD3HT43peS`; read-only reference). Because the Ken DS is not a library in the audit files, step 0 of
`FIGMA_EXPORT.md` (`figma-export/tokens.js`, from `scripts/figma-export/ds-tokens.json`) recreates its variables, text styles and `Button / Brand` there before the install/chunks.
Design never changes for tokens: bind only on an exact match. Paste chunks verbatim and compare the result with the preview before reporting.
