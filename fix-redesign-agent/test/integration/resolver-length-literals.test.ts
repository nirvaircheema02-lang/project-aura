import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { applyEdit } from '../../src/dom/apply-edit.ts';
import { resolveTargets, type ReferenceHooks } from '../../src/resolution/resolve.ts';
import { authorizedProperties } from '../../src/resolution/schema.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';
import { decision, entryFor, now, prop, residual, RUN, stub, targetFor } from '../helpers/resolver-stub.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Round 2, defect 2: a length / keyword literal that a reference hands back is taken verbatim only by ALLOWLIST - a length property AND a value that is, as a
 * whole, a strict length grammar. The earlier denylist (`scan()` sees no colour) let `4px; border-top-color: var(--nope, red)`, an escaped `\72 ed` and
 * `var(--unknown-anywhere, red)` through as "plain lengths": the target held that text and applyEdit painted it.
 */

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await page.setContent('<div data-fra-element="eLight" style="padding:0;border:1px solid rgb(0,0,255);width:200px;height:80px"><h3>Plan A</h3></div>');
});
afterAll(async () => { await browser.close(); cleanupDsFixtures(); });

async function resolveWith(reference: ReferenceHooks, property: string) {
  const f = residual('f-card', 'card', [prop({ property })]);
  return resolveTargets({ page, dsIndex: miniDsIndex(), dsRegistryVersion: 'v1', decisions: null, reference, now }, { run: RUN, findings: [f], entries: [entryFor('eLight', 'f-card')], judgment: { decisions: [decision({ property })], notes: [] } });
}

describe('a smuggled value is never the target', () => {
  it.each([
    ['padding', '4px; border-top-color: var(--nope, red)'],
    ['padding', '4px; border-top-color: red'],
    ['padding', '\\72 ed'],
    ['padding', '4px \\72 ed'],
    ['padding', 'var(--unknown-anywhere, red)'],
    ['padding', 'var(--unknown-anywhere)'],
    ['padding', 'var(--unknown-anywhere, 4px)'],
    ['gap', '4px } .x { color: red'],
    ['border-radius', '4px /* red */'],
    ['border-radius', '4px url(https://x.example/a.png)'],
    ['font-size', 'calc(1px + red)'],
    ['font-size', 'calc(1px + var(--nope, red))'],
    ['letter-spacing', 'inherit !important'],
    ['line-height', 'env(safe-area-inset-top)'],
  ])('%s: %s is refused', async (property, value) => {
    const out = await resolveWith(stub({ [property]: value }), property);
    const t = targetFor(out.file.targets, property);
    expect(t.outcome, `${property}: ${value}`).toBe('unresolved');
    expect(t.target).toBeNull();
    expect(t.decisionReason).toMatch(/no DS mapping|hardcoded|did not resolve|not a plain/i);
    expect(authorizedProperties(out.file, 'f-card').size).toBe(0);
  });

  it('the reviewer\'s reproduction no longer reaches the page: nothing is resolved, so nothing can be applied', async () => {
    const out = await resolveWith(stub({ padding: '4px; border-top-color: var(--nope, red)' }), 'padding');
    expect(targetFor(out.file.targets, 'padding').target).toBeNull();
    // and the applier would have refused the text anyway
    const applied = await applyEdit(page, { findingId: 'f-card', selector: '[data-fra-element="eLight"]', expectedMatches: 1, kind: 'style', property: 'padding', value: '4px; border-top-color: var(--nope, red)', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'x', confidence: 1 }, null);
    expect(applied.applied).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-fra-element="eLight"]')!).borderTopColor)).toBe('rgb(0, 0, 255)');
  });
});

describe('a plain length or keyword of a length property is still taken, flagged as not DS guidance', () => {
  it.each([
    ['border-radius', '10px'],
    ['border-radius', '8px 4px'],
    ['border-radius', '50%'],
    ['padding', '0'],
    ['padding', '12px 16px'],
    ['padding-top', '1.5rem'],
    ['gap', 'normal'],
    ['gap', '1rem 2rem'],
    ['font-size', 'clamp(1rem, 2vw, 1.5rem)'],
    ['font-size', 'calc(1rem + 2px)'],
    ['font-size', 'calc((100% - 2rem) / 3)'],
    ['line-height', '1.5'],
    ['letter-spacing', '-0.01em'],
    ['letter-spacing', 'normal'],
    ['border-top-width', '1px'],
    ['border-top-style', 'solid'],
    ['outline-offset', '2px'],
    ['padding', 'min(10px, 2rem)'],
  ])('%s: %s', async (property, value) => {
    const out = await resolveWith(stub({ [property]: value }), property);
    const t = targetFor(out.file.targets, property);
    expect(t, `${property}: ${value} - ${t.decisionReason}`).toMatchObject({ outcome: 'resolved-target', target: { value, token: null }, provenance: { kind: 'approved-project-pattern' } });
  });

  it('a literal length is recorded as a proposed local variant (not DS guidance)', async () => {
    const t = targetFor((await resolveWith(stub({ 'border-radius': '10px' }), 'border-radius')).file.targets, 'border-radius');
    expect(t.provenance.reference!.classification).toBe('proposed-local-variant');
  });
});

describe('a DS token still resolves, and an unresolved var() is no longer taken as a literal', () => {
  it('a DS token of a length property is substituted', async () => {
    const out = await resolveWith(stub({ 'border-radius': 'var(--radius-sm)' }), 'border-radius');
    expect(targetFor(out.file.targets, 'border-radius')).toMatchObject({ outcome: 'resolved-target', target: { value: '10px', token: '--radius-sm' } });
  });

  it('a var() the DS does not define is refused with the token named, not kept as the literal text', async () => {
    const out = await resolveWith(stub({ 'border-radius': 'var(--radius-nope)' }), 'border-radius');
    const t = targetFor(out.file.targets, 'border-radius');
    expect(t.outcome).toBe('unresolved');
    expect(t.decisionReason).toMatch(/--radius-nope/);
  });
});
