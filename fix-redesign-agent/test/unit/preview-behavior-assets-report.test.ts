import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssetWriter, downloadRemoteAssets, extForMime, rewriteCssUrls } from '../../src/preview/assets.ts';
import { compareBehavior, unavailableSummary, type ProbeResult, type SectionBehavior } from '../../src/preview/behavior.ts';
import { renderFindingAccounting } from '../../src/preview/report.ts';
import { portForRun } from '../../src/preview/server.ts';
import type { PreviewVerification } from '../../src/preview/types.ts';

const section = (over: Partial<SectionBehavior> & { items?: SectionBehavior['items'] } = {}): SectionBehavior => ({ sectionId: 'hero', located: true, items: [], scroll: null, animations: [], sticky: [], ...over });
const item = (index: number, kind: string, label: string, probes: ProbeResult[], href: string | null = null) => ({ index, kind, tag: kind === 'link' ? 'a' : 'button', label, href, probes });
const noDelta = { added: [], removed: [] };
const click = (effects: Array<'text' | 'expanded' | 'height' | 'overlay' | 'value'>, changed = true): ProbeResult => ({ probe: 'click', changed, effects, delta: noDelta, overlayDelta: 0, heightDelta: 0, expandedDelta: 0, stateful: false });

describe('compareBehavior — original page vs the preview', () => {
  it('a link keeps its destination; a changed href is a mismatch', () => {
    const orig = [section({ items: [item(0, 'link', 'Pricing', [{ probe: 'link', href: '/pricing' }], '/pricing')] })];
    expect(compareBehavior(orig, [section({ items: [item(0, 'link', 'Pricing', [{ probe: 'link', href: '/pricing/' }], '/pricing/')] })])[0]!.verdict).toBe('match');
    expect(compareBehavior(orig, [section({ items: [item(0, 'link', 'Pricing', [{ probe: 'link', href: '/other' }], '/other')] })])[0]!.verdict).toBe('mismatch');
  });
  it('a click reaction on the original that does nothing in the preview is reported as not reproduced, never as a pass', () => {
    const orig = [section({ items: [item(0, 'group-item', 'What is X?', [click(['text', 'height'])])] })];
    const none = [section({ items: [item(0, 'group-item', 'What is X?', [click([], false)])] })];
    const r = compareBehavior(orig, none)[0]!;
    expect(r.verdict).toBe('unavailable');
    expect(r.detail).toMatch(/nothing happens in the preview/);
  });
  it('compares the KIND of reaction, not the words (currencies differ between production and a preview)', () => {
    const orig = [section({ items: [item(0, 'pointer', 'APAC', [click(['value'])])] })];
    expect(compareBehavior(orig, [section({ items: [item(0, 'pointer', 'APAC', [click(['value', 'text'])])] })])[0]!.verdict).toBe('match');
    expect(compareBehavior(orig, [section({ items: [item(0, 'pointer', 'APAC', [click(['overlay'])])] })])[0]!.verdict).toBe('mismatch');
  });
  it('a control missing from the preview is unavailable, or not-probed for a hand-authored section', () => {
    const orig = [section({ items: [item(0, 'button', 'Open', [click(['expanded'])])] })];
    expect(compareBehavior(orig, [section()])[0]!.verdict).toBe('unavailable');
    expect(compareBehavior(orig, [section()], { overrideSectionIds: new Set(['hero']) })[0]!.verdict).toBe('not-probed');
  });
  it('a section that is not rendered at all is a mismatch; one that could not be located is not-probed', () => {
    expect(compareBehavior([section()], [])[0]!.verdict).toBe('mismatch');
    expect(compareBehavior([section({ located: false, note: 'not found' })], [section()])[0]!.verdict).toBe('not-probed');
  });
  it('scroll-linked changes and animations must exist in the preview; sticky must too', () => {
    const orig = [section({ scroll: { linked: 3, timer: 0, examples: ['path'] }, animations: [{ name: 'marquee', durationMs: 30000, iterations: 'infinite', state: 'running' }], sticky: ['div.sticky'] })];
    const none = compareBehavior(orig, [section()]);
    expect(none.map((r) => [r.probe, r.verdict])).toEqual([['scroll', 'unavailable'], ['animation', 'unavailable'], ['sticky', 'mismatch']]);
    const all = compareBehavior(orig, [section({ scroll: { linked: 2, timer: 0, examples: [] }, animations: [{ name: 'x', durationMs: 30000, iterations: 'infinite', state: 'running' }], sticky: ['div.sticky'] })]);
    expect(all.every((r) => r.verdict === 'match')).toBe(true);
  });
  it('compares links by destination: relative and absolute forms of the same page match', () => {
    const orig = [section({ items: [item(0, 'link', 'Book', [{ probe: 'link', href: '/custom-form' }], '/custom-form')] })];
    const prev = [section({ items: [item(0, 'link', 'Book', [{ probe: 'link', href: 'https://www.kenresearch.com/custom-form' }], 'https://www.kenresearch.com/custom-form')] })];
    expect(compareBehavior(orig, prev, { siteBase: 'https://www.kenresearch.com/p' })[0]!.verdict).toBe('match');
  });
  it('a hand-authored section\'s missing sticky panel is not-probed, a generated section\'s is a mismatch', () => {
    const orig = [section({ sticky: ['input.sticky "Search"'] })];
    expect(compareBehavior(orig, [section()], { overrideSectionIds: new Set(['hero']) })[0]!.verdict).toBe('not-probed');
    expect(compareBehavior(orig, [section()])[0]!.verdict).toBe('mismatch');
  });
  it('summarises every non-reproduced behaviour for the reviewer, grouped by section and probe', () => {
    const orig = [section({ items: [item(0, 'group-item', 'Q1', [click(['text'])]), item(1, 'group-item', 'Q2', [click(['text'])])] })];
    const lines = unavailableSummary(compareBehavior(orig, [section()]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^hero · click: 2 items/);
  });
});

describe('assets', () => {
  let dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fra-assets-')); dirs.push(d); return d; };

  it('maps mime types to file extensions', () => {
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('font/woff2; charset=x')).toBe('woff2');
    expect(extForMime('application/x-unknown', 'https://x.test/a/b.png?v=1')).toBe('png');
  });
  it('turns data: URIs into content-addressed files and leaves ordinary URLs alone', async () => {
    const dir = tmp();
    const w = createAssetWriter(dir, new Map());
    const url = w.urlFor('data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64'));
    expect(url).toMatch(/^\/assets\/[0-9a-f]{12}\.png$/);
    expect(w.urlFor('data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64'))).toBe(url);
    expect(w.urlFor('/relative.png')).toBe('/relative.png');
    await w.flush();
    expect(readFileSync(join(dir, url.slice(1)), 'utf8')).toBe('PNGDATA');
    expect(w.urlFor('data:font/woff2;base64,AAAA')).toMatch(/^\/fonts\//);
  });
  it('records remote URLs that were never downloaded, so the preview cannot silently call production', () => {
    const w = createAssetWriter(tmp(), new Map([['https://cdn.test/a.png', { file: 'remote/a.png' }]]));
    expect(w.urlFor('https://cdn.test/a.png')).toBe('/remote/a.png');
    expect(w.urlFor('https://cdn.test/missing.png')).toBe('https://cdn.test/missing.png');
    expect(w.remoteMissing).toEqual(['https://cdn.test/missing.png']);
  });
  it('rewrites url(...) in CSS through the resolver', () => {
    expect(rewriteCssUrls('a{background:url("data:image/png;base64,AA")} b{background:url(/x.png)}', () => '/assets/z.png')).toBe('a{background:url("/assets/z.png")} b{background:url(/x.png)}');
  });
  it('downloads remote assets once with an injected fetch, and reports failures instead of hiding them', async () => {
    const dir = tmp();
    const calls: string[] = [];
    const fetchImpl = (async (u: string) => { calls.push(u); return u.includes('bad') ? new Response('no', { status: 404 }) : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }); }) as unknown as typeof fetch;
    const res = await downloadRemoteAssets(['https://cdn.test/ok.png', 'https://cdn.test/bad.png', 'https://cdn.test/ok.png'], dir, { fetchImpl });
    expect(calls.filter((c) => c.includes('ok')).length).toBe(1);
    expect([...res.map.keys()]).toEqual(['https://cdn.test/ok.png']);
    expect(res.failed.map((f) => f.url)).toEqual(['https://cdn.test/bad.png']);
    expect(existsSync(join(dir, res.map.get('https://cdn.test/ok.png')!.file))).toBe(true);
  });

  it('REGRESSION: asks for webp/png, because an image optimizer answers `*/*` with a JPEG and a transparent logo ends up on a black square', async () => {
    const dir = tmp();
    const seen: string[] = [];
    const fetchImpl = (async (_u: string, init?: { headers?: Record<string, string> }) => { seen.push(init?.headers?.['Accept'] ?? ''); return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/webp' } }); }) as unknown as typeof fetch;
    await downloadRemoteAssets(['https://cdn.test/logo'], dir, { fetchImpl });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('image/webp');
    expect(seen[0]).toContain('image/png');
    expect(seen[0]?.startsWith('*/*')).toBe(false);
  });
});

describe('report and ports', () => {
  const v = (findings: PreviewVerification['findings']): PreviewVerification => ({
    schemaVersion: 1, generatedAt: '', url: 'http://127.0.0.1:4400/', mode: 'selected-sections', expectedSectionIds: ['hero'], renderedSectionIds: ['hero'], checks: [], findings, interactions: [], unavailable: [], simulated: [],
    summary: { passed: 0, failed: 0, notChecked: 0, findingsVerified: 0, findingsTotal: findings.length, interactionsMatched: 0, interactionsTotal: 0, interactionsUnavailable: 0 }, verdict: 'pass',
  });
  it('only measured findings are called fixed; everything else is listed with its reason', () => {
    const acct = renderFindingAccounting(v([
      { findingId: 'a'.repeat(32), section: 'Hero', type: 'button', label: 'Go', status: 'fixed-verified', route: 'css-edit', detail: '4 measured properties match' },
      { findingId: 'b'.repeat(32), section: 'Hero', type: 'input', label: 'Name', status: 'unresolved', route: 'original', detail: 'padding is 0px, expected 8px' },
      { findingId: 'c'.repeat(32), section: 'Hero', type: 'button', label: 'India', status: 'not-represented', route: 'none', detail: 'inside a closed panel' },
    ]));
    expect(acct.md).toContain('1 fixed (measured)');
    expect(acct.md).toContain('1 UNRESOLVED');
    expect(acct.md).toContain('1 NOT in the preview');
    expect(acct.md).toContain('inside a closed panel');
  });
  it('gives each run a stable port above the base', () => {
    expect(portForRun('run-a', 4400)).toBe(portForRun('run-a', 4400));
    expect(portForRun('run-a', 4400)).toBeGreaterThanOrEqual(4400);
    expect(portForRun('run-a', 4400)).toBeLessThan(4800);
  });
});
