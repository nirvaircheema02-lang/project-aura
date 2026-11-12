import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assessReference, loadReferenceCatalog, referenceCatalogOf, type ReferenceCatalogFile } from '../../src/ds/reference-patterns.ts';

/**
 * The approved Project Aura reference evidence (Report Store, Case Study, Competition Benchmarking): how the same
 * semantic ROLE is actually used on the approved pages. Supporting evidence only — a verdict (consistent /
 * single-source / divergent), never a decision, and never a replacement for the Design System.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const props = (over: Record<string, string>) => ({ 'font-size': '12px', 'font-weight': '500', 'letter-spacing': '1.5px', 'text-transform': 'uppercase', color: '#b01f24', 'font-family': 'DM Sans', ...over });
const pages = [{ id: 'report-store', name: 'Report Store', folder: 'rs' }, { id: 'case-study', name: 'Case Study', folder: 'cs' }, { id: 'competition-benchmarking', name: 'Competition Benchmarking', folder: 'cb' }];
const catalog = (patterns: ReferenceCatalogFile['patterns']) => referenceCatalogOf({ schemaVersion: 1, evidence: 'test', measuredOn: '2026-10-07', pages, patterns });
const obs = (page: string, properties: Record<string, string>) => ({ page, source: `${page}/x.css:1`, properties });

describe('the shipped catalog: what the three approved pages actually say (measured from their sources)', () => {
  const real = loadReferenceCatalog(undefined, REPO)!;

  it('holds evidence from the Report Store, the Case Study and Competition Benchmarking', () => {
    expect(real).toBeDefined();
    expect(real.pages.map((p) => p.name)).toEqual(['Report Store', 'Case Study', 'Competition Benchmarking']);
    for (const p of real.patterns) for (const o of p.observations) {
      expect(real.pages.some((page) => page.id === o.page), `${o.page} is a declared page`).toBe(true);
      expect(o.source.length).toBeGreaterThan(10); // every value says where it was measured
    }
  });

  it('Competition Benchmarking is the APPROVED page (competition-benchmarking-v2-react, http://localhost:3095) — every one of its observations is measured from it, none from v3', () => {
    const cb = real.pages.find((p) => p.id === 'competition-benchmarking')!;
    expect(cb.folder).toBe('projects/competition-benchmarking-v2-react');
    const observed = real.patterns.flatMap((p) => p.observations).filter((o) => o.page === 'competition-benchmarking');
    expect(observed.length).toBeGreaterThanOrEqual(2); // the section eyebrow and the description under the heading
    for (const o of observed) {
      expect(o.source.startsWith('competition-benchmarking-v2-react/src/globals.css:'), o.source).toBe(true);
      expect(o.source).not.toContain('competition-benchmarking-v3');
    }
    expect(cb.note).toContain('replaces competition-benchmarking-v3'); // the page entry says why v3 is not used, so it is not re-introduced
  });

  it('the eyebrow is NOT one consistent pattern across the approved pages — it is DIVERGENT, and says exactly how', () => {
    const a = assessReference(real, 'eyebrow', 'light')!;
    expect(a.verdict).toBe('divergent');
    expect(a.pages).toEqual(['Report Store', 'Case Study', 'Competition Benchmarking']);
    expect(a.differing.map((d) => d.property).sort()).toEqual(['color', 'font-size', 'font-weight', 'letter-spacing']);
    expect(a.agreed).toMatchObject({ 'text-transform': 'uppercase', 'font-family': 'DM Sans' }); // the only things all three share
    const size = a.differing.find((d) => d.property === 'font-size')!;
    expect(size.values.map((v) => v.value)).toEqual(['12px', '12.8px', '12px']);
    expect(a.differing.find((d) => d.property === 'font-weight')!.values.map((v) => v.value)).toEqual(['400', '400', '600']);
    expect(a.differing.find((d) => d.property === 'letter-spacing')!.values.map((v) => v.value)).toEqual(['1.8px', '1.57px', '2.4px']);
    expect(a.note).toContain('do not agree');
  });

  it('an eyebrow on a dark surface, and the description under a heading, are read from their own observations', () => {
    expect(assessReference(real, 'eyebrow', 'dark')).toMatchObject({ verdict: 'divergent', surface: 'dark', pages: ['Report Store', 'Case Study'] });
    const description = assessReference(real, 'description', 'light')!;
    expect(description.verdict).toBe('divergent'); // weight 400 everywhere — but 14px / 14px / 16px, and line-height and colour differ too
    expect(description.agreed).toMatchObject({ 'font-weight': '400', 'font-family': 'DM Sans' });
    expect(description.differing.map((d) => d.property).sort()).toEqual(['color', 'font-size', 'line-height']);
    expect(description.differing.find((d) => d.property === 'font-size')!.values).toEqual([
      { page: 'Report Store', value: '14px' },
      { page: 'Case Study', value: '14px' },
      { page: 'Competition Benchmarking', value: '16px' },
    ]);
  });

  it('a role the catalog holds nothing for gives no verdict at all — the element is exactly as undecided as before', () => {
    expect(assessReference(real, 'carousel', 'light')).toBeNull();
    expect(assessReference(undefined, 'eyebrow', 'light')).toBeNull();
  });
});

describe('the verdicts', () => {
  it('CONSISTENT: at least two approved pages, every property they define agreeing (lengths within a sub-pixel, a colour is the same painted colour)', () => {
    const c = catalog([{ role: 'stat-label', surface: 'light', observations: [obs('report-store', props({ 'font-size': '12px', color: '#b01f24' })), obs('case-study', props({ 'font-size': '12.2px', color: 'rgb(176, 31, 36)' })), obs('competition-benchmarking', props({ 'font-size': '11.9px' }))] }]);
    const a = assessReference(c, 'stat-label', 'light')!;
    expect(a.verdict).toBe('consistent');
    expect(a.differing).toEqual([]);
    expect(Object.keys(a.agreed).length).toBeGreaterThanOrEqual(3);
    expect(a.note).toContain('consistently');
    expect(a.note).toContain('does not define');
  });

  it('SINGLE-SOURCE: one page is not a pattern', () => {
    const c = catalog([{ role: 'step-label', surface: 'light', observations: [obs('case-study', props({}))] }]);
    expect(assessReference(c, 'step-label', 'light')).toMatchObject({ verdict: 'single-source', pages: ['Case Study'] });
  });

  it('DIVERGENT: the pages disagree — their own values are listed, nothing is averaged or picked', () => {
    const c = catalog([{ role: 'tag-line', surface: 'light', observations: [obs('report-store', props({ 'font-weight': '400' })), obs('case-study', props({ 'font-weight': '600' }))] }]);
    const a = assessReference(c, 'tag-line', 'light')!;
    expect(a.verdict).toBe('divergent');
    expect(a.differing).toEqual([{ property: 'font-weight', values: [{ page: 'Report Store', value: '400' }, { page: 'Case Study', value: '600' }] }]);
  });

  it('two pages that share too little to call it one pattern are not "consistent" either', () => {
    const c = catalog([{ role: 'sliver', surface: 'light', observations: [obs('report-store', { 'font-size': '12px' }), obs('case-study', { 'font-size': '12px' })] }]);
    expect(assessReference(c, 'sliver', 'light')?.verdict).toBe('divergent');
  });

  it('the surface decides which observations count: unknown is read as light, "any" answers both, a dark-only pattern never answers light', () => {
    const c = catalog([
      { role: 'r', surface: 'dark', observations: [obs('report-store', props({})), obs('case-study', props({}))] },
      { role: 'any-role', surface: 'any', observations: [obs('report-store', props({})), obs('case-study', props({}))] },
    ]);
    expect(assessReference(c, 'r', 'dark')?.verdict).toBe('consistent');
    expect(assessReference(c, 'r', 'light')).toBeNull();
    expect(assessReference(c, 'r', 'unknown')).toBeNull();
    expect(assessReference(c, 'any-role', 'dark')?.verdict).toBe('consistent');
    expect(assessReference(c, 'any-role', 'unknown')?.verdict).toBe('consistent');
  });
});

describe('loading the catalog', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'audit-ref-')); dirs.push(d); return d; };

  it('a missing file is simply no evidence — not an error', () => {
    expect(loadReferenceCatalog('nope.json', tmp())).toBeUndefined();
  });

  it('a catalog that EXISTS but cannot be trusted is an error, never silently ignored', () => {
    const d = tmp();
    writeFileSync(join(d, 'bad.json'), '{ not json');
    expect(() => loadReferenceCatalog('bad.json', d)).toThrow(/not valid JSON/);
    writeFileSync(join(d, 'shape.json'), JSON.stringify({ schemaVersion: 1, evidence: 'x', measuredOn: 'y', pages: [], patterns: [{ role: 'a', surface: 'sideways', observations: [] }] }));
    expect(() => loadReferenceCatalog('shape.json', d)).toThrow(/invalid approved reference catalog/);
  });

  it('its version is a content hash — changing one observed value changes it (and so the engine fingerprint of the evidence)', () => {
    const a = catalog([{ role: 'r', surface: 'light', observations: [obs('report-store', props({}))] }]);
    const b = catalog([{ role: 'r', surface: 'light', observations: [obs('report-store', props({ 'font-size': '13px' }))] }]);
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
    expect(a.version).not.toBe(b.version);
  });
});
