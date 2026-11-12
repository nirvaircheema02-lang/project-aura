import type { AiMode } from '../llm/provider.ts';
import type { RenderingPolicy } from '../t-layer/browser.ts';

/**
 * policy_version (§2.2): the snapshot of everything that shapes a finding
 * OTHER than the page and the Design System — the S8 confidence bands, the
 * audit ENGINE's behaviour revision, and the exact rendering engine. Built in
 * exactly one place: it used to be four copies of a template string, which
 * could drift apart silently.
 *
 * The browser part is the exact build, not the channel name. Two runs on
 * different Chromium builds carry different policy versions, so a rendering
 * change is visible as a policy change instead of passing for a REGRESSION.
 * The execution mode is part of it for the same reason: a deterministic
 * no-api result and a model-backed one are different baselines.
 */

export const S8_POLICY_TAG = 's8-bands-0.85/0.5';

/**
 * The behaviour revision of the audit ENGINE: what B1 (section bounds), B2 (detection), B3 (DS
 * matching), B4 (compliance rules), B5 (completeness verification), B6 and B7 (final coverage) decide for the SAME page
 * and the SAME Design System. It is part of `policyVersion`, and the policy version is what
 * (1) stops a full-site run reusing findings an older engine produced — the §4.4 memoization in
 * page-graph.ts copies a page's previous findings only when its DOM, the DS registry AND the policy
 * are all unchanged — and (2) makes S7 call a changed comparison a BASELINE CHANGE instead of a
 * regression or a resolution.
 *
 * Bump it with ANY change to what those nodes detect, match, compare or report — a new rule, a new
 * detection shape, a sampling or exclusion policy, a different expected value — and add a line to
 * `ENGINE_REVISION_LOG`. The guard test (test/unit/engine-revision.test.ts) fingerprints
 * `ENGINE_SOURCE_FILES` and fails until the revision, its log line and the pinned fingerprint
 * agree, so a behaviour change cannot ship without invalidating stale reused findings. Comments
 * and formatting do not move the fingerprint; a pure refactor needs it re-pinned only.
 */
export const AUDIT_ENGINE_REVISION = 12;

/** What each engine revision changed — one line per bump, newest last. The current revision MUST have an entry. */
export const ENGINE_REVISION_LOG: Readonly<Record<number, string>> = {
  1: 'B1 adopts content a section owns but renders outside its own y-range (a sticky scroll stage’s overflowing list) and tells B2 which refs; B2 detects non-interactive badges, samples only real listings (≥ 12 repeated members or a B1-flagged listing) and reports the refs it decided on; B3 picks a heading level by nearest rendered size and keeps component identity ahead of compliance; B4 adds the R1.2 decorative-colour, R3.5 spacing and nearest-step R1.3/R3.6 checks with exact-variant precedence; B5 verifies completeness (repeated non-interactive cards) without re-capturing what B2 declined and counts only true failures.',
  2: 'An element B5 recovers takes the same path as a first-pass one — B2 classifies it (a repeated block is a card only with a visible surface), B3 searches the DS family for its type (the rule\'s files, then the rest of the family: Badge/Tag/Chip/Pill/Label/Status, the other R4.4 cards) and records the search, then B4 audits it against that component\'s full contract or, only when no family exists, B6 evaluates it; a structural type (a bordered/filled text leaf, a surfaced repeated block) may claim its family at LOW confidence, so a badge is an existing Badge with deviations, not a B6 new component, and R1.2\'s brand-red prohibition stands for such a match; B5 verifies B3\'s recorded search and B4\'s contract coverage in at most 2 passes and marks whatever stays unresolved NEEDS_REVIEW.',
  3: 'Body text and stat numerals are audited: B2 offers a plain paragraph or text leaf (not inside a heading or control) as a candidate and types a bare display-size numeral `stat`, otherwise `paragraph`; B3 answers both as foundation-only (the DS has no family for them) so they never reach B6; B4 checks their colour against the DS palette (R1.1), brand red as text or a gradient numeral (R1.2), type scale and typeface, and records the verified properties so a clean text element is a MATCH; background-clip is now extracted so gradient-clipped numerals are read by their real ink.',
  4: 'Heading role is decided from the section\'s whole text hierarchy before any DS component is chosen, never from the h1–h3 tag: B2 builds each section\'s TypeContext (dominant text, document order) and classifies a small, short, upper-case/tracked text before the dominant text as an eyebrow (supporting heading), promotes the dominant display-size text — even a `<p>` — to the main section heading, and treats body-sized regular-weight heading-tagged copy beside it as a description (paragraph); B3 matches an eyebrow to the DS eyebrow family (OverheadText / SectionLabel) ignoring its heading tag, pins the Ken-red text treatment on light surfaces and the DS inverse treatment (SectionLabel, never OverheadText) on dark, and gives a promoted main heading its SectionHeading size by nearest rendered size only; B4 no longer cites R1.2 for a brand-red eyebrow written as a heading.',
  5: 'B7 — Final Audit Coverage & QA — joins the page graph after B6. It builds an INDEPENDENT manifest of the rendered page (DOM, accessibility tree, visible text, computed style, geometry, interaction state), puts every meaningful item in exactly ONE state (audited / excluded with a stated reason / needs review / capture failed), checks that each audited item was audited under the right ROLE (B2\'s own classifier over the complete section hierarchy), routes every gap to the stage that owns it (missing element → B2, wrong role → B2/B3, wrong family → B3, missed property → B4, no family → B6, content behind a hover / tab / disclosure / carousel → a targeted reveal, then the normal flow) in at most 2 corrective passes, settles what is still open as NEEDS_REVIEW, and publishes a Coverage Gate that passes only when nothing is unaccounted; B2 records the reason behind every ref it declines to audit; and the approved Project Aura reference catalog is consulted — after the DS family search, never before — for a role the DS cannot represent: a consistent pattern is a reference-backed DS candidate (B6), an ambiguous one is NEEDS_REVIEW; and a main heading promoted by its role from a non-heading element (a display-size <p>) is described by the tag it really has — never by the h2 slot the size match used as a tie-break proxy.',
  6: 'The approved-reference catalog reads its Competition Benchmarking evidence from the APPROVED page, competition-benchmarking-v2-react (confirmed by the design lead; served at http://localhost:3095), instead of competition-benchmarking-v3: the section eyebrow (12px / 600 / 2.4px, Ken red) and the description under a heading (16px / 400 / 1.65) now carry that page\'s measured values, so the verdict a role the DS cannot represent is assessed against changes.',
  7: 'B7\'s recovery is a LOOP, not a report: while anything is unaccounted, exactly those items go back through the stage that owns them (B2 → B3 → B4 | B6, a role fix, a layer reveal), the manifest is REBUILT and reconciled again, and B7 checks again — until nothing is unaccounted. It ends by convergence, never by hope: an item gets two attempts and is then settled into an explicit, reasoned state (excluded · needs review · capture failed — recorded in the Coverage ledger, with no stub findings), a round that changes nothing (twice) ends the loop, and count / time / capture limits stop a pathological page (only an item B7 never got to examine stays unaccounted, and the gate then fails). Cheap recoveries run before expensive reveals, and a hover layer is revealed ONCE (its trigger, a control inside it, its parent, keyboard focus) with every member captured while it is open — the per-item host marker used to overwrite itself, so only the last item of each menu had a valid selector and the rest timed out. An audited element whose DOM stamp the page erased is still accounted for by its words and place (a MATCH included) and is never re-audited, so recovery cannot duplicate a finding; later rounds re-verify only what they touched.',
  8: 'B7 attributes a recovered or dynamic item to its TRUE owning section and writes ONE finding per physical element. Section ownership is decided from the page\'s structure, never from where a box sits when it is read: the section the audit already holds the element in, the section B1 adopted it into, the B1 section root whose DOM subtree holds it (section roots are now stamped in the DOM), the owner of the control that reveals it, its Header / Footer / Navigation region — geometry only for an item in the normal flow — and an overlay nothing owns is listed under "(outside any section)" with a review note instead of being filed under whichever section happened to lie beneath it (a header mega-menu revealed over the hero is the Header\'s); the owner is revalidated from the live element right before a recovered finding is written. Element identity is the canonical DOM path + DOM role + normalised words + section (with geometry and liveness to tell genuine look-alikes apart): B7\'s twin lookup also finds an element the page moved or re-rendered by that identity, a recovered finding is reconciled against the findings the audit already holds before it is kept, and a final validation merges any two findings of one canonical element into the earlier one (its finding id and history), keeping the strongest valid classification and the evidence of both.',
  9: 'Global chrome is identified BEFORE the page\'s own sections: B7 resolves every item to a structural region — Global Header, Page Content or Global Footer. An element inside the page\'s own banner (a top-level <header> / role=banner) or contentinfo landmark, or revealed by a control that is, belongs to the Global Header / Global Footer section before any other ownership rule is consulted (a <header> of an article or section is not one), so the hero owns only what sits in the page-content hero\'s own subtree — a header mega-menu, search overlay or account menu rendered over the hero, or portalled outside the header, is never the hero\'s; geometry stays a fallback for normal-flow content only, and an overlay no structure owns is "(outside any section)" with a review note. A first-pass finding whose element sits in the banner / contentinfo landmark is moved to the Global Header / Global Footer section. Each section and finding carries its region (location.region), and a Global Header finding its sub-group (location.group): Base Navigation, one "<Trigger label> Menu" per menu (named by the control that opens it), Search, Account/User Menu.',
  10: 'Typography is judged ROLE-FIRST and against the DS\'s own scale. (1) R1.3\'s accepted sizes are the DS Major Third steps (--text-xs … --text-5xl: 12.8 / 16 / 20 / 25 / 31.25 / 39 / 48.8 / 61 / 76.3) plus the exceptions R1.3\'s own "WHEN NOT" names (--text-compact 14, --text-nav 14, --text-2xs 11, --text-card-micro 10), read from the DS rule text — text-size tokens are now CLASSIFIED (scale · documented exception · legacy remap · component-specific · alias) and only the first two are valid text sizes: --text-md 18, --text-13/24/30/32/48 and --text-nav-helper (the "V0.2 remap" tokens), --button-font-* / --badge-*-font / --text-paywall-* / --text-eyebrow … (component tokens) and --typography-size-* aliases (--typography-size-2xs is 11px in FOUNDATIONS but a 12px CSS fallback in utilities.css) no longer make an off-scale size pass, and the R1.3 finding names the legacy / component token a size equals. (2) B2 decides two more ROLES from the section before any DS rule is chosen — `card-title` (a title over a smaller description whose pattern repeats across the section\'s cards, 16–26px, heavier than body copy or heading-tagged: judged by the DS card-title contract R4.3.5 + R1.4 — --text-base 20px with 4+ cards / --text-lg 25px with 2–3, DM Sans 500) and `label` (a short heading-tagged text below the DS heading range — H3 starts at 25px — that is no eyebrow, description or card title: audited on the foundation rules like body text, never forced into SectionHeading by its tag); B7\'s independent role check reads both. (3) A clean text element says FOUNDATION checks passed, not "matches the Design System": additive comparison.basis (`foundation-only` | `ds-component`), the property table lists each verified property as a verified MATCH with the DS value it was verified against (never "Not verified" beside "3 passed"), and the recommendation / evidence line state that no component was compared.',
  11: 'FAQ questions and clickable UI labels are judged by their own contract, never forced into SectionHeading (whose nearest size is 25px+). B2: a clickable heading phrased as a question, below the DS heading range, is the new role `question` (typed paragraph) and a short clickable heading below that range is a `label`; both are found from role evidence together (clickable + phrasing + size), never the tag alone, and a clickable heading at display size keeps the LOW-confidence section-heading doubt path. B4: a `question` is compared against the DS AccordionItem question (--text-sm 16px, weight 500) instead of the generic scale — accepted sizes are 16px and the documented 14px compact-text exception, anything else gets one recommendation to the nearest accepted size (18px → 16px), never 31.25px; a `label` is audited on the foundation rules like body text. B7\'s independent role check names both roles.',
  12: 'The FAQ `question` role is limited to FAQ size (≤ 18px). A clickable heading phrased as a question at 20px or more is an article / card title (the DS card-title range), not an accordion question — related-article titles ("How Taxi Revolution of Al Fujairah Is Transforming…?", 20px/600) were being told to become a 16px AccordionItem question. No other rule changed.',
};

/**
 * The sources whose behaviour decides what an audit reports for a given page and Design System:
 * every file of the stages that detect, match, compare, verify and account (B1–B7), plus the shared
 * helpers they call to decide a value or its wording. Paths are relative to the repository root.
 * The guard test fingerprints exactly these files, and fails if a file is added to a stage
 * directory without being listed here. Deliberately NOT listed: page capture and rendering
 * (a change there changes the captured DOM, and the DOM hash already invalidates reuse), the
 * Design System readers (the DS registry version covers the DS itself), and orchestration
 * (graph, gates, state) — none of those decides what a finding says.
 */
export const ENGINE_SOURCE_FILES: readonly string[] = [
  'src/agents/b1-page-analyzer/deterministic.ts',
  'src/agents/b1-page-analyzer/index.ts',
  'src/agents/b2-component-detector/deterministic.ts',
  'src/agents/b2-component-detector/index.ts',
  'src/agents/b3-ds-matcher/deterministic.ts',
  'src/agents/b3-ds-matcher/index.ts',
  'src/agents/b4-compliance-auditor/foundation-rules.ts',
  'src/agents/b4-compliance-auditor/index.ts',
  'src/agents/b5-visual-verifier/completeness.ts',
  'src/agents/b5-visual-verifier/index.ts',
  'src/agents/b6-new-component-evaluator/evaluate.ts',
  'src/agents/b6-new-component-evaluator/index.ts',
  'src/agents/b6-new-component-evaluator/post-fix-opportunity.ts',
  'src/skills/nearest-typography.ts',
  'src/skills/s3-component-taxonomy.ts',
  'src/skills/s5-compliance-classification.ts',
  'src/skills/s8-confidence-escalation-policy.ts',
  'src/skills/contextual-recommendations.ts',
  'src/t-layer/element-registry.ts',
  'src/t-layer/section-label.ts',
  'src/t-layer/token-comparator.ts',
  'src/t-layer/dom-facts.ts',
  'src/t-layer/computed-style.ts',
  'src/ds/component-styles.ts',
  'src/ds/context-models.ts',
  // B7 and the approved-reference lookup (Decision Log #45 / #46): behaviour, and the evidence it reads.
  'src/agents/b3-ds-matcher/reference.ts',
  'src/agents/b7-coverage-qa/index.ts',
  'src/agents/b7-coverage-qa/manifest.ts',
  'src/agents/b7-coverage-qa/reconcile.ts',
  'src/agents/b7-coverage-qa/ownership.ts',
  'src/agents/b7-coverage-qa/identity.ts',
  'src/agents/b7-coverage-qa/regions.ts',
  'src/agents/b7-coverage-qa/correct.ts',
  'src/agents/b7-coverage-qa/ledger.ts',
  'src/agents/b7-coverage-qa/states.ts',
  'src/ds/reference-patterns.ts',
  'reference/approved-reference-patterns.json',
];

/** `revision` defaults to the engine's current one; it is a parameter only so tests can build an OLDER engine's policy string. */
export function policyVersionFor(rendering: RenderingPolicy, aiMode: AiMode, revision: number = AUDIT_ENGINE_REVISION): string {
  return `${S8_POLICY_TAG}+recommendations-context-v2+engine-r${revision}+ai-${aiMode}+browser-${rendering.channel}@${rendering.browserVersion}+playwright@${rendering.playwrightVersion}`;
}

/** Human-readable engine line for reports: "Playwright Chromium 141.0.7390.37 (channel chromium, Playwright 1.63.0)". */
export function describeRenderingEngine(rendering: RenderingPolicy): string {
  return `Playwright Chromium ${rendering.browserVersion} (channel ${rendering.channel}, Playwright ${rendering.playwrightVersion})`;
}
