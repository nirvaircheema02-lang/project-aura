import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { openDb } from '../../src/db/index.ts';
import { loadDsRegistry, type DsRegistry } from '../../src/ds/d2-registry/index.ts';
import { referenceCatalogOf, loadReferenceCatalog, type ReferenceCatalog } from '../../src/ds/reference-patterns.ts';
import { decideMatch, dsIndex, type DsIndex } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import { attachReference, referenceRoleOf } from '../../src/agents/b3-ds-matcher/reference.ts';
import { evaluateUnmatched } from '../../src/agents/b6-new-component-evaluator/evaluate.ts';
import { routesToNewComponentEvaluator } from '../../src/skills/s8-confidence-escalation-policy.ts';
import type { DetectedComponent, DsMatch, PageSession } from '../../src/agents/types.ts';

/**
 * DESIGN SYSTEM FIRST, approved Project Aura reference second. The matching order is locked:
 *   exact DS component/pattern → closest valid DS family/variant → approved reference pattern → NEEDS_REVIEW
 *   → only a genuine no-family / no-pattern case → B6.
 * The reference catalog is consulted ONLY for what the DS search left undecided; it never overrides a DS answer,
 * never makes an element a SectionHeading (or any other unrelated component), and an ambiguous pattern is a
 * question for a human, not a guess.
 */

let registry: DsRegistry;
let index: DsIndex;
beforeAll(async () => {
  registry = await loadDsRegistry(loadConfig().designSystemPath);
  index = await dsIndex(registry);
}, 120_000);

/** A catalog that FAILS if anything reads it — proof the DS answer was first and final. */
const tripwire = new Proxy({}, { get: () => { throw new Error('the reference catalog was consulted although the Design System answered'); } }) as unknown as ReferenceCatalog;

const pages = [{ id: 'report-store', name: 'Report Store', folder: 'rs' }, { id: 'case-study', name: 'Case Study', folder: 'cs' }, { id: 'competition-benchmarking', name: 'Competition Benchmarking', folder: 'cb' }];
const obs = (page: string, properties: Record<string, string>) => ({ page, source: `${page}/x.css:1`, properties });
const agreeing = { 'font-size': '20px', 'font-weight': '400', 'text-transform': 'none', color: '#404040', 'font-family': 'Noto Serif' };
const catalogOf = (role: string, observations: ReturnType<typeof obs>[], surface: 'light' | 'dark' | 'any' = 'light') => referenceCatalogOf({ schemaVersion: 1, evidence: 'test', measuredOn: '2026-10-07', pages, patterns: [{ role, surface, observations }] });

function component(componentType: string, over: Partial<DetectedComponent> = {}, raw: Record<string, string> = {}, surface: 'light' | 'dark' | 'unknown' = 'light'): DetectedComponent {
  return {
    elId: 's0-0', ref: 'e1', sectionId: 's0', sectionName: 'Intro', captureState: 'default', componentType, label: 'A quotation about research', domSignals: [], visualSignals: '', instanceGroupKey: 'k', detectionConfidence: 0.9, confidenceOutOfContract: false,
    fingerprint: { structuralPath: 'blockquote', role: 'generic', accessibleName: '', textPrefix: 'A quotation', box: { x: 0, y: 0, width: 600, height: 60 } }, findingId: 'f1',
    style: { connected: true, raw: { 'font-size': '20px', 'font-weight': '400', color: 'rgb(64, 64, 64)', 'font-family': 'Noto Serif', 'text-transform': 'none', ...raw }, rootFontSizePx: 16, box: { width: 600, height: 60 } },
    signature: 'sig-quote', containsPlaceholder: false, screenshots: { element: null, context: null }, evidenceClipped: false, href: null,
    domFacts: { tag: 'blockquote', classes: [], roleAttr: null, cursor: 'auto', text: 'A quotation about research', hasSvg: false, hasImg: false, ownText: true, childElementCount: 0, context: { breadcrumb: false, current: false, expanded: false, surface, surfaceEvidence: 'test', imageSource: null, accessibleName: '' }, style: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderTopWidth: '0px', borderTopStyle: 'none', paddingLeft: '0px', paddingTop: '0px', color: 'rgb(64, 64, 64)', fontSize: '18px', fontWeight: '400', display: 'block', opacity: '1', visibility: 'visible', textTransform: 'none', letterSpacing: 'normal' }, box: { x: 0, y: 0, width: 600, height: 60 } },
    ...over,
  } as unknown as DetectedComponent;
}

describe('the role the reference catalog is asked about', () => {
  it('is B2\'s role: an eyebrow, a description (a heading-tagged element that is body copy), otherwise the component type', () => {
    expect(referenceRoleOf({ componentType: 'eyebrow' })).toBe('eyebrow');
    expect(referenceRoleOf({ componentType: 'paragraph', headingRole: 'description' })).toBe('description');
    expect(referenceRoleOf({ componentType: 'paragraph' })).toBe('paragraph');
    expect(referenceRoleOf({ componentType: 'quote' })).toBe('quote');
  });
});

describe('the Design System is searched FIRST — the catalog is never read when the DS answered', () => {
  it('an eyebrow the DS defines (OverheadText / SectionLabel, R4.8) is matched by the DS; the catalog is not consulted — even a catalog with evidence for it', () => {
    const eyebrow = component('eyebrow', { headingRole: 'eyebrow' }, { color: 'rgb(70, 68, 73)', 'font-size': '10px', 'font-weight': '500', 'letter-spacing': 'normal', 'text-transform': 'none', 'font-family': 'DM Sans', display: 'block' });
    eyebrow.domFacts!.tag = 'h2'; // an eyebrow written as a heading: its tag is not evidence about which DS component it is
    const ds = decideMatch(eyebrow, index, registry, 1440);
    expect(ds.dsComponent, 'the DS family answers').not.toBeNull();
    expect(['OverheadText', 'SectionLabel']).toContain(ds.dsComponent);
    expect(ds.search?.family?.ruleId).toBe('R4.8'); // the DS family search is on record…
    const out = attachReference(ds, eyebrow, tripwire); // …and a catalog that throws on any read is never touched
    expect(out).toBe(ds);
    expect(out.reference).toBeUndefined();
  });

  it('body text and stat numerals (the DS governs them by foundation rules) never consult it either', () => {
    const para = component('paragraph');
    const ds = decideMatch(para, index, registry, 1440);
    expect(ds.foundationOnly).toBe(true);
    expect(attachReference(ds, para, tripwire)).toBe(ds);
  });

  it('a heading\'s DS slot answers first too: a section heading is SectionHeading, never a reference pattern', () => {
    const heading = component('section-heading', {}, { 'font-size': '31px' });
    heading.domFacts!.tag = 'h2';
    const ds = decideMatch(heading, index, registry, 1440);
    expect(ds.dsComponent).toBe('SectionHeading');
    expect(attachReference(ds, heading, tripwire)).toBe(ds);
  });
});

describe('when the DS has nothing for the role, the approved pages are consulted — as a verdict, not a decision', () => {
  const quote = component('quote');

  it('a role the DS names no family for is genuinely undecided (the DS search is on record), and routes to B6 as before', () => {
    const ds = decideMatch(quote, index, registry, 1440);
    expect(ds.dsComponent).toBeNull();
    expect(ds.search).toMatchObject({ basis: 'undecided', undecidedBecause: 'no-family' });
    expect(routesToNewComponentEvaluator(ds)).toBe(true);
  });

  it('CONSISTENT across the approved pages → a reference-backed pattern is attached; the match is still undecided (never forced into a DS component)', () => {
    const ds = decideMatch(quote, index, registry, 1440);
    const out = attachReference(ds, quote, catalogOf('quote', [obs('report-store', agreeing), obs('case-study', agreeing), obs('competition-benchmarking', agreeing)]));
    expect(out.reference).toMatchObject({ role: 'quote', verdict: 'consistent', pages: ['Report Store', 'Case Study', 'Competition Benchmarking'] });
    expect(out.dsComponent).toBeNull();
    expect(out.dsFile).toBeNull();
    expect(out.undecidedReason).toContain('approved Project Aura reference');
    expect(routesToNewComponentEvaluator(out)).toBe(true);
  });

  it('SINGLE-SOURCE and DIVERGENT evidence is attached just the same — with its verdict, for a human', () => {
    const ds = decideMatch(quote, index, registry, 1440);
    expect(attachReference(ds, quote, catalogOf('quote', [obs('case-study', agreeing)])).reference?.verdict).toBe('single-source');
    expect(attachReference(ds, quote, catalogOf('quote', [obs('report-store', agreeing), obs('case-study', { ...agreeing, 'font-size': '24px' })])).reference?.verdict).toBe('divergent');
  });

  it('no evidence for the role → nothing changes at all (the same object comes back)', () => {
    const ds = decideMatch(quote, index, registry, 1440);
    expect(attachReference(ds, quote, catalogOf('something-else', [obs('case-study', agreeing)]))).toBe(ds);
    expect(attachReference(ds, quote, undefined)).toBe(ds);
  });

  it('the surface is the element\'s own measured one: a dark-surface role is judged on the dark observations', () => {
    const dark = component('quote', {}, {}, 'dark');
    const ds = decideMatch(dark, index, registry, 1440);
    const catalog = catalogOf('quote', [obs('report-store', agreeing), obs('case-study', agreeing)], 'dark');
    expect(attachReference(ds, dark, catalog).reference).toMatchObject({ surface: 'dark', verdict: 'consistent' });
    expect(attachReference(decideMatch(quote, index, registry, 1440), quote, catalog).reference).toBeUndefined(); // a light element has no dark evidence
  });

  it('the real shipped catalog reaches the same outcome for the eyebrow it actually holds: DIVERGENT, so NEEDS_REVIEW — never a guess', () => {
    const real = loadReferenceCatalog(undefined, join(import.meta.dirname, '..', '..'))!;
    const undecidedEyebrow = { ...decideMatch(quote, index, registry, 1440) }; // any undecided match, asked about the eyebrow role
    const eyebrow = component('eyebrow', { headingRole: 'eyebrow' });
    const out = attachReference(undecidedEyebrow, eyebrow, real);
    expect(out.reference).toMatchObject({ role: 'eyebrow', verdict: 'divergent' });
  });
});

describe('B6 reads the verdict: a consistent pattern is a reference-backed DS candidate, anything less is NEEDS_REVIEW — never a new component, never SectionHeading', () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-b6-ref-'));
    db = openDb(join(dir, 'audit.db'));
  });
  afterAll(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const session = () => ({
    registry, db, aiMode: 'no-api', auditId: 'a1', runId: 'r1', pageId: 'p1', url: 'https://example.test/', templateFamily: null,
    capture: { canonical: { pageUrl: 'https://example.test/' }, renderSettled: { settled: true }, renderingPolicy: { channel: 'chromium', browserVersion: '1.0.0.0', playwrightVersion: '1.0.0' } },
  }) as unknown as PageSession;

  const evaluate = async (observations: ReturnType<typeof obs>[] | null) => {
    const c = component('quote');
    const ds = decideMatch(c, index, registry, 1440);
    const match: DsMatch = observations ? attachReference(ds, c, catalogOf('quote', observations)) : ds;
    const [finding] = await evaluateUnmatched(session(), { components: [c], matches: new Map([[c.ref, match]]) }, [c]);
    return finding!;
  };

  it('CONSISTENT → DS_CANDIDATE, worded as a reference-backed pattern proposed for governance (not a violation, not a new component)', async () => {
    const f = await evaluate([obs('report-store', agreeing), obs('case-study', agreeing)]);
    expect(f.classification).toBe('DS_CANDIDATE');
    expect(f.component.dsComponent).toBeNull();
    expect(f.action.recommendation).toContain('reference-backed pattern');
    expect(f.action.recommendation).toContain('supporting evidence, never a replacement for the Design System');
    expect(f.action.dsCandidateNote).toContain('reference-backed pattern (not in the DS)');
    expect(f.action.registryUpdateRef, 'proposed for DS governance').not.toBeNull();
  });

  it('DIVERGENT → NEEDS_REVIEW, with the pages\' own values beside what was measured', async () => {
    const f = await evaluate([obs('report-store', agreeing), obs('case-study', { ...agreeing, 'font-size': '24px' })]);
    expect(f.classification).toBe('NEEDS_REVIEW');
    expect(f.review?.reason).toContain('do not agree');
    expect(f.review?.observed.find((o) => o.property === 'font-size')).toMatchObject({ actual: '20px', expected: 'varies: 20px (Report Store) / 24px (Case Study)' });
  });

  it('SINGLE-SOURCE → NEEDS_REVIEW (one page is not a pattern)', async () => {
    const f = await evaluate([obs('case-study', agreeing)]);
    expect(f.classification).toBe('NEEDS_REVIEW');
    expect(f.review?.reason).toContain('one page is not a pattern');
  });

  it('NO reference evidence → B6 decides exactly as it always did (a lone, unrepeated element is a question for a human)', async () => {
    const f = await evaluate(null);
    expect(f.classification).toBe('NEEDS_REVIEW');
    expect(f.review?.reason).not.toContain('reference');
  });
});
