import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { buildAuditData, type AuditData } from '../../src/agents/c2-json-writer/index.ts';
import { writeHtmlReport } from '../../src/agents/c1-html-reporter/index.ts';
import { HTML_TEMPLATE_VERSION, STATUS_COLORS, renderRun } from '../../src/dashboard/views/render.ts';
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

  it('keeps the existing empty evidence placeholder in the finding details for a missing screenshot', async () => {
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('<dt>Evidence</dt><dd class="evidence"><span class="muted">—</span></dd>');
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

  it('keeps review findings in the section-wise list without a duplicate review section', async () => {
    const data = buildAllStatusesData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).not.toContain('<section id="review">');
    expect(html).not.toContain('class="review-list"');
    expect(html).not.toContain('also in Needs review below');
    expect(html).toContain('data-classification="NEEDS_REVIEW"');
    expect(html).toContain('data-classification="UNVERIFIED"');
    expect((html.match(/class="frow" /g) ?? []).length).toBe(data.findings.length);
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

/**
 * The Fix Plan review layer (html-report-v2). These assertions pin the parts a future session
 * could silently regress: the findingId addressing hook the whole feature hangs off, the exact
 * action labels the approved plan fixed, and the column-index bug the checkbox column would
 * otherwise reintroduce.
 */
describe('HTML template v2 — Fix Plan review layer', () => {
  it('stamps the v13 template version (v13: the Coverage Gate is one compact Summary line + a collapsed Coverage details accordion)', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(HTML_TEMPLATE_VERSION).toBe('html-report-v19');
    expect(html).toContain('<!-- html-report-v19 -->');
  });

  it('gives every finding row a data-finding-id — the addressing hook decisions use', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    for (const f of data.findings) expect(html).toContain(`data-finding-id="${f.identity.findingId}"`);
    // Each finding has one row and its existing selection checkbox.
    const rows = html.match(/<div class="frow"[^>]*>/g) ?? [];
    for (const f of data.findings) {
      expect(rows.filter(row => row.includes(`data-finding-id="${f.identity.findingId}"`))).toHaveLength(1);
    }
  });

  it('stamps the run id on <body> so the embedded script can key its draft and export per-run', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain(`data-run-id="${data.run.runId}"`);
    expect(html).toContain('data-fp-source="html-report"');
  });

  it('carries the exact action ids and labels the approved plan fixed', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    // f-decision was removed in the v2.1 filter simplification (see the describe block below) —
    // The duplicate review section and its controls were removed in v9.
    for (const id of ['fp-all', 'fp-fix', 'fp-skip', 'fp-keep', 'fp-clear', 'fp-clear-all', 'fp-export', 'f-section']) {
      expect(html, `missing #${id}`).toContain(`id="${id}"`);
    }
    for (const label of ['Mark as Fix', 'Mark as Skip', 'Mark as Keep for Review', 'Clear Decision', 'Clear All Decisions', 'Export Fix Plan (']) {
      expect(html, `missing label ${label}`).toContain(label);
    }
    expect(html).toContain('aria-label="Select all visible findings"');
  });

  it('v3: the Findings table is gone — a #findings <div> of compact .frow cards replaces the old <table>, sorted via a select control instead of column clicks', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).not.toContain('<table id="findings">');
    expect(html).toContain('<div id="findings">');
    expect(html).toContain('class="frow"');
    expect(html).toContain('id="f-sort"');
    expect(html).toContain('id="f-sort-dir"');
    expect(html).toContain('<input type="checkbox" class="fp-cb" id="fp-all"');
  });

  it('embeds a seed plan and renders server-side decisions when one is supplied', async () => {
    const data = buildData();
    const decided = data.findings[0]!.identity.findingId;
    const fixPlan = {
      schemaVersion: 1 as const,
      runId: data.run.runId,
      updatedAt: null,
      entries: [{ findingId: decided, decision: 'fix' as const, decidedAt: '2026-09-18T10:00:00.000Z', decidedBy: null, note: null, source: 'html-report' as const }],
    };
    await writeHtmlReport(paths, 'kenresearch-a', data, { fixPlan });
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('id="fp-seed"');
    expect(html).toContain(decided);
    expect(html).toContain('data-decision="fix"');
    expect(html).toContain('>FIX</span>');
  });

  it('renders no decision markup at all when no plan is supplied — undecided is the neutral default', async () => {
    const data = buildData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    // Only the CSS rules mention a decision value; no row or card carries one.
    expect(html).not.toContain('<tr data-classification="INCORRECT" data-severity="HIGH" data-band="HIGH" data-escalation="NONE" data-finding-id="x" data-decision=');
    expect(html).toContain('"entries":[]');
  });
});

/**
 * v2.1 — the reported bulk-selection bug (Mark as Fix then Mark as Skip silently overwrote the
 * prior Fix decisions because checkboxes stayed checked), decision counts, simplified Findings
 * filters + Section filter + section-wise grouping, and the New Component Plan kept structurally
 * separate from the Fix Plan above.
 */
describe('HTML template v2.1 — selection-clear fix, decision counts, section grouping, and the separate New Component Plan', () => {
  function multiSectionData(): AuditData {
    const findings: Finding[] = [
      finding({ classification: 'INCORRECT', location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Header', captureState: 'default' } }),
      finding({ classification: 'INCORRECT', location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Header', captureState: 'default' } }),
      finding({ classification: 'DEVIATION', location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Hero', captureState: 'default' } }),
      finding({
        classification: 'NEW_COMPONENT',
        component: { productionType: 'badge', productionLabel: 'Trend badge', dsComponent: null, dsVariant: null, signature: 'sig-badge' },
        location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Footer', captureState: 'default' },
      }),
      finding({
        classification: 'DS_CANDIDATE',
        component: { productionType: 'chip', productionLabel: 'Filter chip', dsComponent: null, dsVariant: null, signature: 'sig-chip' },
        location: { url: 'https://www.kenresearch.com/a', pageId: 'p1', pageName: 'A', templateFamily: 'Consulting', section: 'Footer', captureState: 'default' },
        action: { recommendation: 'n/a', rootCauseRef: null, dsCandidateNote: 'Reused 3x, follows foundations', registryUpdateRef: 'cand-sig-chip' },
      }),
    ];
    const page: PageResult = {
      runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'dom-1', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1', findings,
      compliance: { match: 0, deviation: 1, incorrect: 2, newComponent: 1, dsCandidate: 1, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
      coverage: { sectionsAnalyzed: 3, componentsDetected: 5, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
    };
    return buildAuditData({ runId: 'run-1', auditId: 'audit-1', mode: 'single-page', startedAt: '2026-09-15T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] });
  }

  it('the selection-clear fix is present: fpSetDecision unchecks every .fp-cb after applying, before the next bulk action can reuse the stale selection', async () => {
    const data = multiSectionData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const fnBody = html.slice(html.indexOf('function fpSetDecision'), html.indexOf('function fpExport'));
    expect(fnBody).toContain('for (const cb of fpAllCheckboxes()) cb.checked = false;');
    // The clear must happen INSIDE fpSetDecision, before fpSaveDraft — not merely exist somewhere
    // else in the script where it wouldn't run on every bulk action.
    expect(fnBody.indexOf('cb.checked = false')).toBeLessThan(fnBody.indexOf('fpSaveDraft()'));
  });

  it('renders live decision counts server-side, computed from the seeded plan and total finding count', async () => {
    const data = multiSectionData();
    const decidedFix = data.findings[0]!.identity.findingId; // an INCORRECT finding in Header
    const decidedSkip = data.findings[2]!.identity.findingId; // the DEVIATION finding in Hero
    const fixPlan = {
      schemaVersion: 1 as const,
      runId: data.run.runId,
      updatedAt: null,
      entries: [
        { findingId: decidedFix, decision: 'fix' as const, decidedAt: '2026-09-18T10:00:00.000Z', decidedBy: null, note: null, source: 'html-report' as const },
        { findingId: decidedSkip, decision: 'skip' as const, decidedAt: '2026-09-18T10:00:00.000Z', decidedBy: null, note: null, source: 'html-report' as const },
      ],
    };
    await writeHtmlReport(paths, 'kenresearch-a', data, { fixPlan });
    const html = await readFile(paths.reportHtml, 'utf-8');
    // 5 findings total, 2 decided -> 3 undecided.
    expect(html).toContain('id="fp-counts">Fix 1 · Skip 1 · Review 0 · Undecided 3<');
    expect(html).toContain(`data-total-findings="${data.findings.length}"`);
  });

  it('v3: the Findings view is grouped by section with a rich .fsec-header per section (count + Incorrect/Review/Fix breakdown), and the Section filter lists exactly those sections', async () => {
    const data = multiSectionData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    // Header: 2 INCORRECT findings, 0 review-state, 0 fix-decided (no fixPlan supplied here).
    expect(html).toContain('class="fsec-header" data-section="Header">Header · 2 findings · 2 Incorrect · 0 Review · Fix 0<');
    // Hero: 1 DEVIATION finding.
    expect(html).toContain('class="fsec-header" data-section="Hero">Hero · 1 finding · 0 Incorrect · 0 Review · Fix 0<');
    // NEW_COMPONENT/DS_CANDIDATE findings ARE part of data.findings (C2's flat array), so their
    // section ("Footer") still gets a group in the main Findings view alongside its own separate
    // appearance in "New components & DS candidates" below.
    expect(html).toContain('class="fsec-header" data-section="Footer">Footer · 2 findings · 0 Incorrect · 0 Review · Fix 0<');
    expect(html).toContain('<select id="f-section" aria-label="Filter by section"><option value="">View All</option><option value="Header">Header (2)</option><option value="Hero">Hero (1)</option><option value="Footer">Footer (2)</option></select>');
    // The removed filters must actually be gone, not just untested.
    expect(html).not.toContain('id="f-band"');
    expect(html).not.toContain('id="f-esc"');
    expect(html).not.toContain('id="f-decision"');
  });

  it('sorts within each section group independently rather than flattening the whole view', async () => {
    const data = multiSectionData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('groupRows.sort((a, b) => {');
    expect(html).toContain("classList.contains('fsec-header')");
    expect(html).toContain('anchor.after(row)');
  });

  it('v3: each compact row carries a full detail section (never removing information) that is hidden until expanded', async () => {
    const data = multiSectionData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('class="frow-detail" hidden');
    expect(html).toContain('class="frow-expand" aria-expanded="false">Details</button>');
    // The compact summary is CSS-clamped (frow-summary), never a JS-truncated shorter string —
    // the full recommendation text still exists in the DOM (inside frow-detail) either way, so
    // search continues to match it even though it visually collapses to 1-2 lines.
    for (const f of data.findings) {
      if (f.classification === 'NEW_COMPONENT' || f.classification === 'DS_CANDIDATE') continue;
      expect(html).toContain(escapeForAssert(f.action.recommendation));
    }
  });

  function escapeForAssert(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c as '&' | '<' | '>' | '"' | "'"]);
  }

  it('the New Component Plan has its own checkboxes, its own seed, and never the Fix Plan\'s class/state', async () => {
    const data = multiSectionData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const badgeId = data.findings.find((f) => f.classification === 'NEW_COMPONENT')!.identity.findingId;
    const chipId = data.findings.find((f) => f.classification === 'DS_CANDIDATE')!.identity.findingId;
    expect(html).toContain(`<div class="ncp-row" data-finding-id="${badgeId}" data-candidate-source="current_state">`);
    expect(html).toContain(`<div class="ncp-row" data-finding-id="${chipId}" data-candidate-source="current_state">`);
    expect(html).toContain('id="ncp-seed"');
    expect(html).toContain(`"findingId":"${badgeId}","classification":"NEW_COMPONENT"`);
    expect(html).toContain(`"findingId":"${chipId}","classification":"DS_CANDIDATE"`);
    for (const label of ['Select all visible', 'Add New Component', 'Export New Component Plan (']) {
      expect(html, `missing label ${label}`).toContain(label);
    }
    // Structural isolation: the two checkbox classes never appear on the same input, and the
    // Fix Plan bar's ids never leak into the New Component Plan bar or vice versa.
    expect(html).not.toContain('class="fp-cb ncp-cb"');
    expect(html).not.toContain('class="ncp-cb fp-cb"');
    expect(html).not.toContain('id="fp-add"');
    expect(html).not.toContain('id="ncp-fix"');
    // The Fix Plan bulk bar's own JS must never reference the NCP class or vice versa.
    const fpBlock = html.slice(html.indexOf('function fpSetDecision'), html.indexOf('New Component Plan — deliberately separate'));
    expect(fpBlock).not.toContain('.ncp-cb');
    const ncpBlock = html.slice(html.indexOf('New Component Plan — deliberately separate'));
    expect(ncpBlock).not.toContain("querySelectorAll('.fp-cb");
  });

  it('data.json findings are never altered by any of this — same ids, same classifications, same count as buildAuditData produced', async () => {
    const data = multiSectionData();
    const before = JSON.stringify(data.findings);
    await writeHtmlReport(paths, 'kenresearch-a', data);
    expect(JSON.stringify(data.findings)).toBe(before);
  });
});

/**
 * Post-Fix Component Opportunity (html-report-v4) — an additive render-time inference over B6's
 * own findings, never a change to B6's current-state classification. Only a repeated, unmatched
 * pattern whose sole blocker is a measured, known foundation-rule violation qualifies; it must use
 * the SAME New Component checkbox/export system as a real candidate, never the Fix Plan's.
 */
describe('HTML template v4 — Post-Fix Component Opportunity', () => {
  function b6Incorrect(over: Partial<Finding> = {}): Finding {
    return finding({
      classification: 'INCORRECT',
      component: { productionType: 'nav-link', productionLabel: 'Home', dsComponent: null, dsVariant: null, signature: 'sig-postfix' },
      comparison: { mismatches: [], ruleViolations: [{ ruleId: 'R1.4', title: 'Two-Font Pairing', why: 'set in Arial — not a Design System typeface', severity: 'HIGH' }] },
      review: { status: 'NEEDS_REVIEW', reason: 'the DS component is for a human to name', node: 'B6', signals: [], possibleMatches: [], observed: [] },
      ...over,
    });
  }

  function postFixData(): AuditData {
    // Explicit distinct ids: the shared finding() factory derives a default id from
    // JSON.stringify(over).length, which collides when three calls pass identical overrides —
    // exactly what a repeated-pattern fixture like this one does by construction.
    const findings: Finding[] = [
      b6Incorrect({ identity: { findingId: 'postfix-rep-1' } as Finding['identity'] }),
      b6Incorrect({ identity: { findingId: 'postfix-related-2' } as Finding['identity'] }),
      b6Incorrect({ identity: { findingId: 'postfix-related-3' } as Finding['identity'] }),
    ];
    const page: PageResult = {
      runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'dom-1', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1', findings,
      compliance: { match: 0, deviation: 0, incorrect: 3, newComponent: 0, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
      coverage: { sectionsAnalyzed: 1, componentsDetected: 3, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
    };
    return buildAuditData({ runId: 'run-1', auditId: 'audit-1', mode: 'single-page', startedAt: '2026-09-21T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] });
  }

  it('surfaces the opportunity clearly labeled "Potential — after fixes", tagged data-candidate-source="post_fix"', async () => {
    const data = postFixData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('<span class="pill DS_CANDIDATE post-fix">Potential — after fixes</span>');
    expect(html).toContain('data-candidate-source="post_fix"');
    expect(html).toContain('3 instances');
  });

  it('seeds the New Component Plan JS with candidateSource and relatedFindingIds so export can carry them through', async () => {
    const data = postFixData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const repId = data.findings[0]!.identity.findingId;
    const relatedIds = [data.findings[1]!.identity.findingId, data.findings[2]!.identity.findingId];
    expect(html).toContain(`"findingId":"${repId}","classification":"DS_CANDIDATE","candidateSource":"post_fix","relatedFindingIds":["${relatedIds[0]}","${relatedIds[1]}"]`);
    // ncp-add must stage candidateSource/relatedFindingIds from the seed onto the exported entry.
    const ncpBlock = html.slice(html.indexOf('New Component Plan — deliberately separate'));
    expect(ncpBlock).toContain('ncpCandidateSource.get(findingId)');
    expect(ncpBlock).toContain('ncpRelatedIds.get(findingId)');
  });

  it('shows the New Component action bar even when there are zero current-state candidates, as long as a post-fix opportunity exists', async () => {
    const data = postFixData();
    expect(data.newComponents).toHaveLength(0);
    expect(data.dsCandidates).toHaveLength(0);
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('id="ncp-add"');
    expect(html).toContain('Export New Component Plan (0)');
  });

  it('never surfaces an opportunity when a plausible existing DS look-alike was found — fixing it would just conform to that component', async () => {
    const data = postFixData();
    for (const f of data.findings) f.review!.possibleMatches = [{ dsComponent: 'TextLink', dsFile: 'atoms/TextLink.tsx', dsVariant: 'sm', score: 0.5, why: 'shares most governed properties' }];
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).not.toContain('Potential — after fixes');
    // Nothing else qualifies in this fixture either, so the action bar itself must not render —
    // it appears only when there is at least one real candidate or opportunity to act on.
    expect(html).not.toContain('id="ncp-add"');
  });

  it('renders a real current-state candidate as a compact .ncp-row card, correctly wired to its own checkbox and seed entry', async () => {
    const data = multiSectionData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const badgeId = data.findings.find((f) => f.classification === 'NEW_COMPONENT')!.identity.findingId;
    expect(html).toContain(`<div class="ncp-row" data-finding-id="${badgeId}" data-candidate-source="current_state">`);
    expect(html).toContain(`<input type="checkbox" class="ncp-cb" data-finding-id="${badgeId}"`);
    expect(html).toContain(`"findingId":"${badgeId}","classification":"NEW_COMPONENT","candidateSource":"current_state"`);
  });

  function multiSectionData(): AuditData {
    const findings: Finding[] = [
      finding({ classification: 'NEW_COMPONENT', component: { productionType: 'badge', productionLabel: 'Trend badge', dsComponent: null, dsVariant: null, signature: 'sig-badge' } }),
    ];
    const page: PageResult = {
      runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'dom-1', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1', findings,
      compliance: { match: 0, deviation: 0, incorrect: 0, newComponent: 1, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
      coverage: { sectionsAnalyzed: 1, componentsDetected: 1, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
    };
    return buildAuditData({ runId: 'run-1', auditId: 'audit-1', mode: 'single-page', startedAt: '2026-09-15T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] });
  }
});

/**
 * html-report-v5 — sticky-bar handoff, persistent staged/Added state, and evidence thumbnails on
 * every New Component candidate. Nothing here changes B6, the post-fix opportunity logic, the
 * Fix Plan schema, or data.json.
 */
describe('HTML template v5 — sticky handoff, staged/Added state, and candidate thumbnails', () => {
  function candidateData(): AuditData {
    const findings: Finding[] = [
      finding({
        classification: 'NEW_COMPONENT',
        component: { productionType: 'badge', productionLabel: 'Trend badge', dsComponent: null, dsVariant: null, signature: 'sig-badge' },
        quality: { severity: 'LOW', confidence: 0.7, confidenceBand: 'MEDIUM', escalationStatus: 'NONE', escalationReasons: [], evidence: [{ kind: 'element-screenshot', ref: evidencePath, note: null, box: { x: 0, y: 0, width: 1, height: 1 } }], visualVerdict: 'NOT_CHECKED' },
      }),
      finding({
        classification: 'DS_CANDIDATE',
        component: { productionType: 'section-heading', productionLabel: 'Our Insights', dsComponent: null, dsVariant: null, signature: 'sig-heading' },
        quality: {
          severity: 'LOW',
          confidence: 0.6,
          confidenceBand: 'MEDIUM',
          escalationStatus: 'NONE',
          escalationReasons: [],
          evidence: [
            { kind: 'element-screenshot', ref: evidencePath, note: null, box: { x: 0, y: 0, width: 1, height: 1 } },
            { kind: 'context-screenshot', ref: missingEvidencePath, note: null, box: { x: 0, y: 0, width: 1, height: 1 } },
          ],
          visualVerdict: 'NOT_CHECKED',
        },
      }),
      finding({
        classification: 'NEW_COMPONENT',
        component: { productionType: 'chip', productionLabel: 'No evidence chip', dsComponent: null, dsVariant: null, signature: 'sig-chip-noshot' },
      }),
    ];
    const page: PageResult = {
      runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'dom-1', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1', findings,
      compliance: { match: 0, deviation: 0, incorrect: 0, newComponent: 2, dsCandidate: 1, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
      coverage: { sectionsAnalyzed: 1, componentsDetected: 3, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
    };
    return buildAuditData({ runId: 'run-1', auditId: 'audit-1', mode: 'single-page', startedAt: '2026-09-21T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] });
  }

  it('wraps the Fix Plan bar and every section through Pages in .fp-scope, ending before New Components begins — the sticky containing block the handoff relies on', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const scopeOpen = html.indexOf('<div class="fp-scope">');
    const fpBar = html.indexOf('<div class="fp-bar">');
    const pagesHeading = html.indexOf('<h2>Pages</h2>');
    const newComponentsHeading = html.indexOf('<h2>New components &amp; DS candidates</h2>');
    expect(scopeOpen).toBeGreaterThan(-1);
    expect(scopeOpen).toBeLessThan(fpBar);
    expect(fpBar).toBeLessThan(pagesHeading);
    expect(pagesHeading).toBeLessThan(newComponentsHeading);
    // .fp-scope must close somewhere between Pages and New Components — never after.
    expect(html.slice(pagesHeading, newComponentsHeading)).toContain('</div>');
  });

  it('makes .ncp-bar sticky at the same top offset as .fp-bar, so the handoff is seamless', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const fpBarRule = style.match(/\.fp-bar\s*\{([^}]*)\}/)![1]!;
    const ncpBarRule = style.match(/\.ncp-bar\s*\{([^}]*)\}/)![1]!;
    expect(fpBarRule).toContain('position: sticky');
    expect(fpBarRule).toContain('top: 0');
    expect(ncpBarRule).toContain('position: sticky');
    expect(ncpBarRule).toContain('top: 0');
  });

  it('every candidate card carries a hidden "Added" badge and the JS paints it (and a data-staged row marker) from the staged map, separately from the temporary checkbox selection', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect((html.match(/<span class="ncp-added" hidden>✓ Added <button type="button" class="ncp-remove" aria-label="Remove from New Component Plan" title="Remove">×<\/button><\/span>/g) ?? []).length).toBe(3);
    const ncpBlock = html.slice(html.indexOf('New Component Plan — deliberately separate'));
    expect(ncpBlock).toContain('function ncpPaintStaged()');
    expect(ncpBlock).toContain("row.toggleAttribute('data-staged', staged)");
    expect(ncpBlock).toContain('badge.hidden = !staged');
    // Painted on every refresh (load, change, and after Add) — not just once at load: the call
    // site sits inside ncpRefreshUi's own body, between its opening and closing braces.
    const refreshBody = ncpBlock.slice(ncpBlock.indexOf('function ncpRefreshUi'), ncpBlock.indexOf('ncpRefreshUi();'));
    expect(refreshBody).toContain('ncpPaintStaged();');
  });

  it('the Added badge actually renders hidden by default via visibility, not display — a display:none badge would be removed from grid auto-placement entirely, shifting every later column one track left', async () => {
    // Caught live in a real browser: a plain [hidden] -> display:none rule DOES hide the badge, but
    // since a display:none element is not a grid item at all, every column after it lands one track
    // early on an unstaged row — the status pill (a later column) ends up squeezed into the badge's
    // own narrower track and overflows it, which is exactly the "Potential — after fixes" overlap
    // and staged/unstaged misalignment reported live. visibility:hidden keeps the badge as a grid
    // item (its column stays reserved) while still being invisible and non-interactive.
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    expect(style).toMatch(/\.ncp-added\[hidden\]\s*\{\s*visibility:\s*hidden;?\s*\}/);
    expect(style).not.toMatch(/\.ncp-added\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });

  it('reserves comfortable, fixed-width columns for the Added badge and the status pill — measured live: 80px/160px leave a few px of slack around real rendered content, never a razor-thin or overflowing fit', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const rowMainRule = style.match(/\.ncp-row-main\s*\{([^}]*)\}/)![1]!;
    expect(rowMainRule).toContain('grid-template-columns: 22px 80px 160px 1fr 170px 1.4fr 56px 60px');
  });

  it('a small × inside the Added badge unstages the candidate — deletes it from ncpStaged only, persists the draft, and repaints; never touches Fix Plan state', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('class="ncp-remove"');
    expect(html).toContain('aria-label="Remove from New Component Plan"');
    const ncpBlock = html.slice(html.indexOf('New Component Plan — deliberately separate'));
    const removeListener = ncpBlock.slice(ncpBlock.indexOf("closest?.('.ncp-remove')") - 40, ncpBlock.indexOf("closest?.('.ncp-remove')") + 300);
    expect(removeListener).toContain("closest('.ncp-row')");
    expect(removeListener).toContain('ncpStaged.delete(findingId)');
    expect(removeListener).toContain('ncpSaveDraft()');
    expect(removeListener).toContain('ncpRefreshUi()');
    // Structural isolation, same discipline as the existing Fix Plan / NCP split checks.
    const fpBlock = html.slice(html.indexOf('function fpSetDecision'), html.indexOf('New Component Plan — deliberately separate'));
    expect(fpBlock).not.toContain('.ncp-remove');
    expect(fpBlock).not.toContain('ncpStaged');
  });

  it('re-adding an already-staged candidate cannot increase the staged count — Map.set by findingId stays idempotent', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const ncpBlock = html.slice(html.indexOf('New Component Plan — deliberately separate'));
    expect(ncpBlock).toContain('const ncpStaged = new Map();');
    expect(ncpBlock).toContain('ncpStaged.set(findingId, entry);');
  });

  it('shows a real evidence thumbnail for a component-level candidate, preferring the tight element crop', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const badgeId = data.findings.find((f) => f.component.productionType === 'badge')!.identity.findingId;
    const row = html.slice(html.indexOf(`data-finding-id="${badgeId}" data-candidate-source`), html.indexOf(`data-finding-id="${badgeId}" data-candidate-source`) + 2000);
    expect(row).toContain('class="ncp-thumb"');
    expect(row).toContain(`<a href="data:image/png;base64,${REAL_PNG.toString('base64')}" target="_blank" rel="noopener">`);
    expect(row).toContain('loading="lazy"');
  });

  it('prefers the wider context crop for a section-level candidate over a tight element crop', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const headingId = data.findings.find((f) => f.component.productionType === 'section-heading')!.identity.findingId;
    // The context-screenshot ref points at a MISSING file (evidenceUrl resolves to null for it in
    // the live dashboard's URL resolver, but the standalone writer embeds real files only) — this
    // fixture uses the standalone writer, so a missing context ref falls back to the element shot
    // it also carries, proving the preference order without needing two real files on disk.
    const rowStart = html.indexOf(`data-finding-id="${headingId}" data-candidate-source`);
    const row = html.slice(rowStart, rowStart + 2000);
    expect(row).toContain('class="ncp-thumb"');
    expect(row).toContain(REAL_PNG.toString('base64')); // fell back to the element shot since context wasn't a real file
  });

  it('shows the existing no-evidence placeholder, never a broken image, when a candidate has no screenshot at all', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const chipId = data.findings.find((f) => f.component.productionType === 'chip')!.identity.findingId;
    const rowStart = html.indexOf(`data-finding-id="${chipId}" data-candidate-source`);
    const row = html.slice(rowStart, rowStart + 2000);
    expect(row).toContain('<span class="none">no evidence</span>');
  });

  it('shows an instance count on every candidate card, current-state and post-fix alike', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('class="ncp-meta">Hero · 1 instance<'); // the shared finding() factory's default section
  });

  it('clicking a candidate\'s Details button reveals full evidence, signature, and confidence — nothing removed, only collapsed', async () => {
    const data = candidateData();
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    expect(html).toContain('class="ncp-expand" aria-expanded="false">Details</button>');
    expect(html).toContain('class="ncp-detail" hidden>');
    expect(html).toContain('<dt>Signature</dt>');
    expect(html).toContain('<dt>Confidence</dt>');
    expect(html).toContain('<dt>Evidence</dt>');
  });
});

/**
 * html-report-v10 — a screenshot that exists must also SHOW something. Two real causes of "the
 * screenshot is there but looks blank", both seen on the real Deals & IPO run:
 *  - an element that is hidden until hover/interaction (a collapsed card action, an opacity:0
 *    reveal link, an item in a closed menu) is audited, but its crop is one flat colour — while a
 *    perfectly good shot of its surroundings exists and was never used;
 *  - a wide, short crop of left-aligned text, centre-cropped into a 56×40 thumbnail, shows only
 *    its empty middle.
 * The report now reads the pixels (src/output/evidence-image.ts) and chooses/places evidence by
 * what is visible in it. Nothing is re-captured and data.json is untouched.
 */
describe('HTML template v10 — evidence that actually shows something', () => {
  type Rgba = [number, number, number, number];
  let shots: string;
  /** Real PNGs with known geometry, written into this describe's own folder. */
  function writePng(name: string, width: number, height: number, fill: Rgba, paint?: (set: (x: number, y: number, c: Rgba) => void) => void): { path: string; base64: string } {
    const img = new PNG({ width, height });
    const set = (x: number, y: number, c: Rgba) => {
      const o = (y * width + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = c[3];
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, fill);
    paint?.(set);
    const buf = PNG.sync.write(img);
    const path = join(shots, name);
    writeFileSync(path, buf);
    return { path, base64: buf.toString('base64') };
  }
  const box = (set: (x: number, y: number, c: Rgba) => void, x0: number, y0: number, w: number, h: number, c: Rgba) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c);
  };

  beforeAll(() => {
    // A real run layout: the dashboard maps evidence to URLs by the path after /screenshots/.
    shots = join(dir, 'v10-run', 'screenshots', 'p1');
    mkdirSync(shots, { recursive: true });
  });

  const ev = (kind: 'element-screenshot' | 'context-screenshot', ref: string) => ({ kind, ref, note: null, box: { x: 0, y: 0, width: 1, height: 1 } });
  function dataFor(findings: Finding[]): AuditData {
    const page: PageResult = {
      runId: 'run-1', pageId: 'p1', url: 'https://www.kenresearch.com/a', pageName: 'A', templateFamily: 'Consulting', domHash: 'dom-1', dsRegistryVersion: 'ds-hash', policyVersion: 'policy-1', findings,
      compliance: { match: 0, deviation: findings.length, incorrect: 0, newComponent: 0, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
      coverage: { sectionsAnalyzed: 1, componentsDetected: findings.length, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
      capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0 },
    };
    return buildAuditData({ runId: 'run-1', auditId: 'audit-1', mode: 'single-page', startedAt: '2026-10-06T10:00:00.000Z', targetUrl: 'https://www.kenresearch.com/a', pages: [page], failedPages: [] });
  }
  const withShots = (id: string, label: string, evidence: ReturnType<typeof ev>[]): Finding =>
    finding({
      classification: 'DEVIATION',
      identity: { findingId: id } as Finding['identity'],
      component: { productionType: 'link', productionLabel: label, dsComponent: null, dsVariant: null, signature: `sig-${id}` },
      quality: { severity: 'LOW', confidence: 0.9, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence, visualVerdict: 'NOT_CHECKED' },
    });
  const rowOf = (html: string, id: string): string => {
    const start = html.indexOf(`<div class="frow"`, html.indexOf(`data-finding-id="${id}"`) - 200);
    return html.slice(start, html.indexOf('</div>\n  </div>', start) + 20);
  };
  const thumbOf = (row: string): string => row.slice(row.indexOf('<span class="frow-thumb'), row.indexOf('</span>', row.indexOf('<span class="frow-thumb')) + 7);

  it('a flat element crop (a hidden element) yields to its context shot — the row never shows the empty box, and says why', async () => {
    const flat = writePng('hidden-element.png', 12, 50, [16, 16, 16, 255]);
    const ctx = writePng('hidden-context.png', 200, 120, [255, 255, 255, 255], (set) => box(set, 20, 30, 120, 40, [30, 80, 160, 255]));
    const data = dataFor([withShots('hidden-1', 'Get in Touch', [ev('element-screenshot', flat.path), ev('context-screenshot', ctx.path)])]);
    const result = await writeHtmlReport(paths, 'kenresearch-a', data);
    const html = await readFile(paths.reportHtml, 'utf-8');
    const row = rowOf(html, 'hidden-1');
    const thumb = thumbOf(row);
    expect(thumb).toContain(`data:image/png;base64,${ctx.base64}`);
    expect(thumb).not.toContain(flat.base64);
    expect(thumb).toContain('thumb-context'); // dashed: this is the surroundings, not the element's own crop
    expect(thumb).toContain('title="The element crop has no visible detail');
    expect(row).toContain('class="evidence-note"'); // and the detail panel states it in words
    expect(row).toContain('Showing its surroundings instead.');
    expect(row).not.toContain(flat.base64);
    // The rejected flat crop is not embedded or packaged — only what is shown is shipped.
    expect(result.embeddedRefs).toContain(ctx.path);
    expect(result.embeddedRefs).not.toContain(flat.path);
  });

  it('a finding whose element crop was never captured shows its context shot instead of an empty thumbnail', async () => {
    const ctx = writePng('only-context.png', 200, 120, [255, 255, 255, 255], (set) => box(set, 20, 30, 120, 40, [30, 80, 160, 255]));
    const data = dataFor([withShots('ctxonly-1', 'Footer link', [ev('context-screenshot', ctx.path)])]);
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const thumb = thumbOf(rowOf(await readFile(paths.reportHtml, 'utf-8'), 'ctxonly-1'));
    expect(thumb).toContain(`data:image/png;base64,${ctx.base64}`);
    expect(thumb).not.toContain('thumb-context'); // nothing was rejected — there was simply no element crop
  });

  it('left-aligned text in a wide, short crop is shown from where the text starts — not a centre-crop of its empty middle', async () => {
    // 400x20 crop, text ink only in x 0..99 — the old `object-fit: cover` showed x≈172..228: blank.
    const strip = writePng('strip.png', 400, 20, [255, 255, 255, 255], (set) => box(set, 0, 4, 100, 12, [30, 30, 30, 255]));
    const data = dataFor([withShots('strip-1', 'IPO Advisory', [ev('element-screenshot', strip.path)])]);
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const thumb = thumbOf(rowOf(await readFile(paths.reportHtml, 'utf-8'), 'strip-1'));
    expect(thumb).toContain('class="thumb-ink"');
    const style = /style="left:(-?\d+)px;top:(-?\d+)px;width:(\d+)px;height:(\d+)px"/.exec(thumb)!;
    const [left, top, width, height] = [Number(style[1]), Number(style[2]), Number(style[3]), Number(style[4])];
    const scale = width / 400;
    // The text's left edge lands at (or just inside) the thumbnail's left edge, at a readable scale…
    expect(scale).toBeGreaterThanOrEqual(0.6);
    expect(left + 0 * scale).toBeGreaterThanOrEqual(0);
    expect(left + 0 * scale).toBeLessThanOrEqual(4);
    // …and the strip sits vertically inside the 38px-tall inner box, not above or below it.
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + height).toBeLessThanOrEqual(38 + 1);
  });

  it('a small crop that fits is centred and fitted whole — the ink box is placed inside the thumbnail, never clipped', async () => {
    // 120x30 crop, a 40x12 mark in its middle: the ink box is tiny relative to the image.
    const small = writePng('small.png', 120, 30, [255, 255, 255, 255], (set) => box(set, 40, 9, 40, 12, [200, 30, 40, 255]));
    const data = dataFor([withShots('small-1', 'Badge', [ev('element-screenshot', small.path)])]);
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const thumb = thumbOf(rowOf(await readFile(paths.reportHtml, 'utf-8'), 'small-1'));
    const style = /style="left:(-?\d+)px;top:(-?\d+)px;width:(\d+)px;height:(\d+)px"/.exec(thumb)!;
    const [left, top, width] = [Number(style[1]), Number(style[2]), Number(style[3])];
    const scale = width / 120;
    // ink box (mark ± 3px pad) = x 37..83 (46 wide), y 6..24 (18 tall): fully inside the 54x38 inner box.
    expect(left + 37 * scale).toBeGreaterThanOrEqual(0);
    expect(left + 83 * scale).toBeLessThanOrEqual(54 + 1);
    expect(top + 6 * scale).toBeGreaterThanOrEqual(0);
    expect(top + 24 * scale).toBeLessThanOrEqual(38 + 1);
  });

  it('when every shot is flat there is nothing better to show — the flat one is still shown, exactly as before, with a plain-words note', async () => {
    const flat = writePng('flat-only.png', 12, 50, [16, 16, 16, 255]);
    const data = dataFor([withShots('flatonly-1', 'Get in Touch', [ev('element-screenshot', flat.path)])]);
    await writeHtmlReport(paths, 'kenresearch-a', data);
    const row = rowOf(await readFile(paths.reportHtml, 'utf-8'), 'flatonly-1');
    expect(thumbOf(row)).toContain(`data:image/png;base64,${flat.base64}`);
    expect(thumbOf(row)).not.toContain('thumb-context');
    expect(row).toContain('This screenshot has no visible detail');
  });

  it('without an inspector (a caller that cannot read the files) every screenshot is shown exactly as before — no fallback, no ink placement', () => {
    const flat = writePng('noinspect-flat.png', 12, 50, [16, 16, 16, 255]);
    const ctx = writePng('noinspect-ctx.png', 200, 120, [255, 255, 255, 255], (set) => box(set, 20, 30, 120, 40, [30, 80, 160, 255]));
    const data = dataFor([withShots('plain-1', 'Get in Touch', [ev('element-screenshot', flat.path), ev('context-screenshot', ctx.path)])]);
    const html = renderRun('proj', data, '/evidence/proj/run-1');
    const thumb = thumbOf(rowOf(html, 'plain-1'));
    expect(thumb).toMatch(/<img src="\/evidence\/proj\/run-1\/[^"]+" alt="evidence" loading="lazy">/);
    expect(thumb).not.toContain('thumb-ink');
    expect(thumb).not.toContain('thumb-context');
    expect(html).not.toContain('class="evidence-note"');
  });

  it('thumbnails never centre-crop (`object-fit: cover`) — the rule that made left-aligned text look blank is gone', async () => {
    await writeHtmlReport(paths, 'kenresearch-a', buildData());
    const style = (await readFile(paths.reportHtml, 'utf-8')).match(/<style>([\s\S]*?)<\/style>/)![1]!;
    expect(style).toMatch(/\.frow-thumb img, \.ncp-thumb img \{[^}]*object-fit: contain/);
    expect(style).not.toMatch(/\.(frow|ncp)-thumb img \{[^}]*object-fit: cover/);
  });

  it('the New Component cards use the same visible-evidence choice — a hidden element\'s candidate thumbnail is its surroundings, not a flat box', async () => {
    const flat = writePng('ncp-flat.png', 12, 50, [16, 16, 16, 255]);
    const ctx = writePng('ncp-ctx.png', 200, 120, [255, 255, 255, 255], (set) => box(set, 20, 30, 120, 40, [30, 80, 160, 255]));
    const candidate = finding({
      classification: 'NEW_COMPONENT',
      identity: { findingId: 'ncp-hidden-1' } as Finding['identity'],
      component: { productionType: 'button', productionLabel: 'Connect via Mail', dsComponent: null, dsVariant: null, signature: 'sig-ncp-hidden' },
      quality: { severity: 'LOW', confidence: 0.7, confidenceBand: 'MEDIUM', escalationStatus: 'NONE', escalationReasons: [], evidence: [ev('element-screenshot', flat.path), ev('context-screenshot', ctx.path)], visualVerdict: 'NOT_CHECKED' },
    });
    await writeHtmlReport(paths, 'kenresearch-a', dataFor([candidate]));
    const html = await readFile(paths.reportHtml, 'utf-8');
    const card = html.slice(html.indexOf('<div class="ncp-row" data-finding-id="ncp-hidden-1"'));
    const thumb = card.slice(card.indexOf('<span class="ncp-thumb">'), card.indexOf('</span>', card.indexOf('<span class="ncp-thumb">')) + 7);
    expect(thumb).toContain(`data:image/png;base64,${ctx.base64}`);
    expect(thumb).not.toContain(flat.base64);
    expect(thumb).toContain('class="thumb-context"');
  });
});
