import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuditData, type AuditData } from '../../src/agents/c2-json-writer/index.ts';
import { writeHtmlReport } from '../../src/agents/c1-html-reporter/index.ts';
import { HTML_TEMPLATE_VERSION, STATUS_COLORS } from '../../src/dashboard/views/render.ts';
import { ensureRunDirs, projectNameFor, runPaths } from '../../src/output/run-store.ts';
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * The standalone HTML report: a self-contained sibling of report.xlsx, built from the exact
 * same data.json (renderRun, unchanged) with every evidence screenshot embedded as a data: URI
 * instead of linked by a server-relative path — so the file opens on its own, copied anywhere,
 * with no dashboard server and no external asset folder.
 */

const REAL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

let dir: string;
let paths: ReturnType<typeof runPaths>;
let evidencePath: string;
const missingEvidencePath = '/nonexistent/el-gone-element.png';

function finding(over: Partial<Finding> & { classification: Finding['classification'] }): Finding {
  const base: Finding = {
    identity: { auditId: 'audit-1', runId: 'run-1', findingId: `f-${Math.abs(JSON.stringify(over).length)}-${over.classification}`, timestamp: '2026-09-15T10:00:00.000Z', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1' },
    location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Hero', captureState: 'default' },
    component: { productionType: 'button', productionLabel: 'CTA', dsComponent: 'Button', dsVariant: 'primary', signature: 'sig-1' },
    classification: over.classification,
    comparison: { mismatches: [], ruleViolations: [] },
    quality: { severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
    action: { recommendation: 'Do the thing', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: over.classification, delta: null, previousRunId: null },
  };
  return { ...base, ...over, identity: { ...base.identity, ...(over.identity ?? {}) } };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-c1html-'));
  paths = runPaths(join(dir, 'projects'), 'kenresearch-a', 'run-1');
  await ensureRunDirs(paths);
  mkdirSync(join(paths.screenshotsDir, 'p1'), { recursive: true });
  evidencePath = join(paths.screenshotsDir, 'p1', 'el-1-element.png');
  writeFileSync(evidencePath, REAL_PNG);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function buildData(): AuditData {
  const findings: Finding[] = [
    finding({ classification: 'MATCH' }),
    finding({
      classification: 'DEVIATION',
      quality: { severity: 'MEDIUM', confidence: 0.8, confidenceBand: 'MEDIUM', escalationStatus: 'NONE', escalationReasons: [], evidence: [{ kind: 'element-screenshot', ref: evidencePath, note: null, box: { x: 0, y: 0, width: 1, height: 1 } }], visualVerdict: 'CONFIRMED' },
      comparison: { mismatches: [{ property: 'height', actual: '44px', expected: '48px', expectedToken: '--button-height-md', comparison: 'length-px', delta: -4 }], ruleViolations: [] },
    }),
    finding({
      classification: 'NEEDS_REVIEW',
      component: { productionType: 'card', productionLabel: 'Report card', dsComponent: null, dsVariant: null, signature: 'sig-2' },
      quality: { severity: 'INFO', confidence: 0.1, confidenceBand: 'LOW', escalationStatus: 'QUEUED', escalationReasons: [], evidence: [{ kind: 'element-screenshot', ref: missingEvidencePath, note: null, box: { x: 0, y: 0, width: 1, height: 1 } }], visualVerdict: 'NOT_CHECKED' },
      review: { status: 'NEEDS_REVIEW', reason: 'no comparable DS property', node: 'n1', signals: [], possibleMatches: [], observed: [] },
    }),
  ];
  const page: PageResult = {
    runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'dom-1', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1', findings,
    compliance: { match: 1, deviation: 1, incorrect: 0, newComponent: 0, dsCandidate: 0, needsReview: 1, unverified: 0, notCompared: 0, compliancePercent: 50 },
    coverage: { sectionsAnalyzed: 2, componentsDetected: 3, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
    capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
  };
  return buildAuditData({ runId: 'run-1', auditId: 'audit-1', mode: 'single-page', startedAt: '2026-09-15T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] });
}

describe('C1 HTML report — standalone, embedded evidence', () => {
  it('embeds real evidence as data: URIs, never a server-relative path or the raw filesystem path', async () => {
    const data = buildData();
    const result = await writeHtmlReport(paths, projectNameFor(data.run.targetUrl), data);
    expect(existsSync(paths.reportHtml)).toBe(true);

    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain(REAL_PNG.toString('base64'));
    // Never the dashboard's server-relative form, and never the bare absolute filesystem path.
    expect(html).not.toMatch(/src="\/screenshots\//);
    expect(html).not.toContain(evidencePath);

    expect(result.embeddedRefs).toContain(evidencePath);
    expect(result.missingRefs.some((e) => e.startsWith(`${missingEvidencePath}:`))).toBe(true);
    expect(result.zipBytes).toBeNull();
    expect(existsSync(paths.reportPackageZip)).toBe(false);
  });

  it('still renders a "no screenshot" placeholder for the missing evidence ref, exactly like the live dashboard', async () => {
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toMatch(/no screenshot captured/);
  });

  it('carries the same numbers as C2 — no separate calculation, verified by reading the numbers back out of the HTML', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain(`>${data.websiteSummary.compliancePercent}%<`);
    expect(html).toContain(`>${data.websiteSummary.match}<`);
    expect(html).toContain(`>${data.websiteSummary.deviation}<`);
  });

  it('P2 requirement: never references localhost, a dashboard port, or an external network resource — opens and shares standalone with no server', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).not.toMatch(/localhost/i);
    expect(html).not.toMatch(/https?:\/\/(?!www\.kenresearch\.com)/); // no network host except the audited page's OWN url text, which is report content, not a dependency
    expect(html).not.toMatch(/<link[^>]+href=/); // no external stylesheet
    expect(html).not.toMatch(/<script[^>]+src=/); // no external script — the inline SCRIPT block is the only JS
  });

  it('is stamped with the locked HTML_TEMPLATE_VERSION and uses the approved status palette — not a per-run reinvention', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain(`<!-- ${HTML_TEMPLATE_VERSION} -->`);
    expect(html).toContain(`--critical: ${STATUS_COLORS.incorrect};`);
    expect(html).toContain(`--high: ${STATUS_COLORS.deviation};`);
    expect(html).toContain(`--medium: ${STATUS_COLORS.needsReview};`);
    expect(html).toContain(`--gray: ${STATUS_COLORS.unverified};`);
    expect(html).toContain(`--ok: ${STATUS_COLORS.match};`);
    // UNVERIFIED must render in the distinct gray var, never fall back to the amber --medium.
    expect(html).toContain('.UNVERIFIED { color: var(--gray);');
  });

  it('falls back to report-package.zip only when the standalone HTML would be excessively large, and still keeps report.html as the primary output', async () => {
    const data = buildData();
    const result = await writeHtmlReport(paths, 'kenresearch-a', data, { zipThresholdBytes: 100 });
    expect(existsSync(paths.reportHtml)).toBe(true); // still written — the preferred output, always
    expect(result.zipBytes).not.toBeNull();
    expect(existsSync(paths.reportPackageZip)).toBe(true);

    const zipBytes = readFileSync(paths.reportPackageZip);
    expect(zipBytes.readUInt32LE(0)).toBe(0x04034b50); // local file header signature — a real zip, not a stub
    expect(zipBytes.length).toBe(result.zipBytes);

    // The packaged HTML (inside the zip) is the relative-path variant, not the embedded one —
    // report.html on disk is untouched and still has the base64 data.
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('data:image/png;base64,');
  });
});

/**
 * Locks the semantic status-color application across the whole rendered report — not just the
 * STATUS_COLORS constant (test/unit/html-template-palette.test.ts covers that), but that every
 * surface actually USES it correctly. Regression protection for the specific bug found and fixed
 * here: summary cards for "Needs review"/"Unverified" shared one generic amber-tinted `.attention`
 * class that never referenced STATUS_COLORS at all — so UNVERIFIED's summary card rendered amber,
 * not gray, even though the pill/review-border already had the right color. Fixed by giving each
 * of the five status cards its own subtle, border-only accent tied to STATUS_COLORS, background
 * left neutral.
 */
function buildAllStatusesData(): AuditData {
  const findings: Finding[] = [
    finding({ classification: 'MATCH' }),
    finding({
      classification: 'DEVIATION',
      comparison: { mismatches: [{ property: 'height', actual: '44px', expected: '48px', expectedToken: '--button-height-md', comparison: 'length-px', delta: -4 }], ruleViolations: [] },
    }),
    finding({ classification: 'INCORRECT', comparison: { mismatches: [{ property: 'color', actual: '#000', expected: '#fff', expectedToken: '--color-fg', comparison: 'exact', delta: null }], ruleViolations: [] } }),
    finding({
      classification: 'NEEDS_REVIEW',
      component: { productionType: 'card', productionLabel: 'Report card', dsComponent: null, dsVariant: null, signature: 'sig-2' },
      review: { status: 'NEEDS_REVIEW', reason: 'no comparable DS property', node: 'n1', signals: [], possibleMatches: [], observed: [] },
    }),
    finding({ classification: 'UNVERIFIED', component: { productionType: 'input', productionLabel: 'Email field', dsComponent: 'Input', dsVariant: null, signature: 'sig-3' } }),
  ];
  const page: PageResult = {
    runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'dom-1', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1', findings,
    compliance: { match: 1, deviation: 1, incorrect: 1, newComponent: 0, dsCandidate: 0, needsReview: 1, unverified: 1, notCompared: 0, compliancePercent: 33 },
    coverage: { sectionsAnalyzed: 2, componentsDetected: 5, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
    capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
  };
  return buildAuditData({ runId: 'run-1', auditId: 'audit-1', mode: 'single-page', startedAt: '2026-09-15T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] });
}

describe('HTML template — locked semantic status-color application (summary cards, pills, review-item borders)', () => {
  it('gives each of the five summary status cards its own status-keyed class, tied to STATUS_COLORS — never the old generic shared "attention" class', async () => {
    const data = buildAllStatusesData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');

    expect(html).toContain('class="card status-match"');
    expect(html).toContain('class="card status-deviation"');
    expect(html).toContain('class="card status-incorrect"');
    expect(html).toContain('class="card status-needsReview"');
    expect(html).toContain('class="card status-unverified"');
    // The old bug: UNVERIFIED and NEEDS_REVIEW summary cards shared one hardcoded amber class,
    // regardless of STATUS_COLORS — must never come back.
    expect(html).not.toMatch(/class="card attention"/);
    expect(html).not.toMatch(/\.card\.attention\b/);
  });

  it('each status card CSS rule is a border-only accent tied to the correct STATUS_COLORS var — never a background override (backgrounds stay neutral/white)', async () => {
    const data = buildAllStatusesData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');

    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    const style = styleMatch![1]!;

    const cardRules: Record<string, string> = {
      match: '--ok',
      deviation: '--high',
      incorrect: '--critical',
      needsReview: '--medium',
      unverified: '--gray',
    };
    for (const [status, varName] of Object.entries(cardRules)) {
      const ruleMatch = style.match(new RegExp(`\\.card\\.status-${status}\\s*\\{([^}]*)\\}`));
      expect(ruleMatch, `expected a .card.status-${status} rule`).not.toBeNull();
      const rule = ruleMatch![1]!;
      expect(rule).toContain(`border-left: 3px solid var(${varName})`);
      expect(rule).not.toMatch(/background/); // subtle accent only — no background tint
    }
  });

  it('every finding-table pill maps to the correct STATUS_COLORS-derived var, all five distinct', async () => {
    const data = buildAllStatusesData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');

    expect(html).toContain('.MATCH { color: var(--ok);');
    expect(html).toContain('.DEVIATION { color: var(--high);');
    expect(html).toContain('.INCORRECT { color: var(--critical);');
    expect(html).toContain('.NEEDS_REVIEW { color: var(--medium);');
    expect(html).toContain('.UNVERIFIED { color: var(--gray);');

    // Confirm the five var()s actually resolve to five distinct hex values in this same document
    // (never two statuses silently sharing a hue in the rendered output, not just the constant).
    const rootMatch = html.match(/:root\s*\{([^}]*)\}/);
    const root = rootMatch![1]!;
    const varValue = (name: string) => root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    const values = ['critical', 'high', 'medium', 'gray', 'ok'].map(varValue);
    expect(values.every(Boolean)).toBe(true);
    expect(new Set(values).size).toBe(5);
  });

  it('Needs Review / Unverified review-item cards keep their locked left-border treatment — solid amber for Needs Review, dashed gray for Unverified', async () => {
    const data = buildAllStatusesData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');

    expect(html).toContain('border-left: 3px solid var(--medium)'); // .rv default (Needs Review)
    expect(html).toContain('border-left-style: dashed; border-left-color: var(--gray);'); // UNVERIFIED override
    expect(html).toContain('data-status="UNVERIFIED"');
  });

  it('does not over-color the report — every .card background stays the neutral surface color, never a status hue', async () => {
    const data = buildAllStatusesData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    const style = styleMatch![1]!;
    const cardBaseRule = style.match(/\.card\s*\{([^}]*)\}/)![1]!;
    expect(cardBaseRule).toContain('background: var(--surface)');
  });
});
