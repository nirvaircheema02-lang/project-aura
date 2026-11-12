import type { AuditData } from '../../agents/c2-json-writer/index.ts';
import { describeRenderingEngine } from '../../graph/run-metadata.ts';
import { FINDING_STATUSES, findingStatus, isNotCompared, reAuditLabel, statusLabel, type Finding } from '../../skills/s0-result-contract.ts';

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
 * BUMP THE VERSION whenever the visual template itself changes (new section, different
 * card layout, a new status color) — never for a data change, which is what every future
 * audit is expected to vary. Stamped into every rendered page as an HTML comment
 * (`layout()` below) so a shared file can always be traced back to the template version
 * that produced it.
 */
export const HTML_TEMPLATE_VERSION = 'html-report-v1'; // v1: initial locked baseline — summary cards, sortable/filterable findings + review tables, standalone data:-URI evidence, the 5-color STATUS_COLORS palette (Unverified corrected to a genuinely distinct gray, not amber+dashed)

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

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
`;

const SCRIPT = `
const rows = () => Array.from(document.querySelectorAll('#findings tbody tr'));
function applyFilters() {
  const cls = document.getElementById('f-class').value;
  const sev = document.getElementById('f-sev').value;
  const band = document.getElementById('f-band').value;
  const esc = document.getElementById('f-esc').value;
  const q = document.getElementById('f-q').value.toLowerCase();
  let shown = 0;
  for (const tr of rows()) {
    const ok =
      (!cls || tr.dataset.classification === cls) &&
      (!sev || tr.dataset.severity === sev) &&
      (!band || tr.dataset.band === band) &&
      (!esc || tr.dataset.escalation === esc) &&
      (!q || tr.textContent.toLowerCase().includes(q));
    tr.hidden = !ok;
    if (ok) shown++;
  }
  document.getElementById('shown').textContent = shown + ' of ' + rows().length + ' findings';
}
for (const id of ['f-class','f-sev','f-band','f-esc','f-q']) {
  document.getElementById(id)?.addEventListener('input', applyFilters);
}
document.querySelectorAll('#findings th[data-sort]').forEach((th, idx) => {
  th.addEventListener('click', () => {
    const tbody = document.querySelector('#findings tbody');
    const dir = th.dataset.dir === 'asc' ? -1 : 1;
    th.dataset.dir = dir === 1 ? 'asc' : 'desc';
    const sorted = rows().sort((a, b) => {
      const av = a.children[idx].dataset.sortValue ?? a.children[idx].textContent;
      const bv = b.children[idx].dataset.sortValue ?? b.children[idx].textContent;
      const an = Number(av), bn = Number(bv);
      return (Number.isNaN(an) || Number.isNaN(bn) ? String(av).localeCompare(String(bv)) : an - bn) * dir;
    });
    for (const tr of sorted) tbody.appendChild(tr);
  });
});
applyFilters();
function applyReviewFilters() {
  const status = document.getElementById('r-status')?.value ?? '';
  const q = (document.getElementById('r-q')?.value ?? '').toLowerCase();
  let shown = 0;
  const items = Array.from(document.querySelectorAll('#review .rv'));
  for (const el of items) {
    const ok = (!status || el.dataset.status === status) && (!q || el.textContent.toLowerCase().includes(q));
    el.hidden = !ok;
    if (ok) shown++;
  }
  const counter = document.getElementById('r-shown');
  if (counter) counter.textContent = shown + ' of ' + items.length + ' items';
}
for (const id of ['r-status','r-q']) document.getElementById(id)?.addEventListener('input', applyReviewFilters);
applyReviewFilters();
`;

function layout(title: string, body: string): string {
  return `<!doctype html><!-- ${HTML_TEMPLATE_VERSION} --><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
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
 * One Needs Review item: everything a reviewer needs to make the decision the
 * system could not — the evidence, where it is, what was detected, which DS
 * components it might be, the measured values against the closest DS values,
 * and why no deterministic decision was possible. All of it read from C2.
 */
function reviewItem(f: Finding, resolveEvidence: EvidenceResolver): string {
  const status = findingStatus(f);
  const shot = f.quality.evidence.find((e) => e.kind === 'element-screenshot') ?? f.quality.evidence.find((e) => e.kind === 'context-screenshot');
  const shotUrl = shot ? resolveEvidence(shot.ref) : null;
  const review = f.review;
  const signals = review?.signals.length ? review.signals : [];
  const matches = review?.possibleMatches ?? [];
  const observed = review?.observed.length
    ? review.observed
    : f.comparison.mismatches.map((m) => ({ property: m.property, actual: m.actual, expected: m.expected, expectedToken: m.expectedToken }));
  return `<article class="rv" data-status="${status}">
    <div class="rv-shot">${shotUrl ? `<a href="${shotUrl}" target="_blank"><img src="${shotUrl}" alt="evidence for ${escapeHtml(f.component.productionLabel.slice(0, 40))}" loading="lazy"></a>` : '<div class="none">no screenshot captured</div>'}</div>
    <div>
      <div class="rv-head"><span class="pill ${status}">${escapeHtml(statusLabel(status))}</span>
        <b>${escapeHtml(f.component.productionType)}</b> <span>${escapeHtml(f.component.productionLabel.slice(0, 80) || '(no label)')}</span>
        <span class="muted">confidence ${f.quality.confidence.toFixed(2)} ${escapeHtml(f.quality.confidenceBand)}</span></div>
      <div class="rv-where mono">${escapeHtml(f.location.url)} · ${escapeHtml(f.location.section)}</div>
      <p class="rv-why"><b>Why no deterministic decision:</b> ${escapeHtml(review?.reason ?? f.action.recommendation)}</p>
      <div class="rv-grid">
        <div><h4>Detected signals</h4>${signals.length ? `<ul>${signals.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '<span class="muted">—</span>'}</div>
        <div><h4>Possible DS matches</h4>${
          matches.length
            ? `<ol>${matches.map((m) => `<li><b>${escapeHtml(m.dsComponent)}</b>${m.dsVariant ? ` <span class="muted">${escapeHtml(m.dsVariant)}</span>` : ''} · ${m.score.toFixed(2)} <span class="muted">— ${escapeHtml(m.why)}</span></li>`).join('')}</ol>`
            : '<span class="muted">none in the Design System catalog</span>'
        }</div>
      </div>
      ${
        observed.length
          ? `<table><thead><tr><th>Property</th><th>Actual</th><th>Expected (DS)</th></tr></thead><tbody>${observed
              .map((o) => `<tr><td class="mono">${escapeHtml(o.property)}</td><td class="mono">${escapeHtml(o.actual)}</td><td class="mono">${escapeHtml(o.expected ?? '—')}${o.expectedToken ? ` <span class="muted">${escapeHtml(o.expectedToken)}</span>` : ''}</td></tr>`)
              .join('')}</tbody></table>`
          : ''
      }
    </div>
  </article>`;
}

export function renderRun(projectName: string, data: AuditData, evidence: string | EvidenceResolver, usedRefs?: Set<string>): string {
  const base = resolverFor(evidence);
  // Every evidence ref this render actually looked up, in one pass — so a caller building a
  // report package (src/agents/c1-html-reporter/index.ts) knows exactly which files to bundle
  // without re-deriving the same "which shot wins" selection logic a second time.
  const resolveEvidence: EvidenceResolver = usedRefs
    ? (ref) => {
        usedRefs.add(ref);
        return base(ref);
      }
    : base;
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
  // A run written before needsReview/unverified were split out as their own arrays (third-pass
  // review OUT-6) still has to populate the review queue — recomputed from the findings
  // themselves rather than left falsely empty.
  const reviewItems = [
    ...(data.needsReview ?? data.findings.filter((f) => findingStatus(f) === 'NEEDS_REVIEW')),
    ...(data.unverified ?? data.findings.filter(isNotCompared)),
  ];

  const findingRows = data.findings
    .map((f) => {
      const m = f.comparison.mismatches[0];
      const rule = f.comparison.ruleViolations[0];
      const shot = f.quality.evidence.find((e) => e.kind === 'element-screenshot');
      const shotUrl = shot ? resolveEvidence(shot.ref) : null;
      // One status per finding, from S0: a not-compared match is UNVERIFIED — never a plain
      // MATCH — and S7's record of a prior issue whose element is gone is RESOLVED history.
      const status = findingStatus(f);
      return `<tr data-classification="${status}" data-severity="${f.quality.severity}" data-band="${f.quality.confidenceBand}" data-escalation="${f.quality.escalationStatus}">
      <td><span class="pill ${f.quality.severity}">${f.quality.severity}</span></td>
      <td><span class="pill ${status}">${escapeHtml(statusLabel(status))}</span></td>
      <td>${escapeHtml(f.location.section)}</td>
      <td>${escapeHtml(f.component.productionType)} <span class="muted">${escapeHtml(f.component.productionLabel.slice(0, 40))}</span></td>
      <td>${escapeHtml(f.component.dsComponent ?? '—')}${f.component.dsVariant ? ` <span class="muted">/${escapeHtml(f.component.dsVariant)}</span>` : ''}</td>
      <td class="mono">${escapeHtml(m?.property ?? (rule ? rule.ruleId : '—'))}</td>
      <td class="mono">${escapeHtml(m?.actual ?? '—')}</td>
      <td class="mono">${escapeHtml(m?.expected ?? '—')}${m?.expectedToken ? `<br><span class="muted">${escapeHtml(m.expectedToken)}</span>` : ''}</td>
      <td data-sort-value="${f.quality.confidence}">${f.quality.confidence.toFixed(2)} <span class="muted">${escapeHtml(f.quality.confidenceBand)}</span></td>
      <td>${escapeHtml(f.quality.escalationStatus)}${f.quality.escalationReasons.length ? `<br><span class="muted">${escapeHtml(f.quality.escalationReasons.join(', '))}</span>` : ''}</td>
      <td>${escapeHtml(reAuditLabel(f))}${f.history.baselineChanged?.length ? `<br><span class="muted">${escapeHtml(f.history.baselineChanged.join('; '))}</span>` : ''}</td>
      <td class="evidence">${shotUrl ? `<a href="${shotUrl}" target="_blank"><img src="${shotUrl}" alt="evidence" loading="lazy"></a>` : '<span class="muted">—</span>'}</td>
      <td>${escapeHtml(f.review ? `${f.review.reason} ` : '')}${escapeHtml(f.action.recommendation)}</td></tr>`;
    })
    .join('');

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
      <td>${i.occurrences}</td><td>${i.affectedPages.length}</td><td>${escapeHtml(i.example.recommendation)}</td></tr>`,
    )
    .join('');

  const neutralRows = [...data.newComponents, ...data.dsCandidates]
    .map(
      (f) => `<tr><td><span class="pill ${f.classification}">${escapeHtml(statusLabel(f.classification))}</span></td>
      <td>${escapeHtml(f.component.productionType)} <span class="muted">${escapeHtml(f.component.productionLabel.slice(0, 40))}</span></td>
      <td>${escapeHtml(f.location.section)}</td><td class="mono">${escapeHtml(f.component.signature.slice(0, 12))}</td>
      <td>${f.quality.confidence.toFixed(2)}</td><td class="mono">${escapeHtml(f.action.registryUpdateRef ?? '—')}</td>
      <td>${escapeHtml(f.action.dsCandidateNote ?? f.action.recommendation)}</td></tr>`,
    )
    .join('');

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

      <section id="review"><h2>Needs review</h2>
        <p class="muted" style="font-size:13px;margin-top:-6px">What the audit could not decide on its own — never guessed, never counted in the score. Each item shows the evidence, what was detected, the Design System components it might be, the measured values against the closest DS values, and why no deterministic decision was possible.</p>
        ${
          reviewItems.length
            ? `<div class="controls">
          <select id="r-status"><option value="">Needs review + unverified</option><option value="NEEDS_REVIEW">${escapeHtml(statusLabel('NEEDS_REVIEW'))}</option><option value="UNVERIFIED">${escapeHtml(statusLabel('UNVERIFIED'))}</option></select>
          <input type="search" id="r-q" placeholder="Search component, section, DS match…" size="34">
          <span class="muted" id="r-shown"></span>
        </div>
        <div class="review-list">${reviewItems.map((f) => reviewItem(f, resolveEvidence)).join('')}</div>`
            : '<p class="muted">Nothing needs review in this run.</p>'
        }
      </section>

      <section><h2>Findings</h2>
        <div class="controls">
          <select id="f-class"><option value="">All statuses</option>${FINDING_STATUSES.map((c) => `<option value="${c}">${escapeHtml(statusLabel(c))}</option>`).join('')}</select>
          <select id="f-sev"><option value="">All severities</option>${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((c) => `<option>${c}</option>`).join('')}</select>
          <select id="f-band"><option value="">All confidence</option>${['HIGH', 'MEDIUM', 'LOW'].map((c) => `<option>${c}</option>`).join('')}</select>
          <select id="f-esc"><option value="">All review states</option>${['NONE', 'QUEUED', 'IN_REVIEW', 'RESOLVED'].map((c) => `<option>${c}</option>`).join('')}</select>
          <input type="search" id="f-q" placeholder="Search component, section, property…" size="34">
          <span class="muted" id="shown"></span>
        </div>
        <table id="findings"><thead><tr>
          <th data-sort>Severity</th><th data-sort>Status</th><th data-sort>Section</th><th data-sort>Production</th><th data-sort>DS component</th>
          <th data-sort>Property</th><th data-sort>Actual</th><th data-sort>Expected</th><th data-sort>Confidence</th><th data-sort>Review</th><th data-sort>Re-audit</th><th>Evidence</th><th>Recommendation</th>
        </tr></thead><tbody>${findingRows}</tbody></table>
      </section>

      <section><h2>Global issues</h2><table><thead><tr><th>Issue</th><th>Severity</th><th>Occurrences</th><th>Pages</th><th>Recommendation</th></tr></thead><tbody>${issueRows || '<tr><td colspan="5" class="muted">None</td></tr>'}</tbody></table></section>

      <section><h2>Components</h2><table><thead><tr><th>DS component</th><th>Variant</th><th>Production type</th><th>Instances</th><th>Match</th><th>Deviation</th><th>Incorrect</th><th>Needs review</th><th>Unverified</th><th>Compliance</th></tr></thead><tbody>${componentRows || '<tr><td colspan="10" class="muted">None</td></tr>'}</tbody></table></section>

      <section><h2>Pages</h2><table><thead><tr><th>URL</th><th>Template</th><th>Components</th><th>Match</th><th>Deviation</th><th>Incorrect</th><th>Needs review</th><th>Unverified</th><th>Compliance</th><th>Capture</th></tr></thead><tbody>${pageRows}</tbody></table></section>

      <section><h2>New components &amp; DS candidates</h2><table><thead><tr><th>Status</th><th>Component</th><th>Section</th><th>Signature</th><th>Confidence</th><th>Registry request</th><th>Note</th></tr></thead><tbody>${neutralRows || '<tr><td colspan="7" class="muted">None</td></tr>'}</tbody></table></section>

      ${data.failedPages.length ? `<section><h2>Failed / skipped pages</h2><table><thead><tr><th>URL</th><th>Reason</th></tr></thead><tbody>${data.failedPages.map((f) => `<tr><td class="mono">${escapeHtml(f.url)}</td><td>${escapeHtml(f.reason)}</td></tr>`).join('')}</tbody></table></section>` : ''}
     </main>
     <script>${SCRIPT}</script>`,
  );
}
