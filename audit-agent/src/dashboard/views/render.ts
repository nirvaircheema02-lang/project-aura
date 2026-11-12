import type { AuditData } from '../../agents/c2-json-writer/index.ts';
import { coverageLine } from '../../agents/b7-coverage-qa/ledger.ts';
import { computePostFixOpportunities } from '../../agents/b6-new-component-evaluator/post-fix-opportunity.ts';
import { describeRenderingEngine } from '../../graph/run-metadata.ts';
import { FINDING_STATUSES, findingStatus, reAuditLabel, statusLabel, type Finding } from '../../skills/s0-result-contract.ts';
import { FIX_PLAN_DECISIONS, type FixPlan, type FixPlanDecision } from '../../output/fix-plan.ts';
import type { EvidenceImageInfo, EvidenceInspector } from '../../output/evidence-image.ts';
import { expectedForDisplay, pageRoots, recommendationForDisplay, withResolvedPx } from '../../output/display-values.ts';
import { inReadingOrder } from '../../output/reading-order.ts';
import { BASE_NAVIGATION, REGION_LABEL, headerGroupRank } from '../../agents/b7-coverage-qa/regions.ts';

/**
 * Server-rendered views for the C4 Local Audit Dashboard (ARCHITECTURE.md §6,
 * IMPLEMENTATION-PLAN.md §11). Every number rendered here comes straight from
 * C2's audit data — this file computes NO aggregates of its own, which is what
 * makes the C4↔C2 parity test meaningful rather than circular.
 */

/**
 * The pinned, versioned HTML/dashboard template contract — the counterpart to
 * `FIGMA_CONTRACT_VERSION` (src/figma/prompt-contract.ts). `renderRun` (the standalone
 * report, src/agents/c1-html-reporter/index.ts) and the live dashboard share this ONE
 * template; nothing about layout, palette, cards, filters, or evidence handling should
 * ever be re-derived per run or re-invented in a future session — it's locked here.
 *
 * BUMP THE VERSION whenever what the template DRAWS changes — a new section, a different
 * card layout, a new status color, or the format it prints a value in (the `2.441rem
 * (39.06px)` rule, src/output/display-values.ts) — never for a data change, which is what
 * every future audit is expected to vary. If a rendered report could differ for the same
 * data.json, the stamp must differ too. Stamped into every rendered page as an HTML comment
 * (`layout()` below) so a shared file can always be traced back to the template version
 * that produced it.
 */
export const HTML_TEMPLATE_VERSION = 'html-report-v19'; // v19: findings are listed in READING ORDER inside each section and each Global Header / Global Footer sub-group — top to bottom, left to right along one visual row, an enclosing card before what it contains (src/output/reading-order.ts, from the page-absolute evidence box the audit already stored) — instead of in detection order (which read 02, 01, 03 …). Display only: data.json, ids, statuses, counts, the Fix Plan and the Figma plan are unchanged. v18: a finding's detail shows its MATCH BASIS — `Foundation checks only` (no DS component applies: body text, a card title, a label, supporting copy; a MATCH there means no foundation issue, never a component match) or `DS component compared` — read from the additive comparison.basis (engine r10); a run without it shows nothing new. Report-layer only. v17: the Findings view gains a little vertical separation between SECTIONS — 10px of space before each new section header (never between finding rows, never before a sub-group header, never before the first section), section headers 10px tall in padding (sub-group headers keep 8px); a filtered-out Global Header / Global Footer button now actually hides (a button's own display no longer overrides [hidden]). CSS only: grouping, the accordion, filters, sorting and the Fix Plan are untouched. v16: the Global Header / Global Footer accordion's chevron moved from the left of the row to its FAR RIGHT, vertically centred — Lucide's chevron-right when collapsed, chevron-down when expanded (drawn inline, no icon library), label and counts left-aligned. Visual only: the whole row is still the one `<button aria-expanded>` target, the keyboard behaviour, the toggle / filter script, the Fix Plan and every other section are untouched, and both surfaces (the HTML report and the live Dashboard) draw it from this one template. v15: the Global Header and the Global Footer are ACCORDIONS in the Findings view — collapsed by default, each opened and closed by a disclosure <button aria-expanded> (the region's own header row); the Global Header keeps its sub-groups inside it; the hero and every other page section are drawn exactly as before; a filter or search that lands on a global region's findings opens it. Collapse is the attribute `data-gr-collapsed` (never the `hidden` the filters own), so filtering, sorting, the Fix Plan, data-section / data-group and the Details toggle are untouched. Report-layer only: data.json, ownership and every audit stage are unchanged. v14: findings are grouped by STRUCTURAL REGION — the site header is shown as `Global Header` with its sub-groups (Base Navigation · one group per menu · Search · Account/User Menu), the footer as `Global Footer`, and the page's own sections (the hero included) follow, owning only what is in their own subtree (B7 ownership, engine r9); a run that predates r9 carries no region and is grouped exactly as before. Report-layer only: it reads each finding's location.region / location.group and each section's region, and changes nothing the audit stored. v13: the Coverage Gate is COMPACT — the Summary shows only `Coverage: PASSED · N discovered · N accounted · 0 unaccounted` (or `INCOMPLETE · N discovered · R remaining`) and the whole ledger — the six numbers, recovery passes / recovered items, every exclusion, review, failure and remaining item with its reason — sits in a COLLAPSED `Coverage details` accordion. v12: the Summary shows B7's Coverage Gate (Decision Log #45); the Summary shows B7's Coverage Gate (Decision Log #45) — PASSED or INCOMPLETE with the six numbers it is made of (discovered · audited · excluded with reason · needs review · capture failed · unaccounted), exactly which items are unaccounted when it does not pass, and the ledger behind it (per kind, every exclusion grouped by its stated reason, every needs-review and capture-failed item, B7's corrective actions); a run that predates B7 says so instead of implying a pass. Report-layer only: it reads data.json's coverageSummary.gate and the per-page coverage ledgers and changes nothing the audit stored. v11: an Expected typography value stored in rem is shown with its resolved px beside it (`2.441rem (39.06px)`) everywhere the report quotes one — the compact summary, the detail Expected field, the property comparison table and the recommendation / note views — the px being the rem length × THAT page's MEASURED root font size (data.json pageSummary[].rootFontSizePx, recorded at capture; the browser default only for a run that recorded none). Display formatting only (src/output/display-values.ts, shared with the Figma plan and the Excel report): data.json, DS values, matching, status and the stored recommendation text are unchanged, and a non-typography rem (padding, radius) is shown as before. v10: evidence screenshots that look blank are fixed at the report layer — an element crop that is one flat colour (an element hidden until hover/interaction) falls back to its context shot with an honest note instead of showing an empty box, and compact thumbnails show the region that actually has content (ink bounding box, contain-fit, leading portion of a long strip) instead of a centre-crop that is empty for left-aligned text; both read from the pixels (src/output/evidence-image.ts), never from a new capture or a data.json change. v9: remove the duplicate review list; all findings remain in their section-wise rows. v8: independent property readings, explicit unresolved/candidate values and deduplicated recommendations. v7: section IDs, page-order labels/counts and zero-finding sections share the canonical section inventory. v6: a small "×" inside the "✓ Added" badge unstages a mistakenly-added New Component candidate — deletes it from ncpStaged only (never touches selection/checkbox state), so the count drops, the badge/row highlight clear via the same ncpPaintStaged() repaint, and the candidate can be selected and added again. Fix Plan untouched. v5: New Components UI refinements — .ncp-bar becomes sticky (top:0, same slot as .fp-bar), handed off cleanly because .fp-bar's sticky containing block is now .fp-scope (Summary…Pages), which ends exactly where the New Components section begins, so the two never stack; candidate rows become compact expandable .ncp-row cards (mirroring .frow) with a thumbnail (reused evidence, click-to-enlarge via the same <a target=_blank> idiom as .rv-shot — never a new capture, never a new image system) and an instance count shown for every candidate; staging a candidate now paints a persistent "✓ Added" badge + left-border on its row (data-staged), separate from the temporary checkbox selection that still clears after every Add — dedup is unchanged (Map.set by findingId, already idempotent). v4: adds Post-Fix Component Opportunity rows to the existing "New components & DS candidates" section — a repeated, unmatched pattern whose only blocker is a known, measured foundation-rule violation is surfaced as "Potential — after fixes", dashed-pill distinct from a real current-state candidate, selectable ONLY through the existing New Component checkbox/export system (never the Fix Plan). B6's own current-state classification is unchanged; this is a render-time inference over already-persisted findings, never a data.json change. v3: the Findings table becomes a compact, section-grouped list of expandable .frow cards (checkbox/decision/severity/status/name/DS component/short summary/thumbnail/expand — full property/actual/expected/confidence/review/re-audit/recommendation/evidence moved into a collapsible detail, never removed) with a simplified sort control (Severity/Status/Confidence) replacing per-column header clicks, richer section-group headers (counts + Incorrect/Review/Fix breakdown), and a separate New Component Plan area with its own "Add New Component" action. v2 added the Fix Plan review layer — per-finding checkboxes, multi-select, Mark as Fix/Skip/Keep for Review, Clear Decision, and a client-side "Export Fix Plan" download. v1 was the initial locked baseline — summary cards, sortable/filterable findings + review tables, standalone data:-URI evidence, the 5-color STATUS_COLORS palette (Unverified corrected to a genuinely distinct gray, not amber+dashed)


/**
 * B7's Coverage Gate for the Summary — COMPACT. The Summary carries one short line and nothing else:
 *
 *     Coverage: PASSED · 473 discovered · 473 accounted · 0 unaccounted
 *     Coverage: INCOMPLETE · 473 discovered · 227 remaining          (B7's loop stopped with items still unaccounted)
 *
 * (`RECHECKING` is the live state — the CLI prints it while B7 re-audits what it found missing; a finished report
 * is PASSED or INCOMPLETE.) Everything behind the line lives in a COLLAPSED `Coverage details` accordion: the
 * numbers the gate is made of, the recovery passes and what was recovered, and — each in its own collapsed list —
 * every exclusion with its reason, every item needing review, every capture failure and every item still
 * unaccounted. Reads `coverageSummary.gate` and each page's `coverage[].ledger` — never computes a number of its
 * own. A run that predates B7 says so.
 */
function coverageGateHtml(data: AuditData): string {
  const gate = data.coverageSummary?.gate;
  if (!gate) return '<p class="muted" style="font-size:13px">Coverage: not recorded — this audit predates the B7 final coverage check, so it makes no claim that every item on the page was accounted for.</p>';
  const ledgers = (data.coverage ?? []).map((c, i) => ({ ledger: c.ledger, url: data.pageSummary[i]?.url ?? '' })).filter((x): x is { ledger: NonNullable<typeof x.ledger>; url: string } => x.ledger !== undefined);
  const multi = data.pageSummary.length > 1;
  const where = (url: string) => (multi ? ` <span class="muted">(${escapeHtml(url)})</span>` : '');

  const [head = '', ...tail] = coverageLine(gate, gate.passed ? 'PASSED' : 'INCOMPLETE').split(' · ');
  const line = `<span class="gate-line"><span class="gate-state">${escapeHtml(head)}</span>${tail.length ? ` · ${escapeHtml(tail.join(' · '))}` : ''}</span>`;

  const item = (i: { kind: string; label: string; section: string; reason: string; findingId?: string }, url: string) =>
    `<li><b>${escapeHtml(i.kind)}</b> “${escapeHtml(i.label)}” — ${escapeHtml(i.section)}${where(url)}${i.findingId ? ` <span class="mono muted">finding ${escapeHtml(i.findingId.slice(0, 8))}</span>` : ''}<br><span class="muted">${escapeHtml(i.reason)}</span></li>`;
  /** A long per-item list: its own collapsed accordion, closed by default, absent when empty. */
  const list = (title: string, rows: string[]) => (rows.length ? `<details class="gate-list"><summary>${escapeHtml(title)} (${rows.length})</summary><ul>${rows.join('')}</ul></details>` : '');
  const listOf = (pick: (l: (typeof ledgers)[number]['ledger']) => Array<{ kind: string; label: string; section: string; reason: string; findingId?: string }>) => ledgers.flatMap((l) => pick(l.ledger).map((i) => item(i, l.url)));

  const excluded = new Map<string, { count: number; examples: string[] }>();
  for (const l of ledgers) for (const e of l.ledger.excludedByReason) {
    const g = excluded.get(e.reason) ?? { count: 0, examples: [] };
    g.count += e.count;
    for (const x of e.examples) if (g.examples.length < 4) g.examples.push(x);
    excluded.set(e.reason, g);
  }
  const excludedRows = [...excluded.entries()].sort((a, b) => b[1].count - a[1].count).map(([reason, e]) => `<li>${e.count} × ${escapeHtml(reason)}<br><span class="muted">e.g. ${e.examples.map((x) => `“${escapeHtml(x)}”`).join(', ')}</span></li>`);
  const remainingRows = gate.incomplete.flatMap((p) => p.unaccounted.map((i) => item(i, p.pageUrl)));
  if (gate.pagesWithoutLedger > 0) remainingRows.push(`<li>${gate.pagesWithoutLedger} page(s) carry no coverage ledger — an audit that predates B7, or one B7 did not complete: nothing on them is claimed accounted for.</li>`);

  const kinds = new Map<string, { discovered: number; audited: number; excluded: number; needsReview: number; captureFailed: number; unaccounted: number }>();
  for (const l of ledgers) for (const [kind, row] of Object.entries(l.ledger.byKind)) {
    const k = kinds.get(kind) ?? { discovered: 0, audited: 0, excluded: 0, needsReview: 0, captureFailed: 0, unaccounted: 0 };
    for (const key of Object.keys(k) as Array<keyof typeof k>) k[key] += row[key];
    kinds.set(kind, k);
  }
  const roles = ledgers.reduce((n, l) => ({ checked: n.checked + l.ledger.roleChecks.checked, inconsistent: n.inconsistent + l.ledger.roleChecks.inconsistent, corrected: n.corrected + l.ledger.roleChecks.corrected, unresolved: n.unresolved + l.ledger.roleChecks.unresolved }), { checked: 0, inconsistent: 0, corrected: 0, unresolved: 0 });
  const recoveries = ledgers.map((l) => l.ledger.recovery).filter((r): r is NonNullable<typeof r> => r !== undefined);
  const recorded = ledgers.length > 0 && recoveries.length === ledgers.length;
  const sum = (pick: (r: NonNullable<(typeof recoveries)[number]>) => number) => recoveries.reduce((n, r) => n + pick(r), 0);
  const stop = [...new Set(recoveries.map((r) => r.stopped))].filter((x) => x !== 'not-needed');
  const actions = ledgers.flatMap((l) => l.ledger.actions);
  const notes = ledgers.flatMap((l) => l.ledger.notes.map((n) => `${escapeHtml(n)}${where(l.url)}`));
  const num = (label: string, value: string | number) => `<div><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;

  const details = `<details class="gate-details"><summary>Coverage details</summary>
    <div class="gate-grid">${num('discovered', gate.discovered)}${num('audited', gate.audited)}${num('excluded with reason', gate.excluded)}${num('needs review', gate.needsReview)}${num('capture failed', gate.captureFailed)}${num('unaccounted', gate.unaccounted)}</div>
    <div class="gate-grid">${num('recovery passes', recorded ? sum((r) => r.passes) : ledgers.reduce((n, l) => n + l.ledger.passes, 0))}${num('recovered items', recorded ? sum((r) => r.recovered) : 'not recorded')}${num('settled with a reason', recorded ? sum((r) => r.settled) : 'not recorded')}${num('remaining', gate.unaccounted)}</div>
    <p class="muted" style="margin:4px 0 0">Every unaccounted item goes back through B2 → B3 → B4 / B6 (a reveal first, for content only an interaction shows), the manifest is rebuilt and checked again — until nothing is unaccounted or no further round can change anything; an item that cannot be audited after two attempts is settled into an explicit state with its reason.${recorded && stop.length ? ` It stopped: ${escapeHtml(stop.map((x) => ({ complete: 'everything recovered or settled', converged: 'no further progress was possible', limit: 'at its safety limit' })[x] ?? x).join('; '))}.` : ''} Independent evidence: ${escapeHtml([...new Set(ledgers.flatMap((l) => l.ledger.sources))].join(' · ') || 'none')}. Role check (was each item audited under the right role?): ${roles.checked} checked · ${roles.inconsistent} inconsistent · ${roles.corrected} corrected · ${roles.unresolved} unresolved.</p>
    ${kinds.size ? `<table><thead><tr><th>Kind</th><th>Discovered</th><th>Audited</th><th>Excluded</th><th>Needs review</th><th>Capture failed</th><th>Unaccounted</th></tr></thead><tbody>${[...kinds.entries()].map(([k, r]) => `<tr><td>${escapeHtml(k)}</td><td>${r.discovered}</td><td>${r.audited}</td><td>${r.excluded}</td><td>${r.needsReview}</td><td>${r.captureFailed}</td><td>${r.unaccounted}</td></tr>`).join('')}</tbody></table>` : ''}
    ${list('Remaining items (still unaccounted)', remainingRows)}${list('Excluded with a stated reason', excludedRows)}${list('Need review', listOf((l) => l.needsReview))}${list('Capture failed', listOf((l) => l.captureFailed))}${list('Recovery actions (at most 2 attempts per item)', actions.map((a) => `<li>pass ${a.pass} · ${escapeHtml(a.route)} · ${escapeHtml(a.outcome)} — “${escapeHtml(a.label)}”: ${escapeHtml(a.reason)}</li>`))}${list('Stated boundaries of the manifest', notes.map((n) => `<li>${n}</li>`))}
  </details>`;
  return `<div class="gate${gate.passed ? '' : ' fail'}" role="status">${line}${details}</div>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * DISPLAY ONLY — the permanent report-formatting rule for Expected typography values in `rem`
 * (`2.441rem` → `2.441rem (39.06px)`) lives in ONE shared module, `src/output/display-values.ts`, so the
 * HTML report, the live dashboard, the Figma plan and the Excel report cannot drift apart. Re-exported
 * here because this is where it first shipped. Stored findings are never changed.
 */
export { withResolvedPx };

/**
 * Evidence refs are absolute filesystem paths and are nested per page
 * (`…/screenshots/<pageId>/<el>-element.png`). Keep everything AFTER
 * `/screenshots/` — taking only the basename drops the page directory and
 * every image 404s, which is exactly what happened the first time this was
 * rendered against a real run.
 */
export function evidenceRelativePath(absoluteRef: string): string | null {
  const marker = '/screenshots/';
  const i = absoluteRef.indexOf(marker);
  if (i === -1) return null;
  const rel = absoluteRef.slice(i + marker.length);
  return rel.length > 0 ? rel : null;
}

function evidenceUrl(base: string, absoluteRef: string): string | null {
  const rel = evidenceRelativePath(absoluteRef);
  return rel ? `${base}/${rel.split('/').map(encodeURIComponent).join('/')}` : null;
}

/**
 * Resolves an evidence ref (an absolute filesystem path) to whatever the `<img src>` should be.
 * The live dashboard passes a string base and gets the server-relative URL above; the standalone
 * HTML report (src/output/html-report.ts) passes a function that reads the file and returns a
 * `data:` URI instead, so the exact same markup embeds the image rather than linking to it.
 */
export type EvidenceResolver = (absoluteRef: string) => string | null;

function resolverFor(evidence: string | EvidenceResolver): EvidenceResolver {
  return typeof evidence === 'function' ? evidence : (ref) => evidenceUrl(evidence, ref);
}

/**
 * The locked semantic status palette (`HTML_TEMPLATE_VERSION` below) — the SAME five-color
 * meaning as the Figma template's `colorForMarkerStatus` (src/figma/publish-plan.ts):
 * Incorrect=Red, Deviation=Orange, Needs Review=Amber, Unverified=Gray (a genuinely distinct
 * hue, not amber-plus-a-dashed-border — that was the drift this constant fixes), Match=Green.
 * Exported so a test can assert the mapping directly instead of grepping a CSS string.
 */
export const STATUS_COLORS = {
  incorrect: '#b01f24', // red
  deviation: '#d96548', // orange
  needsReview: '#c99a2e', // amber
  unverified: '#6b7280', // gray — muted treatment pairs this with a dashed border below, but the HUE itself must read as gray, not amber
  match: '#3f7d58', // green
} as const;

/**
 * The reviewer's DECISIONS — deliberately a different palette from `STATUS_COLORS`, because a
 * decision is not an audit status. A reader must never confuse "the audit found this INCORRECT"
 * (red, from STATUS_COLORS) with "a human decided to fix this" (indigo, from here). Purple/teal/
 * slate share no hue with the five canonical status colors for exactly that reason.
 */
export const DECISION_COLORS = {
  fix: '#3f51b5', // indigo — an action was chosen
  skip: '#6b7280', // slate — deliberately muted; skipping is not a finding, it is a dismissal
  keep_for_review: '#0f766e', // teal — still open, but consciously so
} as const;

/** The exact labels the approved plan fixes for each decision pill. */
export const DECISION_LABELS = { fix: 'FIX', skip: 'SKIP', keep_for_review: 'KEEP FOR REVIEW' } as const;

const STYLE = `
:root {
  --bg: #f5f2f1; --surface: #ffffff; --ink: #000000; --ink-muted: rgba(0,0,0,.62);
  --line: #e4dedb; --brand: #b01f24; --critical: ${STATUS_COLORS.incorrect}; --high: ${STATUS_COLORS.deviation}; --medium: ${STATUS_COLORS.needsReview}; --gray: ${STATUS_COLORS.unverified}; --low: #6c5bc0; --ok: ${STATUS_COLORS.match};
  --radius: 10px; font-synthesis: none;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 "DM Sans", system-ui, -apple-system, sans-serif; }
a { color: inherit; }
header { background: var(--surface); border-bottom: 1px solid var(--line); padding: 18px 28px; display: flex; gap: 20px; align-items: baseline; flex-wrap: wrap; }
header h1 { font-family: "Noto Serif", Georgia, serif; font-weight: 300; font-size: 26px; margin: 0; letter-spacing: -.02em; }
header .meta { color: var(--ink-muted); font-size: 13px; }
main { padding: 24px 28px 64px; max-width: 1500px; }
section { margin-bottom: 32px; }
h2 { font-family: "Noto Serif", Georgia, serif; font-weight: 300; font-size: 20px; margin: 0 0 12px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
.card .n { font-family: "Noto Serif", Georgia, serif; font-size: 28px; font-weight: 300; line-height: 1.1; }
.card .l { color: var(--ink-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-top: 6px; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; font-size: 13.5px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: #faf8f7; font-size: 11.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-muted); cursor: pointer; user-select: none; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: #fbfafa; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; border: 1px solid currentColor; white-space: nowrap; }
.CRITICAL { color: var(--critical); } .HIGH { color: var(--high); } .MEDIUM { color: var(--medium); } .LOW { color: var(--low); } .INFO { color: var(--ink-muted); }
.MATCH { color: var(--ok); } .DEVIATION { color: var(--high); } .INCORRECT { color: var(--critical); } .NEW_COMPONENT, .DS_CANDIDATE { color: var(--low); }
.NEEDS_REVIEW { color: var(--medium); } .UNVERIFIED { color: var(--gray); border-style: dashed; } .RESOLVED { color: var(--ok); border-style: dotted; }
.post-fix { border-style: dashed; } /* same "not a confirmed state" idiom as .UNVERIFIED — a post-fix opportunity is a hypothesis, not a current classification */
.card.status-match { border-left: 3px solid var(--ok); }
.card.status-deviation { border-left: 3px solid var(--high); }
.card.status-incorrect { border-left: 3px solid var(--critical); }
.card.status-needsReview { border-left: 3px solid var(--medium); }
.card.status-unverified { border-left: 3px solid var(--gray); }
.review-list { display: grid; gap: 12px; }
.rv { display: grid; grid-template-columns: 220px 1fr; gap: 16px; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--medium); border-radius: var(--radius); padding: 14px 16px; }
.rv[data-status="UNVERIFIED"] { border-left-style: dashed; border-left-color: var(--gray); }
.rv-shot img { width: 100%; max-height: 180px; object-fit: contain; object-position: left top; border: 1px solid var(--line); border-radius: 6px; background: #faf8f7; }
.rv-shot .none { display: flex; align-items: center; justify-content: center; height: 90px; border: 1px dashed var(--line); border-radius: 6px; color: var(--ink-muted); font-size: 12px; }
.rv-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.rv-head b { font-weight: 600; }
.rv-where { color: var(--ink-muted); font-size: 12.5px; margin: 2px 0 8px; word-break: break-all; }
.rv-why { margin: 0 0 10px; font-size: 13.5px; }
.rv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; font-size: 13px; }
.rv-grid h4 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-muted); font-weight: 600; }
.rv-grid ul, .rv-grid ol { margin: 0; padding-left: 18px; }
.rv table { margin-top: 10px; font-size: 12.5px; }
.rv table th { cursor: default; }
@media (max-width: 760px) { .rv { grid-template-columns: 1fr; } }
.controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; align-items: center; }
select, input[type=search] { font: inherit; font-size: 13px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.evidence img { max-width: 190px; border: 1px solid var(--line); border-radius: 6px; display: block; }
.muted { color: var(--ink-muted); }
.bar { height: 8px; background: var(--line); border-radius: 999px; overflow: hidden; margin-top: 8px; }
.bar > i { display: block; height: 100%; background: var(--ok); }
.note { background: #fffdf6; border: 1px solid #eadfae; border-radius: var(--radius); padding: 10px 14px; font-size: 13px; }
.gate { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; background: #f6faf7; border: 1px solid #cfdcd3; border-left: 4px solid #3f7d58; border-radius: var(--radius); padding: 7px 14px; font-size: 13.5px; margin: 12px 0; }
.gate.fail { background: #fdf4f4; border-color: #e6c3c4; border-left-color: #b01f24; }
.gate .gate-state { font-weight: 700; letter-spacing: .02em; }
.gate ul { margin: 6px 0 4px 18px; padding: 0; }
.gate details { margin: 0; } .gate summary { cursor: pointer; font-weight: 600; }
.gate .gate-details > summary { font-weight: 500; font-size: 12.5px; color: var(--muted, #6b7280); }
.gate .gate-details[open] { flex-basis: 100%; }
.gate .gate-details[open] > summary { margin-bottom: 6px; }
.gate .gate-grid { display: flex; flex-wrap: wrap; gap: 4px 22px; margin: 6px 0; }
.gate .gate-grid div { display: flex; flex-direction: column; min-width: 96px; }
.gate .gate-grid b { font-size: 16px; } .gate .gate-grid span { font-size: 11.5px; color: var(--muted, #6b7280); }
.gate .gate-list { margin-top: 6px; } .gate .gate-list > summary { font-weight: 500; font-size: 12.5px; }
.gate .gate-list ul { max-height: 360px; overflow: auto; }
.gate table { margin-top: 6px; font-size: 12.5px; }

/* ---- Fix Plan review layer (html-report-v2) ---- */
.fp-bar { position: sticky; top: 0; z-index: 20; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; margin: 0 0 20px; }
.fp-bar .sel { font-size: 13px; color: var(--ink-muted); min-width: 108px; }
.fp-bar .spacer { flex: 1; }
.fp-bar button { font: inherit; font-size: 12.5px; padding: 6px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); cursor: pointer; }
.fp-bar button:hover:not(:disabled) { background: #f6f4f3; }
.fp-bar button:disabled { opacity: .45; cursor: not-allowed; }
.fp-bar button.d-fix { border-color: ${DECISION_COLORS.fix}; color: ${DECISION_COLORS.fix}; }
.fp-bar button.d-skip { border-color: ${DECISION_COLORS.skip}; color: ${DECISION_COLORS.skip}; }
.fp-bar button.d-keep { border-color: ${DECISION_COLORS.keep_for_review}; color: ${DECISION_COLORS.keep_for_review}; }
.fp-bar button.primary { background: var(--brand); border-color: var(--brand); color: #fff; font-weight: 600; }
.fp-bar button.primary:hover:not(:disabled) { background: #8e191d; }
.fp-bar button.quiet { color: var(--ink-muted); }
.fp-cb { width: 15px; height: 15px; cursor: pointer; accent-color: var(--brand); margin: 0; }
th.fp-col, td.fp-col { width: 28px; padding-right: 0; cursor: default; }
.dpill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .04em; border: 1px solid currentColor; white-space: nowrap; }
.dpill.fix { color: ${DECISION_COLORS.fix}; } .dpill.skip { color: ${DECISION_COLORS.skip}; } .dpill.keep_for_review { color: ${DECISION_COLORS.keep_for_review}; }
tr[data-decision="fix"] td.fp-col { box-shadow: inset 3px 0 0 ${DECISION_COLORS.fix}; }
tr[data-decision="skip"] td.fp-col { box-shadow: inset 3px 0 0 ${DECISION_COLORS.skip}; }
tr[data-decision="keep_for_review"] td.fp-col { box-shadow: inset 3px 0 0 ${DECISION_COLORS.keep_for_review}; }
tr[data-decision="skip"] { opacity: .62; }
.rv[data-decision="fix"] { border-left-color: ${DECISION_COLORS.fix}; border-left-style: solid; }
.rv[data-decision="skip"] { border-left-color: ${DECISION_COLORS.skip}; opacity: .62; }
.rv[data-decision="keep_for_review"] { border-left-color: ${DECISION_COLORS.keep_for_review}; border-left-style: solid; }
.fp-note { font-size: 12.5px; }
.fp-counts { font-size: 12.5px; color: var(--ink-muted); }
@media print { .fp-bar { display: none; } }

/* ---- Compact section-wise Findings view (v2.2 — replaces the wide 15-column table) ---- */
#findings { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.fsec-header { background: #faf8f7; font-weight: 600; color: var(--ink-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; padding: 10px 12px; border-bottom: 1px solid var(--line); border-top: 1px solid var(--line); }
.fsec-header:first-child { border-top: 0; }
/* Each NEW section starts a little apart from the one above it (10px, before its header only — never between finding rows, never before a sub-group header, never before the first section). */
.fsec-header:not(.fsub-header):not(:first-child) { margin-top: 10px; }
.fsec-region { background: #f3efee; color: var(--ink); }
/* Global Header / Global Footer accordion (v15): the region header is a native <button>; its rows and sub-group headers collapse by attribute. */
button.fsec-toggle { appearance: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; margin: 0; text-align: left; font-family: inherit; border-left: 0; border-right: 0; cursor: pointer; }
/* v16: the disclosure chevron sits at the FAR RIGHT of the row, vertically centred — Lucide's chevron-right when collapsed, chevron-down when expanded, drawn inline (the report loads no icon font). Label + counts stay left-aligned. The glyph follows aria-expanded alone, so the toggle script is untouched; pointer-events: none keeps the whole <button> the one click target. */
.fsec-chev { flex: none; width: 16px; height: 16px; margin: -1px 0; color: var(--ink-muted); pointer-events: none; } /* the -1px keeps the 16px glyph from making the row taller than every other section header */
.fsec-chev .fsec-chev-down, button.fsec-toggle[aria-expanded="true"] .fsec-chev .fsec-chev-right { display: none; }
button.fsec-toggle[aria-expanded="true"] .fsec-chev .fsec-chev-down { display: inline; }
button.fsec-toggle[hidden] { display: none; } /* a button's own display would otherwise override [hidden], so a filtered-out region header must say so */
button.fsec-toggle:hover { background: #ece6e4; }
button.fsec-toggle:hover .fsec-chev, button.fsec-toggle:focus-visible .fsec-chev { color: var(--ink); }
button.fsec-toggle:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
[data-gr-collapsed] { display: none !important; }
.fsub-header { padding-top: 8px; padding-bottom: 8px; padding-left: 28px; text-transform: none; letter-spacing: 0; font-weight: 500; background: #fcfbfa; }
.frow { border-bottom: 1px solid var(--line); }
.frow:last-child { border-bottom: 0; }
.frow:hover { background: #fbfafa; }
.frow-main { display: grid; grid-template-columns: 22px 84px 56px 84px 1fr 130px 1.6fr 56px 60px; gap: 10px; align-items: center; padding: 8px 12px; font-size: 13px; }
.frow-name b { font-weight: 600; }
.frow-summary { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 12.5px; color: var(--ink-muted); }
.frow-also-review { font-size: 11px; color: var(--medium); font-style: italic; }
.frow-thumb.has-shot, .ncp-thumb a { position: relative; display: block; width: 56px; height: 40px; overflow: hidden; border: 1px solid var(--line); border-radius: 4px; background: #fff; }
/* A thumbnail shows the WHOLE image fitted into the box (contain) — never a centre-crop, which is empty for left-aligned text in a wide, short crop. When the report knows where the content is (the ink box), .thumb-ink places exactly that region instead, sized and offset inline. */
.frow-thumb img, .ncp-thumb img { display: block; width: 100%; height: 100%; object-fit: contain; }
.frow-thumb img.thumb-ink, .ncp-thumb img.thumb-ink { position: absolute; max-width: none; object-fit: fill; }
/* Dashed border = this is the element's surroundings, not its own crop (the crop had nothing visible to show). */
.frow-thumb.thumb-context, .ncp-thumb a.thumb-context { border-style: dashed; }
.evidence-note { margin-top: 4px; font-size: 11.5px; color: var(--ink-muted); max-width: 320px; }
.frow-expand, .ncp-expand { font: inherit; font-size: 11.5px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); cursor: pointer; color: var(--ink-muted); white-space: nowrap; }
.frow-expand:hover, .ncp-expand:hover { background: #f6f4f3; }
.frow-detail { padding: 6px 12px 16px 46px; font-size: 12.5px; background: #fbfafa; border-top: 1px dashed var(--line); }
.frow-detail table { margin-top: 8px; font-size: 12.5px; }
.frow-detail .frow-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 20px; }
.frow-detail dt { color: var(--ink-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin-top: 8px; }
.frow-detail dd { margin: 2px 0 0; }
.frow-detail .evidence img { max-width: 240px; }
.frow[data-decision="skip"] { opacity: .62; }
.sort-dir { font: inherit; font-size: 13px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); cursor: pointer; }
@media (max-width: 900px) { .frow-main { grid-template-columns: 22px 1fr 60px; } .frow-main > *:not(:first-child):not(.frow-name):not(.frow-expand) { display: none; } }

/* ---- New Component Plan (separate from the Fix Plan layer above — own color, own state) ----
   .ncp-bar is sticky at the SAME top offset as .fp-bar, but the two never fight for it: .fp-bar's
   sticky containing block is now .fp-scope (Summary through Pages, wrapped further down), so it
   naturally stops sticking exactly where that wrapper ends — right as the New Components section
   (.ncp-bar's own container) begins. One handoff, no JS scroll-tracking, no stacking. */
.ncp-bar { position: sticky; top: 0; z-index: 20; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; margin: 0 0 12px; }
.ncp-bar .sel { font-size: 13px; color: var(--ink-muted); min-width: 90px; }
.ncp-bar .spacer { flex: 1; }
.ncp-bar button { font: inherit; font-size: 12.5px; padding: 6px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); cursor: pointer; }
.ncp-bar button:hover:not(:disabled) { background: #f6f4f3; }
.ncp-bar button:disabled { opacity: .45; cursor: not-allowed; }
.ncp-bar button.primary { background: #3b5f8a; border-color: #3b5f8a; color: #fff; font-weight: 600; }
.ncp-bar button.primary:hover:not(:disabled) { background: #2f4d70; }
.ncp-cb { width: 15px; height: 15px; cursor: pointer; accent-color: #3b5f8a; margin: 0; }
@media print { .ncp-bar { display: none; } }

/* ---- New Component candidates — compact expandable cards, same pattern as .frow/.frow-detail ---- */
.ncp-list { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.ncp-row { border-bottom: 1px solid var(--line); }
.ncp-row:last-child { border-bottom: 0; }
.ncp-row:hover { background: #fbfafa; }
.ncp-row[data-staged] { border-left: 3px solid var(--ok); background: #f4faf6; }
.ncp-row-main { display: grid; grid-template-columns: 22px 80px 160px 1fr 170px 1.4fr 56px 60px; gap: 10px; align-items: center; padding: 8px 12px; font-size: 13px; }
.ncp-name b { font-weight: 600; }
.ncp-meta { font-size: 12.5px; color: var(--ink-muted); }
.ncp-summary { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 12.5px; color: var(--ink-muted); }
.ncp-thumb .none { display: flex; align-items: center; justify-content: center; width: 56px; height: 40px; border: 1px dashed var(--line); border-radius: 4px; color: var(--ink-muted); font-size: 9px; text-align: center; }
.ncp-added { display: inline-flex; align-items: center; gap: 3px; padding: 1px 4px 1px 6px; border-radius: 999px; font-size: 10.5px; font-weight: 600; letter-spacing: .02em; border: 1px solid var(--ok); color: var(--ok); white-space: nowrap; }
/* Reserves its 80px grid column at all times (visibility, not display) — a display:none badge is
   removed from grid auto-placement entirely, which shifts every later column one track left and is
   exactly why an unstaged row's status pill used to land in this cell and overflow it. */
.ncp-added[hidden] { visibility: hidden; }
.ncp-remove { border: 0; background: none; padding: 0; margin: 0; font: inherit; font-size: 11px; line-height: 1; color: inherit; cursor: pointer; opacity: .65; }
.ncp-remove:hover { opacity: 1; }
.ncp-detail { padding: 6px 12px 16px 46px; font-size: 12.5px; background: #fbfafa; border-top: 1px dashed var(--line); }
.ncp-detail .ncp-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 20px; }
.ncp-detail dt { color: var(--ink-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin-top: 8px; }
.ncp-detail dd { margin: 2px 0 0; }
.ncp-detail .evidence img { max-width: 240px; }
@media (max-width: 900px) { .ncp-row-main { grid-template-columns: 22px 1fr 60px; } .ncp-row-main > *:not(:first-child):not(.ncp-name):not(.ncp-expand) { display: none; } }
`;

const SCRIPT = `
/* Fix Plan state is declared FIRST, before any filter code runs. applyFilters() calls
   refreshSelectionUi(), which reads \`decisions\` — declaring it lower down puts it in the
   temporal dead zone for that first call, which throws and silently kills the rest of this
   script (every listener included). Function declarations hoist; const bindings do not. */
const FP_RUN_ID = document.body.dataset.runId || '';
const FP_SOURCE = document.body.dataset.fpSource || 'html-report';
const FP_TOTAL = Number(document.body.dataset.totalFindings || '0');
const FP_KEY = 'auditAgent:fixPlanDraft:' + FP_RUN_ID;
const DECISION_LABEL = { fix: 'FIX', skip: 'SKIP', keep_for_review: 'KEEP FOR REVIEW' };
const decisions = new Map();
for (const e of fpSeed()) decisions.set(e.findingId, e);
for (const e of fpLoadDraft()) decisions.set(e.findingId, e); // draft wins: it is strictly newer than what was rendered

// v2.2: the Findings table became a compact list of .frow cards grouped under .fsec-header
// dividers — .section-group-header/<tr> no longer exist here. rows() excludes headers, which get
// their own visibility pass below, keyed by whether any row in their own group is still visible.
const rows = () => Array.from(document.querySelectorAll('#findings .frow'));

// Global Header / Global Footer accordion (v15). A global region's rows and sub-group headers carry data-gr and start
// collapsed (data-gr-collapsed); the region's header row is a <button aria-expanded>. Collapse is an ATTRIBUTE, never the
// 'hidden' attribute the filters own, so filtering, sorting, the Fix Plan and the Details toggle keep working underneath it.
const grUser = new Map(); // region (its data-section) -> true when the reader opened it by hand
function grSet(sec, open) {
  document.querySelectorAll('#findings [data-gr]').forEach((el) => {
    if (el.dataset.section !== sec) return;
    if (open) el.removeAttribute('data-gr-collapsed'); else el.setAttribute('data-gr-collapsed', '');
  });
  document.querySelectorAll('#findings .fsec-toggle').forEach((b) => {
    if (b.dataset.section === sec) b.setAttribute('aria-expanded', String(open));
  });
}
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('#findings .fsec-toggle');
  if (!btn) return;
  const open = btn.getAttribute('aria-expanded') !== 'true';
  grUser.set(btn.dataset.section, open);
  grSet(btn.dataset.section, open);
});

function applyFilters() {
  const cls = document.getElementById('f-class').value;
  const sev = document.getElementById('f-sev').value;
  const section = document.getElementById('f-section')?.value ?? '';
  const q = document.getElementById('f-q').value.toLowerCase();
  let shown = 0;
  for (const row of rows()) {
    const ok =
      (!cls || row.dataset.classification === cls) &&
      (!sev || row.dataset.severity === sev) &&
      (!section || row.dataset.section === section) &&
      (!q || row.textContent.toLowerCase().includes(q));
    row.hidden = !ok;
    if (ok) shown++;
  }
  // A section's header shows only while at least one of ITS OWN rows is still visible — keeps
  // grouping and filtering mutually consistent (e.g. a search matching 2 of a section's 8 rows
  // still shows that section's header, just not the other 6).
  const allRows = rows();
  // A filter or search that lands on a global region's findings OPENS that region; with no filter a region is as the
  // reader left it (collapsed until opened by hand).
  const filtering = Boolean(cls || sev || section || q);
  document.querySelectorAll('#findings .fsec-toggle').forEach((b) => {
    const sec = b.dataset.section;
    const targeted = filtering && allRows.some((row) => row.dataset.section === sec && !row.hidden);
    grSet(sec, targeted || grUser.get(sec) === true);
  });
  document.querySelectorAll('#findings .fsec-header').forEach((header) => {
    const sec = header.dataset.section;
    const grp = header.dataset.group; // a sub-group header (Global Header › Reports Menu) follows only ITS OWN rows
    header.hidden = header.dataset.empty === 'true' ? Boolean((section && section !== sec) || cls || sev || q) : !allRows.some((row) => row.dataset.section === sec && (!grp || row.dataset.group === grp) && !row.hidden);
  });
  document.getElementById('shown').textContent = shown + ' of ' + rows().length + ' findings';
  if (typeof refreshSelectionUi === 'function') refreshSelectionUi();
}
for (const id of ['f-class','f-sev','f-section','f-q']) {
  document.getElementById(id)?.addEventListener('input', applyFilters);
}

// Compact sort control — replaces the old per-column <th> clicks, which have no equivalent in a
// card layout. Same "sort WITHIN each group, never a global flatten" behavior as before: a
// flatten would move every row to the end in sorted order and leave the group headers behind,
// scrambling rows out of their sections.
const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const SORT_KEYS = {
  severity: (r) => SEVERITY_RANK[r.dataset.severity] ?? -1,
  status: (r) => r.dataset.classification || '',
  confidence: (r) => Number(r.dataset.confidence),
};
let sortDir = 1;
function applySort() {
  const key = document.getElementById('f-sort')?.value;
  if (!key || !SORT_KEYS[key]) return;
  const getValue = SORT_KEYS[key];
  document.querySelectorAll('#findings .fsec-header').forEach((header) => {
    const groupRows = [];
    let sib = header.nextElementSibling;
    while (sib && !sib.classList.contains('fsec-header')) { groupRows.push(sib); sib = sib.nextElementSibling; }
    groupRows.sort((a, b) => {
      const av = getValue(a), bv = getValue(b);
      return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * sortDir;
    });
    let anchor = header;
    for (const row of groupRows) { anchor.after(row); anchor = row; }
  });
}
document.getElementById('f-sort')?.addEventListener('change', applySort);
document.getElementById('f-sort-dir')?.addEventListener('click', () => {
  sortDir *= -1;
  const btn = document.getElementById('f-sort-dir');
  if (btn) btn.textContent = sortDir === 1 ? '↑ Asc' : '↓ Desc';
  applySort();
});

// One expand/collapse toggle for every compact row, delegated from the document since rows are
// re-parented by sort/filter but never re-created.
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('.frow-expand');
  if (!btn) return;
  const row = btn.closest('.frow');
  const detail = row?.querySelector('.frow-detail');
  if (!detail) return;
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  detail.hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
  btn.textContent = expanded ? 'Details' : 'Hide';
});

applyFilters();
function applyReviewFilters() {
  const status = document.getElementById('r-status')?.value ?? '';
  const dec = document.getElementById('r-decision')?.value ?? '';
  const q = (document.getElementById('r-q')?.value ?? '').toLowerCase();
  let shown = 0;
  const items = Array.from(document.querySelectorAll('#review .rv'));
  for (const el of items) {
    const d = el.dataset.decision || '';
    const ok =
      (!status || el.dataset.status === status) &&
      (!dec || (dec === 'undecided' ? d === '' : d === dec)) &&
      (!q || el.textContent.toLowerCase().includes(q));
    el.hidden = !ok;
    if (ok) shown++;
  }
  const counter = document.getElementById('r-shown');
  if (counter) counter.textContent = shown + ' of ' + items.length + ' items';
  if (typeof refreshSelectionUi === 'function') refreshSelectionUi();
}
for (const id of ['r-status','r-decision','r-q']) document.getElementById(id)?.addEventListener('input', applyReviewFilters);
applyReviewFilters();

/* ================= Fix Plan review layer (html-report-v2) =================
   Decisions live in a SIDECAR keyed only by findingId — this script never reads, writes or
   depends on any other finding field, which is what keeps data.json untouched by design rather
   than by discipline. A finding with no entry is undecided; that is the neutral default and the
   reason the exported plan is sparse. */
function fpSeed() {
  const el = document.getElementById('fp-seed');
  if (!el) return [];
  try { return (JSON.parse(el.textContent).entries) || []; } catch { return []; }
}
/* localStorage is a best-effort DRAFT, never canonical: some file:// origins throw on access
   outright, so every read and write is wrapped and simply degrades to memory-only. */
function fpLoadDraft() {
  try { const raw = localStorage.getItem(FP_KEY); return raw ? (JSON.parse(raw).entries || []) : []; } catch { return []; }
}
function fpSaveDraft() {
  try { localStorage.setItem(FP_KEY, JSON.stringify(fpPlan())); } catch { /* storage blocked — memory-only, never fatal */ }
}
function fpPlan() {
  return { schemaVersion: 1, runId: FP_RUN_ID, updatedAt: null, entries: Array.from(decisions.values()) };
}

function fpNodesFor(findingId) {
  return Array.from(document.querySelectorAll('[data-finding-id="' + (window.CSS && CSS.escape ? CSS.escape(findingId) : findingId) + '"]'));
}
/* A NEEDS_REVIEW/UNVERIFIED finding renders TWICE — once as a table row, once as a review card.
   Both carry the same data-finding-id, so every decision change must repaint every node with
   that id or the two views silently disagree about the same finding. */
function fpPaint(findingId) {
  const entry = decisions.get(findingId);
  for (const node of fpNodesFor(findingId)) {
    if (entry) node.dataset.decision = entry.decision; else node.removeAttribute('data-decision');
    const badge = node.querySelector('.dpill');
    if (badge) {
      badge.textContent = entry ? DECISION_LABEL[entry.decision] : '';
      badge.className = 'dpill' + (entry ? ' ' + entry.decision : '');
      badge.hidden = !entry;
    }
  }
}
function fpDecidedCount() { return decisions.size; }
function fpAllCheckboxes() { return Array.from(document.querySelectorAll('.fp-cb[data-finding-id]')); }
function fpVisibleCheckboxes() {
  return fpAllCheckboxes().filter((cb) => {
    const host = cb.closest('.frow, .rv');
    return host && !host.hidden && !host.hasAttribute('data-gr-collapsed'); // a row inside a collapsed global region is not visible
  });
}
function fpSelectedIds() {
  const ids = new Set();
  for (const cb of fpAllCheckboxes()) if (cb.checked) ids.add(cb.dataset.findingId);
  return Array.from(ids);
}
/** Tallies the live decision map for the bar's "Fix X · Skip Y · Review Z · Undecided N" readout. */
function fpCounts() {
  let fix = 0, skip = 0, keep = 0;
  for (const e of decisions.values()) {
    if (e.decision === 'fix') fix++;
    else if (e.decision === 'skip') skip++;
    else if (e.decision === 'keep_for_review') keep++;
  }
  return { fix: fix, skip: skip, keep: keep, undecided: Math.max(0, FP_TOTAL - decisions.size) };
}

function refreshSelectionUi() {
  const n = fpSelectedIds().length;
  const selLabel = document.getElementById('fp-selected');
  if (selLabel) selLabel.textContent = n + ' selected';
  for (const id of ['fp-fix','fp-skip','fp-keep','fp-clear']) {
    const b = document.getElementById(id);
    if (b) b.disabled = n === 0;
  }
  const exp = document.getElementById('fp-export');
  if (exp) exp.textContent = 'Export Fix Plan (' + fpDecidedCount() + ')';
  const counts = fpCounts();
  const countsLabel = document.getElementById('fp-counts');
  if (countsLabel) countsLabel.textContent = 'Fix ' + counts.fix + ' · Skip ' + counts.skip + ' · Review ' + counts.keep + ' · Undecided ' + counts.undecided;
  const head = document.getElementById('fp-all');
  if (head) {
    const vis = fpVisibleCheckboxes();
    const checked = vis.filter((cb) => cb.checked).length;
    head.checked = vis.length > 0 && checked === vis.length;
    head.indeterminate = checked > 0 && checked < vis.length;
  }
}

function fpSetDecision(decision) {
  const ids = fpSelectedIds();
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  for (const findingId of ids) {
    if (decision === null) decisions.delete(findingId);
    else decisions.set(findingId, { findingId: findingId, decision: decision, decidedAt: now, decidedBy: null, note: null, source: FP_SOURCE });
    fpPaint(findingId);
  }
  // Clear the selection immediately after applying — otherwise a still-checked row from THIS
  // action gets re-decided the next time a bulk button is clicked, silently overwriting what was
  // just set (the exact reported bug: Mark as Fix, select one more, Mark as Skip, and every
  // previously-fixed row flips to Skip too). Existing decisions for rows not currently checked
  // are untouched either way.
  for (const cb of fpAllCheckboxes()) cb.checked = false;
  fpSaveDraft();
  applyFilters();
  applyReviewFilters();
  refreshSelectionUi();
}

function fpExport() {
  const plan = fpPlan();
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'fix-plan.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t && t.classList && t.classList.contains('fp-cb')) refreshSelectionUi();
});
document.getElementById('fp-all')?.addEventListener('change', (ev) => {
  const on = ev.target.checked;
  for (const cb of fpVisibleCheckboxes()) cb.checked = on;
  refreshSelectionUi();
});
document.getElementById('fp-select-visible')?.addEventListener('click', () => {
  for (const cb of fpVisibleCheckboxes()) cb.checked = true;
  refreshSelectionUi();
});
document.getElementById('fp-fix')?.addEventListener('click', () => fpSetDecision('fix'));
document.getElementById('fp-skip')?.addEventListener('click', () => fpSetDecision('skip'));
document.getElementById('fp-keep')?.addEventListener('click', () => fpSetDecision('keep_for_review'));
document.getElementById('fp-clear')?.addEventListener('click', () => fpSetDecision(null));
document.getElementById('fp-export')?.addEventListener('click', fpExport);
document.getElementById('fp-clear-all')?.addEventListener('click', () => {
  if (decisions.size === 0) return;
  if (!confirm('Clear all ' + decisions.size + ' decision(s) for this run? This only clears your local draft — data.json is never touched.')) return;
  const ids = Array.from(decisions.keys());
  decisions.clear();
  for (const id of ids) fpPaint(id);
  fpSaveDraft();
  applyFilters();
  applyReviewFilters();
  refreshSelectionUi();
});

for (const id of decisions.keys()) fpPaint(id);
refreshSelectionUi();

/* ================= New Component Plan — deliberately separate from the Fix Plan above =================
   Own state (ncpStaged, never decisions), own localStorage key, own CSS class (.ncp-cb, never
   .fp-cb). The Fix Plan's bulk bar must never read or clear this, and vice versa — kept apart by
   construction (disjoint DOM regions, disjoint JS variables), not just by convention. There is no
   Fix/Skip/Keep-for-Review decision here: a candidate is either staged for the New Component Plan
   or it isn't. */
const NCP_KEY = 'auditAgent:newComponentPlanDraft:' + FP_RUN_ID;
const ncpClassification = new Map();
const ncpCandidateSource = new Map();
const ncpRelatedIds = new Map();
for (const e of ncpSeed()) {
  ncpClassification.set(e.findingId, e.classification);
  ncpCandidateSource.set(e.findingId, e.candidateSource);
  if (e.relatedFindingIds) ncpRelatedIds.set(e.findingId, e.relatedFindingIds);
}
const ncpStaged = new Map();
for (const e of ncpLoadDraft()) ncpStaged.set(e.findingId, e);

function ncpSeed() {
  const el = document.getElementById('ncp-seed');
  if (!el) return [];
  try { return JSON.parse(el.textContent) || []; } catch { return []; }
}
function ncpLoadDraft() {
  try { const raw = localStorage.getItem(NCP_KEY); return raw ? (JSON.parse(raw).entries || []) : []; } catch { return []; }
}
function ncpSaveDraft() {
  try { localStorage.setItem(NCP_KEY, JSON.stringify(ncpPlan())); } catch { /* storage blocked — memory-only, never fatal */ }
}
function ncpPlan() {
  return { schemaVersion: 1, runId: FP_RUN_ID, updatedAt: null, entries: Array.from(ncpStaged.values()) };
}
function ncpAllCheckboxes() { return Array.from(document.querySelectorAll('.ncp-cb[data-finding-id]')); }
function ncpVisibleCheckboxes() {
  return ncpAllCheckboxes().filter((cb) => {
    const host = cb.closest('.ncp-row');
    return host && !host.hidden;
  });
}
// Paints the persistent "already staged" state onto every row — separate from the temporary
// checkbox selection, which fpSetDecision-style handlers clear after every bulk action. Runs on
// every refresh (load, add, change) so a staged row stays visibly marked even after its checkbox
// is unchecked, and a page reload with an existing draft shows the same state immediately.
function ncpPaintStaged() {
  for (const cb of ncpAllCheckboxes()) {
    const row = cb.closest('.ncp-row');
    if (!row) continue;
    const staged = ncpStaged.has(cb.dataset.findingId);
    row.toggleAttribute('data-staged', staged);
    const badge = row.querySelector('.ncp-added');
    if (badge) badge.hidden = !staged;
  }
}
function ncpSelectedIds() {
  const ids = new Set();
  for (const cb of ncpAllCheckboxes()) if (cb.checked) ids.add(cb.dataset.findingId);
  return Array.from(ids);
}
function ncpRefreshUi() {
  const n = ncpSelectedIds().length;
  const sel = document.getElementById('ncp-selected');
  if (sel) sel.textContent = n + ' selected';
  const addBtn = document.getElementById('ncp-add');
  if (addBtn) addBtn.disabled = n === 0;
  const staged = document.getElementById('ncp-staged');
  if (staged) staged.textContent = ncpStaged.size + ' staged';
  const exp = document.getElementById('ncp-export');
  if (exp) exp.textContent = 'Export New Component Plan (' + ncpStaged.size + ')';
  const head = document.getElementById('ncp-all');
  if (head) {
    const vis = ncpVisibleCheckboxes();
    const checked = vis.filter((cb) => cb.checked).length;
    head.checked = vis.length > 0 && checked === vis.length;
    head.indeterminate = checked > 0 && checked < vis.length;
  }
  ncpPaintStaged();
}
// One expand/collapse toggle for every candidate card, delegated like .frow-expand's — its own
// listener, not a shared one, so this block stays fully self-contained and movable.
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('.ncp-expand');
  if (!btn) return;
  const row = btn.closest('.ncp-row');
  const detail = row?.querySelector('.ncp-detail');
  if (!detail) return;
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  detail.hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
  btn.textContent = expanded ? 'Details' : 'Hide';
});
// Unstage a mistakenly-added candidate — only ever removes from ncpStaged (never touches
// selection/checkbox state), so the same candidate can be selected and re-added later.
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest?.('.ncp-remove');
  if (!btn) return;
  const findingId = btn.closest('.ncp-row')?.dataset.findingId;
  if (!findingId) return;
  ncpStaged.delete(findingId);
  ncpSaveDraft();
  ncpRefreshUi();
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t && t.classList && t.classList.contains('ncp-cb')) ncpRefreshUi();
});
document.getElementById('ncp-all')?.addEventListener('change', (ev) => {
  const on = ev.target.checked;
  for (const cb of ncpVisibleCheckboxes()) cb.checked = on;
  ncpRefreshUi();
});
document.getElementById('ncp-select-visible')?.addEventListener('click', () => {
  for (const cb of ncpVisibleCheckboxes()) cb.checked = true;
  ncpRefreshUi();
});
document.getElementById('ncp-add')?.addEventListener('click', () => {
  const ids = ncpSelectedIds();
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  for (const findingId of ids) {
    const entry = { findingId: findingId, classification: ncpClassification.get(findingId) || 'DS_CANDIDATE', selectedAt: now, note: null, candidateSource: ncpCandidateSource.get(findingId) || 'current_state' };
    const related = ncpRelatedIds.get(findingId);
    if (related && related.length) entry.relatedFindingIds = related;
    ncpStaged.set(findingId, entry);
  }
  // Same clear-after-action fix as the Fix Plan bar, applied consistently here too.
  for (const cb of ncpAllCheckboxes()) cb.checked = false;
  ncpSaveDraft();
  ncpRefreshUi();
});
document.getElementById('ncp-export')?.addEventListener('click', () => {
  const plan = ncpPlan();
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'new-component-plan.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
ncpRefreshUi();
`;

/**
 * `run` stamps `<body data-run-id data-fp-source data-total-findings>` so the embedded scripts
 * can key their localStorage drafts, exported entries, and the "Undecided" count per-run without
 * any of that becoming a per-render template string. Index pages pass nothing and get a plain
 * `<body>`, exactly as before.
 */
function layout(title: string, body: string, run?: { runId: string; source: 'html-report' | 'dashboard'; totalFindings: number }): string {
  const bodyAttrs = run ? ` data-run-id="${escapeHtml(run.runId)}" data-fp-source="${escapeHtml(run.source)}" data-total-findings="${run.totalFindings}"` : '';
  return `<!doctype html><!-- ${HTML_TEMPLATE_VERSION} --><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body${bodyAttrs}>${body}</body></html>`;
}

export function renderProjectsIndex(projects: Array<{ name: string; runs: string[]; targetUrl: string }>): string {
  const rows = projects
    .map(
      (p) => `<tr><td><a href="/projects/${encodeURIComponent(p.name)}">${escapeHtml(p.name)}</a></td>
      <td class="mono">${escapeHtml(p.targetUrl)}</td><td>${p.runs.length}</td>
      <td>${p.runs[0] ? `<a href="/projects/${encodeURIComponent(p.name)}/runs/${encodeURIComponent(p.runs[0])}">latest run</a>` : '<span class="muted">no runs</span>'}</td></tr>`,
    )
    .join('');
  return layout(
    'Audit Dashboard',
    `<header><h1>Design System Audit</h1><span class="meta">local dashboard · reads each run's data.json</span></header>
     <main><section><h2>Projects</h2>${
       projects.length === 0
         ? '<p class="muted">No audits yet. Run <span class="mono">audit-page &lt;url&gt;</span> to create one.</p>'
         : `<table><thead><tr><th>Project</th><th>Target</th><th>Runs</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
     }</section></main>`,
  );
}

export function renderRunsIndex(projectName: string, runs: Array<{ runId: string; startedAt: string | null; compliance: number | null }>): string {
  const rows = runs
    .map(
      (r) => `<tr><td><a href="/projects/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(r.runId)}">${escapeHtml(r.runId)}</a></td>
      <td>${escapeHtml(r.startedAt ?? '—')}</td><td>${r.compliance === null ? '—' : r.compliance + '%'}</td></tr>`,
    )
    .join('');
  return layout(
    `${projectName} — runs`,
    `<header><h1>${escapeHtml(projectName)}</h1><span class="meta"><a href="/">all projects</a></span></header>
     <main><section><h2>Runs</h2><table><thead><tr><th>Run</th><th>Started</th><th>Compliance</th></tr></thead><tbody>${rows}</tbody></table></section></main>`,
  );
}

/**
 * The Global Header / Global Footer accordion's chevron (v16): Lucide's chevron-right and chevron-down paths, inline so the
 * report stays one self-contained file. It is decoration — the row's own text and `aria-expanded` say everything — so it is
 * `aria-hidden`; the stylesheet shows exactly one of the two paths from the button's `aria-expanded`.
 */
const FSEC_CHEVRON = '<svg class="fsec-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path class="fsec-chev-right" d="m9 18 6-6-6-6"/><path class="fsec-chev-down" d="m6 9 6 6 6-6"/></svg>';

/**
 * `opts.inspectEvidence` lets a caller that can read the screenshots from disk (the standalone
 * writer and the live dashboard both can) have the report choose evidence by what is actually
 * VISIBLE in it. Without it every screenshot is assumed fine and shown exactly as before.
 */
export function renderRun(projectName: string, data: AuditData, evidence: string | EvidenceResolver, usedRefs?: Set<string>, fixPlan?: FixPlan, opts: { inspectEvidence?: EvidenceInspector | undefined } = {}): string {
  const base = resolverFor(evidence);
  // The one existing signal for which surface is rendering: the standalone report passes a
  // resolver function (it embeds data: URIs), the live dashboard passes a URL base string.
  const fpSource: 'html-report' | 'dashboard' = typeof evidence === 'function' ? 'html-report' : 'dashboard';
  // Sparse by contract — a finding with no entry is undecided, so this Map is deliberately
  // smaller than data.findings and is only ever read by findingId.
  const fixPlanDecisions = new Map<string, FixPlanDecision>((fixPlan?.entries ?? []).map((e) => [e.findingId, e.decision]));
  // Every evidence ref this render actually looked up, in one pass — so a caller building a
  // report package (src/agents/c1-html-reporter/index.ts) knows exactly which files to bundle
  // without re-deriving the same "which shot wins" selection logic a second time.
  const resolveEvidence: EvidenceResolver = usedRefs
    ? (ref) => {
        usedRefs.add(ref);
        return base(ref);
      }
    : base;

  // ── Evidence that is actually visible ─────────────────────────────────────────────────────────
  // A screenshot existing is not the same as a screenshot showing something. An element hidden
  // until hover/interaction (a collapsed card action, an opacity:0 reveal link, an item in a closed
  // menu) is audited with its real box and computed styles, but its crop is one flat colour — and a
  // wide, short crop of left-aligned text has an empty centre. Both used to render as an empty box.
  type EvidenceKind = 'element-screenshot' | 'context-screenshot';
  interface EvidencePick {
    url: string;
    info: EvidenceImageInfo | null;
    kind: EvidenceKind;
    /** The shot that would have been shown first, when it had nothing visible and another one was shown instead. */
    fellBackFrom: EvidenceKind | null;
    /** Nothing better existed, so this shot — which has no visible detail — is shown as it always was. */
    blank: boolean;
  }
  const inspect = opts.inspectEvidence;
  /**
   * The first of `order` that has something to look at. A flat-colour shot is skipped in favour of
   * the next kind; if every shot is flat (or only one exists) the flat one is still shown — never
   * worse than before, and never a broken image — and says so.
   */
  const pickEvidence = (f: Finding, order: readonly EvidenceKind[]): EvidencePick | null => {
    let flat: { ref: string; info: EvidenceImageInfo; kind: EvidenceKind } | null = null;
    for (const kind of order) {
      const entry = f.quality.evidence.find((ev) => ev.kind === kind);
      if (!entry) continue;
      const info = inspect?.(entry.ref) ?? null;
      if (info?.blank) {
        flat ??= { ref: entry.ref, info, kind };
        continue;
      }
      const url = resolveEvidence(entry.ref);
      if (url) return { url, info, kind, fellBackFrom: flat?.kind ?? null, blank: false };
    }
    if (!flat) return null;
    const url = resolveEvidence(flat.ref);
    return url ? { url, info: flat.info, kind: flat.kind, fellBackFrom: null, blank: true } : null;
  };
  const NO_DETAIL_ELEMENT = 'The element crop has no visible detail — the element is hidden until hover or interaction, or is a flat shape. Showing its surroundings instead.';
  const NO_DETAIL_CONTEXT = 'The surroundings shot has no visible detail. Showing the element crop instead.';
  const NO_DETAIL_ONLY = 'This screenshot has no visible detail — the element is hidden until hover or interaction, or is a flat shape.';
  /** One sentence for a reviewer when what is shown is not simply the first-choice, content-bearing crop. */
  const evidenceNote = (pick: EvidencePick | null): string | null =>
    !pick ? null : pick.fellBackFrom === 'element-screenshot' ? NO_DETAIL_ELEMENT : pick.fellBackFrom === 'context-screenshot' ? NO_DETAIL_CONTEXT : pick.blank ? NO_DETAIL_ONLY : null;
  const evidenceNoteHtml = (pick: EvidencePick | null): string => {
    const note = evidenceNote(pick);
    return note ? `<div class="evidence-note">${escapeHtml(note)}</div>` : '';
  };

  // Inner size of the 56×40 thumbnail box (its 1px border is inside the 56×40).
  const THUMB_W = 54;
  const THUMB_H = 38;
  /** Below this a crop of a long strip is a smudge; show its leading part at a readable scale instead. */
  const THUMB_MIN_STRIP_SCALE = 0.6;
  /**
   * The thumbnail's <img>. With the content's bounding box known, exactly that region is placed in
   * the box: fitted whole when it fits, and — for a long strip of text, which fitted whole would be
   * unreadably thin — its leading part at THUMB_MIN_STRIP_SCALE, so the first words read. Without
   * it (no inspector, a context shot, a flat crop) the whole image is fitted into the box.
   */
  const thumbImgHtml = (pick: EvidencePick, alt: string): string => {
    const attrs = `src="${pick.url}" alt="${escapeHtml(alt)}" loading="lazy"`;
    const info = pick.info;
    const ink = pick.kind === 'element-screenshot' && !pick.blank && info ? info.ink : null;
    if (!ink || !info) return `<img ${attrs}>`;
    const strip = Math.max(ink.width / ink.height, ink.height / ink.width) > 3.5;
    let scale = Math.min(THUMB_W / ink.width, THUMB_H / ink.height, 2);
    if (strip && scale < THUMB_MIN_STRIP_SCALE) scale = THUMB_MIN_STRIP_SCALE;
    // Centre when it fits (the epsilon: contain-scaling makes the binding axis equal the box exactly, and
    // floating point must not tip that into the anchored branch), else anchor the content's start.
    const place = (box: number, start: number, length: number) => (length * scale <= box + 0.01 ? (box - length * scale) / 2 - start * scale : 2 - start * scale);
    const left = place(THUMB_W, ink.x, ink.width);
    const top = place(THUMB_H, ink.y, ink.height);
    return `<img ${attrs} class="thumb-ink" style="left:${Math.round(left)}px;top:${Math.round(top)}px;width:${Math.round(info.width * scale)}px;height:${Math.round(info.height * scale)}px">`;
  };
  const thumbTitleAttr = (pick: EvidencePick): string => {
    const note = evidenceNote(pick);
    return note ? ` title="${escapeHtml(note)}"` : '';
  };
  const s = data.websiteSummary;
  // `statusKey` ties a summary card to the SAME STATUS_COLORS hue used everywhere else
  // (pills, review-item left borders) via a 3px left-border accent — never a background tint,
  // per the locked "subtle accent only, backgrounds stay neutral/white" rule. Only the five
  // canonical statuses (match/deviation/incorrect/needsReview/unverified) ever get one; every
  // other summary card (Compliance, DS candidates, Resolved, etc.) stays fully neutral.
  const card = (n: string | number, l: string, statusKey?: keyof typeof STATUS_COLORS) =>
    `<div class="card${statusKey ? ` status-${statusKey}` : ''}"><div class="n">${escapeHtml(n)}</div><div class="l">${escapeHtml(l)}</div></div>`;
  // C2's own counts. Older data.json files predate some of them — shown as "—", never recomputed here.
  const counts = data.statusCounts;
  const needsReviewCount = s.needsReview ?? counts?.NEEDS_REVIEW ?? '—';
  const unverifiedCount = s.unverified ?? s.notCompared ?? '—';
  /**
   * Compact by default: checkbox, decision, severity, status, production/component name, DS
   * component, a 1-2 line summary, an evidence thumbnail, and an expand toggle. Nothing from the
   * old wide table is REMOVED — property/actual/expected, confidence+band, review state,
   * re-audit state, the full recommendation, and full-size evidence all still exist, inside
   * `.frow-detail`, collapsed until the reviewer asks for them. The Section name is deliberately
   * NOT repeated per row — the row is already inside that section's own group header.
   */
  const sectionKey = (f: Finding) => f.location.sectionId ? `${f.location.pageId}/${f.location.sectionId}` : f.location.section;
  const sectionNames = new Map<string, string>();
  // Each page's MEASURED root font size (data.json's pageSummary) — an expected `rem` is shown with the px
  // it renders at on the page the finding belongs to (display only; see src/output/display-values.ts).
  const roots = pageRoots(data);
  const findingRowHtml = (f: Finding): string => {
    const m = f.comparison.mismatches[0];
    const observed = f.comparison.properties ?? [];
    const root = roots.of(f);
    const reading = observed.find(p => p.status === 'DIFFERENT') ?? observed[0];
    const rule = f.comparison.ruleViolations[0];
    // The element crop, or — when that has nothing visible in it, or none was captured — the
    // element in its surroundings. Never an empty box while a usable screenshot exists.
    const shot = pickEvidence(f, ['element-screenshot', 'context-screenshot']);
    // One status per finding, from S0: a not-compared match is UNVERIFIED — never a plain
    // MATCH — and S7's record of a prior issue whose element is gone is RESOLVED history.
    const status = findingStatus(f);
    const findingId = f.identity.findingId;
    const decision = fixPlanDecisions.get(findingId);
    const summary = m
      ? `${m.property}: ${m.actual} → ${m.expected == null ? '—' : expectedForDisplay(m.property, m.expected, root)}`
      : rule
        ? `${rule.title} — ${rule.why}`
        : recommendationForDisplay(f.action.recommendation, root);
    return `<div class="frow" data-classification="${status}" data-severity="${f.quality.severity}" data-section="${escapeHtml(sectionKey(f))}"${f.location.group ? ` data-group="${escapeHtml(f.location.group)}"` : ''} data-finding-id="${escapeHtml(findingId)}" data-confidence="${f.quality.confidence}"${decision ? ` data-decision="${escapeHtml(decision)}"` : ''}>
    <div class="frow-main">
      <input type="checkbox" class="fp-cb" data-finding-id="${escapeHtml(findingId)}" aria-label="Select finding ${escapeHtml(f.component.productionType)} ${escapeHtml(f.component.productionLabel.slice(0, 40))}">
      <span class="dpill${decision ? ` ${decision}` : ''}"${decision ? '' : ' hidden'}>${decision ? escapeHtml(DECISION_LABELS[decision]) : ''}</span>
      <span class="pill ${f.quality.severity}">${f.quality.severity}</span>
      <span class="pill ${status}">${escapeHtml(statusLabel(status))}</span>
      <span class="frow-name"><b>${escapeHtml(f.component.productionType)}</b> <span class="muted">${escapeHtml(f.component.productionLabel.slice(0, 40))}</span></span>
      <span class="frow-ds muted">${f.component.dsComponent ? `${escapeHtml(f.component.dsComponent)}${f.component.dsVariant ? `/${escapeHtml(f.component.dsVariant)}` : ''}` : '—'}</span>
      <span class="frow-summary">${escapeHtml(summary)}</span>
      <span class="frow-thumb${shot ? ` has-shot${shot.fellBackFrom === 'element-screenshot' ? ' thumb-context' : ''}` : ''}"${shot ? thumbTitleAttr(shot) : ''}>${shot ? thumbImgHtml(shot, 'evidence') : ''}</span>
      <button type="button" class="frow-expand" aria-expanded="false">Details</button>
    </div>
    <div class="frow-detail" hidden>
      <div class="frow-detail-grid">
        <div><dt>Property</dt><dd class="mono">${escapeHtml(m?.property ?? reading?.property ?? (rule ? rule.ruleId : 'Comparison unavailable'))}</dd></div>
        <div><dt>Actual</dt><dd class="mono">${escapeHtml(m?.actual ?? reading?.actual ?? 'Not measured')}</dd></div>
        <div><dt>Expected</dt><dd class="mono">${escapeHtml(m?.expected != null ? expectedForDisplay(m.property, m.expected, root) : (reading?.expected ? `${reading.status === 'UNRESOLVED' ? 'Candidate only: ' : ''}${expectedForDisplay(reading.property, reading.expected, root)}` : 'Not resolved'))}${m?.expectedToken ? ` <span class="muted">${escapeHtml(m.expectedToken)}</span>` : ''}</dd></div>
        <div><dt>Confidence</dt><dd>${f.quality.confidence.toFixed(2)} <span class="muted">${escapeHtml(f.quality.confidenceBand)}</span></dd></div>
        ${f.comparison.basis ? `<div><dt>Match basis</dt><dd>${f.comparison.basis === 'foundation-only' ? 'Foundation checks only <span class="muted">no DS component applies</span>' : 'DS component compared'}</dd></div>` : ''}
        <div><dt>Review state</dt><dd>${escapeHtml(f.quality.escalationStatus)}${f.quality.escalationReasons.length ? `<br><span class="muted">${escapeHtml(f.quality.escalationReasons.join(', '))}</span>` : ''}</dd></div>
        <div><dt>Re-audit</dt><dd>${escapeHtml(reAuditLabel(f))}${f.history.baselineChanged?.length ? `<br><span class="muted">${escapeHtml(f.history.baselineChanged.join('; '))}</span>` : ''}</dd></div>
      </div>
      <dt>Element</dt><dd>${escapeHtml(f.component.productionLabel)}</dd>
      <dt>Recommendation</dt><dd>${escapeHtml(recommendationForDisplay(f.action.recommendation, root))}</dd>
      ${observed.length ? `<table class="property-readings"><thead><tr><th>Property / part</th><th>Actual</th><th>Expected</th><th>Comparison</th><th>Source / note</th></tr></thead><tbody>${observed.map(p => `<tr><td>${escapeHtml(p.property)}</td><td class="mono">${escapeHtml(p.actual ?? 'Not measured')}</td><td class="mono">${escapeHtml(p.expected ? `${p.status === 'UNRESOLVED' ? 'Candidate only: ' : ''}${expectedForDisplay(p.property, p.expected, root)}` : 'Not resolved')}${p.expectedToken ? `<br>${escapeHtml(p.expectedToken)}` : ''}</td><td>${escapeHtml(p.status === 'UNRESOLVED' ? 'Not verified' : p.status === 'MATCH' ? 'Matches' : 'Differs')}</td><td>${escapeHtml([p.source,p.note].filter(Boolean).join(' · '))}</td></tr>`).join('')}</tbody></table>` : ''}
      <dt>Evidence</dt><dd class="evidence">${shot ? `<a href="${shot.url}" target="_blank"><img src="${shot.url}" alt="evidence" loading="lazy"></a>${evidenceNoteHtml(shot)}` : '<span class="muted">—</span>'}</dd>
    </div>
  </div>`;
  };

  // Grouped by section, preserving each section's first-appearance order in data.findings (never
  // re-sorted alphabetically — the simplest, least-surprising default). "View All" (the Section
  // filter's empty/default state) shows every group; selecting one section shows only its group,
  // via the SAME data-section attribute the row template above already carries.
  const sectionOrder: string[] = [];
  const findingsBySection = new Map<string, Finding[]>();
  // Global chrome is shown as its own top-level region: the site header and footer carry the region B7 gave them
  // (a run that predates it carries none and is titled exactly as before).
  const regionOfKey = new Map<string, NonNullable<Finding['location']['region']>>();
  const titleOf = (name: string, region: Finding['location']['region'] | undefined): string => (region === 'global-header' || region === 'global-footer' ? REGION_LABEL[region] : name);
  for (const section of data.sections ?? []) {
    const key = `${section.pageId}/${section.id}`;
    if (section.region) regionOfKey.set(key, section.region);
    sectionOrder.push(key); findingsBySection.set(key, []); sectionNames.set(key, titleOf(section.name, section.region));
  }
  for (const f of data.findings) {
    const sec = sectionKey(f);
    if (f.location.region) regionOfKey.set(sec, f.location.region);
    sectionNames.set(sec, titleOf(f.location.section, f.location.region));
    if (!findingsBySection.has(sec)) {
      findingsBySection.set(sec, []);
      sectionOrder.push(sec);
    }
    findingsBySection.get(sec)!.push(f);
  }
  const findingRows = sectionOrder
    .map((sec) => {
      const group = inReadingOrder(findingsBySection.get(sec)!);
      const incorrectCount = group.filter((f) => findingStatus(f) === 'INCORRECT').length;
      const reviewCount = group.filter((f) => findingStatus(f) === 'NEEDS_REVIEW' || findingStatus(f) === 'UNVERIFIED').length;
      const fixCountInGroup = group.filter((f) => fixPlanDecisions.get(f.identity.findingId) === 'fix').length;
      const counts = (rows: Finding[]) => `${rows.length} finding${rows.length === 1 ? '' : 's'} · ${rows.filter((f) => findingStatus(f) === 'INCORRECT').length} Incorrect · ${rows.filter((f) => findingStatus(f) === 'NEEDS_REVIEW' || findingStatus(f) === 'UNVERIFIED').length} Review · Fix ${rows.filter((f) => fixPlanDecisions.get(f.identity.findingId) === 'fix').length}`;
      const regionKind = regionOfKey.get(sec);
      if ((regionKind === 'global-header' || regionKind === 'global-footer') && group.length > 0) {
        // The Global Header / Global Footer are ACCORDIONS, collapsed by default: the region header row is a disclosure
        // <button aria-expanded>; its rows and sub-group headers carry `data-gr data-gr-collapsed`, appended at the END of
        // each tag so every other attribute (data-section, data-group, data-classification …) is exactly where it was.
        const collapsedRow = (f: Finding) => findingRowHtml(f).replace(/^(<div class="frow"[^>]*)>/, '$1 data-gr data-gr-collapsed>');
        const toggle = `<button type="button" class="fsec-header fsec-region fsec-toggle" data-section="${escapeHtml(sec)}" aria-expanded="false">${escapeHtml(sectionNames.get(sec) ?? sec)} · ${counts(group)}${FSEC_CHEVRON}</button>`;
        if (regionKind === 'global-header' && group.some((f) => f.location.group)) {
          // Global Header › Base Navigation · each menu (in the order found) · Search · Account/User Menu
          const found: string[] = [];
          for (const f of group) { const g = f.location.group ?? BASE_NAVIGATION; if (!found.includes(g)) found.push(g); }
          const groups = found.map((g, i) => ({ g, i })).sort((a, b) => headerGroupRank(a.g) - headerGroupRank(b.g) || a.i - b.i).map((x) => x.g);
          return toggle + groups.map((g) => {
            const rows = group.filter((f) => (f.location.group ?? BASE_NAVIGATION) === g);
            return `<div class="fsec-header fsub-header" data-section="${escapeHtml(sec)}" data-group="${escapeHtml(g)}" data-gr data-gr-collapsed>${escapeHtml(g)} · ${counts(rows)}</div>` + rows.map(collapsedRow).join('');
          }).join('');
        }
        return toggle + group.map(collapsedRow).join('');
      }
      const header = `<div class="fsec-header" data-section="${escapeHtml(sec)}"${group.length ? '' : ' data-empty="true"'}>${escapeHtml(sectionNames.get(sec) ?? sec)} · ${group.length} finding${group.length === 1 ? '' : 's'} · ${incorrectCount} Incorrect · ${reviewCount} Review · Fix ${fixCountInGroup}</div>`;
      return header + group.map(findingRowHtml).join('');
    })
    .join('');
  // Options follow the canonical page order; stable IDs keep duplicate names distinct.
  const sectionFilterOptions = sectionOrder;

  // Server-rendered so the bar shows real counts on first paint rather than flashing zeros before
  // the client script runs — the client script keeps this element live after that.
  const fixCount = [...fixPlanDecisions.values()].filter((d) => d === 'fix').length;
  const skipCount = [...fixPlanDecisions.values()].filter((d) => d === 'skip').length;
  const keepCount = [...fixPlanDecisions.values()].filter((d) => d === 'keep_for_review').length;
  const undecidedCount = data.findings.length - fixPlanDecisions.size;

  const componentRows = data.componentSummary
    .map(
      (c) => `<tr><td>${escapeHtml(c.dsComponent ?? '—')}</td><td>${escapeHtml(c.dsVariant ?? '—')}</td><td>${escapeHtml(c.productionType)}</td>
      <td>${c.instances}</td><td>${c.match}</td><td>${c.deviation}</td><td>${c.incorrect}</td><td>${c.needsReview ?? '—'}</td><td>${c.notCompared ?? '—'}</td><td>${c.compliancePercent === null ? '—' : c.compliancePercent + '%'}</td></tr>`,
    )
    .join('');

  const pageRows = data.pageSummary
    .map(
      (p) => `<tr><td class="mono">${escapeHtml(p.url)}</td><td>${escapeHtml(p.templateFamily ?? 'unclassified')}</td><td>${p.componentsChecked}</td>
      <td>${p.compliance.match}</td><td>${p.compliance.deviation}</td><td>${p.compliance.incorrect}</td><td>${p.compliance.needsReview ?? '—'}</td><td>${p.compliance.notCompared ?? '—'}</td>
      <td>${p.compliance.compliancePercent === null ? '—' : p.compliance.compliancePercent + '%'}</td>
      <td>${p.settled ? 'settled' : '<span class="muted">partial</span>'}</td></tr>`,
    )
    .join('');

  const issueRows = data.globalIssues
    .map(
      (i) => `<tr><td>${escapeHtml(i.title)}</td><td><span class="pill ${i.severity}">${escapeHtml(i.severity)}</span></td>
      <td>${i.occurrences}</td><td>${i.affectedPages.length}</td><td>${escapeHtml(recommendationForDisplay(i.example.recommendation, roots.ofUrl(i.example.url)))}</td></tr>`,
    )
    .join('');

  // New Component Plan candidates — a UI/export layer only, on top of findings B6 already fully
  // classified (NEW_COMPONENT/DS_CANDIDATE). Deliberately its own checkbox class, own data seed,
  // own DOM region: never the Fix Plan's .fp-cb/decisions, and never driven by the Fix Plan bar.
  const newComponentCandidates = [...data.newComponents, ...data.dsCandidates];

  // Repetition count shown on every candidate card (current-state AND post-fix alike) — the same
  // signature-grouping signal computePostFixOpportunities uses internally, computed once here
  // purely for display so a current-state row can show "N instances" too.
  const signatureCounts = new Map<string, number>();
  for (const f of data.findings) signatureCounts.set(f.component.signature, (signatureCounts.get(f.component.signature) ?? 0) + 1);

  // Reuses the SAME evidence a real B6 finding already carries (component.screenshots.element/
  // context, captured during the original audit) — never a new capture, never re-measured. A
  // section-level pattern (a heading, not a tight control) shows the wider context shot first,
  // since a bare text crop is uninformative on its own; everything else prefers the tight element
  // crop. A shot with nothing visible in it (a hidden element's flat crop) yields to the other
  // kind, which in turn falls back to no evidence at all — never a broken or empty-looking image.
  const pickEvidenceForCandidate = (f: Finding): EvidencePick | null =>
    pickEvidence(f, /section/i.test(f.component.productionType) ? ['context-screenshot', 'element-screenshot'] : ['element-screenshot', 'context-screenshot']);

  // One shared card template for both candidate kinds — same compact/expandable shape as .frow,
  // same thumbnail-links-to-full-size idiom as .rv-shot. Clicking the thumbnail opens the exact
  // same evidence image at full size in a new tab; nothing new is built for that.
  function ncpRowHtml(v: {
    findingId: string;
    candidateSource: 'current_state' | 'post_fix';
    statusHtml: string;
    productionType: string;
    productionLabel: string;
    section: string;
    instances: number;
    summaryText: string;
    detailHtml: string;
    evidence: EvidencePick | null;
  }): string {
    const thumb = v.evidence
      ? `<a href="${v.evidence.url}" target="_blank" rel="noopener"${v.evidence.fellBackFrom === 'element-screenshot' ? ' class="thumb-context"' : ''}${thumbTitleAttr(v.evidence)}>${thumbImgHtml(v.evidence, `evidence for ${v.productionType}`)}</a>`
      : '<span class="none">no evidence</span>';
    return `<div class="ncp-row" data-finding-id="${escapeHtml(v.findingId)}" data-candidate-source="${v.candidateSource}">
      <div class="ncp-row-main">
        <input type="checkbox" class="ncp-cb" data-finding-id="${escapeHtml(v.findingId)}" aria-label="Select ${escapeHtml(v.productionType)} for the New Component Plan">
        <span class="ncp-added" hidden>✓ Added <button type="button" class="ncp-remove" aria-label="Remove from New Component Plan" title="Remove">×</button></span>
        ${v.statusHtml}
        <span class="ncp-name"><b>${escapeHtml(v.productionType)}</b> <span class="muted">${escapeHtml(v.productionLabel.slice(0, 40))}</span></span>
        <span class="ncp-meta">${escapeHtml(v.section)} · ${v.instances} instance${v.instances === 1 ? '' : 's'}</span>
        <span class="ncp-summary">${escapeHtml(v.summaryText)}</span>
        <span class="ncp-thumb">${thumb}</span>
        <button type="button" class="ncp-expand" aria-expanded="false">Details</button>
      </div>
      <div class="ncp-detail" hidden>${v.detailHtml}</div>
    </div>`;
  }

  const neutralRows = newComponentCandidates
    .map((f) => {
      const evidence = pickEvidenceForCandidate(f);
      const detailHtml = `<div class="ncp-detail-grid">
        <div><dt>Signature</dt><dd class="mono">${escapeHtml(f.component.signature)}</dd></div>
        <div><dt>Confidence</dt><dd>${f.quality.confidence.toFixed(2)}</dd></div>
        <div><dt>Registry request</dt><dd class="mono">${escapeHtml(f.action.registryUpdateRef ?? '—')}</dd></div>
      </div>
      <dt>Note</dt><dd>${escapeHtml(recommendationForDisplay(f.action.dsCandidateNote ?? f.action.recommendation, roots.of(f)))}</dd>
      <dt>Evidence</dt><dd class="evidence">${evidence ? `<a href="${evidence.url}" target="_blank" rel="noopener"><img src="${evidence.url}" alt="evidence" loading="lazy"></a>${evidenceNoteHtml(evidence)}` : '<span class="muted">—</span>'}</dd>`;
      return ncpRowHtml({
        findingId: f.identity.findingId,
        candidateSource: 'current_state',
        statusHtml: `<span class="pill ${f.classification}">${escapeHtml(statusLabel(f.classification))}</span>`,
        productionType: f.component.productionType,
        productionLabel: f.component.productionLabel,
        section: f.location.section,
        instances: signatureCounts.get(f.component.signature) ?? 1,
        summaryText: recommendationForDisplay(f.action.dsCandidateNote ?? f.action.recommendation, roots.of(f)),
        detailHtml,
        evidence,
      });
    })
    .join('');

  // Post-Fix Component Opportunity (additive, render-time only): a repeated, currently-unmatched
  // pattern whose sole blocker is a known foundation-rule violation — never B6's own classification,
  // never a data.json field. Uses the SAME .ncp-cb checkbox/export system as a real candidate row,
  // never the Fix Plan's, and is visually marked "Potential — after fixes" (dashed pill) so it is
  // never confused with a classification B6 actually made. computePostFixOpportunities() itself is
  // untouched — only its already-returned fields are used here, plus a lookup into data.findings
  // for the representative finding's own evidence (never re-measured, never a new capture).
  const postFixOpportunities = computePostFixOpportunities(data.findings);
  const findingById = new Map(data.findings.map((f) => [f.identity.findingId, f]));
  const postFixRows = postFixOpportunities
    .map((o) => {
      const repFinding = findingById.get(o.representativeFindingId);
      const evidence = repFinding ? pickEvidenceForCandidate(repFinding) : null;
      const sourceIds = [o.representativeFindingId, ...o.relatedFindingIds];
      const ruledOut = o.ruledOutDsComponent ? `closest DS look-alike (${escapeHtml(o.ruledOutDsComponent)}) checked and ruled out` : 'no existing DS component resembled it';
      const detailHtml = `<div class="ncp-detail-grid">
        <div><dt>Signature</dt><dd class="mono">${escapeHtml(o.signature)}</dd></div>
        <div><dt>Confidence</dt><dd>${o.confidence}</dd></div>
        <div><dt>Existing DS component</dt><dd>${escapeHtml(ruledOut)}</dd></div>
      </div>
      <dt>Source finding(s)</dt><dd class="mono">${sourceIds.map((id) => escapeHtml(id)).join(', ')}</dd>
      <dt>Fix first</dt><dd><ul>${o.whatToFixFirst.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></dd>
      <dt>Evidence</dt><dd class="evidence">${evidence ? `<a href="${evidence.url}" target="_blank" rel="noopener"><img src="${evidence.url}" alt="evidence" loading="lazy"></a>${evidenceNoteHtml(evidence)}` : '<span class="muted">—</span>'}</dd>`;
      return ncpRowHtml({
        findingId: o.representativeFindingId,
        candidateSource: 'post_fix',
        statusHtml: '<span class="pill DS_CANDIDATE post-fix">Potential — after fixes</span>',
        productionType: o.productionType,
        productionLabel: o.productionLabel,
        section: o.section,
        instances: o.instances,
        summaryText: o.reason,
        detailHtml,
        evidence,
      });
    })
    .join('');

  // Findable by findingId only — never Finding content — so the client script can resolve a
  // future Design System Update Agent's needs (classification) without re-deriving it from the DOM.
  const newComponentSeed = [
    ...newComponentCandidates.map((f) => ({ findingId: f.identity.findingId, classification: f.classification, candidateSource: 'current_state' })),
    ...postFixOpportunities.map((o) => ({
      findingId: o.representativeFindingId,
      classification: 'DS_CANDIDATE',
      candidateSource: 'post_fix',
      relatedFindingIds: o.relatedFindingIds,
    })),
  ];

  const coverage = data.coverageSummary;
  const compliance = s.compliancePercent;

  return layout(
    `${projectName} — ${data.run.runId}`,
    `<header>
      <h1>${escapeHtml(projectName)}</h1>
      <span class="meta"><a href="/">projects</a> · <a href="/projects/${encodeURIComponent(projectName)}">runs</a> · run <span class="mono">${escapeHtml(data.run.runId)}</span> · ${escapeHtml(data.run.mode)} · ${escapeHtml(data.run.startedAt)}</span>
      <span class="meta">DS version <span class="mono">${escapeHtml(data.run.dsRegistryVersion.slice(0, 12))}</span> · browser <span class="mono">${escapeHtml(
        data.run.renderingPolicy ? describeRenderingEngine(data.run.renderingPolicy) : 'not recorded',
      )}</span> · AI mode <span class="mono">${escapeHtml(data.run.aiMode === 'no-api' ? 'no-api (deterministic, no model calls)' : (data.run.aiMode ?? 'not recorded'))}</span></span>
     </header>
     <main>
      <div class="fp-scope">
      <div class="fp-bar">
        <span class="sel" id="fp-selected">0 selected</span>
        <button type="button" id="fp-fix" class="d-fix" disabled>Mark as Fix</button>
        <button type="button" id="fp-skip" class="d-skip" disabled>Mark as Skip</button>
        <button type="button" id="fp-keep" class="d-keep" disabled>Mark as Keep for Review</button>
        <button type="button" id="fp-clear" class="quiet" disabled>Clear Decision</button>
        <span class="fp-counts" id="fp-counts">Fix ${fixCount} · Skip ${skipCount} · Review ${keepCount} · Undecided ${undecidedCount}</span>
        <span class="spacer"></span>
        <span class="muted fp-note">Decisions are yours, not the audit's — <span class="mono">data.json</span> is never modified.</span>
        <button type="button" id="fp-clear-all" class="quiet">Clear All Decisions</button>
        <button type="button" id="fp-export" class="primary">Export Fix Plan (${fixPlanDecisions.size})</button>
      </div>
      <section><h2>Summary</h2>
        <div class="cards">
          ${card(compliance === null ? '—' : `${compliance}%`, 'Compliance')}
          ${card(s.match, 'Match', 'match')}${card(s.deviation, 'Deviation', 'deviation')}${card(s.incorrect, 'Incorrect', 'incorrect')}
          ${card(s.dsCandidate, 'DS candidates')}${card(s.newComponent, 'New components')}
          ${card(needsReviewCount, 'Needs review', 'needsReview')}${card(unverifiedCount, 'Unverified', 'unverified')}${card(counts?.RESOLVED ?? '—', 'Resolved — not on page')}
          ${card(data.reAudit.resolved, 'Resolved since last run')}${card(s.componentsChecked, 'Components checked')}${card(s.pagesAudited, 'Pages audited')}
          ${card(s.escalationsQueued, 'Awaiting review')}
        </div>
        ${compliance === null ? '' : `<div class="bar"><i style="width:${compliance}%"></i></div>`}
        ${coverageGateHtml(data)}
        <p class="muted" style="font-size:13px">Compliance counts MATCH ÷ (MATCH + DEVIATION + INCORRECT). DS candidates and new components are deliberately excluded, and so is everything that needs a human decision: NEEDS REVIEW (the status could not be decided without semantic judgment) and UNVERIFIED (a matched component nothing could be compared on). RESOLVED rows are history — prior issues whose element is gone.</p>
        ${
          data.reAudit.previousRunId
            ? `<p class="note">Re-audit vs <span class="mono">${escapeHtml(data.reAudit.previousRunId)}</span>: ${data.reAudit.newIssues} new · ${data.reAudit.stillOpen} still open · ${data.reAudit.resolved} resolved · ${data.reAudit.regressions} regressions${
                data.reAudit.unverified ? ` · ${data.reAudit.unverified} prior issue(s) not re-verified` : ''
              }</p>${
                data.reAudit.baselineChanges?.length
                  ? `<p class="note">The comparison baseline changed since that run, so status changes across it are not counted as regressions or resolutions: ${data.reAudit.baselineChanges
                      .map((b) => `${escapeHtml(b.note)} (${b.findings} finding(s))`)
                      .join(' · ')}</p>`
                  : ''
              }`
            : ''
        }
        ${
          coverage
            ? (() => {
                // A run predating a later-added coverage sub-field (e.g. OUT-1's sampledListings)
                // still has to render, never crash on the older data.json (third-pass review OUT-6).
                const truncation = coverage.truncation ?? [];
                const droppedRefs = coverage.droppedRefs ?? [];
                const sampledListings = coverage.sampledListings ?? [];
                return `<p class="muted" style="font-size:13px">Coverage: ${coverage.sectionsAnalyzed} sections · ${coverage.componentsDetected} components · ${coverage.excludedPersonalized} personalized section(s) excluded · ${coverage.excludedOffDomain} off-domain link(s) excluded · ${coverage.unexpandedStates} unexpanded state(s) · ${droppedRefs.length} unresolvable element reference(s)${sampledListings.length ? ` · ${sampledListings.length} listing(s) sampled` : ''}</p>${
                  truncation.length > 0 || droppedRefs.length > 0 || sampledListings.length > 0
                    ? `<details class="note"><summary>Coverage boundaries (${truncation.length}), dropped element references (${droppedRefs.length}) and sampled listings (${sampledListings.length})</summary><ul>${[
                        ...truncation.map((t) => `<li><b>${escapeHtml(t.what)}</b> — ${escapeHtml(t.detail)}${data.pageSummary.length > 1 ? ` <span class="muted">(${escapeHtml(t.pageUrl)})</span>` : ''}</li>`),
                        ...droppedRefs.map((d) => `<li><span class="mono">${escapeHtml(d.node)} ${escapeHtml(d.ref)}</span> — ${escapeHtml(d.reason)}${data.pageSummary.length > 1 ? ` <span class="muted">(${escapeHtml(d.pageUrl)})</span>` : ''}</li>`),
                        ...sampledListings.map((s) => `<li><b>${escapeHtml(s.section)}</b> — ${s.sampled} of ${s.totalObserved} audited (bounded listing sample)${data.pageSummary.length > 1 ? ` <span class="muted">(${escapeHtml(s.pageUrl)})</span>` : ''}</li>`),
                      ].join('')}</ul></details>`
                    : ''
                }`;
              })()
            : ''
        }
      </section>

      <section><h2>Findings</h2>
        <div class="controls">
          <label class="sel" style="min-width:0"><input type="checkbox" class="fp-cb" id="fp-all" aria-label="Select all visible findings"> <span class="muted" style="font-size:12.5px">select all visible</span></label>
          <select id="f-class"><option value="">All statuses</option>${FINDING_STATUSES.map((c) => `<option value="${c}">${escapeHtml(statusLabel(c))}</option>`).join('')}</select>
          <select id="f-sev"><option value="">All severities</option>${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((c) => `<option>${c}</option>`).join('')}</select>
          <select id="f-section" aria-label="Filter by section"><option value="">View All</option>${sectionFilterOptions.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(sectionNames.get(s) ?? s)} (${findingsBySection.get(s)?.length ?? 0})</option>`).join('')}</select>
          <input type="search" id="f-q" placeholder="Search component, section, property…" size="34">
          <select id="f-sort" aria-label="Sort by"><option value="">Sort: default order</option><option value="severity">Sort: Severity</option><option value="status">Sort: Status</option><option value="confidence">Sort: Confidence</option></select>
          <button type="button" id="f-sort-dir" class="sort-dir">↑ Asc</button>
          <span class="muted" id="shown"></span>
        </div>
        <div id="findings">${findingRows || '<p class="muted" style="padding:12px">None</p>'}</div>
      </section>

      <section><h2>Global issues</h2><table><thead><tr><th>Issue</th><th>Severity</th><th>Occurrences</th><th>Pages</th><th>Recommendation</th></tr></thead><tbody>${issueRows || '<tr><td colspan="5" class="muted">None</td></tr>'}</tbody></table></section>

      <section><h2>Components</h2><table><thead><tr><th>DS component</th><th>Variant</th><th>Production type</th><th>Instances</th><th>Match</th><th>Deviation</th><th>Incorrect</th><th>Needs review</th><th>Unverified</th><th>Compliance</th></tr></thead><tbody>${componentRows || '<tr><td colspan="10" class="muted">None</td></tr>'}</tbody></table></section>

      <section><h2>Pages</h2><table><thead><tr><th>URL</th><th>Template</th><th>Components</th><th>Match</th><th>Deviation</th><th>Incorrect</th><th>Needs review</th><th>Unverified</th><th>Compliance</th><th>Capture</th></tr></thead><tbody>${pageRows}</tbody></table></section>
      </div>

      <section><h2>New components &amp; DS candidates</h2>
        ${postFixOpportunities.length ? `<p class="muted" style="margin:0 0 10px">Cards marked <span class="pill DS_CANDIDATE post-fix">Potential — after fixes</span> are not a B6 classification — they are repeated, currently-unmatched patterns whose only known blocker is a measured foundation-rule violation. Select and export them exactly like any other candidate below; nothing here is added automatically.</p>` : ''}
        ${
          newComponentCandidates.length + postFixOpportunities.length
            ? `<div class="ncp-bar">
          <input type="checkbox" class="ncp-cb" id="ncp-all" aria-label="Select all visible candidates">
          <span class="sel" id="ncp-selected">0 selected</span>
          <button type="button" id="ncp-select-visible">Select all visible</button>
          <button type="button" id="ncp-add" disabled>Add New Component</button>
          <span class="spacer"></span>
          <span class="muted fp-note" id="ncp-staged">0 staged</span>
          <button type="button" id="ncp-export" class="primary">Export New Component Plan (0)</button>
        </div>`
            : ''
        }
        <div class="ncp-list">${neutralRows + postFixRows || '<p class="muted" style="padding:12px">None</p>'}</div>
      </section>
      <script type="application/json" id="ncp-seed">${JSON.stringify(newComponentSeed).replace(/</g, '\\u003c')}</script>

      ${data.failedPages.length ? `<section><h2>Failed / skipped pages</h2><table><thead><tr><th>URL</th><th>Reason</th></tr></thead><tbody>${data.failedPages.map((f) => `<tr><td class="mono">${escapeHtml(f.url)}</td><td>${escapeHtml(f.reason)}</td></tr>`).join('')}</tbody></table></section>` : ''}
     </main>
     <script type="application/json" id="fp-seed">${JSON.stringify(fixPlan ?? { schemaVersion: 1, runId: data.run.runId, updatedAt: null, entries: [] }).replace(/</g, '\\u003c')}</script>
     <script>${SCRIPT}</script>`,
    { runId: data.run.runId, source: fpSource, totalFindings: data.findings.length },
  );
}
