import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuditData, writeAuditData, type AuditData } from '../../src/agents/c2-json-writer/index.ts';
import { writeExcelReport } from '../../src/agents/c1-excel-reporter/index.ts';
import { ensureRunDirs, loadOrCreateProject, projectNameFor, runPaths } from '../../src/output/run-store.ts';
import { isNotCompared, type Finding, type PageResult } from '../../src/skills/s0-result-contract.ts';
import type { RenderingPolicy } from '../../src/t-layer/browser.ts';
import { describeRenderingEngine } from '../../src/graph/run-metadata.ts';

/**
 * C1 ↔ C2 parity (ARCHITECTURE.md Decision Log #19). C2's data.json is the
 * canonical truth; C1's workbook is checked against IT — never against
 * another output. The numbers are read back out of the generated .xlsx, so
 * this tests what the file actually contains, not what the builder intended.
 */

const RENDERING: RenderingPolicy = {
  engine: 'chromium',
  channel: 'chromium',
  browserVersion: '141.0.7390.37',
  playwrightVersion: '1.63.0',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
  userAgent: 'Mozilla/5.0 Chrome/141.0.7390.37 KenResearchDSAudit/0.1',
};

let dir: string;
let data: AuditData;
let workbook: ExcelJS.Workbook;
let paths: ReturnType<typeof runPaths>;

function finding(over: Partial<Finding> & { classification: Finding['classification'] }): Finding {
  const base: Finding = {
    identity: {
      auditId: 'audit-1',
      runId: 'run-1',
      findingId: `f-${Math.abs(JSON.stringify(over).length)}-${over.classification}`,
      timestamp: '2026-09-11T10:00:00.000Z',
      dsRegistryVersion: 'ds-hash',
      policyVersion: 'policy-1',
    },
    location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Hero', captureState: 'default' },
    component: { productionType: 'button', productionLabel: 'CTA', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-1' },
    classification: over.classification,
    comparison: { mismatches: [], ruleViolations: [] },
    quality: {
      severity: 'LOW',
      confidence: 0.9,
      confidenceBand: 'HIGH',
      escalationStatus: 'NONE',
      escalationReasons: [],
      evidence: [],
      visualVerdict: 'NOT_CHECKED',
    },
    action: { recommendation: 'Do the thing', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: over.classification, delta: null, previousRunId: null },
  };
  return { ...base, ...over, identity: { ...base.identity, ...(over.identity ?? {}) } };
}

const page = (over: Partial<PageResult>): PageResult => ({
  runId: 'run-1',
  pageId: 'p1',
  url: 'https://www.kenresearch.com/a',
  pageName: 'A',
  templateFamily: 'Consulting',
  domHash: 'dom-1',
  dsRegistryVersion: 'ds-hash',
  policyVersion: 'policy-1',
  findings: [],
  compliance: { match: 0, deviation: 0, incorrect: 0, newComponent: 0, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: null },
  coverage: { sectionsAnalyzed: 3, componentsDetected: 5, excludedPersonalized: 1, excludedOffDomain: 1, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
  capture: { settled: true, httpStatus: 200, consoleSummary: '0 messages', criticalFailures: 0 },
  ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-c1c2-'));

  const findings: Finding[] = [
    finding({ classification: 'MATCH' }),
    finding({
      classification: 'DEVIATION',
      quality: { severity: 'MEDIUM', confidence: 0.8, confidenceBand: 'MEDIUM', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'CONFIRMED' },
      comparison: {
        mismatches: [{ property: 'height', actual: '44px', expected: '48px', expectedToken: '--button-height-md', comparison: 'length-px', delta: -4 }],
        ruleViolations: [],
      },
      history: { previousStatus: 'MATCH', currentStatus: 'DEVIATION', delta: 'REGRESSION', previousRunId: 'run-0' },
    }),
    finding({
      classification: 'INCORRECT',
      quality: { severity: 'CRITICAL', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'QUEUED', escalationReasons: ['CALIBRATION_SAMPLE'], evidence: [], visualVerdict: 'CONFIRMED' },
      comparison: { mismatches: [], ruleViolations: [{ ruleId: 'R1.2', title: 'Brand red is CTA-only', why: 'decorative use' }] },
    }),
    finding({ classification: 'NEW_COMPONENT', component: { productionType: 'card', productionLabel: 'Preview', dsComponent: null, dsVariant: null, signature: 'sig-2' } }),
    // A matched component nothing could be compared on — must NOT count as compliant.
    finding({
      classification: 'MATCH',
      component: { productionType: 'button', productionLabel: 'Unverified CTA', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-nc' },
      quality: { severity: 'INFO', confidence: 0.3, confidenceBand: 'LOW', escalationStatus: 'QUEUED', escalationReasons: ['NOT_COMPARED', 'MODEL_OMITTED', 'LOW_CONFIDENCE'], evidence: [], visualVerdict: 'NOT_CHECKED' },
      action: { recommendation: 'Not verified — the model returned no expectation. Needs human review; excluded from the compliance score.', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    }),
    finding({
      classification: 'DS_CANDIDATE',
      component: { productionType: 'card', productionLabel: 'Report card', dsComponent: null, dsVariant: null, signature: 'sig-3' },
      action: { recommendation: 'Consider adding', rootCauseRef: null, dsCandidateNote: 'repeated 3x', registryUpdateRef: 'cand-sig-3' },
    }),
  ];

  data = buildAuditData({
    runId: 'run-1',
    auditId: 'audit-1',
    mode: 'single-page',
    startedAt: '2026-09-11T10:00:00.000Z',
    targetUrl: 'https://www.kenresearch.com/a',
    pages: [page({ findings, compliance: { match: 1, deviation: 1, incorrect: 1, newComponent: 1, dsCandidate: 1, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 33.3 } })],
    failedPages: [{ url: 'https://www.kenresearch.com/broken', reason: 'HTTP 404 — page does not exist' }],
    renderingPolicy: RENDERING,
  });

  paths = runPaths(join(dir, 'projects'), projectNameFor(data.run.targetUrl), data.run.runId);
  await ensureRunDirs(paths);
  await loadOrCreateProject(paths, { targetUrl: data.run.targetUrl, mode: 'single-page', figmaTeamPlanKey: 'team::1364202946001928079' });
  await writeAuditData(paths.dataJson, data);
  await writeExcelReport(paths.reportXlsx, data);

  workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(paths.reportXlsx);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * ExcelJS column `key`s are a write-time convenience and are NOT stored in the
 * .xlsx, so a workbook read back from disk can only be addressed by index.
 * Reading through the header row is the honest way to assert on the real file.
 */
function headerIndex(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => map.set(String(cell.value), col));
  return map;
}

function cellValue(sheet: ExcelJS.Worksheet, rowNumber: number, header: string): ExcelJS.CellValue {
  const col = headerIndex(sheet).get(header);
  if (!col) throw new Error(`column "${header}" not found in ${sheet.name}`);
  return sheet.getRow(rowNumber).getCell(col).value;
}

function dataRows(sheet: ExcelJS.Worksheet, requiredHeader: string): ExcelJS.Row[] {
  const col = headerIndex(sheet).get(requiredHeader);
  if (!col) throw new Error(`column "${requiredHeader}" not found in ${sheet.name}`);
  return (sheet.getRows(2, Math.max(0, sheet.rowCount - 1)) ?? []).filter((r) => r.getCell(col).value !== null && r.getCell(col).value !== undefined);
}

describe('C2 — canonical audit data', () => {
  it('computes compliance once, with neutral classifications excluded (v1.0 §13)', () => {
    expect(data.websiteSummary.compliancePercent).toBe(33.3); // 1 MATCH / (1+1+1)
    expect(data.websiteSummary.newComponent).toBe(1);
    expect(data.websiteSummary.dsCandidate).toBe(1);
  });

  it('groups repeated defects into global issues and surfaces re-audit deltas', () => {
    expect(data.globalIssues.length).toBeGreaterThan(0);
    expect(data.reAudit.regressions).toBe(1);
  });

  it('writes data.json into the Project → Runs layout alongside the workbook', () => {
    expect(existsSync(paths.dataJson)).toBe(true);
    expect(existsSync(paths.reportXlsx)).toBe(true);
    expect(existsSync(paths.projectFile)).toBe(true);
    expect(existsSync(paths.screenshotsDir)).toBe(true);
  });

  it('project.json persists the Figma destination so re-audits update the same file', async () => {
    const project = JSON.parse(await readFile(paths.projectFile, 'utf-8'));
    expect(project.figmaTeamPlanKey).toBe('team::1364202946001928079');
    expect(project.figmaFileKey).toBeNull(); // not yet published — C3 fills this in
    expect(project.figmaNodes).toMatchObject({ pages: {}, frames: {} });
  });
});

describe('C1 ↔ C2 parity — Excel is checked against the canonical data, not against another output', () => {
  it('produces the nine tabs of v1.0 §15, in order, plus 10 Needs Review (Decision Log #31)', () => {
    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      '01 Executive Summary',
      '02 Template Summary',
      '03 Page Summary',
      '04 All Findings',
      '05 Component Summary',
      '06 Global Issues',
      '07 New Components',
      '08 DS Candidates',
      '09 Failed Skipped Pages',
      '10 Needs Review',
    ]);
  });

  it('every headline number in the Executive Summary equals C2 exactly', () => {
    const sheet = workbook.getWorksheet('01 Executive Summary')!;
    const values = new Map<string, unknown>();
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      values.set(String(row.getCell(1).value), row.getCell(2).value);
    });
    expect(values.get('Match')).toBe(data.websiteSummary.match);
    expect(values.get('Deviation')).toBe(data.websiteSummary.deviation);
    expect(values.get('Incorrect implementation')).toBe(data.websiteSummary.incorrect);
    expect(values.get('Overall compliance %')).toBe(data.websiteSummary.compliancePercent);
    expect(values.get('Components checked')).toBe(data.websiteSummary.componentsChecked);
    expect(values.get('Findings awaiting review')).toBe(data.websiteSummary.escalationsQueued);
    expect(values.get('Re-audit — regressions')).toBe(data.reAudit.regressions);
    expect(values.get('Design System version')).toBe(data.run.dsRegistryVersion);
    expect(values.get('Unverified — nothing compared (excluded from score, awaiting review)')).toBe(data.websiteSummary.unverified);
    expect(values.get('Needs review (excluded from score, awaiting a human decision)')).toBe(data.websiteSummary.needsReview);
  });

  it('C2 excludes a not-compared MATCH from the score instead of counting it compliant', () => {
    expect(data.websiteSummary.notCompared).toBe(1);
    expect(data.websiteSummary.match).toBe(1); // the verified MATCH only
    expect(data.websiteSummary.compliancePercent).toBe(33.3); // unchanged by the unverified component
    const button = data.componentSummary.find((c) => c.dsComponent === 'Button' && c.dsVariant === 'primary')!;
    expect(button.notCompared).toBe(1);
  });

  it('the Executive Summary names the exact browser build C2 recorded', () => {
    const sheet = workbook.getWorksheet('01 Executive Summary')!;
    let engine: unknown;
    sheet.eachRow((row) => {
      if (row.getCell(1).value === 'Browser engine') engine = row.getCell(2).value;
    });
    expect(data.run.renderingPolicy?.browserVersion).toBe('141.0.7390.37');
    expect(engine).toBe(describeRenderingEngine(data.run.renderingPolicy!));
    expect(String(engine)).toContain('141.0.7390.37');
  });

  it('All Findings lists one row per actionable mismatch and omits compliant components', () => {
    const sheet = workbook.getWorksheet('04 All Findings')!;
    const index = headerIndex(sheet);
    const rows = dataRows(sheet, 'Status');
    expect(rows.every((r) => r.getCell(index.get('Status')!).value !== 'MATCH')).toBe(true);

    // Not-compared matches ARE actionable (a human must verify them), so they are listed.
    const expectedRows = data.findings
      .filter((f) => f.classification !== 'MATCH' || isNotCompared(f))
      .reduce((n, f) => n + Math.max(1, f.comparison.mismatches.length), 0);
    expect(rows).toHaveLength(expectedRows);
    expect(rows.filter((r) => r.getCell(index.get('Status')!).value === 'UNVERIFIED')).toHaveLength(data.websiteSummary.unverified);

    const deviation = rows.find((r) => r.getCell(index.get('Status')!).value === 'DEVIATION')!;
    expect(deviation.getCell(index.get('Actual')!).value).toBe('44px');
    expect(deviation.getCell(index.get('Expected')!).value).toBe('48px');
    expect(deviation.getCell(index.get('Expected token')!).value).toBe('--button-height-md');
    expect(deviation.getCell(index.get('Re-audit')!).value).toBe('REGRESSION');
  });

  it('carries the rule id and severity through for INCORRECT findings', () => {
    const sheet = workbook.getWorksheet('04 All Findings')!;
    const index = headerIndex(sheet);
    const incorrect = dataRows(sheet, 'Status').find((r) => r.getCell(index.get('Status')!).value === 'INCORRECT')!;
    expect(incorrect.getCell(index.get('Rule')!).value).toBe('R1.2');
    expect(incorrect.getCell(index.get('Severity')!).value).toBe('CRITICAL');
  });

  it('the neutral tabs carry exactly C2\'s new components and DS candidates', () => {
    expect(dataRows(workbook.getWorksheet('07 New Components')!, 'URL')).toHaveLength(data.newComponents.length);
    expect(dataRows(workbook.getWorksheet('08 DS Candidates')!, 'URL')).toHaveLength(data.dsCandidates.length);
    expect(cellValue(workbook.getWorksheet('08 DS Candidates')!, 2, 'Registry request')).toBe('cand-sig-3');
  });

  it('failed pages are reported with their reason rather than silently dropped', () => {
    const sheet = workbook.getWorksheet('09 Failed Skipped Pages')!;
    expect(cellValue(sheet, 2, 'URL')).toBe('https://www.kenresearch.com/broken');
    expect(String(cellValue(sheet, 2, 'Reason'))).toContain('404');
  });

  it('page and component summaries match C2 row for row', () => {
    const pageSheet = workbook.getWorksheet('03 Page Summary')!;
    expect(dataRows(pageSheet, 'URL')).toHaveLength(data.pageSummary.length);
    expect(cellValue(pageSheet, 2, 'Compliance %')).toBe(data.pageSummary[0]!.compliance.compliancePercent);
    expect(dataRows(workbook.getWorksheet('05 Component Summary')!, 'Instances')).toHaveLength(data.componentSummary.length);
  });
});
