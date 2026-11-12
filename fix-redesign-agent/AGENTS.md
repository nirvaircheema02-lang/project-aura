# Project instructions

Work only in fix-redesign-agent unless the user explicitly expands the scope.
Before planning, generating, editing or reviewing a redesign, read and follow
[docs/REDESIGN_RULES.md](docs/REDESIGN_RULES.md). These are persistent user instructions
for every page and every run, including the generated React previews and any hand-authored preview overrides.
An explicit later user instruction may revise them; audit recommendations and model
preferences do not override them. Do not claim a new page is verified until it has
actually been checked.

For Fix JSON review, page fixes or previews, load the project-local
[fix-redesign skill](.claude/skills/fix-redesign/SKILL.md), even if it is not shown in
the session's installed-skills catalog. For selected NEEDS_REVIEW/UNVERIFIED findings
or missing design prescriptions, follow its Design Review Resolver reference. Make
routine DS choices autonomously within the user's scope; suggestion-only requests
remain read-only. The Resolver is an executable pipeline stage (node RV, before R3) whose targets
(`context/resolved-targets.json`) R3, R4, R5 and R8 all consume; the skill reference describes how a
session answers its residual design questions. It is not a component-building agent (those stay disabled).

Startup input is `Run ID/Name + Mode` (Full Page | Selected Sections); resolve everything else
automatically. The default deliverable of every run is the generated, verified React Preview
(runnable source + localhost URL, pipeline nodes B1/R8) — never hand-build one per run and never
substitute static HTML. Claim a finding fixed only when `preview/verification.json` measured it;
report unresolved and not-reproduced items. G2 is the user's decision. Component creation and
publishing are out of scope.

Before G2 the pipeline also measures every resolved target in the rendered preview, compares design,
hover/focus, composition, alignment and sticky behaviour with the immutable baseline of the original, and
runs ONE bounded correction loop (`fidelity.*` budget). Report what is still open; never mark a check
passed that was not run. Reference projects come only from `references/approved-projects.json`.
Verification vocabulary (applies to every report you write): each check is *verified*, *failed* or
*unverified* — never merge them. An `incomplete` fidelity verdict, a `failed` or `unverified` preserve
decision and any `required.open` entry are open required checks, never a pass. A rendered-preview failure
reopens the finding in R3 even when R5 measured it fixed. A reference's colours are mapped to exact or
nearest-suitable DS tokens (never used raw, never a raw-colour "proposed variant"); reference components are
matched by purpose, not by tag or role. See docs/REDESIGN_RULES.md and docs/ARCHITECTURE.md §8d.6.
Typography/colour rules the user set apply to every page automatically (details in docs/REDESIGN_RULES.md): "Step NN" labels are not upper-cased and stay small
(2xs); stat numerals use the DS type-scale step and the neutral ink `--black-900` — never brand red, no hover colour change or gradient — and count up once when
scrolled into view (reduced motion shows the final value). The Resolver derives these targets and the preview runtime applies them; never add a per-run CSS
override for them. Brand red is for CTAs only; CTAs use `Button` `brand`, never `primary`.
Structural rules (docs/REDESIGN_RULES.md "Structural DS rules"): an unmapped "Read More ↗" arrow link is the DS `CTALink`; an eyebrow label drops its decorative icon and takes the DS
SectionLabel style. A page-specific user instruction (e.g. "these cards: square corners") goes in `projects/<project>/user-style-rules.json`, never in a hand-edited preview. A section that is the same on several pages (Our Resources, FAQs, testimonials…) has the same design on every page: put its rule in the repo-level `user-style-rules.shared.json`.
The preview's overall status is PASS, FAIL or INCOMPLETE (never PASS with a required check unverified); report it verbatim. The correction budget is one persisted allowance per run and plan, shared by resume and `preview --regenerate`; never bypass it or reset it without the explicit `--reset-budget` and the user's say-so. See docs/REDESIGN_RULES.md and docs/ARCHITECTURE.md §8d.7.

Locked for every page (docs/REDESIGN_RULES.md, "Locked for every page"): text ink `#141016` becomes `--black-900`; the numbered 01–0N cards have square corners and the other cards fade to 20% while one is hovered. They live in `user-style-rules.shared.json` (`section: "*"` = every section) and `runtime/cardFocus.ts` — never as a per-project file or a hand-edited preview.
