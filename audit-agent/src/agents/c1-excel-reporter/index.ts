import ExcelJS from 'exceljs';
import type { AuditData } from '../c2-json-writer/index.ts';
import { describeRenderingEngine } from '../../graph/run-metadata.ts';
import { findingStatus, reAuditLabel, statusLabel, type Finding } from '../../skills/s0-result-contract.ts';
import { expectedForDisplay, pageRoots, recommendationForDisplay, type PageRoots } from '../../output/display-values.ts';

/**
 * C1 — Excel / Structured Reporter (v1.0 §11, §15). A mandatory deliverable
 * (ARCHITECTURE.md §6), not evidence. Tabs 01–09 are exactly the spec's; tab
 * 10 lists what needs a human decision (Decision Log #31).
 *
 * C1 reads C2's audit data and NOTHING else — it never recomputes an
 * aggregate, so Excel cannot disagree with the dashboard or Figma about a
 * number (Decision Log #19). Its parity with C2 is tested directly.
 */

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1E' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

function addSheet(wb: ExcelJS.Workbook, name: string, columns: Array<{ header: string; key: string; width: number }>): ExcelJS.Worksheet {
  const sheet = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns;
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  return sheet;
}

/** Severity drives the only conditional colour in the workbook — readable without a legend. */
function severityColor(severity: string): string | null {
  switch (severity) {
    case 'CRITICAL':
      return 'FFF8D7DA';
    case 'HIGH':
      return 'FFFDE2CE';
    case 'MEDIUM':
      return 'FFFFF3CD';
    default:
      return null;
  }
}

export async function buildWorkbook(data: AuditData): Promise<ExcelJS.Workbook> {
  // Each page's measured root font size — an expected `rem` is shown with the px it renders at on ITS page.
  const roots = pageRoots(data);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ken Research AI Design System Audit Agent';
  wb.created = new Date(data.run.startedAt);

  // 01 Executive Summary — website-level counts and compliance.
  const exec = addSheet(wb, '01 Executive Summary', [
    { header: 'Metric', key: 'metric', width: 34 },
    { header: 'Value', key: 'value', width: 52 },
  ]);
  const s = data.websiteSummary;
  for (const [metric, value] of [
    ['Target', data.run.targetUrl],
    ['Mode', data.run.mode],
    ['Run ID', data.run.runId],
    ['Started', data.run.startedAt],
    ['Design System version', data.run.dsRegistryVersion],
    ['Policy version', data.run.policyVersion],
    ['AI mode', aiModeLabel(data)],
    ['Browser engine', data.run.renderingPolicy ? describeRenderingEngine(data.run.renderingPolicy) : 'not recorded'],
    ['Pages audited', s.pagesAudited],
    ['Pages failed/skipped', s.pagesFailed],
    ['Templates detected', s.templatesDetected],
    ['Components checked', s.componentsChecked],
    ['Match', s.match],
    ['Deviation', s.deviation],
    ['Incorrect implementation', s.incorrect],
    ['New components (excluded from score)', s.newComponent],
    ['DS candidates (excluded from score)', s.dsCandidate],
    ['Needs review (excluded from score, awaiting a human decision)', s.needsReview ?? 0],
    ['Unverified — nothing compared (excluded from score, awaiting review)', s.unverified ?? s.notCompared ?? 0],
    ['Resolved — not on page (history only, not the same as fixed)', data.statusCounts?.RESOLVED ?? 0],
    ['Overall compliance %', s.compliancePercent === null ? 'n/a' : s.compliancePercent],
    ['Findings awaiting review', s.escalationsQueued],
    // A run predating coverageSummary (or one of its later-added sub-fields, e.g. OUT-1's
    // sampledListings) still has to render — never a crash on an older data.json (third-pass
    // review OUT-6).
    ['Element references dropped (unresolvable at capture, or cited by a model but absent)', (data.coverageSummary?.droppedRefs ?? []).length],
    ['Coverage boundaries', (data.coverageSummary?.truncation ?? []).map((t) => `${t.what}: ${t.detail}`).join(' | ') || 'none'],
    [
      'Listings sampled (not fully enumerated)',
      (data.coverageSummary?.sampledListings ?? []).map((s) => `${s.section}: ${s.sampled} of ${s.totalObserved} audited`).join(' | ') || 'none',
    ],
    // B7's Coverage Gate (Decision Log #45): the six numbers, and what is missing when it does not pass.
    ['Coverage gate (B7 — every discovered item accounted for)', coverageGateText(data)],
    ['Re-audit — new issues', data.reAudit.newIssues],
    ['Re-audit — still open', data.reAudit.stillOpen],
    ['Re-audit — resolved', data.reAudit.resolved],
    ['Re-audit — regressions', data.reAudit.regressions],
    ['Re-audit — prior issues unverified', data.reAudit.unverified ?? 0],
    ['Re-audit — baseline changes', (data.reAudit.baselineChanges ?? []).map((b) => `${b.note} (${b.findings} finding(s))`).join(' | ') || 'none'],
  ] as Array<[string, string | number]>) {
    exec.addRow({ metric, value });
  }
  exec.getColumn('metric').font = { bold: true };

  // 02 Template Summary
  const templates = addSheet(wb, '02 Template Summary', [
    { header: 'Template', key: 'templateFamily', width: 28 },
    { header: 'Pages', key: 'pages', width: 10 },
    { header: 'Components', key: 'components', width: 14 },
    { header: 'Match', key: 'match', width: 10 },
    { header: 'Deviation', key: 'deviation', width: 12 },
    { header: 'Incorrect', key: 'incorrect', width: 12 },
    { header: 'Needs review', key: 'needsReview', width: 14 },
    { header: 'Unverified', key: 'notCompared', width: 14 },
    { header: 'Compliance %', key: 'compliancePercent', width: 14 },
  ]);
  for (const row of data.templateSummary) templates.addRow({ ...row, needsReview: row.needsReview ?? 0 });

  // 03 Page Summary
  const pages = addSheet(wb, '03 Page Summary', [
    { header: 'URL', key: 'url', width: 62 },
    { header: 'Template', key: 'templateFamily', width: 22 },
    { header: 'Components', key: 'componentsChecked', width: 14 },
    { header: 'Match', key: 'match', width: 10 },
    { header: 'Deviation', key: 'deviation', width: 12 },
    { header: 'Incorrect', key: 'incorrect', width: 12 },
    { header: 'Needs review', key: 'needsReview', width: 14 },
    { header: 'Unverified', key: 'notCompared', width: 14 },
    { header: 'Compliance %', key: 'compliancePercent', width: 14 },
    { header: 'Fully settled', key: 'settled', width: 14 },
    { header: 'HTTP', key: 'httpStatus', width: 8 },
  ]);
  for (const p of data.pageSummary) {
    pages.addRow({
      url: p.url,
      templateFamily: p.templateFamily ?? 'unclassified',
      componentsChecked: p.componentsChecked,
      match: p.compliance.match,
      deviation: p.compliance.deviation,
      incorrect: p.compliance.incorrect,
      needsReview: p.compliance.needsReview ?? 0,
      notCompared: p.compliance.notCompared,
      compliancePercent: p.compliance.compliancePercent,
      settled: p.settled ? 'yes' : 'partial',
      httpStatus: p.httpStatus,
    });
  }

  // 04 All Findings — one row per actionable finding, actual vs expected.
  const findings = addSheet(wb, '04 All Findings', [
    { header: 'Severity', key: 'severity', width: 11 },
    { header: 'Status', key: 'classification', width: 15 },
    { header: 'URL', key: 'url', width: 46 },
    { header: 'Section', key: 'section', width: 22 },
    { header: 'Production component', key: 'production', width: 26 },
    { header: 'DS component', key: 'ds', width: 20 },
    { header: 'DS variant', key: 'variant', width: 14 },
    { header: 'Property', key: 'property', width: 22 },
    { header: 'Actual', key: 'actual', width: 18 },
    { header: 'Expected', key: 'expected', width: 18 },
    { header: 'Expected token', key: 'token', width: 26 },
    { header: 'Rule', key: 'rule', width: 10 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Review state', key: 'escalation', width: 14 },
    { header: 'Visual check', key: 'visual', width: 14 },
    { header: 'Re-audit', key: 'delta', width: 24 },
    { header: 'Why not decided', key: 'reviewReason', width: 50 },
    { header: 'Possible DS matches', key: 'possibleMatches', width: 40 },
    { header: 'Recommendation', key: 'recommendation', width: 60 },
  ]);
  for (const f of data.findings) {
    // "One row per actionable finding" (§15 tab 04). Anything that still needs a
    // human — unverified, needs review — IS actionable, so it is listed; a plain
    // MATCH and S7's history record of a gone element are not.
    const status = findingStatus(f);
    if (status === 'MATCH' || status === 'RESOLVED') continue;
    const rows = f.comparison.mismatches.length > 0 ? f.comparison.mismatches : f.comparison.properties?.length ? f.comparison.properties : [null];
    for (const m of rows) {
      const row = findings.addRow({
        severity: f.quality.severity,
        classification: status,
        url: f.location.url,
        section: f.location.section,
        production: `${f.component.productionType} "${f.component.productionLabel}"`,
        ds: f.component.dsComponent ?? '—',
        variant: f.component.dsVariant ?? '—',
        property: m?.property ?? '—',
        actual: m?.actual ?? 'Not measured',
        expected: m?.expected ? `${'status' in m && m.status === 'UNRESOLVED' ? 'Candidate only: ' : ''}${expectedForDisplay(m.property, m.expected, roots.of(f))}` : 'Not resolved',
        token: m?.expectedToken ?? '—',
        rule: f.comparison.ruleViolations[0]?.ruleId ?? '—',
        confidence: f.quality.confidence,
        escalation: f.quality.escalationStatus,
        visual: f.quality.visualVerdict,
        delta: reAuditLabel(f),
        reviewReason: f.review?.reason ?? '—',
        possibleMatches: possibleMatchesLabel(f),
        recommendation: recommendationForDisplay(f.action.recommendation, roots.of(f)),
      });
      const color = severityColor(f.quality.severity);
      if (color) row.getCell('severity').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    }
  }

  // 05 Component Summary
  const components = addSheet(wb, '05 Component Summary', [
    { header: 'DS component', key: 'dsComponent', width: 24 },
    { header: 'DS variant', key: 'dsVariant', width: 16 },
    { header: 'Production type', key: 'productionType', width: 20 },
    { header: 'Instances', key: 'instances', width: 12 },
    { header: 'Match', key: 'match', width: 10 },
    { header: 'Deviation', key: 'deviation', width: 12 },
    { header: 'Incorrect', key: 'incorrect', width: 12 },
    { header: 'Needs review', key: 'needsReview', width: 14 },
    { header: 'Unverified', key: 'notCompared', width: 14 },
    { header: 'Compliance %', key: 'compliancePercent', width: 14 },
    { header: 'Affected pages', key: 'affected', width: 14 },
  ]);
  for (const c of data.componentSummary) {
    components.addRow({ ...c, needsReview: c.needsReview ?? 0, dsComponent: c.dsComponent ?? '—', dsVariant: c.dsVariant ?? '—', affected: c.affectedPages.length });
  }

  // 06 Global Issues — deduplicated root causes.
  const issues = addSheet(wb, '06 Global Issues', [
    { header: 'Issue', key: 'title', width: 46 },
    { header: 'Status', key: 'classification', width: 15 },
    { header: 'Severity', key: 'severity', width: 11 },
    { header: 'Occurrences', key: 'occurrences', width: 13 },
    { header: 'Pages affected', key: 'pages', width: 15 },
    { header: 'Example URL', key: 'url', width: 46 },
    { header: 'Recommendation', key: 'recommendation', width: 60 },
  ]);
  for (const i of data.globalIssues) {
    issues.addRow({
      title: i.title,
      classification: i.classification,
      severity: i.severity,
      occurrences: i.occurrences,
      pages: i.affectedPages.length,
      url: i.example.url,
      recommendation: recommendationForDisplay(i.example.recommendation, roots.ofUrl(i.example.url)),
    });
  }

  // 07 New Components / 08 DS Candidates
  for (const [name, list] of [
    ['07 New Components', data.newComponents],
    ['08 DS Candidates', data.dsCandidates],
  ] as const) {
    const sheet = addSheet(wb, name, [
      { header: 'Production component', key: 'production', width: 30 },
      { header: 'URL', key: 'url', width: 46 },
      { header: 'Section', key: 'section', width: 22 },
      { header: 'Signature', key: 'signature', width: 34 },
      { header: 'Confidence', key: 'confidence', width: 12 },
      { header: 'Review state', key: 'escalation', width: 14 },
      { header: 'Registry request', key: 'registry', width: 40 },
      { header: 'Note', key: 'note', width: 70 },
    ]);
    for (const f of list) {
      sheet.addRow({
        production: `${f.component.productionType} "${f.component.productionLabel}"`,
        url: f.location.url,
        section: f.location.section,
        signature: f.component.signature,
        confidence: f.quality.confidence,
        escalation: f.quality.escalationStatus,
        registry: f.action.registryUpdateRef ?? '—',
        note: recommendationForDisplay(f.action.dsCandidateNote ?? f.action.recommendation, roots.of(f)),
      });
    }
  }

  // 09 Failed / Skipped Pages
  const failed = addSheet(wb, '09 Failed Skipped Pages', [
    { header: 'URL', key: 'url', width: 62 },
    { header: 'Reason', key: 'reason', width: 80 },
  ]);
  for (const f of data.failedPages) failed.addRow(f);

  // 10 Needs Review — C2's own review queues, in C2's order (Decision Log #31).
  const review = addSheet(wb, '10 Needs Review', [
    { header: 'Status', key: 'status', width: 15 },
    { header: 'URL', key: 'url', width: 46 },
    { header: 'Section', key: 'section', width: 22 },
    { header: 'Detected component', key: 'production', width: 30 },
    { header: 'Detected signals', key: 'signals', width: 40 },
    { header: 'Possible DS matches', key: 'possibleMatches', width: 40 },
    { header: 'Actual vs expected', key: 'observed', width: 50 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Why not decided', key: 'reason', width: 60 },
    { header: 'Evidence', key: 'evidence', width: 50 },
  ]);
  for (const f of [...(data.needsReview ?? []), ...(data.unverified ?? [])]) {
    review.addRow({
      status: statusLabel(findingStatus(f)),
      url: f.location.url,
      section: f.location.section,
      production: `${f.component.productionType} "${f.component.productionLabel}"`,
      signals: (f.review?.signals ?? []).join(', ') || '—',
      possibleMatches: possibleMatchesLabel(f),
      observed: observedLabel(f, roots),
      confidence: f.quality.confidence,
      reason: recommendationForDisplay(f.review?.reason ?? f.action.recommendation, roots.of(f)),
      evidence: f.quality.evidence.find((e) => e.kind === 'element-screenshot')?.ref ?? '—',
    });
  }

  return wb;
}

function coverageGateText(data: AuditData): string {
  const g = data.coverageSummary?.gate;
  if (!g) return 'not recorded — this audit predates the B7 final coverage check';
  const head = `${g.passed ? 'PASSED' : 'INCOMPLETE'} — ${g.discovered} discovered · ${g.audited} audited · ${g.excluded} excluded with reason · ${g.needsReview} need review · ${g.captureFailed} capture failed · ${g.unaccounted} unaccounted`;
  const missing = g.incomplete.flatMap((p) => p.unaccounted.map((i) => `${i.kind} “${i.label}” (${i.section}): ${i.reason}`));
  return missing.length ? `${head}. Missing: ${missing.join(' | ')}` : g.pagesWithoutLedger > 0 ? `${head}. ${g.pagesWithoutLedger} page(s) carry no coverage ledger.` : head;
}

function aiModeLabel(data: AuditData): string {
  if (data.run.aiMode === 'no-api') return 'no-api (deterministic — no model API calls)';
  if (data.run.aiMode === 'anthropic-api') return 'anthropic-api';
  return 'not recorded';
}

function possibleMatchesLabel(f: Finding): string {
  const matches = f.review?.possibleMatches ?? [];
  return matches.length ? matches.map((m) => `${m.dsComponent}${m.dsVariant ? ` (${m.dsVariant})` : ''} ${m.score.toFixed(2)}`).join('; ') : '—';
}

function observedLabel(f: Finding, roots: PageRoots): string {
  const root = roots.of(f);
  if (f.comparison.properties?.length) return f.comparison.properties.map(p => `${p.property}: ${p.actual ?? 'Not measured'} → ${p.expected == null ? 'Not resolved' : expectedForDisplay(p.property, p.expected, root)} (${p.status}${p.note ? '; '+p.note : ''})`).join('; ');
  const observed = f.review?.observed ?? [];
  if (observed.length) return observed.map((o) => `${o.property}: ${o.actual} → ${o.expected == null ? 'no DS value' : expectedForDisplay(o.property, o.expected, root)}${o.expectedToken ? ` (${o.expectedToken})` : ''}`).join('; ');
  return f.comparison.mismatches.map((m) => `${m.property}: ${m.actual} → ${expectedForDisplay(m.property, m.expected, root)}`).join('; ') || '—';
}

export async function writeExcelReport(path: string, data: AuditData): Promise<void> {
  const wb = await buildWorkbook(data);
  await wb.xlsx.writeFile(path);
}
