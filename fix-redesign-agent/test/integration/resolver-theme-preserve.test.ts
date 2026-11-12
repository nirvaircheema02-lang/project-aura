import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { compareDesign } from '../../src/fidelity/compare.ts';
import { evaluatePreserveTargets } from '../../src/fidelity/preserve.ts';
import { resolveTargets } from '../../src/resolution/resolve.ts';
import type { ResolvedTarget } from '../../src/resolution/schema.ts';
import { base, cap, el, resolutionOf, sec } from '../helpers/fidelity-captures.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';
import { decision, entryFor, now, prop, residual, RUN } from '../helpers/resolver-stub.ts';

// Chromium under a loaded machine (other suites run in parallel) is several times slower than alone: the 5 s default flaked, the checks themselves did not
vi.setConfig({ testTimeout: 60_000 });

/**
 * Round 2, defect 8: the surface a judgment was resolved on is where the page is RENDERED, not an alternate theme. A preserve-existing / unresolved outcome
 * carries theme `inherit` (the surface stays in the provenance text); otherwise the fidelity evaluator, which gates every non-`inherit` theme, could never verify
 * a judged preserve - on a dark page, every one of them was permanently `unverified`.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
.dark{background:#111114;color:#fafafa;padding:8px}
.light{background:#fff;color:#333;padding:8px}
.tile{display:block;box-sizing:border-box;width:300px;height:120px;border:1px solid #333;padding:16px;margin:8px}
</style></head><body>
<div class="dark" data-variant="cinematic-dark"><div class="tile" data-fra-element="eDark"><h3>Plan B</h3><p>Descriptive text about the plan.</p><a href="#b">Read more</a></div></div>
<div class="light" data-variant="editorial-light"><div class="tile" data-fra-element="eLight"><h3>Plan A</h3><p>Descriptive text about the plan.</p><a href="#a">Read more</a></div></div>
</body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await (await browser.newContext()).newPage();
  await page.setContent(PAGE);
});
afterAll(async () => { await browser.close(); cleanupDsFixtures(); });

const resolveOn = async (element: string, decisions: ReturnType<typeof decision>[], properties = [prop({ property: 'color' })]) =>
  resolveTargets({ page, dsIndex: miniDsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: null, now }, { run: RUN, findings: [residual('f-card', 'card', properties)], entries: [entryFor(element, 'f-card')], judgment: { decisions, notes: [] } });
const of = (targets: ResolvedTarget[], property: string) => targets.find((t) => t.property === property)!;

describe('a judged preserve / unresolved outcome is not scoped to a theme', () => {
  it.each(['eDark', 'eLight'])('%s: preserve-existing carries theme inherit and records the measured surface in its provenance', async (element) => {
    const out = await resolveOn(element, [decision({ property: 'color', outcome: 'preserve-existing', value: null, source: 'original-baseline', reference: null, unresolvedReason: 'no-ds-requirement', reason: 'the DS states no text colour here' })]);
    const t = of(out.file.targets, 'color');
    expect(t.outcome).toBe('preserve-existing');
    expect(t.theme).toBe('inherit');
    expect(t.provenance.evidence.join(' ')).toMatch(element === 'eDark' ? /dark surface/ : /light surface/);
  });

  it('unresolved carries theme inherit too, and a judged source=original-baseline preserve as well', async () => {
    const out = await resolveOn('eDark', [
      decision({ property: 'color', outcome: 'unresolved', value: null, source: 'proposed-local-variant', reference: null, unresolvedReason: 'state-context', reason: 'a hover colour is not captured' }),
      decision({ property: 'background-color', outcome: 'preserve-existing', value: null, source: 'ds-token', reference: null, unresolvedReason: 'no-ds-requirement', reason: 'keep it' }),
    ], [prop({ property: 'color' }), prop({ property: 'background-color' })]);
    expect(of(out.file.targets, 'color')).toMatchObject({ outcome: 'unresolved', theme: 'inherit' });
    expect(of(out.file.targets, 'background-color')).toMatchObject({ outcome: 'preserve-existing', theme: 'inherit' });
    const baselineSourced = await resolveOn('eDark', [decision({ property: 'color', outcome: 'resolved-target', value: 'x', source: 'original-baseline', reference: null, reason: 'keep' })]);
    expect(of(baselineSourced.file.targets, 'color')).toMatchObject({ outcome: 'preserve-existing', theme: 'inherit' });
  });

  it('a RESOLVED colour target resolved in a surface scope keeps the real theme', async () => {
    const out = await resolveOn('eDark', [decision({ source: 'ds-token', reference: null, value: 'var(--border-soft)', dsToken: '--border-soft' })], [prop({ property: 'border-top-color' })]);
    expect(of(out.file.targets, 'border-top-color')).toMatchObject({ outcome: 'resolved-target', theme: 'dark' });
    const light = await resolveOn('eLight', [decision({ source: 'ds-token', reference: null, value: 'var(--border-soft)', dsToken: '--border-soft' })], [prop({ property: 'border-top-color' })]);
    expect(of(light.file.targets, 'border-top-color')).toMatchObject({ outcome: 'resolved-target', theme: 'light' });
  });
});

describe('the fidelity evaluator can verify a judged preserve resolved on a dark surface', () => {
  const finding = el('0', { tag: 'a', label: 'Read more', textHash: 'rm', roles: ['finding', 'interactive', 'text'], findingIds: ['f-card'], style: { color: 'rgb(250, 250, 250)', 'font-size': '16px' } });
  const sectionOf = (viewport: 'desktop' | 'mobile') => sec({ sectionId: 'A', viewport, elements: [el(''), finding] });
  const sections = [sectionOf('desktop'), sectionOf('mobile')];

  it('identical baseline and output: preserved-verified (before the fix: unverified, "theme not captured by the verifier")', async () => {
    const out = await resolveOn('eDark', [decision({ property: 'color', outcome: 'preserve-existing', value: null, source: 'original-baseline', reference: null, unresolvedReason: 'no-ds-requirement', reason: 'keep it' })]);
    const t = of(out.file.targets, 'color');
    const baseline = base(sections);
    const report = compareDesign({ baseline, observed: cap(sections), exemptions: [] });
    const [result] = evaluatePreserveTargets({ resolution: resolutionOf(t), report, baseline, exemptions: [] });
    expect(result!.verification, result!.detail).toBe('preserved-verified');
  });

  it('the evaluator still refuses to verify a target that really is scoped to a theme (the gate itself is unchanged)', async () => {
    const out = await resolveOn('eDark', [decision({ property: 'color', outcome: 'preserve-existing', value: null, source: 'original-baseline', reference: null, unresolvedReason: 'no-ds-requirement', reason: 'keep it' })]);
    const t = { ...of(out.file.targets, 'color'), theme: 'dark' as const };
    const baseline = base(sections);
    const report = compareDesign({ baseline, observed: cap(sections), exemptions: [] });
    const [result] = evaluatePreserveTargets({ resolution: resolutionOf(t), report, baseline, exemptions: [] });
    expect(result!.verification).toBe('unverified');
    expect(result!.detail).toMatch(/theme/);
  });
});
