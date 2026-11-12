import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { buildFinding, type ComponentEvaluation } from '../../src/agents/b4-compliance-auditor/index.ts';
import { expectedForDisplay, FALLBACK_ROOT_FONT_SIZE_PX, isTypographyProperty, pageRoots, recommendationForDisplay, TYPOGRAPHY_LENGTH_PROPERTIES, withResolvedPx } from '../../src/output/display-values.ts';
import { lengthToPx } from '../../src/t-layer/computed-style.ts';
import type { DetectedComponent, DsMatch, PageSession, TypographyChoice } from '../../src/agents/types.ts';

/**
 * The permanent report-formatting rule — an Expected typography value in `rem` is displayed with its
 * resolved px beside it (`2.441rem (39.06px)`) — as ONE shared module every report surface uses. Pure
 * display: nothing here is stored, so no finding, status, match or recommendation text can change.
 */

describe('which properties are typography', () => {
  it('font-size, line-height, letter-spacing, word-spacing and text-indent — and a compound part of them (label.font-size)', () => {
    for (const p of ['font-size', 'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'label.font-size', 'FONT-SIZE']) expect(isTypographyProperty(p), p).toBe(true);
    expect([...TYPOGRAPHY_LENGTH_PROPERTIES].sort()).toEqual(['font-size', 'letter-spacing', 'line-height', 'text-indent', 'word-spacing']);
  });

  it('spacing, radius, colour, weight and family are not — and neither is nothing', () => {
    for (const p of ['padding-left', 'margin-top', 'gap', 'border-top-left-radius', 'color', 'font-weight', 'font-family', 'width', 'text-transform', '', null, undefined]) expect(isTypographyProperty(p), String(p)).toBe(false);
  });
});

describe('expectedForDisplay — a structured Expected value', () => {
  it('a typography rem length gains its px, resolved by the audit\'s own conversion — whatever the value', () => {
    expect(expectedForDisplay('font-size', '2.441rem')).toBe('2.441rem (39.06px)');
    expect(expectedForDisplay('font-size', '1.953rem')).toBe('1.953rem (31.25px)');
    expect(expectedForDisplay('line-height', '1.5rem')).toBe('1.5rem (24px)');
    expect(expectedForDisplay('letter-spacing', '0.05rem')).toBe('0.05rem (0.8px)');
    expect(expectedForDisplay('label.font-size', '0.688rem')).toBe('0.688rem (11.01px)');
  });

  it('uses the root it is given, not a hardcoded 16', () => {
    expect(expectedForDisplay('font-size', '2rem', 18)).toBe('2rem (36px)');
    expect(expectedForDisplay('font-size', '2rem', 10)).toBe('2rem (20px)');
    expect(expectedForDisplay('font-size', '2.441rem', 20)).toBe('2.441rem (48.82px)');
  });

  it('every other Expected value is returned exactly as given — a token name, em, px, a keyword, a compound value, a colour, "Not resolved"', () => {
    for (const value of ['--text-lg', '1.2em', '32px', 'inline-flex', '1rem 2rem', 'clamp(2rem, 4vw, 3rem)', '#b01f24', 'Not resolved']) {
      expect(expectedForDisplay('font-size', value), value).toBe(value);
    }
  });

  it('a rem value of a NON-typography property is shown as it always was (the rule is for typography)', () => {
    expect(expectedForDisplay('padding-left', '0.625rem')).toBe('0.625rem');
    expect(expectedForDisplay('border-top-left-radius', '0.5rem')).toBe('0.5rem');
    expect(expectedForDisplay('max-width', '12rem')).toBe('12rem');
  });

  it('is idempotent and null-safe', () => {
    expect(expectedForDisplay('font-size', expectedForDisplay('font-size', '2.441rem'))).toBe('2.441rem (39.06px)');
    expect(expectedForDisplay('font-size', null)).toBe('');
    expect(expectedForDisplay('font-size', undefined)).toBe('');
  });
});

describe('the root a rem is converted with: the page\'s MEASURED root, the browser default only when none was recorded', () => {
  it('the fallback is the browser default the audit\'s own converter uses when it is given no root', () => {
    expect(FALLBACK_ROOT_FONT_SIZE_PX).toBe(16);
    expect(lengthToPx('1rem')).toBe(FALLBACK_ROOT_FONT_SIZE_PX);
    expect(withResolvedPx('2rem')).toBe('2rem (32px)');
    expect(withResolvedPx('2rem', undefined)).toBe('2rem (32px)');
    expect(withResolvedPx('2rem', null)).toBe('2rem (32px)');
  });

  it('a recorded root that cannot be one (0, negative, NaN, Infinity) is not trusted — the fallback applies', () => {
    for (const bad of [0, -16, Number.NaN, Number.POSITIVE_INFINITY]) expect(withResolvedPx('2rem', bad), String(bad)).toBe('2rem (32px)');
  });

  const finding = (pageId: string, url: string) => ({ location: { pageId, url } });
  const data = {
    pageSummary: [
      { pageId: 'p16', url: 'https://example.test/a', rootFontSizePx: 16 },
      { pageId: 'p20', url: 'https://example.test/b', rootFontSizePx: 20 },
      { pageId: 'p10', url: 'https://example.test/c', rootFontSizePx: 10 },
      { pageId: 'old', url: 'https://example.test/old' }, // written before the root was recorded
      { pageId: 'bad', url: 'https://example.test/bad', rootFontSizePx: 0 }, // damaged
    ],
  };

  it('pageRoots hands each finding the root measured on ITS page — by page id, by url for an aggregate row', () => {
    const roots = pageRoots(data);
    expect(roots.of(finding('p16', 'https://example.test/a'))).toBe(16);
    expect(roots.of(finding('p20', 'https://example.test/b'))).toBe(20);
    expect(roots.of(finding('p10', 'https://example.test/c'))).toBe(10);
    expect(roots.ofUrl('https://example.test/b')).toBe(20);
    // the page id wins when both are known and disagree; the url is the fallback for a record whose id is not in the summary
    expect(roots.of(finding('p20', 'https://example.test/a'))).toBe(20);
    expect(roots.of(finding('unknown-id', 'https://example.test/b'))).toBe(20);
  });

  it('a page that recorded none, a damaged one, an unknown page and no summary at all give undefined — never a guessed number', () => {
    const roots = pageRoots(data);
    expect(roots.of(finding('old', 'https://example.test/old'))).toBeUndefined();
    expect(roots.of(finding('bad', 'https://example.test/bad'))).toBeUndefined();
    expect(roots.of(finding('nope', 'https://example.test/nope'))).toBeUndefined();
    expect(roots.ofUrl(null)).toBeUndefined();
    expect(roots.ofUrl('')).toBeUndefined();
    expect(pageRoots({}).of(finding('p20', 'https://example.test/b'))).toBeUndefined();
  });

  it('the same expected value is shown with each page\'s own px', () => {
    const roots = pageRoots(data);
    const shown = (pageId: string, url: string) => expectedForDisplay('font-size', '1.953rem', roots.of(finding(pageId, url)));
    expect(shown('p16', 'https://example.test/a')).toBe('1.953rem (31.25px)');
    expect(shown('p20', 'https://example.test/b')).toBe('1.953rem (39.06px)');
    expect(shown('p10', 'https://example.test/c')).toBe('1.953rem (19.53px)');
    expect(shown('old', 'https://example.test/old')).toBe('1.953rem (31.25px)'); // the fallback, the only assumed root
  });
});

describe('withResolvedPx — the single-value formatter underneath', () => {
  it('is the same function the HTML report has always exported', async () => {
    const render = await import('../../src/dashboard/views/render.ts');
    expect(render.withResolvedPx).toBe(withResolvedPx);
  });
});

describe('recommendationForDisplay — recommendation / detail prose that quotes an Expected typography value', () => {
  it('B4\'s one quoting format `<property>: <actual> → <expected>` gains the px on a typography rem value', () => {
    expect(recommendationForDisplay('Source: atoms/Button.tsx (primary). font-size: 15px → 1rem; padding-left: 8px → 0.625rem. Preserve properties already matching.')).toBe(
      'Source: atoms/Button.tsx (primary). font-size: 15px → 1rem (16px); padding-left: 8px → 0.625rem. Preserve properties already matching.',
    );
  });

  it('several typography values in one recommendation each get theirs; non-rem and non-typography fragments are untouched', () => {
    expect(recommendationForDisplay('font-size: 12px → 0.75rem; line-height: 20px → 1.5rem; letter-spacing: 0px → 0.12em; color: #000 → --ink; padding-top: 4px → 0.25rem')).toBe(
      'font-size: 12px → 0.75rem (12px); line-height: 20px → 1.5rem (24px); letter-spacing: 0px → 0.12em; color: #000 → --ink; padding-top: 4px → 0.25rem',
    );
  });

  it('a value that already carries its px — B4\'s own nearest-size annotation, or a value formatted before — is never doubled', () => {
    const b4 = 'font-size: 32px → 1.953rem (31.25px — the closest DS size, 0.75px away)';
    expect(recommendationForDisplay(b4)).toBe(b4);
    const once = recommendationForDisplay('font-size: 15px → 1rem.');
    expect(once).toBe('font-size: 15px → 1rem (16px).');
    expect(recommendationForDisplay(once)).toBe(once);
  });

  it('a compound part (label.font-size) and the root argument work in prose too; null becomes an empty string', () => {
    expect(recommendationForDisplay('label.font-size: 12px → 1rem', 20)).toBe('label.font-size: 12px → 1rem (20px)');
    expect(recommendationForDisplay('font-size: 32px → 1.953rem; line-height: 48px → 3rem', 10)).toBe('font-size: 32px → 1.953rem (19.53px); line-height: 48px → 3rem (30px)');
    expect(recommendationForDisplay(null)).toBe('');
    expect(recommendationForDisplay('Comparison incomplete: nothing could be compared.')).toBe('Comparison incomplete: nothing could be compared.');
  });
});

// ── The coupling that matters: the prose the display function reads is the prose B4 writes. ──────────
describe('B4\'s own recommendation text is what recommendationForDisplay reads — a change to either fails here', () => {
  let registry: DsRegistry;
  beforeAll(async () => {
    registry = await loadDsRegistry(loadConfig().designSystemPath);
  });

  const component: DetectedComponent = {
    elId: 'el-1', ref: 'e1', sectionId: 's1', sectionName: 'Hero', captureState: 'default', componentType: 'section-heading', label: 'Find your survey', domSignals: [], visualSignals: '', instanceGroupKey: 'k',
    detectionConfidence: 0.9, confidenceOutOfContract: false, fingerprint: { structuralPath: 'h2', role: 'heading', accessibleName: '', textPrefix: '', box: { x: 0, y: 0, width: 600, height: 48 } }, findingId: 'f1',
    style: { connected: true, raw: {}, rootFontSizePx: 16, box: { width: 600, height: 48 } }, signature: 'sig', containsPlaceholder: false, screenshots: { element: null, context: null }, evidenceClipped: false, href: null, domFacts: null,
  };
  const match: DsMatch = { dsComponent: 'SectionHeading', dsFile: 'atoms/SectionHeading.tsx', dsVariant: 'level 3', confidence: 0.85, rationale: 'x', unanswered: false, confidenceOutOfContract: false };
  const evaluation = (extra: Partial<ComponentEvaluation> = {}): ComponentEvaluation => ({
    mismatches: [
      { property: 'font-size', actual: '15px', expected: '1rem', expectedToken: null, comparison: 'length-px', delta: 1 },
      { property: 'padding-left', actual: '8px', expected: '0.625rem', expectedToken: null, comparison: 'length-px', delta: 2 },
    ],
    passed: ['font-weight', 'font-family', 'line-height'], unresolved: [], ruleViolations: [], ruleNotes: [], ruleConfidences: [], ruleOutOfContract: false,
    expectationConfidence: { value: 0.9, outOfContract: false }, modelOmitted: false, notComparedWhy: '', expectationCount: 5, ...extra,
  });
  const session = () => ({
    registry, aiMode: 'no-api', auditId: 'a1', runId: 'r1', pageId: 'p1', url: 'https://example.test/', templateFamily: null,
    capture: { canonical: { pageUrl: 'https://example.test/' }, renderSettled: { settled: true }, renderingPolicy: { channel: 'chromium', browserVersion: '1.0.0.0', playwrightVersion: '1.0.0' } },
  }) as unknown as PageSession;

  it('a font-size rem mismatch B4 quotes bare gains its px at display time — the stored text is not touched', () => {
    const finding = buildFinding(session(), component, match, evaluation());
    const stored = finding.action.recommendation;
    expect(stored).toContain('font-size: 15px → 1rem');
    const shown = recommendationForDisplay(stored);
    expect(shown).toContain('font-size: 15px → 1rem (16px)');
    expect(shown).toContain('padding-left: 8px → 0.625rem'); // spacing: not typography
    expect(shown).not.toContain('0.625rem (');
    expect(finding.action.recommendation).toBe(stored); // the finding is exactly what B4 wrote
  });

  it('a nearest-size font-size B4 already annotates (`… (31.25px — the closest DS size …)`) is left as B4 wrote it', () => {
    const typography: TypographyChoice = {
      property: 'font-size', actualPx: 32, closestPx: 31.25, closestValue: '1.953rem', closestToken: null, differencePx: 0.75, variant: 'level 3', semanticTag: 'h2', followsSemanticLevel: false, decidedBy: 'distance',
      considered: [{ variant: 'level 3', px: 31.25, value: '1.953rem', distancePx: 0.75 }],
    };
    const finding = buildFinding(session(), component, match, evaluation({ mismatches: [{ property: 'font-size', actual: '32px', expected: '1.953rem', expectedToken: null, comparison: 'length-px', delta: 0.75 }], typography }));
    expect(finding.action.recommendation).toContain('font-size: 32px → 1.953rem (31.25px — the closest DS size, 0.75px away)');
    expect(recommendationForDisplay(finding.action.recommendation)).toBe(finding.action.recommendation);
  });
});
