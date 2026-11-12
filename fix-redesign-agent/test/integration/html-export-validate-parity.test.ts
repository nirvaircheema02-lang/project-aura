import type { BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCheck, renderedParityCheck, validateExport, type ExportExpectation, type ParityTarget } from '../../src/html/export-validate.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';

/**
 * §8.5's browser-backed checks (per the source file's own header comment: "parseCheck /
 * renderedParityCheck need a real one [browser]"). `validateExport` composes `parseCheck`
 * unconditionally, so its aggregation is proved here too, not in the pure unit file.
 */

let pool: BrowserPool;
let context: BrowserContext;

beforeAll(async () => {
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSRedesignTest/0.1' });
  await pool.start();
});
afterAll(async () => {
  await pool?.stop();
});
beforeEach(async () => {
  context = await pool.newIsolatedContext();
});
afterEach(async () => {
  await context?.close();
});

describe('parseCheck', () => {
  it('passes a well-formed document', async () => {
    expect(await parseCheck(context, '<!doctype html><html><body><p>hi</p></body></html>')).toEqual([]);
  }, 30_000);

  it('passes even a bare fragment — real HTML5 parsing always yields a <body>, so this check alone cannot enforce §8.4 rule 1 ("serialize the whole document")', async () => {
    expect(await parseCheck(context, '<p>just a fragment, no html/body wrapper at all</p>')).toEqual([]);
  }, 30_000);
});

describe('renderedParityCheck — real computed-style comparison', () => {
  const html = '<!doctype html><html><body><div data-fra-element="e1" style="color: rgb(255, 0, 0)">hi</div></body></html>';
  const viewport = { width: 800, height: 600 };

  it('reports no failures when the exported element\'s computed style matches the live baseline', async () => {
    const targets: ParityTarget[] = [{ stamp: 'e1', properties: ['color'] }];
    const liveValues = new Map([['e1', { color: 'rgb(255, 0, 0)' }]]);
    expect(await renderedParityCheck(context, html, viewport, targets, liveValues)).toEqual([]);
  }, 30_000);

  it('reports a per-property mismatch, naming the element, the property, and both values', async () => {
    const targets: ParityTarget[] = [{ stamp: 'e1', properties: ['color'] }];
    const liveValues = new Map([['e1', { color: 'rgb(0, 255, 0)' }]]);
    const failures = await renderedParityCheck(context, html, viewport, targets, liveValues);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('e1');
    expect(failures[0]).toContain('color');
    expect(failures[0]).toContain('export="rgb(255, 0, 0)"');
    expect(failures[0]).toContain('live="rgb(0, 255, 0)"');
  }, 30_000);

  it('reports a target element missing from the export entirely', async () => {
    const targets: ParityTarget[] = [{ stamp: 'never-exported', properties: ['color'] }];
    const liveValues = new Map([['never-exported', { color: 'rgb(0, 0, 0)' }]]);
    const failures = await renderedParityCheck(context, html, viewport, targets, liveValues);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('present in the live page but not found in the export');
  }, 30_000);

  it('skips a target with no recorded live baseline — never a false failure for a finding this run never measured', async () => {
    const targets: ParityTarget[] = [{ stamp: 'e1', properties: ['color'] }];
    expect(await renderedParityCheck(context, html, viewport, targets, new Map())).toEqual([]);
  }, 30_000);
});

describe('validateExport — aggregates every check, never swallowing one failure for another', () => {
  it('ok:true, failures:[] on a fully valid document', async () => {
    const html =
      '<!doctype html><html><body><div data-fra-removed="header" hidden></div><main><img src="data:image/png;base64,AAAA"><div data-fra-element="e1">ok</div></main><div data-fra-removed="footer" hidden></div></body></html>';
    const expectation: ExportExpectation = { file: 'redesign-content.html', scope: 'content-no-header-footer', headerFooterRetained: false };
    expect(await validateExport(context, html, expectation, null)).toEqual({ file: 'redesign-content.html', ok: true, failures: [] });
  }, 30_000);

  it('reports BOTH a zero-network failure AND a duplicate-stamp failure at once — neither swallows the other', async () => {
    const html =
      '<!doctype html><html><body><div data-fra-removed="header" hidden></div><main><img src="https://cdn.example.com/live.png"><div data-fra-element="dup">a</div><div data-fra-element="dup">b</div></main><div data-fra-removed="footer" hidden></div></body></html>';
    const expectation: ExportExpectation = { file: 'redesign-content.html', scope: 'content-no-header-footer', headerFooterRetained: false };
    const result = await validateExport(context, html, expectation, null);

    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => /live network reference/.test(f))).toBe(true);
    expect(result.failures.some((f) => /more than one element/.test(f))).toBe(true);
    expect(result.failures).toHaveLength(2);
  }, 30_000);

  it('folds a rendered-parity failure into the same aggregate result when parityOpts are supplied', async () => {
    const html = '<!doctype html><html><body><div data-fra-element="e1" style="color: rgb(255, 0, 0)">hi</div></body></html>';
    const expectation: ExportExpectation = { file: 'sections/hero.html', scope: 'one-section', onlySectionId: 'hero', headerFooterRetained: false };
    const parityOpts = { viewport: { width: 800, height: 600 }, targets: [{ stamp: 'e1', properties: ['color'] }], liveValues: new Map([['e1', { color: 'rgb(0, 0, 255)' }]]) };
    const result = await validateExport(context, html, expectation, parityOpts);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('e1') && f.includes('color'))).toBe(true);
  }, 30_000);
});
