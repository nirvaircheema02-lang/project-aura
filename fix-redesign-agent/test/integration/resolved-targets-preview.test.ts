import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { extractSections } from '../../src/preview/extract.ts';
import { expectedScope, type Route } from '../../src/preview/plan.ts';
import { verifyPreview } from '../../src/preview/verify.ts';
import type { ExtractionResult } from '../../src/preview/types.ts';
import { RESOLUTION_SCHEMA_VERSION, type ResolutionFile, type ResolvedTarget } from '../../src/resolution/schema.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Resolved targets are checked where they matter: in the RENDERED preview, in their own state. A card that is black by default and
 * white on hover keeps both; a target that is not met, or cannot be measured, is never reported as fixed.
 */

const ORIGINAL = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<style>
body{margin:0;font-family:Arial,sans-serif}
.cards{padding:40px}
.card{display:block;background:#000;color:#fff;padding:20px;border-radius:4px;text-decoration:none;transition:background-color .1s}
.card:hover{background:#fff;color:#000}
</style></head><body>
<section data-fra-section="cards" class="cards"><h2>Services</h2>
<a class="card" href="#a" data-fra-element="e1" data-fra-findings="fidCard">Alpha card</a></section>
</body></html>`;

const FID = 'fidCard';
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const finding = makeFinding({ findingId: FID, section: 'Cards', label: 'Alpha card', mismatches: [] });
const expected = expectedScope('selected-sections', [finding], [finding]);
const routes = new Map<string, { route: Route; sectionId: string; stamp: string | null }>([[FID, { route: 'css-edit', sectionId: 'cards', stamp: 'e1' }]]);

const edit = (property: string, value: string, selector = '[data-fra-element="e1"]'): TargetedEdit => ({ findingId: FID, selector, expectedMatches: 1, kind: 'style', property, value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 'test', confidence: 1 });

const target = (over: Partial<ResolvedTarget>): ResolvedTarget => ({
  id: 't', findingId: FID, property: 'border-top-left-radius', part: 'self', viewport: { name: 'any', width: null }, theme: 'inherit', state: 'default',
  audit: { status: 'UNRESOLVED', actual: '4px', expected: null, expectedToken: null, note: 'length not comparable', source: 'atoms/Card.tsx' }, reason: 'layout-measurement-required', outcome: 'resolved-target',
  target: { value: '8px', comparison: 'length-px', token: null }, provenance: { kind: 'ds-token', ds: null, reference: null, evidence: [] }, decisionReason: 'resolved from the DS', route: 'css-edit', acceptance: [],
  status: { design: 'resolved', implementation: 'applied', verification: 'not-run', implementationDetail: null, verificationDetail: null }, ...over,
});
const resolutionOf = (...targets: ResolvedTarget[]): ResolutionFile => ({ schemaVersion: RESOLUTION_SCHEMA_VERSION, sourceRun: { runId: 'r', projectName: 'p', dataJsonSha256: null, fixPlanSha256: null }, generatedAt: 't', dsRegistryVersion: null, referenceRegistry: null, targets, noTargetFindings: [], notes: [] });

async function run(edits: TargetedEdit[], resolution: ResolutionFile, stateGuards?: ReadonlySet<string>, over: Partial<Parameters<typeof verifyPreview>[0]> = {}) {
  const ctx = await browser.newContext();
  let extraction: ExtractionResult;
  try {
    extraction = await extractSections(ctx, ORIGINAL, { sectionIds: ['cards'], fullPage: false, names: { cards: 'Cards' }, edits, ...(stateGuards ? { stateGuards } : {}) });
  } finally { await ctx.close(); }
  // the preview page: the section's markup in a shadow root, with the finding id the verifier looks for
  const sectionHtml = await sectionMarkup(extraction);
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>preview</title><link rel="icon" href="data:,"></head><body style="margin:0"><main id="m"></main><script>
const host = document.createElement('div'); host.setAttribute('data-pv-section', 'cards'); document.getElementById('m').appendChild(host);
const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<style>' + ${JSON.stringify(extraction.scopedCss)} + '</style><div data-pv-mount>' + ${JSON.stringify(sectionHtml)} + '</div>';
</script></body></html>`;
  const server = await startLocalServer({ '/': { body: page } });
  try {
    return await verifyPreview({
      browser, url: `${server.origin}/`, mode: 'selected-sections', expected, extraction, fixFindings: [finding], routes, decisions: null, islands: [], skippedIslands: [],
      originalBehavior: null, sectionNames: { cards: 'Cards' }, simulated: [], generation: { assetsFailed: [], remoteLeft: [] }, resolution, ...over,
    });
  } finally { await server.close(); }
}

/** Serialises the extracted tree to markup (the generated app does this through JSX). */
async function sectionMarkup(extraction: ExtractionResult): Promise<string> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const out = await page.evaluate((tree) => {
      const render = (n: any): string => (n.t === 'text' ? n.v.replace(/&/g, '&amp;').replace(/</g, '&lt;') : `<${n.tag}${Object.entries(n.attrs ?? {}).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('')}${n.findingIds?.length ? ` data-finding-ids="${n.findingIds.join(' ')}"` : ''}>${(n.children ?? []).map(render).join('')}</${n.tag}>`);
      return render(tree);
    }, extraction.sections[0]!.tree as unknown);
    return out;
  } finally { await ctx.close(); }
}

const targetResult = (v: Awaited<ReturnType<typeof run>>, id: string) => v.targetResults?.find((r) => r.targetId === id);
const check = (v: Awaited<ReturnType<typeof run>>, id: string) => v.checks.find((c) => c.id === id);

describe('resolved targets in the rendered preview', () => {
  it('a radius fix that is measured at rest, with the black-default / white-hover design kept, verifies BOTH targets in their own state', async () => {
    const resolution = resolutionOf(
      target({ id: 'radius' }),
      target({ id: 'hover-bg', property: 'background-color', state: 'hover', audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, target: { value: 'rgb(255, 255, 255)', comparison: 'color-deltaE', token: null } }),
    );
    const v = await run([edit('border-radius', '8px')], resolution);
    expect(targetResult(v, 'radius')).toMatchObject({ verification: 'verified-resolved-target' });
    expect(targetResult(v, 'hover-bg')).toMatchObject({ verification: 'verified-resolved-target' }); // measured with a real hover, not assumed
    expect(v.findings.find((f) => f.findingId === FID)).toMatchObject({ status: 'fixed-verified', targets: { resolved: 2, verified: 2, failed: 0 } });
  }, 120_000);

  it('a target that is NOT met in the rendered preview is failed, the finding is not called fixed, and the measurement check fails', async () => {
    const v = await run([], resolutionOf(target({ id: 'radius' }))); // nothing was applied: the card still has the original 4px
    expect(targetResult(v, 'radius')).toMatchObject({ verification: 'failed' });
    expect(targetResult(v, 'radius')!.detail).toMatch(/4px.*8px/);
    expect(v.findings.find((f) => f.findingId === FID)!.status).not.toBe('fixed-verified');
    expect(check(v, 'ds-fix.measured')!.status).toBe('fail');
    expect(v.verdict).toBe('fail');
  }, 120_000);

  it('an unguarded default-state edit erases the hover and the HOVER target fails; the state-guarded form restores it and it verifies', async () => {
    const hover = target({ id: 'hover-bg', property: 'background-color', state: 'hover', audit: { status: 'NOT-LISTED', actual: null, expected: null, expectedToken: null, note: null, source: null }, target: { value: 'rgb(255, 255, 255)', comparison: 'color-deltaE', token: null } });
    const unguarded = await run([edit('background-color', '#111111')], resolutionOf(hover));
    expect(targetResult(unguarded, 'hover-bg')).toMatchObject({ verification: 'failed' });
    const guarded = await run([edit('background-color', '#111111')], resolutionOf(hover), new Set([`${FID}|background-color`]));
    expect(targetResult(guarded, 'hover-bg')).toMatchObject({ verification: 'verified-resolved-target' });
  }, 180_000);

  it('a state the preview cannot exercise (active) is UNVERIFIED with the reason — never matched, never fixed', async () => {
    const active = target({ id: 'active-bg', property: 'background-color', state: 'active', target: { value: 'rgb(10, 10, 10)', comparison: 'color-deltaE', token: null } });
    const v = await run([edit('border-radius', '8px')], resolutionOf(target({ id: 'radius' }), active));
    expect(targetResult(v, 'radius')).toMatchObject({ verification: 'verified-resolved-target' });
    expect(targetResult(v, 'active-bg')).toMatchObject({ verification: 'unverified' });
    expect(targetResult(v, 'active-bg')!.detail).toMatch(/cannot be exercised/);
    const o = v.findings.find((f) => f.findingId === FID)!;
    expect(o.status).toBe('partially-verified');
    expect(o.targets).toMatchObject({ resolved: 2, verified: 1, unmeasurable: 1 });
    expect(v.summary.findingsVerified).toBe(0); // partially verified is not verified
  }, 120_000);

  it('an unmeasurable target whose implementation is already BLOCKED is explained by the resolver — and still not fixed', async () => {
    const hoverOfLabel = target({ id: 'label-color', part: 'label', property: 'color', state: 'active', status: { design: 'resolved', implementation: 'blocked', verification: 'not-run', implementationDetail: 'no reliable live-DOM selector', verificationDetail: null }, target: { value: 'rgb(1, 1, 1)', comparison: 'color-deltaE', token: null } });
    const v = await run([edit('border-radius', '8px')], resolutionOf(target({ id: 'radius' }), hoverOfLabel));
    const o = v.findings.find((f) => f.findingId === FID)!;
    expect(o.status).toBe('partially-verified');
    expect(o.reported).toBe('resolver');
  }, 120_000);
});

describe('preserve decisions in the verification of the rendered preview', () => {
  const keep = (id = 'keep-w') => target({ id, property: 'width', outcome: 'preserve-existing', target: null, reason: 'no-ds-requirement', route: 'none', status: { design: 'preserved', implementation: 'not-applicable', verification: 'not-run', implementationDetail: null, verificationDetail: null } });
  const result = (verification: 'preserved-verified' | 'failed' | 'unverified', detail = 'x', reason = verification === 'unverified' ? 'not measured by the verifier' : verification) => ({ targetId: 'keep-w', findingId: FID, property: 'width', state: 'default' as const, verification, detail, reason, evidence: [] });
  const resolution = () => resolutionOf(target({ id: 'radius' }), keep());

  it('a FAILED preserve decision: the finding is partially verified, ds-fix.preserved-unchanged fails the verdict, and the result is in targetResults', async () => {
    const v = await run([edit('border-radius', '8px')], resolution(), undefined, { preserveResults: [result('failed', 'the used width changed from 220px to 280px')] });
    const o = v.findings.find((f) => f.findingId === FID)!;
    expect(targetResult(v, 'radius')).toMatchObject({ verification: 'verified-resolved-target' }); // the fix itself was measured
    expect(o.status).toBe('partially-verified');
    expect(o.targets).toMatchObject({ preserved: 1, preservedFailed: 1, preservedVerified: 0, preservedUnverified: 0 });
    expect(o.detail).toMatch(/1 preserved property changed \(width\)/);
    expect(check(v, 'ds-fix.preserved-unchanged')!.status).toBe('fail');
    expect(v.verdict).toBe('fail');
    expect(v.summary.findingsVerified).toBe(0);
    expect(targetResult(v, 'keep-w')).toMatchObject({ verification: 'failed' });
    expect(v.preserve).toMatchObject({ total: 1, failed: 1 });
  }, 120_000);

  it('an UNVERIFIED preserve decision keeps the measured fix but is surfaced: not-checked check, tally and detail', async () => {
    const v = await run([edit('border-radius', '8px')], resolution(), undefined, { preserveResults: [result('unverified')] });
    const o = v.findings.find((f) => f.findingId === FID)!;
    expect(o.status).toBe('fixed-verified');
    expect(o.targets).toMatchObject({ preservedUnverified: 1 });
    expect(o.detail).toMatch(/1 preserve decision\(s\) not verified \(not measured by the verifier\)/);
    expect(check(v, 'ds-fix.preserved-unchanged')!.status).toBe('not-checked');
    // an unverified preserve decision is required evidence missing: INCOMPLETE, never PASS (this assertion used to say 'pass')
    expect(v.verdict).toBe('incomplete');
    expect(v.status).toMatchObject({ verdict: 'incomplete', failedRequired: 0 });
    expect(v.status!.gaps.map((g) => g.family)).toContain('check:ds-fix.preserved-unchanged');
    expect(v.summary.findingsVerified).toBe(1);
  }, 120_000);

  it('every preserve decision verified: the check passes and the tally says so', async () => {
    const v = await run([edit('border-radius', '8px')], resolution(), undefined, { preserveResults: [result('preserved-verified')] });
    expect(check(v, 'ds-fix.preserved-unchanged')!.status).toBe('pass');
    expect(v.findings.find((f) => f.findingId === FID)!.targets).toMatchObject({ preservedVerified: 1 });
  }, 120_000);

  it('a finding "kept by decision" whose element is not rendered is NOT represented — absence is not preservation', async () => {
    const ghost = makeFinding({ findingId: 'ghost', section: 'Cards', label: 'Gone', mismatches: [] });
    const v = await run([edit('border-radius', '8px')], resolutionOf(target({ id: 'radius' })), undefined, {
      fixFindings: [finding, ghost], decisions: { schemaVersion: 1, findings: { ghost: { resolution: 'preserve-existing', note: 'keep it' } } },
    });
    expect(v.findings.find((f) => f.findingId === 'ghost')!.status).toBe('not-represented');
  }, 120_000);
});
