import { describe, expect, it } from 'vitest';
import { buildAuditData } from '../../src/agents/c2-json-writer/index.ts';
import { renderRun, withResolvedPx } from '../../src/dashboard/views/render.ts';
import type { Finding, PageResult } from '../../src/skills/s0-result-contract.ts';

/**
 * Display only: an Expected TYPOGRAPHY value in `rem` is shown with its resolved px beside it (`2.441rem
 * (39.06px)`) everywhere the HTML report and dashboard show it — the compact summary, the detail Expected
 * field, the property comparison table and the recommendation view. The stored finding — expected, status,
 * recommendation — is never changed; only how the string is rendered. (`withResolvedPx` itself lives in
 * src/output/display-values.ts and is shared with the Figma plan and the Excel report — see
 * test/unit/display-values.test.ts and test/integration/report-rem-px-surfaces.test.ts.)
 */

describe('withResolvedPx — one rem length gains its px, anything else is returned unchanged', () => {
  it('2.441rem → 2.441rem (39.06px), 1.953rem → 1.953rem (31.25px), 3.052rem → 3.052rem (48.83px)', () => {
    expect(withResolvedPx('2.441rem')).toBe('2.441rem (39.06px)');
    expect(withResolvedPx('1.953rem')).toBe('1.953rem (31.25px)');
    expect(withResolvedPx('3.052rem')).toBe('3.052rem (48.83px)');
  });

  it('uses the supplied root font size, not a hardcoded 16 — the browser default applies only when none is given', () => {
    expect(withResolvedPx('2rem', 18)).toBe('2rem (36px)');
    expect(withResolvedPx('2rem', 10)).toBe('2rem (20px)');
    expect(withResolvedPx('2rem')).toBe('2rem (32px)');
  });

  it('zero and fractional forms resolve too: 0rem → 0rem (0px), .5rem → .5rem (8px)', () => {
    expect(withResolvedPx('0rem')).toBe('0rem (0px)');
    expect(withResolvedPx('.5rem')).toBe('.5rem (8px)');
  });

  it.each(['32px', '#ffffff', 'inline-flex', '--font-weight-medium', '1.2em', '0 2px 8px rgba(0,0,0,0.15)', 'clamp(2rem, 4vw, 3rem)', '1rem 2rem', 'Not resolved', ''])(
    'is returned exactly as given when it is not a single rem length: %j',
    (value) => {
      expect(withResolvedPx(value)).toBe(value);
    },
  );

  it('null/undefined become an empty string, never "undefined"', () => {
    expect(withResolvedPx(null)).toBe('');
    expect(withResolvedPx(undefined)).toBe('');
  });
});

function finding(): Finding {
  return {
    identity: { auditId: 'a1', runId: 'r1', findingId: 'f-rem-1', timestamp: '2026-10-07T10:00:00.000Z', dsRegistryVersion: 'ds', policyVersion: 'p' },
    location: { url: 'https://example.test/', pageId: 'p1', pageName: 'A', templateFamily: null, section: 'Hero', captureState: 'default' },
    component: { productionType: 'section-heading', productionLabel: 'Find Your Survey', dsComponent: 'SectionHeading', dsVariant: 'level 3', signature: 's1' },
    classification: 'DEVIATION',
    comparison: {
      mismatches: [
        { property: 'font-size', actual: '32px', expected: '1.953rem', expectedToken: null, comparison: 'length-px', delta: 0.75 },
        { property: 'letter-spacing', actual: '0.48px', expected: '-0.01em', expectedToken: null, comparison: 'length-px', delta: 0.8 },
      ],
      ruleViolations: [],
      properties: [
        { property: 'font-size', actual: '32px', expected: '1.953rem', expectedToken: null, source: 'atoms/SectionHeading.tsx', status: 'DIFFERENT', note: null },
        { property: 'font-weight', actual: '300', expected: '300', expectedToken: '--font-weight-light', source: 'atoms/SectionHeading.tsx', status: 'MATCH', note: null },
        { property: 'letter-spacing', actual: '0.48px', expected: '-0.01em', expectedToken: null, source: 'atoms/SectionHeading.tsx', status: 'DIFFERENT', note: null },
        { property: 'padding-left', actual: '24px', expected: '1rem', expectedToken: '--space-md', source: null, status: 'UNRESOLVED', note: 'candidate' },
      ],
    },
    quality: { severity: 'LOW', confidence: 0.85, confidenceBand: 'HIGH', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
    action: { recommendation: 'Source: atoms/SectionHeading.tsx (level 3). font-size: 32px → 1.953rem; letter-spacing: 0.48px → -0.01em.', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
    history: { previousStatus: null, currentStatus: 'DEVIATION', delta: null, previousRunId: null },
  } as Finding;
}

/** One audited page; `rootFontSizePx` is the root its capture MEASURED (omitted → a run that recorded none). */
function auditData(rootFontSizePx?: number) {
  const page = {
    runId: 'r1', pageId: 'p1', url: 'https://example.test/', pageName: 'A', templateFamily: null, domHash: 'd', dsRegistryVersion: 'ds', policyVersion: 'p', findings: [finding()],
    compliance: { match: 0, deviation: 1, incorrect: 0, newComponent: 0, dsCandidate: 0, needsReview: 0, unverified: 0, notCompared: 0, compliancePercent: 0 },
    coverage: { sectionsAnalyzed: 1, componentsDetected: 1, excludedPersonalized: 0, excludedOffDomain: 0, sampledListings: [], unexpandedStates: [], droppedRefs: [], truncation: [] },
    capture: { settled: true, httpStatus: 200, consoleSummary: '', criticalFailures: 0, ...(rootFontSizePx === undefined ? {} : { rootFontSizePx }) },
  } as PageResult;
  return buildAuditData({ runId: 'r1', auditId: 'a1', mode: 'single-page', startedAt: '2026-10-07T10:00:00.000Z', targetUrl: 'https://example.test/', pages: [page], failedPages: [] });
}

function html(rootFontSizePx?: number): string {
  return renderRun('proj', auditData(rootFontSizePx), '/evidence/proj/r1');
}

describe('the rendered report shows the resolved px beside every rem Expected TYPOGRAPHY value (a page measured at the 16px default)', () => {
  const out = html(16);

  it('Expected value summary (the compact row): font-size: 32px → 1.953rem (31.25px)', () => {
    expect(out).toContain('font-size: 32px → 1.953rem (31.25px)');
  });

  it('the detail Expected field shows it too', () => {
    expect(out).toMatch(/<dt>Expected<\/dt><dd class="mono">1\.953rem \(31\.25px\)/);
  });

  it('the property comparison table shows it', () => {
    expect(out).toMatch(/<td class="mono">1\.953rem \(31\.25px\)<\/td>/);
  });

  it('only TYPOGRAPHY is formatted: a rem SPACING value (the "Candidate only" padding-left reading) is shown exactly as before', () => {
    expect(out).toContain('Candidate only: 1rem');
    expect(out).not.toContain('Candidate only: 1rem (16px)');
  });

  it('non-rem expected values are left exactly as they were', () => {
    expect(out).toContain('letter-spacing: 0.48px → -0.01em');
    expect(out).not.toContain('-0.01em (');
    expect(out).toMatch(/<td class="mono">300<br>--font-weight-light<\/td>/);
  });

  it('the recommendation VIEW shows the px beside the quoted rem value too', () => {
    expect(out).toContain('font-size: 32px → 1.953rem (31.25px); letter-spacing: 0.48px → -0.01em.');
  });

  it('display only: rendering never changes the stored finding — expected, status and recommendation are byte-identical', () => {
    const before = JSON.stringify(finding());
    const data = auditData(20);
    const snapshot = JSON.stringify(data);
    renderRun('proj', data, '/evidence/proj/r1');
    expect(JSON.stringify(data)).toBe(snapshot);
    expect(data.findings[0]?.comparison.mismatches[0]?.expected).toBe('1.953rem');
    expect(data.findings[0]?.action.recommendation).toBe('Source: atoms/SectionHeading.tsx (level 3). font-size: 32px → 1.953rem; letter-spacing: 0.48px → -0.01em.');
    expect(JSON.stringify(finding())).toBe(before);
  });
});

describe('the px is the rem length × the page\'s MEASURED root font size — never an assumed 16px', () => {
  it('a page measured at 20px: 1.953rem is 39.06px, in the summary, the detail field, the table and the recommendation view', () => {
    const out = html(20);
    expect(out).toContain('font-size: 32px → 1.953rem (39.06px)');
    expect(out).toMatch(/<dt>Expected<\/dt><dd class="mono">1\.953rem \(39\.06px\)/);
    expect(out).toMatch(/<td class="mono">1\.953rem \(39\.06px\)<\/td>/);
    expect(out).toContain('font-size: 32px → 1.953rem (39.06px); letter-spacing: 0.48px → -0.01em.');
    expect(out).not.toContain('(31.25px)'); // the 16px conversion appears nowhere
  });

  it('a page measured at 10px (the 62.5% convention): 1.953rem is 19.53px', () => {
    const out = html(10);
    expect(out).toContain('font-size: 32px → 1.953rem (19.53px)');
    expect(out).not.toContain('(31.25px)');
  });

  it('only what is not typography is untouched, whatever the root: spacing rem stays bare, em stays as written', () => {
    const out = html(20);
    expect(out).toContain('Candidate only: 1rem');
    expect(out).not.toContain('Candidate only: 1rem (');
    expect(out).toContain('letter-spacing: 0.48px → -0.01em');
  });

  it('a run that recorded no root (an older data.json) falls back to the browser default — the one case a root is assumed', () => {
    expect(auditData().pageSummary[0]).not.toHaveProperty('rootFontSizePx');
    expect(html()).toContain('font-size: 32px → 1.953rem (31.25px)');
  });

  it.each([0, -16, Number.NaN, Number.POSITIVE_INFINITY])('an unusable recorded root (%s) is ignored, not trusted: the fallback applies', (bad) => {
    const data = auditData();
    data.pageSummary[0]!.rootFontSizePx = bad;
    expect(renderRun('proj', data, '/evidence/proj/r1')).toContain('font-size: 32px → 1.953rem (31.25px)');
  });
});
