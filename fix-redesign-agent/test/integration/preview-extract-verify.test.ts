import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { extractSections, openOfflineSnapshot } from '../../src/preview/extract.ts';
import { expectedScope, type Route } from '../../src/preview/plan.ts';
import { typefaceRuleChecks } from '../../src/style/typeface-rule.ts';
import { hrefKeyFor, verifyPreview } from '../../src/preview/verify.ts';
import type { ExtractionResult, PreviewNode } from '../../src/preview/types.ts';
import { makeFinding } from '../helpers/fixture-audit-run.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * The React Preview generator and verifier against a real browser, fully offline:
 *  - extraction from a stamped snapshot honours the run's scope (Selected Sections vs Full Page),
 *    keeps only the CSS that applies, replays the applied edits, and reports content that belongs to no section;
 *  - verification of a running preview is MEASUREMENT, not presence: a wrong scope, altered text,
 *    a style that does not match the audit, or a missing element each fail or are reported honestly.
 */

const ORIGINAL = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<style>
body{margin:0;font-family:Arial,sans-serif}
.hdr{background:#fff;padding:8px}
.hero{background:#111;color:#fff;padding:40px}
.hero h1{font-size:40px;margin:0 0 12px}
.cta{display:inline-flex;padding:8px 16px;color:#fff;background:#222222;text-decoration:none}
.cta:hover{background:#333}
.pricing{padding:30px;background:#eee}
.pricing .pricing-only{color:red}
.plain{padding:12px}
.faq{padding:30px}
@media (min-width:600px){.faq{padding:50px}}
@keyframes spin{to{transform:rotate(1turn)}}
.spinner{animation:spin 2s linear infinite;width:10px;height:10px;background:#000}
.unused-rule{color:green}
</style></head><body>
<header data-fra-section="header" data-fra-scope="excluded" class="hdr">Site header navigation</header>
<main>
<section data-fra-section="hero" class="hero"><h1>Big headline here</h1><p>Some subtitle text</p><a class="cta" href="/go" data-fra-element="e1" data-fra-findings="fid1">Talk to us</a></section>
<section data-fra-section="pricing" data-fra-scope="unselected" class="pricing"><h2>Pricing plans</h2><p class="pricing-only">Pricing detail text</p></section>
<div class="plain">Loose block that belongs to no section</div>
<section data-fra-section="faq" class="faq"><h2>Questions</h2><p>Answer text here</p><div class="spinner"></div></section>
</main>
<footer data-fra-section="footer" data-fra-scope="excluded">Footer links</footer>
</body></html>`;

const NAMES = { hero: 'Hero', pricing: 'Pricing plans', faq: 'FAQ' };
let browser: Browser;
let server: Awaited<ReturnType<typeof startLocalServer>> | null = null;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await server?.close(); await browser?.close(); });

const find = (n: PreviewNode, pred: (e: PreviewNode & { t: 'el' }) => boolean): (PreviewNode & { t: 'el' }) | null => {
  if (n.t !== 'el') return null;
  if (pred(n)) return n;
  for (const c of n.children) { const r = find(c, pred); if (r) return r; }
  return null;
};

async function extract(over: Partial<Parameters<typeof extractSections>[2]> = {}): Promise<ExtractionResult> {
  const ctx = await browser.newContext();
  try { return await extractSections(ctx, ORIGINAL, { sectionIds: ['hero', 'faq'], fullPage: false, names: NAMES, edits: [], ...over }); } finally { await ctx.close(); }
}

describe('extractSections — scope, CSS and content', () => {
  it('Selected Sections: only the selected sections, in page order, never the header, footer or an unselected section', async () => {
    const r = await extract();
    expect(r.sections.map((s) => s.id)).toEqual(['hero', 'faq']);
    expect(r.sections.map((s) => s.name)).toEqual(['Hero', 'FAQ']);
    const all = r.sections.map((s) => s.text).join(' ');
    expect(all).toContain('Big headline here');
    expect(all).not.toMatch(/Pricing|Site header|Footer links/);
    expect(r.sections[0]!.links).toEqual(['/go']);
    expect(r.sections[0]!.headings).toEqual(['Big headline here']);
    expect(r.sections[0]!.height).toBeGreaterThan(80);
  });

  it('keeps only the CSS rules that apply to the extracted sections (state rules, media rules and used keyframes included)', async () => {
    const r = await extract();
    const css = r.scopedCss + r.globalCss;
    expect(css).toContain('.hero h1');
    expect(css).toContain('.cta:hover');
    expect(css).toMatch(/@media \(min-width: ?600px\)/);
    expect(css).toContain('@keyframes spin');
    expect(css).not.toContain('pricing-only');
    expect(css).not.toContain('unused-rule');
  });

  it('records the stamped finding element with its layout so a DS component can take its place', async () => {
    const r = await extract();
    const fe = r.sections[0]!.findingElements[0]!;
    expect(fe).toMatchObject({ stamp: 'e1', findingIds: ['fid1'], tag: 'a' });
    expect(fe.layout.display).toBe('inline-flex');
    expect(fe.layout.fullWidth).toBe(false);
  });

  it('replays the applied edits so the preview carries the validated fixes', async () => {
    const edit: TargetedEdit = { findingId: 'fid1', selector: '[data-fra-element="e1"]', expectedMatches: 1, kind: 'style', property: 'padding-left', value: '28px', removeValue: null, dsComponent: null, dsVariant: null, dsToken: null, rationale: 't', confidence: 1 };
    const r = await extract({ edits: [edit] });
    // edits land as an injected stylesheet rule on the stand-in page; the extracted CSS carries it
    expect(r.scopedCss).toMatch(/\[data-fra-element="e1"\][^{]*\{[^}]*padding-left: ?28px/);
    expect(find(r.sections[0]!.tree, (e) => e.elementStamp === 'e1')).not.toBeNull();
  });

  it('collects every remote asset the sections reference: src, srcset, poster, CSS rules AND inline style background images', async () => {
    const html = ORIGINAL.replace('<h1>Big headline here</h1>', '<h1 style="background-image:linear-gradient(#000,#111),url(https://cdn.example/inline-bg.webp)">Big headline here</h1><img src="https://cdn.example/a.png" srcset="https://cdn.example/a2.png 2x"><video poster="https://cdn.example/p.jpg" src="https://cdn.example/v.mp4"></video>').replace('.hero h1{', '.hero h1{background-image:url(https://cdn.example/rule-bg.png);');
    const ctx = await browser.newContext();
    try {
      const r = await extractSections(ctx, html, { sectionIds: ['hero'], fullPage: false, names: {}, edits: [] });
      expect([...r.remoteAssets].sort()).toEqual(['https://cdn.example/a.png', 'https://cdn.example/a2.png', 'https://cdn.example/inline-bg.webp', 'https://cdn.example/p.jpg', 'https://cdn.example/rule-bg.png', 'https://cdn.example/v.mp4']);
    } finally { await ctx.close(); }
  });

  it('reports content that sits beside a selected section but belongs to no section, instead of dropping it silently', async () => {
    const r = await extract();
    expect(r.orphanContent).toHaveLength(1);
    expect(r.orphanContent[0]).toMatchObject({ tag: 'div', between: 'before faq' });
    expect(r.orphanContent[0]!.text).toContain('Loose block');
  });

  it('Full Page: every page-specific section including the unselected one and an anonymous gap region; global header/footer excluded', async () => {
    const r = await extract({ sectionIds: null, fullPage: true });
    expect(r.sections.map((s) => s.id)).toEqual(['hero', 'pricing', 'region-3', 'faq']);
    expect(r.sections.find((s) => s.id === 'region-3')!.unlabelled).toBe(true);
    expect(r.sections.map((s) => s.text).join(' ')).not.toMatch(/Site header|Footer links/);
    expect(r.orphanContent).toHaveLength(0);
  });

  it('is generated offline from the snapshot alone (no request leaves the stand-in page)', async () => {
    const ctx = await browser.newContext();
    try {
      const { page, close } = await openOfflineSnapshot(ctx, ORIGINAL.replace('</body>', '<img src="https://example.invalid/x.png"></body>'));
      const failed: string[] = [];
      page.on('requestfailed', (q) => failed.push(q.url()));
      await page.waitForTimeout(300);
      expect(failed.some((u) => u.includes('example.invalid'))).toBe(true);
      await close();
    } finally { await ctx.close(); }
  });
});

describe('visible text — what a visitor can read', () => {
  const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px Arial}
.menu-none{display:none}.menu-clip{height:0;overflow:hidden}.menu-faded{opacity:0}.menu-vis{display:block}
</style></head><body><section data-fra-section="calc" class="c">
<h2>Calculator</h2><p>Pick a region below</p>
<div class="menu-none"><p>Hidden by display none</p></div>
<div class="menu-clip"><p>Clipped to zero height</p></div>
<div class="menu-faded"><p>Fully transparent</p></div>
<div class="menu-vis"><p>Shown option text</p></div>
<input type="text" value="India"><input type="range" value="40"><input type="hidden" value="secret"><div class="menu-none"><input type="text" value="Hidden value"></div>
</section></body></html>`;
  it('excludes closed menus however they are hidden (display, zero-height clip, opacity) and includes the values of visible text fields', async () => {
    const ctx = await browser.newContext();
    try {
      const r = await extractSections(ctx, HTML, { sectionIds: ['calc'], fullPage: false, names: {}, edits: [] });
      const sec = r.sections[0]!;
      expect(sec.text).toContain('Hidden by display none');
      expect(sec.text).toContain('Clipped to zero height');
      // a text field's value is something the visitor reads; a slider, a hidden field and a field in a closed menu are not
      expect(sec.visibleText).toBe('Calculator Pick a region below Shown option text India');
    } finally { await ctx.close(); }
  });
});

describe('typefaceRuleChecks', () => {
  it('extracts the offending family from an R1.4 violation and ignores other rules', () => {
    const f = makeFinding({ findingId: 'x' });
    f.comparison.ruleViolations = [
      { ruleId: 'R1.4', title: 'Two-Font Pairing (Serif + Sans)', why: 'set in "manrope" (Manrope, "Manrope Fallback") — not a Design System typeface' },
      { ruleId: 'R3.6', title: 'Border Radius Decision Table', why: 'border-radius 6px is not on the scale' },
    ];
    expect(typefaceRuleChecks(f)).toEqual([{ ruleId: 'R1.4', offending: 'manrope' }]);
  });
});

/** The running preview, simulated: each section in an open shadow root exactly like the generated app's OriginalSection host. */
function previewPage(extraction: ExtractionResult, htmlBySection: Record<string, string>, opts: { omit?: string[]; add?: Array<{ id: string; html: string }>; mutate?: (id: string, html: string) => string; lightDom?: Record<string, string> } = {}): string {
  const hosts = [...extraction.sections.filter((s) => !opts.omit?.includes(s.id)).map((s) => ({ id: s.id, html: opts.mutate ? opts.mutate(s.id, htmlBySection[s.id]!) : htmlBySection[s.id]! })), ...(opts.add ?? [])];
  const data = JSON.stringify(hosts);
  return `<!doctype html><html><head><meta charset="utf-8"><title>preview</title><link rel="icon" href="data:,"></head><body style="margin:0">
<main id="m"></main>
<script>
const css = ${JSON.stringify(extraction.scopedCss)}; const LIGHT = ${JSON.stringify(opts.lightDom ?? {})};
for (const h of ${data}) {
  const host = document.createElement('div'); host.setAttribute('data-pv-section', h.id); document.getElementById('m').appendChild(host); if (LIGHT[h.id]) host.innerHTML = LIGHT[h.id];
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + css + '</style><div data-pv-mount>' + h.html + '</div>';
}
</script></body></html>`;
}

describe('verifyPreview — measurement, not presence', () => {
  let extraction: ExtractionResult;
  let html: Record<string, string>;
  const hero = makeFinding({ findingId: 'fid1', section: 'Hero', label: 'Talk to us', mismatches: [
    { property: 'padding-left', actual: '16px', expected: '28px', expectedToken: null, comparison: 'length-px', delta: null },
    { property: 'background-color', actual: 'rgb(34, 34, 34)', expected: '#b01f24', expectedToken: null, comparison: 'color-deltaE', delta: null },
  ] });
  const faq = makeFinding({ findingId: 'fid2', section: 'FAQ', label: 'Questions', mismatches: [] });
  const pricing = makeFinding({ findingId: 'fid3', section: 'Pricing', label: 'Pricing' });
  const header = makeFinding({ findingId: 'fid4', section: 'Header', label: 'Nav' });
  const all = [hero, pricing, faq, header];
  const fix = [hero, faq];
  const expected = expectedScope('selected-sections', all, fix);
  const routes = new Map<string, { route: Route; sectionId: string; stamp: string | null }>([['fid1', { route: 'css-edit', sectionId: 'hero', stamp: 'e1' }], ['fid2', { route: 'original', sectionId: 'faq', stamp: null }]]);

  beforeAll(async () => {
    extraction = await extract();
    const ctx = await browser.newContext();
    try {
      const { page, close } = await openOfflineSnapshot(ctx, ORIGINAL);
      html = Object.fromEntries(await page.evaluate(() => Array.from(document.querySelectorAll('[data-fra-section]')).map((e) => [e.getAttribute('data-fra-section'), e.outerHTML])));
      // the preview carries the audit's expected values on the finding element and the finding id the verifier looks for
      html['hero'] = html['hero']!.replace('data-fra-findings="fid1"', 'data-fra-findings="fid1" data-finding-ids="fid1" style="padding-left:28px;background-color:#b01f24"');
      await close();
    } finally { await ctx.close(); }
  });

  async function verify(page: string, over: Partial<Parameters<typeof verifyPreview>[0]> = {}) {
    server = await startLocalServer({ '/': { body: page } });
    try {
      return await verifyPreview({
        browser, url: `${server.origin}/`, mode: 'selected-sections', expected, extraction, fixFindings: fix, routes, decisions: null, islands: [], skippedIslands: [],
        originalBehavior: null, sectionNames: NAMES, simulated: [], generation: { assetsFailed: [], remoteLeft: [] }, ...over,
      });
    } finally { await server.close(); server = null; }
  }
  const check = (v: Awaited<ReturnType<typeof verify>>, id: string) => v.checks.find((c) => c.id === id)!;

  it('passes when the right sections render complete and the audit values are measured on the rendered finding', async () => {
    const v = await verify(previewPage(extraction, html));
    expect(v.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(v.renderedSectionIds).toEqual(['hero', 'faq']);
    expect(v.findings.find((f) => f.findingId === 'fid1')).toMatchObject({ status: 'fixed-verified', route: 'css-edit' });
    // no behaviour was captured for this run: interaction parity is NOT claimed
    expect(check(v, 'interaction.parity').status).toBe('not-checked');
    // a finding with nothing to measure and no recorded decision is reported, never counted as fixed
    expect(v.findings.find((f) => f.findingId === 'fid2')!.status).not.toBe('fixed-verified');
    // a gate that could not run is missing required evidence: no check failed, so INCOMPLETE - never PASS (this assertion used to say 'pass')
    expect(v.verdict).toBe('incomplete');
    expect(v.status).toMatchObject({ verdict: 'incomplete', failedRequired: 0, unverifiedRequired: 1 });
    expect(v.status!.gaps).toEqual([expect.objectContaining({ kind: 'unverified', family: 'check:interaction.parity' })]);
  }, 90_000);

  it('FAILS the scope when an unselected section is rendered', async () => {
    const v = await verify(previewPage(extraction, html, { add: [{ id: 'pricing', html: html['pricing']! }] }));
    expect(check(v, 'scope.forbidden').status).toBe('fail');
    expect(check(v, 'scope.sections').status).toBe('fail');
    expect(check(v, 'scope.no-leaked-text').status).toBe('fail');
    expect(v.verdict).toBe('fail');
  }, 90_000);

  it('FAILS the scope when a selected section is missing, and when the global header or footer is rendered', async () => {
    const missing = await verify(previewPage(extraction, html, { omit: ['faq'] }));
    expect(check(missing, 'scope.sections').status).toBe('fail');
    expect(check(missing, 'scope.sections').detail).toMatch(/MISSING faq/);
    const withHeader = await verify(previewPage(extraction, html, { add: [{ id: 'extra', html: '<header>Site header navigation</header>' }] }));
    expect(check(withHeader, 'scope.no-global-chrome').status).toBe('fail');
  }, 90_000);

  it('FAILS content preservation when original text, a link or a heading is lost', async () => {
    const text = await verify(previewPage(extraction, html, { mutate: (id, h) => (id === 'faq' ? h.replace('Answer text here', 'Different words') : h) }));
    expect(check(text, 'content.faq.text').status).toBe('fail');
    const link = await verify(previewPage(extraction, html, { mutate: (id, h) => (id === 'hero' ? h.replace('href="/go"', 'href="/elsewhere"') : h) }));
    expect(check(link, 'content.hero.links').status).toBe('fail');
    const heading = await verify(previewPage(extraction, html, { mutate: (id, h) => (id === 'hero' ? h.replace(/<h1>(.*?)<\/h1>/, '<div>$1</div>') : h) }));
    expect(check(heading, 'content.hero.headings').status).toBe('fail');
  }, 120_000);

  it('does not call a finding fixed when the rendered values do not match the audit (the element merely existing is not proof)', async () => {
    const wrong = { ...html, hero: html['hero']!.replace('padding-left:28px;background-color:#b01f24', 'padding-left:16px;background-color:#222222') };
    const v = await verify(previewPage(extraction, wrong));
    const o = v.findings.find((f) => f.findingId === 'fid1')!;
    expect(o.status).toBe('unresolved');
    expect(o.detail).toMatch(/not matching/);
    expect(check(v, 'ds-fix.measured').status).toBe('fail');
    expect(v.summary.findingsVerified).toBe(0);
  }, 90_000);

  it('reports a Fix finding that has no element in the preview as not represented, with the reason', async () => {
    const without = { ...html, hero: html['hero']!.replace(' data-finding-ids="fid1"', '') };
    const v = await verify(previewPage(extraction, without));
    expect(v.findings.find((f) => f.findingId === 'fid1')!.status).toBe('not-represented');
  }, 90_000);

  it('refuses a design-system Button primary (the black CTA) anywhere in the preview', async () => {
    // a mounted DS island is a slotted light-DOM child of the section host, carrying the component's own data-variant
    const v = await verify(previewPage(extraction, html, { lightDom: { hero: '<div data-pv-island="Button"><a data-variant="primary">Talk to us</a></div>' } }));
    expect(check(v, 'ds-fix.no-black-primary-cta').status).toBe('fail');
    expect(check(await verify(previewPage(extraction, html, { lightDom: { hero: '<div data-pv-island="Button"><a data-variant="brand">Talk to us</a></div>' } })), 'ds-fix.no-black-primary-cta').status).toBe('pass');
  }, 90_000);

  it('a recorded decision or a planner-recorded conflict explains a gap: it is reported, listed, and does not fail the measurement check — an undecided gap still does', async () => {
    const wrong = { ...html, hero: html['hero']!.replace('padding-left:28px;background-color:#b01f24', 'padding-left:16px;background-color:#222222') };
    const page = previewPage(extraction, wrong);
    const undecided = await verify(page);
    expect(check(undecided, 'ds-fix.measured').status).toBe('fail');
    const byPlanner = await verify(page, { plannerGaps: new Map([['fid1', 'the audit expects Button primary, which the project rules prohibit']]) });
    expect(byPlanner.findings.find((f) => f.findingId === 'fid1')).toMatchObject({ status: 'unresolved', reported: 'planner' });
    expect(byPlanner.findings.find((f) => f.findingId === 'fid1')!.detail).toMatch(/prohibit/);
    expect(check(byPlanner, 'ds-fix.measured').status).toBe('pass');
    const byDecision = await verify(page, { decisions: { schemaVersion: 1, findings: { fid1: { resolution: 'propose-variant', note: 'dark-surface treatment' } } } });
    expect(byDecision.findings.find((f) => f.findingId === 'fid1')).toMatchObject({ status: 'unresolved', reported: 'decision' });
    // preserve-existing is never reported as a fix, even though something measurable is present
    const preserved = await verify(page, { decisions: { schemaVersion: 1, findings: { fid1: { resolution: 'preserve-existing', note: 'keep the original' } } } });
    expect(preserved.findings.find((f) => f.findingId === 'fid1')).toMatchObject({ status: 'preserved-by-decision', reported: 'decision' });
    expect(preserved.summary.findingsVerified).toBe(0);
    // an explicit "unresolved" decision is the answer, not something to measure around
    const unresolved = await verify(page, { decisions: { schemaVersion: 1, findings: { fid1: { resolution: 'unresolved', note: 'needs a Select composition' } } } });
    expect(unresolved.findings.find((f) => f.findingId === 'fid1')!.detail).toMatch(/recorded decision: needs a Select composition/);
  }, 120_000);

  it('measures an R1.4 typeface violation on the rendered text, not on the markup', async () => {
    const f = makeFinding({ findingId: 'fid1', section: 'Hero', label: 'Talk to us', mismatches: [] });
    f.comparison.ruleViolations = [{ ruleId: 'R1.4', title: 'Two-Font Pairing (Serif + Sans)', why: 'set in "manrope" (Manrope) — not a Design System typeface' }];
    const dm = { ...html, hero: html['hero']!.replace('style="padding-left:28px;background-color:#b01f24"', 'style="font-family:\'DM Sans\',sans-serif"') };
    const still = { ...html, hero: html['hero']!.replace('style="padding-left:28px;background-color:#b01f24"', 'style="font-family:Manrope,sans-serif"') };
    const ok = await verify(previewPage(extraction, dm), { fixFindings: [f, faq] });
    expect(ok.findings.find((x) => x.findingId === 'fid1')).toMatchObject({ status: 'fixed-verified' });
    const bad = await verify(previewPage(extraction, still), { fixFindings: [f, faq] });
    expect(bad.findings.find((x) => x.findingId === 'fid1')!.status).toBe('unresolved');
  }, 120_000);
});

describe('hrefKeyFor — one destination is one link, however it is written', () => {
  const key = hrefKeyFor('https://www.kenresearch.com/survey/page');
  it('a relative and an absolute link to the same page are equal; trailing slashes and www do not matter', () => {
    expect(key('/custom-form')).toBe(key('https://www.kenresearch.com/custom-form'));
    expect(key('/custom-form/')).toBe(key('https://kenresearch.com/custom-form'));
    expect(key('book')).toBe(key('https://www.kenresearch.com/survey/book'));
  });
  it('different destinations stay different; query and hash count', () => {
    expect(key('/a')).not.toBe(key('/b'));
    expect(key('/a?x=1')).not.toBe(key('/a'));
    expect(key('/a#top')).not.toBe(key('/a'));
    expect(key('https://other.example/a')).not.toBe(key('/a'));
  });
  it('mailto:/tel: links are compared as written', () => {
    expect(key('mailto:a@b.com')).toBe('mailto:a@b.com');
  });
});

describe('probes never leave the page', () => {
  it('a card that wraps or contains a link is not clicked, so probing a page can never navigate it away', async () => {
    const { probeSections } = await import('../../src/preview/behavior.ts');
    const srv = await startLocalServer({
      '/': { body: '<!doctype html><title>t</title><section id="s"><div class="card" style="padding:20px;cursor:pointer;border:1px solid #000"><span>Read the case study</span> <a href="/elsewhere">Open</a></div><div class="plain" style="padding:20px;cursor:pointer" onclick="this.textContent=\'clicked\'">Plain card</div></section>' },
      '/elsewhere': { body: '<!doctype html><title>elsewhere</title><p>navigated away</p>' },
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`${srv.origin}/`);
      const { sections } = await probeSections(page, [{ id: 's', getRoot: async (p) => (await p.$('#s')) }], { reload: async () => { await page.goto(`${srv.origin}/`); } });
      expect(page.url()).toBe(`${srv.origin}/`);
      expect(srv.hits).not.toContain('/elsewhere');
      const probes = sections[0]!.items.flatMap((i) => i.probes);
      expect(probes.some((p) => p.probe === 'skipped' && /never clicked/.test(p.reason))).toBe(true);
      // a control with no link is still probed
      expect(sections[0]!.items.some((i) => i.probes.some((p) => p.probe === 'click'))).toBe(true);
    } finally { await ctx.close(); await srv.close(); }
  }, 60_000);

  it('verification of a preview refuses requests to other hosts (and reports the attempt)', async () => {
    const other = await startLocalServer({ '/pixel': { body: 'x' } });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>p</title><link rel="icon" href="data:,"></head><body><img src="${other.origin}/pixel" alt=""><div data-pv-section="hero"></div></body></html>`;
    const srv = await startLocalServer({ '/': { body: html } });
    try {
      const v = await verifyPreview({ browser, url: `${srv.origin}/`, mode: 'selected-sections', expected: { mode: 'selected-sections', expectedSectionIds: ['hero'], forbiddenSectionIds: [], fixFindingsBySection: {}, globalSectionIds: [] }, extraction: { sections: [], scopedCss: '', globalCss: '', htmlAttrs: {}, bodyAttrs: {}, orphanContent: [], outOfScopeText: [], remoteAssets: [], interactive: [], stats: { rules: 0, keptRules: 0, elements: 0 } }, fixFindings: [], routes: new Map(), decisions: null, islands: [], skippedIslands: [], originalBehavior: null, sectionNames: {}, simulated: [], generation: { assetsFailed: [], remoteLeft: [] } });
      expect(v.checks.find((c) => c.id === 'runtime.no-external-requests')!.status).toBe('fail');
      expect(other.hits).toEqual([]);
    } finally { await srv.close(); await other.close(); }
  }, 60_000);
});

/**
 * The defects reported on the survey preview, reproduced in fixtures and measured by the verifier:
 *  - a DS heading island that lost the original's white and is now near-black on a near-black hero (contrast ≈ 1:1);
 *  - selects whose menu is transparent, never opens, or cannot be driven from the keyboard.
 */
describe('contrast and popup controls — measured, not assumed', () => {
  const finding = makeFinding({ findingId: 'fidH', section: 'Hero', label: 'Big headline', mismatches: [] });
  const sectionStub = (): ExtractionResult['sections'][number] => ({ id: 'hero', name: 'Hero', order: 0, unlabelled: false, tree: { t: 'el', tag: 'section', attrs: {}, children: [] }, ancestors: [], text: 'Big headline Trusted by leading brands', visibleText: 'Big headline Trusted by leading brands', height: 300, locator: { cssPath: 'section', textStart: '', textLength: 0 }, links: [], images: 0, headings: ['Big headline'], findingElements: [] });
  const extractionOf = (): ExtractionResult => ({ sections: [sectionStub()], scopedCss: '', globalCss: '', htmlAttrs: {}, bodyAttrs: {}, orphanContent: [], outOfScopeText: [], remoteAssets: [], interactive: [], stats: { rules: 0, keptRules: 0, elements: 0 } });
  const heroPage = (h1Colour: string) => `<!doctype html><html><head><meta charset="utf-8"><title>p</title><link rel="icon" href="data:,"></head><body style="margin:0">
<div data-pv-section="hero" id="host"><div slot="island1" data-pv-island="SectionHeading" data-finding-ids="fidH"><h1 style="margin:0;font:300 48px/1.1 Arial;color:${h1Colour}">Big headline</h1></div></div>
<script>const r = document.getElementById('host').attachShadow({ mode: 'open' }); r.innerHTML = '<style>.hero{background:linear-gradient(#050505,#111111);padding:40px;color:#fff;font:16px Arial} .muted{color:rgba(255,255,255,.4);font-size:12px;margin:12px 0 0}</style><div data-pv-mount><section class="hero"><slot name="island1"></slot><p class="muted">Trusted by leading brands</p></section></div>';</script></body></html>`;
  const originalHtml = `<!doctype html><html><body style="margin:0"><section data-fra-section="hero" style="background:linear-gradient(#050505,#111111);padding:40px;color:#fff;font:16px Arial"><h1 style="margin:0;font:300 48px/1.1 Arial;color:#fff">Big headline</h1><p style="color:rgba(255,255,255,.4);font-size:12px;margin:12px 0 0">Trusted by leading brands</p></section></body></html>`;

  async function verifyHero(page: string, over: Partial<Parameters<typeof verifyPreview>[0]> = {}) {
    const srv = await startLocalServer({ '/': { body: page } });
    try {
      return await verifyPreview({
        browser, url: `${srv.origin}/`, mode: 'selected-sections', expected: { mode: 'selected-sections', expectedSectionIds: ['hero'], forbiddenSectionIds: [], fixFindingsBySection: { hero: ['fidH'] }, globalSectionIds: [] },
        extraction: extractionOf(), fixFindings: [finding], routes: new Map([['fidH', { route: 'island' as const, sectionId: 'hero', stamp: null }]]), decisions: null, islands: [], skippedIslands: [],
        originalBehavior: null, originalHtml, sectionNames: { hero: 'Hero' }, simulated: [], generation: { assetsFailed: [], remoteLeft: [] }, ...over,
      });
    } finally { await srv.close(); }
  }
  const check = (v: Awaited<ReturnType<typeof verifyHero>>, id: string) => v.checks.find((c) => c.id === id)!;

  it('the reported defect: a near-black H1 on the near-black hero fails the finding, even though nothing about its audit values is wrong', async () => {
    const v = await verifyHero(heroPage('rgb(10, 10, 10)'));
    expect(check(v, 'contrast.fix-findings-legible').status).toBe('fail');
    expect(check(v, 'contrast.fix-findings-legible').detail).toMatch(/Big headline.*\b1(\.0\d?)?:1.*original measures 19\.\d+:1/);
    const o = v.findings.find((f) => f.findingId === 'fidH')!;
    expect(o.contrast).toMatchObject({ passes: false, required: 3 });
    expect(o.contrast!.ratio).toBeLessThan(1.3);
    expect(o.contrast!.baselineRatio).toBeGreaterThan(15);
    expect(o.status).not.toMatch(/verified/);
    expect(v.contrast!.regressions).toBeGreaterThanOrEqual(1);
    expect(v.verdict).toBe('fail');
  }, 120_000);

  it('the repaired H1 (the DS on-dark white) passes with the same measurement, and the inherited muted label is reported without failing the run', async () => {
    const v = await verifyHero(heroPage('rgb(255, 255, 255)'));
    expect(check(v, 'contrast.fix-findings-legible').status).toBe('pass');
    expect(check(v, 'contrast.no-regression').status).toBe('pass');
    const o = v.findings.find((f) => f.findingId === 'fidH')!;
    expect(o.contrast!.passes).toBe(true);
    expect(o.contrast!.ratio).toBeGreaterThan(15);
    // 40%-white 12px label: below AA on the original page too → inherited, listed, left as designed
    const label = v.contrast!.rows.find((r) => /Trusted by/.test(r.text))!;
    expect(label).toMatchObject({ verdict: 'inherited', muted: true, passesAA: false });
    expect(label.ratio).toBeCloseTo(3.8, 0);
    expect(label.baselineRatio).toBeCloseTo(label.ratio, 0);
    expect(check(v, 'contrast.inherited').status).toBe('not-checked');
    expect(v.contrast!.mutedBelowAA).toBe(1);
  }, 120_000);

  it('a recorded decision that accepts a contrast gap (with its reason) is reported, not silently passed — and only then does it stop failing', async () => {
    const page = heroPage('rgb(10, 10, 10)');
    const accepted = await verifyHero(page, { decisions: { schemaVersion: 1, findings: { fidH: { resolution: 'reuse-existing', acceptContrast: 'DS component, shared DS out of scope' } } } });
    expect(check(accepted, 'contrast.fix-findings-legible').status).toBe('pass');
    const o = accepted.findings.find((f) => f.findingId === 'fidH')!;
    expect(o.reported).toBe('decision');
    expect(o.detail).toMatch(/accepted by a recorded decision: DS component, shared DS out of scope/);
    // a decision WITHOUT acceptContrast does not excuse it
    const notAccepted = await verifyHero(page, { decisions: { schemaVersion: 1, findings: { fidH: { resolution: 'reuse-existing', note: 'mounted the DS heading' } } } });
    expect(check(notAccepted, 'contrast.fix-findings-legible').status).toBe('fail');
  }, 120_000);

  /** A listbox implemented the way Radix does it: portalled to the body, opened by click and by Enter/Space/ArrowDown, closed by Escape. */
  const selectPage = (variant: 'ok' | 'transparent' | 'never-opens' | 'mouse-only' | 'no-focus-frame') => `<!doctype html><html><head><meta charset="utf-8"><title>s</title><link rel="icon" href="data:,"><style>
body{margin:0;font:16px Arial} .card{margin:40px;padding:8px;border:1px solid #e5e7eb;border-radius:6px;width:400px}
.card:has(button:focus-visible){border-color:rgba(0,0,0,.9)} button.t{all:unset;display:block;width:100%;cursor:pointer;padding:6px}
#menu{position:fixed;left:40px;top:120px;width:400px;border:1px solid #ccc;z-index:50;${variant === 'transparent' ? '' : 'background:#fff;'}}
#menu div{padding:8px;cursor:pointer}
</style></head><body>
<div data-pv-section="calc" id="host"></div>
<script>
const host = document.getElementById('host'); const root = host.attachShadow({ mode: 'open' });
root.innerHTML = '${variant === 'no-focus-frame' ? '' : '<style>.card:has(button:focus-visible){border-color:rgba(0,0,0,.9)!important}</style>'}<div class="card" style="margin:40px;padding:8px;border:1px solid #e5e7eb;border-radius:6px;width:400px"><button class="t" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="Length of the Interview" style="all:unset;display:block;width:100%;cursor:pointer;padding:6px">Select</button></div>';
const btn = root.querySelector('button'); let menu = null;
const open = () => { if ('${variant}' === 'never-opens' || menu) return; menu = document.createElement('div'); menu.id = 'menu'; menu.setAttribute('role', 'listbox');
  for (const t of ['Select','0-15','16-20','21-30']) { const o = document.createElement('div'); o.setAttribute('role','option'); o.textContent = t; o.onclick = () => { btn.firstChild.nodeValue = t; shut(); }; menu.appendChild(o); }
  menu.dataset.i = '0'; menu.tabIndex = -1; document.body.appendChild(menu); btn.setAttribute('aria-expanded','true'); menu.focus(); };
const shut = () => { if (menu) { menu.remove(); menu = null; btn.setAttribute('aria-expanded','false'); btn.focus(); } };
btn.addEventListener('click', () => (menu ? shut() : open()));
${variant === 'mouse-only' ? '' : "btn.addEventListener('keydown', (e) => { if (['Enter',' ','ArrowDown'].includes(e.key)) { e.preventDefault(); e.__opening = true; open(); } });"}
document.addEventListener('keydown', (e) => { if (!menu || e.__opening) return; e.preventDefault(); if (e.key === 'Escape') shut(); if (e.key === 'ArrowDown') { const o = [...menu.children]; const i = Number(menu.dataset.i) + 1; menu.dataset.i = String(Math.min(i, o.length - 1)); } if (e.key === 'Enter') { const o = menu.children[Number(menu.dataset.i)]; o.click(); } });
</script></body></html>`;
  const selectExtraction = () => ({ ...extractionOf(), sections: [{ ...sectionStub(), id: 'calc', name: 'Calc' }] });
  async function verifySelect(variant: Parameters<typeof selectPage>[0]) {
    const srv = await startLocalServer({ '/': { body: selectPage(variant) } });
    try {
      return await verifyPreview({ browser, url: `${srv.origin}/`, mode: 'selected-sections', expected: { mode: 'selected-sections', expectedSectionIds: ['calc'], forbiddenSectionIds: [], fixFindingsBySection: {}, globalSectionIds: [] }, extraction: selectExtraction(), fixFindings: [], routes: new Map(), decisions: null, islands: [], skippedIslands: [], originalBehavior: null, sectionNames: {}, simulated: [], generation: { assetsFailed: [], remoteLeft: [] } });
    } finally { await srv.close(); }
  }

  it('a select that opens, shows painted readable options, takes the keyboard, picks by keyboard and by click, closes on Escape and shows a focus frame passes', async () => {
    const v = await verifySelect('ok');
    const c = v.popupControls![0]!;
    expect(c).toMatchObject({ label: 'Length of the Interview', clickOpens: true, panelFilled: true, escapeCloses: true, keyboardSelects: true, clickSelects: true });
    expect(c.optionsVisible).toBe(4);
    expect(c.keyboard).toEqual({ enter: true, space: true, arrowDown: true });
    expect(c.focusIndicator.present).toBe(true);
    for (const id of ['interaction.popup-controls', 'interaction.popup-controls-keyboard', 'interaction.popup-controls-focus']) expect(v.checks.find((x) => x.id === id)!.status, id).toBe('pass');
  }, 120_000);

  it('a menu with no background fill is a failure even though its options exist in the DOM', async () => {
    const v = await verifySelect('transparent');
    expect(v.popupControls![0]!.optionsInDom).toBe(4);
    expect(v.popupControls![0]!.panelFilled).toBe(false);
    expect(v.checks.find((x) => x.id === 'interaction.popup-controls')!.status).toBe('fail');
  }, 120_000);

  it('a select whose keyboard focus changes nothing visible fails the focus check (the DS documents a border-colour change for form fields)', async () => {
    const v = await verifySelect('no-focus-frame');
    expect(v.popupControls![0]!.focusIndicator.present).toBe(false);
    expect(v.checks.find((x) => x.id === 'interaction.popup-controls-focus')!.status).toBe('fail');
    expect(v.checks.find((x) => x.id === 'interaction.popup-controls')!.status).toBe('pass');
  }, 120_000);

  it('a select that never opens, and one that cannot be opened from the keyboard, each fail their own check', async () => {
    const never = await verifySelect('never-opens');
    expect(never.checks.find((x) => x.id === 'interaction.popup-controls')!.status).toBe('fail');
    const mouse = await verifySelect('mouse-only');
    expect(mouse.checks.find((x) => x.id === 'interaction.popup-controls')!.status).toBe('pass');
    expect(mouse.checks.find((x) => x.id === 'interaction.popup-controls-keyboard')!.status).toBe('fail');
  }, 120_000);
});
