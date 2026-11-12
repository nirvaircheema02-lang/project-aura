import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { openDb } from '../../src/db/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { DisabledLlmClient } from '../../src/llm/provider.ts';
import { auditPage } from '../../src/agents/page-graph.ts';
import { buildFinding, deterministicEvaluations } from '../../src/agents/b4-compliance-auditor/index.ts';
import { decideMatch, dsIndex, pageTypographyOf } from '../../src/agents/b3-ds-matcher/deterministic.ts';
import { buildCoverageManifest, runCoverageQa, gateIsConsistent } from '../../src/agents/b7-coverage-qa/index.ts';
import { extractComputedStyle, extractComputedStyles } from '../../src/t-layer/computed-style.ts';
import { locatorFor } from '../../src/t-layer/element-registry.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { withFirstPass, type LivePipelineDeps } from '../helpers/live-pipeline.ts';
import type { CoverageLedger, Finding, PageResult } from '../../src/skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent, PageSession } from '../../src/agents/types.ts';

/**
 * B7 — Final Audit Coverage & QA, END TO END (real Chromium, the real Design System, no-api mode, nothing from a
 * real site). An independent final checker: it builds its own manifest of the RENDERED page, every discovered item
 * ends in exactly one state, a gap is routed to the stage that owns it (at most 2 corrective passes), what stays
 * open is NEEDS_REVIEW, and the Coverage Gate passes only when nothing is unaccounted.
 *
 * Gaps are made the way real ones are made — a component the first pass "missed" is removed from B4's output, a role
 * is audited the way the old engine audited it, a finding loses a violation — and B7 is asked to catch them.
 */

const css = `
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
section{padding:40px;min-height:200px}
h2,h3,p{margin:0 0 12px}
.eyebrow{font-size:10px;font-weight:500;color:#464449}
.desc{font-size:16px;font-weight:400}
.big{font:300 30px 'Noto Serif',Georgia,serif;margin:0 0 20px}
.stat{font-size:36px;margin:0}
.pill{display:inline-block;border:1px solid rgb(176,31,36);border-radius:6px;background:rgba(176,31,36,.1);color:rgb(87,62,105);font-size:12px;padding:4px 8px}
.card{border:1px solid #ccc;width:300px;height:160px;float:left;margin:8px;padding:12px}
.card h3{font-size:18px;font-family:'Noto Serif',Georgia,serif;font-weight:300}
`;

/** The brand-perception-survey intro, as measured live, plus a row of repeated cards. */
const introHtml = `<!doctype html><html><head><style>${css}</style></head><body><main>
<section aria-label="Intro" style="height:300px">
  <h2 class="eyebrow">ABOUT KEN SURVEY</h2>
  <h3 class="desc">Built on Reach, Research, and Real Voices</h3>
  <p class="big">Use real feedback from real audiences to understand what drives decisions and act with confidence.</p>
  <p class="stat">250000+</p>
  <span class="pill">Step 01</span>
</section>
<section aria-label="Cards" style="height:260px"><h2 style="font:300 31px 'Noto Serif',Georgia,serif">Why teams choose us</h2>
  <div class="card"><h3>Card one</h3><p>Card copy one</p></div><div class="card"><h3>Card two</h3><p>Card copy two</p></div><div class="card"><h3>Card three</h3><p>Card copy three</p></div>
</section>
</main></body></html>`;

/** Content only an interaction reveals: a hover layer, a tab panel, a carousel slide. */
const stateHtml = `<!doctype html><html><head><style>${css}
.reveal{opacity:0;transition:none} .hoverhost:hover .reveal{opacity:1}
.slide{display:none} .slide.on{display:block}
</style></head><body><main>
<section aria-label="Hover"><h2 style="font:300 31px 'Noto Serif',Georgia,serif">Hover layer</h2><div class="hoverhost" style="width:360px;height:100px;background:#eee"><p>Visible title</p><p class="reveal">Revealed on hover text</p></div></section>
<section aria-label="Tabs"><div role="tablist"><button role="tab" id="t1" aria-selected="true" aria-controls="p1">One</button><button role="tab" id="t2" aria-selected="false" aria-controls="p2">Two</button></div>
  <div role="tabpanel" id="p1" aria-labelledby="t1"><p>Panel one words</p></div><div role="tabpanel" id="p2" aria-labelledby="t2" style="display:none"><p>Panel two words only a tab reveals</p></div></section>
<section aria-label="Carousel"><div class="swiper" id="car"><div class="swiper-slide slide on"><p>Step 05 slide</p></div><div class="swiper-slide slide"><p>Step 06 slide</p></div><div class="swiper-slide slide"><p>Step 07 slide only the next control reveals</p></div>
  <button class="swiper-button-next" id="next" type="button">Next</button></div></section>
</main><script>
 const t1=document.getElementById('t1'),t2=document.getElementById('t2'),p1=document.getElementById('p1'),p2=document.getElementById('p2');
 function pick(on){const a=on===1;t1.setAttribute('aria-selected',String(a));t2.setAttribute('aria-selected',String(!a));p1.style.display=a?'':'none';p2.style.display=a?'none':'';}
 t1.onclick=()=>pick(1);t2.onclick=()=>pick(2);
 const slides=[...document.querySelectorAll('.slide')];let cur=0;
 document.getElementById('next').onclick=()=>{slides[cur].classList.remove('on');cur=(cur+1)%slides.length;slides[cur].classList.add('on');};
</script></body></html>`;

/**
 * A reveal operates only what is safe to operate: a carousel whose "next" is a link to another page must never be
 * clicked (it would navigate away), and a carousel's "next" is ITS OWN control — never the first one on the page.
 */
const unsafeCarouselHtml = `<!doctype html><html><head><style>${css}
.slide{display:none} .slide.on{display:block}
</style></head><body><main>
<section aria-label="Pager"><div class="swiper" id="own"><div class="swiper-slide slide on"><p>Own slide one</p></div><div class="swiper-slide slide"><p>Own slide two behind a next-page link</p></div>
  <a class="swiper-button-next" id="next-link" href="/elsewhere">Next</a></div></section>
</main><script>window.__linkClicks=0;document.getElementById('next-link').addEventListener('click',(e)=>{window.__linkClicks++;e.preventDefault();});</script></body></html>`;

const twoCarouselsHtml = `<!doctype html><html><head><style>${css}
.slide{display:none} .slide.on{display:block}
</style></head><body><main>
<section aria-label="First"><div class="swiper" id="a"><div class="swiper-slide"><p>Alpha slide one</p></div><button class="swiper-button-next" id="next-a" type="button">Next</button></div></section>
<section aria-label="Second"><div class="swiper" id="b"><div class="swiper-slide slide on"><p>Beta slide one</p></div><div class="swiper-slide slide"><p>Beta slide two only its own next control reveals</p></div>
  <button class="swiper-button-next" id="next-b" type="button">Next</button></div></section>
</main><script>
 window.__aClicks=0;document.getElementById('next-a').onclick=()=>{window.__aClicks++;};
 const bs=[...document.querySelectorAll('#b .slide')];let cur=0;
 document.getElementById('next-b').onclick=()=>{bs[cur].classList.remove('on');cur=(cur+1)%bs.length;bs[cur].classList.add('on');};
</script></body></html>`;

/**
 * The recovery loop. A page of distinct notes (the first pass is made to MISS them, the way a real page's late-mounted
 * content is missed), a header menu whose links only a hover opens (the real audit's 179 "faded layer" items), a menu
 * only a CLICK opens (nothing B7 may safely do), and an intro whose audit stamps the page later strips.
 */
const notesHtml = `<!doctype html><html><head><style>${css}</style></head><body><main>
<section aria-label="Notes" style="height:700px"><h2 style="font:300 31px 'Noto Serif',Georgia,serif">Field notes</h2>
${Array.from({ length: 10 }, (_, i) => `<p>Distinct note number ${i + 1} about a different subject entirely</p>`).join('\n')}
</section></main></body></html>`;

const menuCss = `.menu{list-style:none;margin:0;padding:12px 24px} .grp{display:inline-block;position:relative}
.panel{position:absolute;top:100%;left:0;width:260px;background:#fff;border:1px solid #ddd;opacity:0;pointer-events:none}
.panel a{display:block;padding:6px 10px;color:#111;font-size:14px;text-decoration:none}`;
const menuLinks = (names: string[]) => names.map((n, i) => `<a href="#m${i}">${n}</a>`).join('');
const hoverMenuHtml = `<!doctype html><html><head><style>${css}${menuCss}.grp:hover .panel{opacity:1;pointer-events:auto}</style></head><body>
<header><nav aria-label="Main"><ul class="menu"><li class="grp"><button type="button" style="font-size:15px;padding:6px 12px">Reports</button>
<div class="panel">${menuLinks(['Alpha report', 'Beta report', 'Gamma report', 'Delta report', 'Epsilon report', 'Zeta report'])}</div></li></ul></nav></header>
<main><section aria-label="Body" style="height:400px"><h2 style="font:300 31px 'Noto Serif',Georgia,serif">Body copy</h2><p>Plain body copy under the menu</p></section></main></body></html>`;

const clickMenuHtml = `<!doctype html><html><head><style>${css}${menuCss}.grp.open .panel{opacity:1;pointer-events:auto}</style></head><body>
<header><nav aria-label="Main"><ul class="menu"><li class="grp" id="g"><button type="button" onclick="document.getElementById('g').classList.toggle('open')" style="font-size:15px;padding:6px 12px">Company</button>
<div class="panel">${menuLinks(['Hidden one', 'Hidden two', 'Hidden three', 'Hidden four', 'Hidden five'])}</div></li></ul></nav></header>
<main><section aria-label="Body" style="height:400px"><h2 style="font:300 31px 'Noto Serif',Georgia,serif">Body copy</h2><p>Plain body copy under the menu</p></section></main></body></html>`;

/** Sampling, an off-domain link, a visually hidden element: every intentional exclusion has a stated reason. */
const n = (k: number) => Array.from({ length: k }, (_, i) => i + 1);
const exclusionsHtml = `<!doctype html><html><head><style>${css}
.rcard{display:inline-block;width:200px;height:60px;border:1px solid #d9d1ce;padding:12px;margin:8px;color:#111;text-decoration:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
</style></head><body><a class="sr" href="#main">Skip to content</a><main id="main">
<section aria-label="Reports"><h2 style="font:300 31px 'Noto Serif',Georgia,serif">Latest reports</h2>${n(14).map((i) => `<a class="rcard" href="/r/${i}">Report number ${i}</a>`).join('')} <a href="https://example.org/partner" style="color:#555">Partner site</a></section>
</main></body></html>`;

let dir: string;
let deps: LivePipelineDeps;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
const url = (path: string) => `${server.origin}${path}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-b7-'));
  const config = loadConfig();
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({ '/intro': { body: introHtml }, '/state': { body: stateHtml }, '/exclusions': { body: exclusionsHtml }, '/unsafe-carousel': { body: unsafeCarouselHtml }, '/two-carousels': { body: twoCarouselsHtml }, '/notes': { body: notesHtml }, '/hover-menu': { body: hoverMenuHtml }, '/click-menu': { body: clickMenuHtml }, '/elsewhere': { body: '<!doctype html><html><body><p>another page</p></body></html>' } });
  deps = { db: openDb(join(dir, 'audit.db')), registry: await loadDsRegistry(config.designSystemPath), config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'shots') };
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  deps?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const componentOf = (b4: B4Output, label: RegExp): DetectedComponent => {
  const c = b4.components.find((x) => label.test(x.label));
  if (!c) throw new Error(`no component labelled ${label}`);
  return c;
};
const findingOf = (findings: Finding[], label: RegExp): Finding => {
  const f = findings.find((x) => label.test(x.component.productionLabel));
  if (!f) throw new Error(`no finding labelled ${label}`);
  return f;
};

/** B2's first pass MISSING these components: they, their B3 answer and their findings are gone, and B2 never "decided" about them either. */
function withoutComponents(b4: B4Output, drop: DetectedComponent[]): B4Output {
  const refs = new Set(drop.map((c) => c.ref));
  const ids = new Set(drop.map((c) => c.findingId));
  return {
    ...b4,
    components: b4.components.filter((c) => !refs.has(c.ref)),
    matched: b4.matched.filter((c) => !refs.has(c.ref)),
    unmatched: b4.unmatched.filter((c) => !refs.has(c.ref)),
    matches: new Map([...b4.matches].filter(([ref]) => !refs.has(ref))),
    findings: b4.findings.filter((f) => !ids.has(f.identity.findingId)),
    decidedRefs: (b4.decidedRefs ?? []).filter((ref) => !refs.has(ref)),
  };
}

/** The element audited the way the OLD engine audited it: typed by what its tag/size suggested, matched by B3 and judged by B4 as that. */
async function auditedAs(session: PageSession, b4: B4Output, label: RegExp, type: string): Promise<B4Output> {
  const original = componentOf(b4, label);
  const { structural: _s, headingRole: _h, ...rest } = original;
  const wrong = { ...rest, componentType: type } as DetectedComponent;
  const index = await dsIndex(session.registry);
  const match = decideMatch(wrong, index, session.registry, 1440, pageTypographyOf(b4.components, wrong));
  const matches = new Map(b4.matches).set(wrong.ref, match);
  const base: B4Output = { ...b4, components: b4.components.map((c) => (c.ref === wrong.ref ? wrong : c)), matches, matched: [...b4.matched.filter((c) => c.ref !== wrong.ref), wrong], findings: b4.findings.filter((f) => f.identity.findingId !== wrong.findingId) };
  const evaluations = await deterministicEvaluations(session, { ...base, matched: [wrong] });
  return { ...base, findings: [...base.findings, buildFinding(session, wrong, match, evaluations.get(wrong.ref)!)] };
}

const ledgerItem = (ledger: CoverageLedger, text: string, state: string) => [...ledger.needsReview, ...ledger.captureFailed, ...ledger.unaccounted].find((i) => i.label.includes(text) && i.state === state);

describe('B7 builds its OWN manifest of the rendered page — it does not need B2\'s candidate list', () => {
  it('given NOTHING from B2 (no components, no accessibility tree), it still discovers every meaningful item by DOM, visible text, computed style and geometry', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const empty: B4Output = { ...firstPass, components: [], matches: new Map(), matched: [], unmatched: [], findings: [], ariaElements: [], decidedRefs: [] };
      const manifest = await buildCoverageManifest(session, empty);
      const byText = (re: RegExp) => manifest.items.find((i) => re.test(i.text));
      expect(byText(/^ABOUT KEN SURVEY$/)).toMatchObject({ kind: 'heading' });
      expect(byText(/^Built on Reach/)).toMatchObject({ kind: 'heading', tag: 'h3' });
      expect(byText(/^Use real feedback/)).toMatchObject({ kind: 'text', tag: 'p' }); // the main heading is a <p>
      expect(byText(/^250000\+$/)).toMatchObject({ kind: 'text' }); // the stat
      expect(byText(/^Step 01$/)).toMatchObject({ kind: 'badge' });
      expect(manifest.items.filter((i) => i.kind === 'card')).toHaveLength(3);
      expect(manifest.items.filter((i) => i.kind === 'heading' && /^Card (one|two|three)$/.test(i.text))).toHaveLength(3);
      for (const item of manifest.items) {
        expect(item.box.width, item.text).toBeGreaterThan(0);
        expect(item.facts.style.fontSize, item.text).toMatch(/px$/); // its own computed-style reading
      }
    });
  }, 120_000);

  it('an audited element its scan did not classify is kept (the manifest is never smaller than what was audited) — marked as coming from B2', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const ghost = { ...componentOf(firstPass, /^Step 01$/), elId: 'ghost-1', label: 'A role-less clickable', componentType: 'button', fingerprint: { ...componentOf(firstPass, /^Step 01$/).fingerprint, role: 'generic', box: { x: 5, y: 5, width: 40, height: 20 } } };
      const manifest = await buildCoverageManifest(session, { ...firstPass, components: [...firstPass.components, ghost] });
      expect(manifest.items.find((i) => i.stamps.self.includes('ghost-1'))).toMatchObject({ source: 'b2', kind: 'control', text: 'A role-less clickable' });
      expect(manifest.notes.some((x) => x.includes('kept in the manifest as audited'))).toBe(true);
    });
  }, 120_000);
});

describe('a complete audit through the real graph (B1 → … → B6 → B7)', () => {
  let page: PageResult;
  let ledger: CoverageLedger;

  beforeAll(async () => {
    const config = loadConfig();
    page = await auditPage(url('/intro'), { db: deps.db, pool, registry: deps.registry, config, aiMode: 'no-api', llm: new DisabledLlmClient(), politeness: new Politeness(0), evidenceRoot: join(dir, 'shots-graph') }, { runId: 'b7-graph' });
    ledger = page.coverage.ledger!;
  }, 300_000);

  it('the Coverage Gate passes: every discovered item is accounted for, and the numbers add up', () => {
    expect(ledger.gate.passed).toBe(true);
    expect(ledger.gate.unaccounted).toBe(0);
    expect(gateIsConsistent(ledger.gate)).toBe(true);
    expect(ledger.gate.discovered).toBe(ledger.gate.audited + ledger.gate.excluded + ledger.gate.needsReview + ledger.gate.captureFailed);
    expect(ledger.sources).toEqual(expect.arrayContaining(['dom', 'accessibility-tree', 'visible-text', 'computed-style', 'geometry']));
    expect(ledger.passes).toBeLessThanOrEqual(2);
  });

  it('`ABOUT KEN SURVEY` is a supporting heading (an eyebrow) — literal upper-case, no CSS transform, an h2 — audited against the DS eyebrow family, never SectionHeading', () => {
    const f = findingOf(page.findings, /^ABOUT KEN SURVEY$/);
    expect(f.component.productionType).toBe('eyebrow');
    expect(f.component.dsComponent).toMatch(/^(OverheadText|SectionLabel)$/);
    expect(f.component.dsComponent).not.toBe('SectionHeading');
  });

  it('on a light surface its expected colour is Ken red (the locked supporting-heading colour rule)', () => {
    const f = findingOf(page.findings, /^ABOUT KEN SURVEY$/);
    const color = f.comparison.properties?.find((p) => p.property === 'color');
    expect(color, 'the colour is compared').toBeDefined();
    expect(`${color?.expected ?? ''} ${color?.expectedToken ?? ''}`.toLowerCase()).toMatch(/#b01f24|brand-red/);
    expect(color?.status).toBe('DIFFERENT'); // the page has rgb(70, 68, 73)
  });

  it('the dominant <p> is the MAIN section heading, the h3 beside it is a description, the numeral is a stat — and the ledger says so', () => {
    const main = findingOf(page.findings, /^Use real feedback/);
    expect(main.component).toMatchObject({ productionType: 'section-heading', dsComponent: 'SectionHeading' });
    // what the finding says about its tag is the tag it REALLY has (a <p>) — never the h2 slot the size match used as a tie-break proxy
    const said = `${main.action.recommendation ?? ''} ${(main.comparison.properties ?? []).map((p) => p.note ?? '').join(' ')}`;
    expect(said).toContain("The element is a <p> that is the section's main heading by its role");
    expect(said).not.toMatch(/is an h2|actual h2 child/);
    expect(findingOf(page.findings, /^Built on Reach/).component.productionType).toBe('paragraph');
    expect(findingOf(page.findings, /^250000\+$/).component.productionType).toBe('stat');
    expect(ledger.roleChecks.checked).toBeGreaterThan(5);
    expect(ledger.roleChecks).toMatchObject({ inconsistent: 0, unresolved: 0 }); // every item was audited under the right role
  });

  it('the badge and the three cards are audited as existing Design System components — never new ones', () => {
    expect(findingOf(page.findings, /^Step 01$/).component.dsComponent).toBe('Badge');
    expect(page.findings.filter((f) => f.component.productionType === 'card')).toHaveLength(3);
    expect(page.findings.filter((f) => f.component.productionType === 'card').every((f) => f.component.dsComponent !== null)).toBe(true);
  });

  it('the ledger travels with the page result and was persisted for reuse', () => {
    expect(page.coverage.ledger).toBeDefined();
    const row = deps.db.prepare('SELECT ledger_json FROM coverage_ledgers WHERE run_id = ? AND page_id = ?').get('b7-graph', page.pageId) as { ledger_json: string } | undefined;
    expect(JSON.parse(row!.ledger_json).gate).toEqual(ledger.gate);
  });
});

describe('B7 catches what the first pass missed and routes it through the NORMAL flow (B2 → B3 → B4 | B6)', () => {
  it('the main heading implemented as a <p> is missing from the audit → B7 detects it, B2 classifies it as the MAIN heading, B3 matches SectionHeading by nearest size, B4 audits it', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const missed = withoutComponents(firstPass, [componentOf(firstPass, /^Use real feedback/)]);
      const { state, ledger, records } = await runCoverageQa(session, missed);
      const f = findingOf(state.findings, /^Use real feedback/);
      expect(f.component).toMatchObject({ productionType: 'section-heading', dsComponent: 'SectionHeading', dsVariant: 'level 3' });
      expect(state.components.find((c) => /^Use real feedback/.test(c.label))).toMatchObject({ headingRole: 'main', elId: expect.stringContaining('-recovered-b7-') });
      expect(ledger.actions.filter((a) => /Use real feedback/.test(a.label)).map((a) => [a.route, a.outcome])).toEqual(expect.arrayContaining([['B2', 'resolved']]));
      expect(records.find((r) => /^Use real feedback/.test(r.raw.text))).toMatchObject({ state: 'AUDITED' });
      expect(ledger.gate.passed).toBe(true);
    });
  }, 180_000);

  it('a supporting heading audited as a SectionHeading (the old engine\'s answer) is a ROLE inconsistency B7 catches and routes back to B2/B3 — it ends as an eyebrow', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const wrongly = await auditedAs(session, firstPass, /^ABOUT KEN SURVEY$/, 'section-heading');
      const before = findingOf(wrongly.findings, /^ABOUT KEN SURVEY$/);
      expect(before.component.dsComponent).toBe('SectionHeading'); // the bug, reproduced
      const { state, ledger } = await runCoverageQa(session, wrongly);
      const after = findingOf(state.findings, /^ABOUT KEN SURVEY$/);
      expect(after.component.productionType).toBe('eyebrow');
      expect(after.component.dsComponent).toMatch(/^(OverheadText|SectionLabel)$/);
      expect(after.identity.findingId).toBe(before.identity.findingId); // the same element: re-audit history continues
      expect(ledger.roleChecks).toMatchObject({ inconsistent: 1, corrected: 1, unresolved: 0 });
      expect(ledger.actions.some((a) => a.route === 'B2' && /supporting heading/.test(a.reason))).toBe(true);
      expect(ledger.actions.some((a) => a.route === 'B3')).toBe(true);
      expect(ledger.gate.passed).toBe(true);
    });
  }, 180_000);

  it('the dominant <p> audited as ordinary body text is caught the same way and becomes the main section heading', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const wrongly = await auditedAs(session, firstPass, /^Use real feedback/, 'paragraph');
      const { state, ledger } = await runCoverageQa(session, wrongly);
      expect(findingOf(state.findings, /^Use real feedback/).component).toMatchObject({ productionType: 'section-heading', dsComponent: 'SectionHeading' });
      expect(ledger.roleChecks.corrected).toBe(1);
    });
  }, 180_000);

  it('stat text the audit never reached is recovered as a stat — never silently excluded', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const { state, ledger, records } = await runCoverageQa(session, withoutComponents(firstPass, [componentOf(firstPass, /^250000\+$/)]));
      expect(findingOf(state.findings, /^250000\+$/).component.productionType).toBe('stat');
      expect(records.find((r) => r.raw.text === '250000+')?.state).toBe('AUDITED');
      expect(ledger.excludedByReason.some((e) => e.examples.includes('250000+'))).toBe(false);
    });
  }, 180_000);

  it('a missing badge and a missing card are caught — each goes to its existing Design System family, never B6', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const cardTwo = firstPass.components.find((c) => c.componentType === 'card' && /Card two/.test(c.label));
      const dropped = [componentOf(firstPass, /^Step 01$/), ...(cardTwo ? [cardTwo] : [])];
      const { state, ledger } = await runCoverageQa(session, withoutComponents(firstPass, dropped));
      expect(findingOf(state.findings, /^Step 01$/).component).toMatchObject({ productionType: 'badge', dsComponent: 'Badge' });
      if (cardTwo) expect(state.findings.some((f) => f.component.productionType === 'card' && /Card two/.test(f.component.productionLabel) && f.component.dsComponent !== null)).toBe(true);
      expect(state.findings.some((f) => f.review?.node === 'B6')).toBe(false);
      expect(ledger.gate.passed).toBe(true);
    });
  }, 180_000);

  it('a missed radius / brand-colour / gradient violation is caught from a FRESH reading of the element and re-audited by B4', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const pill = findingOf(firstPass.findings, /^Step 01$/);
      expect(pill.comparison.ruleViolations.length, 'the red border and 6px radius are real violations').toBeGreaterThan(0);
      const lost = { ...pill, classification: 'DEVIATION' as const, comparison: { ...pill.comparison, ruleViolations: [] } };
      const corrupted: B4Output = { ...firstPass, findings: firstPass.findings.map((f) => (f.identity.findingId === pill.identity.findingId ? lost : f)) };
      const { state, ledger } = await runCoverageQa(session, corrupted);
      const restored = findingOf(state.findings, /^Step 01$/);
      expect(restored.comparison.ruleViolations.map((v) => v.ruleId).sort()).toEqual(pill.comparison.ruleViolations.map((v) => v.ruleId).sort());
      expect(ledger.actions.some((a) => a.route === 'B4' && /missing from a finding/.test(a.reason))).toBe(true);
    });
  }, 180_000);

  it('a component that was captured but never evaluated is routed on (B3 → B4), not left as a finding-less element', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const stat = componentOf(firstPass, /^250000\+$/);
      const noFinding: B4Output = { ...firstPass, findings: firstPass.findings.filter((f) => f.identity.findingId !== stat.findingId) };
      const { state, records } = await runCoverageQa(session, noFinding);
      expect(state.findings.some((f) => f.identity.findingId === stat.findingId)).toBe(true);
      expect(records.find((r) => r.raw.text === '250000+')?.state).toBe('AUDITED');
    });
  }, 180_000);
});

describe('content only an interaction reveals is found, revealed, handed to the normal flow — and the page is put back', () => {
  it('a hover layer, a tab panel behind its tab and a carousel slide behind its next control are all audited', async () => {
    await withFirstPass(url('/state'), deps, async (session, firstPass) => {
      const { state, ledger, records } = await runCoverageQa(session, firstPass);
      for (const text of ['Revealed on hover text', 'Panel two words only a tab reveals', 'Step 07 slide only the next control reveals']) {
        const r = records.find((x) => x.raw.text === text);
        expect(r?.state, text).toBe('AUDITED');
        expect(state.findings.some((f) => f.component.productionLabel === text), `a finding for "${text}"`).toBe(true);
      }
      expect(ledger.actions.filter((a) => a.route === 'state' && a.outcome === 'resolved').map((a) => a.reason).join(' | ')).toMatch(/hovered its host.*|selected its tab.*|advanced the carousel/s);
      expect(ledger.gate.passed).toBe(true);
      // the page is as it was found: the originally selected tab is selected again
      expect(await session.page.locator('#t1').getAttribute('aria-selected')).toBe('true');
      expect(await session.page.locator('#t2').getAttribute('aria-selected')).toBe('false');
    });
  }, 240_000);

  it('content nothing can reveal is NEEDS_REVIEW after exactly 2 passes, with its reason — never guessed, never dropped, never a silent pass', async () => {
    await withFirstPass(url('/state'), deps, async (session, firstPass) => {
      const never = async () => ({ ok: false as const, reason: 'nothing revealed it: scroll, hover were tried' });
      const { state, ledger, records } = await runCoverageQa(session, firstPass, { reveal: never });
      const open = records.filter((r) => ['Revealed on hover text', 'Panel two words only a tab reveals', 'Step 07 slide only the next control reveals'].includes(r.raw.text));
      expect(open).toHaveLength(3);
      for (const r of open) {
        expect(r.state, r.raw.text).toBe('NEEDS_REVIEW');
        expect(r.reason).toContain('nothing revealed it');
        expect(r.passes).toBe(2); // exactly the cap — two attempts, then an explicit state
      }
      // The explicit state lives in the Coverage ledger: nothing was invented in the FINDINGS to say so (a stub per
      // hidden item would only bury the real findings, and on a real page there can be hundreds).
      expect(state.findings.some((f) => f.component.signature.startsWith('unresolved:'))).toBe(false);
      expect(ledger.passes).toBeLessThanOrEqual(2);
      expect(ledger.recovery).toMatchObject({ stopped: 'converged', remaining: 0 });
      expect(ledger.recovery?.settled).toBeGreaterThanOrEqual(3);
      expect(ledger.actions.filter((a) => a.route === 'state' && a.outcome === 'needs_review').length).toBeGreaterThanOrEqual(6); // 3 items × 2 passes
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 }); // accounted for — as items a human must look at
      expect(ledger.gate.needsReview).toBeGreaterThanOrEqual(3);
    });
  }, 240_000);
});

describe('a reveal operates only what is SAFE to operate — the same predicate as every other click the audit makes', () => {
  it('a carousel whose "next" is a link to another page is never clicked: the slide stays NEEDS_REVIEW with the reason, and the page never moves', async () => {
    await withFirstPass(url('/unsafe-carousel'), deps, async (session, firstPass) => {
      const { ledger, records } = await runCoverageQa(session, firstPass);
      const slide = records.find((r) => r.raw.text === 'Own slide two behind a next-page link');
      expect(slide?.state).toBe('NEEDS_REVIEW');
      expect(slide?.reason).toMatch(/not safe to operate.*link to another page/);
      expect(await session.page.evaluate(() => (window as unknown as { __linkClicks: number }).__linkClicks)).toBe(0); // never even clicked
      expect(new URL(session.page.url()).pathname).toBe('/unsafe-carousel');
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 }); // accounted for — as something a human must look at
    });
  }, 240_000);

  it('a slide is advanced with ITS OWN carousel\'s "next" control — an earlier carousel\'s control is left alone', async () => {
    await withFirstPass(url('/two-carousels'), deps, async (session, firstPass) => {
      const { state, ledger, records } = await runCoverageQa(session, firstPass);
      const slide = records.find((r) => r.raw.text === 'Beta slide two only its own next control reveals');
      expect(slide?.state).toBe('AUDITED');
      expect(state.findings.some((f) => f.component.productionLabel === 'Beta slide two only its own next control reveals')).toBe(true);
      expect(ledger.actions.some((a) => a.route === 'state' && /advanced the carousel/.test(a.reason))).toBe(true);
      expect(await session.page.evaluate(() => (window as unknown as { __aClicks: number }).__aClicks)).toBe(0); // the first carousel's control was never touched
      expect(ledger.gate.passed).toBe(true);
    });
  }, 240_000);
});

describe('the recovery loop — B7 does not stop at reporting what is unaccounted', () => {
  const notesOf = (b4: B4Output) => b4.components.filter((c) => /^Distinct note number/.test(c.label));

  it('everything unaccounted goes back through the normal stages round after round — the manifest rebuilt each time — until unaccounted = 0, with no duplicate finding', async () => {
    await withFirstPass(url('/notes'), deps, async (session, firstPass) => {
      expect(notesOf(firstPass)).toHaveLength(10);
      const missed = withoutComponents(firstPass, notesOf(firstPass));
      const progress: Array<{ round: number; remaining: number }> = [];
      // ten gaps, at most three captured per round: the loop has to come back for the rest, round after round
      const { state, ledger, records } = await runCoverageQa(session, missed, { budget: { roundRecoveries: 3 }, onProgress: (p) => progress.push({ round: p.round, remaining: p.remaining }) });
      expect(ledger.recovery).toMatchObject({ found: 10, recovered: 10, settled: 0, remaining: 0, stopped: 'complete' });
      expect(ledger.recovery?.passes).toBe(4); // 3 + 3 + 3 + 1
      expect(progress.map((p) => p.remaining)).toEqual([10, 7, 4, 1]); // RECHECKING: what is left after each round (nothing after the last)
      for (const r of records.filter((x) => /^Distinct note number/.test(x.raw.text))) expect(r.state, r.raw.text).toBe('AUDITED');
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
      expect(gateIsConsistent(ledger.gate)).toBe(true);
      // no duplicates: one finding per element, ten notes → ten findings, every element id once
      const ids = state.findings.map((f) => f.identity.findingId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(state.findings.filter((f) => /^Distinct note number/.test(f.component.productionLabel))).toHaveLength(10);
      expect(new Set(state.components.map((c) => c.elId)).size).toBe(state.components.length);
      expect(state.findings).toHaveLength(missed.findings.length + 10);
    });
  }, 300_000);

  it('an element that cannot be captured, twice, is CAPTURE_FAILED with its reason — and the loop ends accounted, not spinning', async () => {
    await withFirstPass(url('/notes'), deps, async (session, firstPass) => {
      const missed = withoutComponents(firstPass, notesOf(firstPass).slice(0, 2));
      const { ledger, records } = await runCoverageQa(session, missed, { capture: async () => null });
      const failed = records.filter((r) => r.state === 'CAPTURE_FAILED');
      expect(failed).toHaveLength(2);
      for (const r of failed) {
        expect(r.reason).toContain('evidence capture failed');
        expect(r.passes).toBe(2); // exactly two attempts
      }
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0, captureFailed: 2 });
      expect(ledger.recovery).toMatchObject({ found: 2, recovered: 0, settled: 2, remaining: 0, stopped: 'complete' });
      expect(ledger.passes).toBe(2);
    });
  }, 240_000);

  it('a hover menu is revealed ONCE and every link in it is audited while it is open — the real audit lost 24 attempts to per-item reveals', async () => {
    await withFirstPass(url('/hover-menu'), deps, async (session, firstPass) => {
      const { state, ledger, records } = await runCoverageQa(session, firstPass);
      const links = records.filter((r) => /report$/.test(r.raw.text));
      expect(links).toHaveLength(6);
      for (const r of links) {
        expect(r.state, r.raw.text).toBe('AUDITED');
        expect(state.findings.some((f) => f.component.productionLabel === r.raw.text), `a finding for "${r.raw.text}"`).toBe(true);
      }
      const reveals = ledger.actions.filter((a) => a.route === 'state' && a.outcome === 'resolved');
      expect(reveals).toHaveLength(1); // one reveal for the whole layer …
      expect(reveals[0]?.reason).toMatch(/6 items in the layer are captured while it is open/);
      expect(ledger.actions.filter((a) => a.route === 'state' && a.outcome === 'needs_review')).toHaveLength(0); // … and not one failed attempt
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
      expect(ledger.recovery?.recovered).toBeGreaterThanOrEqual(6);
      // the page is put back: the menu is closed again
      expect(await session.page.evaluate(() => getComputedStyle(document.querySelector('.panel') as Element).opacity)).toBe('0');
    });
  }, 300_000);

  it('a menu only a CLICK opens cannot starve the cheap recoveries: they are done first, the layer is tried once per round, then settled — explicitly, not once per item', async () => {
    await withFirstPass(url('/click-menu'), deps, async (session, firstPass) => {
      const missed = withoutComponents(firstPass, [componentOf(firstPass, /^Body copy$/), componentOf(firstPass, /^Plain body copy/)]);
      const { state, ledger, records } = await runCoverageQa(session, missed, { budget: { roundRecoveries: 2 } });
      // the two cheap items fill round 1; the expensive layer is not even attempted before they are done
      expect(ledger.actions.filter((a) => a.pass === 1 && a.route === 'state')).toHaveLength(0);
      for (const text of ['Body copy', 'Plain body copy under the menu']) expect(records.find((r) => r.raw.text === text)?.state, text).toBe('AUDITED');
      const hidden = records.filter((r) => /^Hidden /.test(r.raw.text));
      expect(hidden).toHaveLength(5);
      for (const r of hidden) {
        expect(r.state, r.raw.text).toBe('NEEDS_REVIEW');
        expect(r.reason).toMatch(/nothing revealed it/);
        expect(r.passes).toBe(2);
      }
      // ONE attempt per layer per round — two in all — however many items the layer holds
      expect(ledger.actions.filter((a) => a.route === 'state' && /in the same hidden layer/.test(a.reason))).toHaveLength(2);
      expect(state.findings.some((f) => f.component.signature.startsWith('unresolved:'))).toBe(false);
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
      expect(ledger.recovery).toMatchObject({ found: 7, recovered: 2, settled: 5, remaining: 0, stopped: 'converged' });
    });
  }, 300_000);

  it('an audited element the page re-rendered (its stamp erased) is still ACCOUNTED FOR — a MATCH included — and is not audited a second time', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const match = findingOf(firstPass.findings, /^Built on Reach/);
      expect(match.classification).toBe('MATCH');
      await session.page.evaluate(() => document.querySelectorAll('[data-audit-el]').forEach((el) => el.removeAttribute('data-audit-el')));
      const { state, ledger, records } = await runCoverageQa(session, firstPass);
      const r = records.find((x) => x.raw.text.startsWith('Built on Reach'))!;
      expect(r.state).toBe('AUDITED');
      expect(r.finding?.identity.findingId).toBe(match.identity.findingId);
      // nothing the audit already held was captured again: each audited label has exactly the findings it had
      for (const f of firstPass.findings) {
        const label = f.component.productionLabel;
        expect(state.findings.filter((x) => x.component.productionLabel === label), label).toHaveLength(firstPass.findings.filter((x) => x.component.productionLabel === label).length);
      }
      expect(new Set(state.findings.map((f) => f.identity.findingId)).size).toBe(state.findings.length);
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
    });
  }, 300_000);
});

describe('every intentional exclusion is recorded with its reason', () => {
  it('a sampled listing, an off-domain link and a visually hidden skip link are EXCLUDED_WITH_REASON — and nothing is unaccounted', async () => {
    await withFirstPass(url('/exclusions'), deps, async (session, firstPass) => {
      const { ledger, records } = await runCoverageQa(session, firstPass);
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
      const reasons = ledger.excludedByReason.map((e) => e.reason);
      expect(reasons.some((r) => /repeated listing — bounded listing sampling/.test(r))).toBe(true);
      expect(reasons.some((r) => /off-domain utility link/.test(r))).toBe(true);
      expect(reasons.some((r) => /visually hidden/.test(r))).toBe(true);
      expect(ledger.excludedByReason.every((e) => e.reason.trim().length > 10 && e.count >= 1)).toBe(true);
      // every excluded item names its reason on the record itself
      for (const r of records.filter((x) => x.state === 'EXCLUDED_WITH_REASON')) expect(r.reason.trim().length, r.raw.text).toBeGreaterThan(10);
      const sampled = ledger.excludedByReason.find((e) => /bounded listing sampling/.test(e.reason));
      expect(sampled?.count).toBe(9); // 14 report cards, the first 5 audited
    });
  }, 180_000);
});

describe('the Coverage Gate fails when anything is unaccounted — and says exactly what', () => {
  it('B7 out of budget before it could look at a gap: the gap stays UNACCOUNTED, the gate FAILS and the audit is incomplete', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const missed = withoutComponents(firstPass, [componentOf(firstPass, /^250000\+$/), componentOf(firstPass, /^Use real feedback/)]);
      const { ledger, state } = await runCoverageQa(session, missed, { budget: { maxRecoveries: 0 } });
      expect(ledger.gate.passed).toBe(false);
      // the two removed components, plus the three surfaced cards this first pass (B1–B4 only, no B5) never captured
      expect(ledger.gate.unaccounted).toBe(5);
      expect(ledger.unaccounted).toHaveLength(ledger.gate.unaccounted); // exactly what is missing is listed — all of it
      expect(ledger.unaccounted.map((i) => i.label)).toEqual(expect.arrayContaining(['250000+', expect.stringContaining('Use real feedback')]));
      expect(ledger.unaccounted.every((i) => i.state === 'UNACCOUNTED' && i.reason.length > 10)).toBe(true);
      expect(ledger.notes.some((n) => n.includes('safety limit'))).toBe(true);
      expect(ledger.recovery).toMatchObject({ stopped: 'limit', remaining: 5 });
      expect(state.findings.some((f) => /^250000\+$/.test(f.component.productionLabel))).toBe(false); // nothing was invented to make the gate pass
      expect(gateIsConsistent(ledger.gate)).toBe(true);
    });
  }, 180_000);

  it('the same page with its budget intact passes, with exactly the same gaps found and closed', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const missed = withoutComponents(firstPass, [componentOf(firstPass, /^250000\+$/), componentOf(firstPass, /^Use real feedback/)]);
      const { ledger } = await runCoverageQa(session, missed);
      expect(ledger.gate).toMatchObject({ passed: true, unaccounted: 0 });
      expect(ledgerItem(ledger, '250000+', 'UNACCOUNTED')).toBeUndefined();
    });
  }, 180_000);
});

describe('B7\'s fresh style reading is the same reading B2 takes', () => {
  it('extractComputedStyles (one round trip for many elements) equals extractComputedStyle per element', async () => {
    await withFirstPass(url('/intro'), deps, async (session, firstPass) => {
      const ids = firstPass.components.map((c) => c.elId);
      const bulk = await extractComputedStyles(session.page, ids);
      for (const c of firstPass.components.slice(0, 8)) {
        const single = await extractComputedStyle(locatorFor(session.page, c.elId));
        expect(bulk[c.elId], c.label).toEqual(single);
      }
      expect((await extractComputedStyles(session.page, ['nope-1']))['nope-1']).toEqual({ connected: false });
    });
  }, 120_000);
});

describe('re-audit and full-site reuse: a reused page carries its ledger, and only a page whose gate PASSED is reused', () => {
  it('the second audit of an unchanged page is reused WITH the first run\'s ledger; with that ledger gone the page is audited again', async () => {
    const config = loadConfig();
    const run = (runId: string, reuse: boolean) => auditPage(url('/intro'), { db: deps.db, pool, registry: deps.registry, config, aiMode: 'no-api', llm: new DisabledLlmClient(), politeness: new Politeness(0), evidenceRoot: join(dir, `shots-${runId}`) }, { runId, reuseIfUnchanged: reuse });
    const first = await run('b7-reuse-1', false);
    const reused = await run('b7-reuse-2', true);
    expect(reused.reusedFromRunId).toBe('b7-reuse-1');
    expect(reused.coverage.ledger?.gate).toEqual(first.coverage.ledger?.gate);
    expect(deps.db.prepare('SELECT COUNT(*) AS n FROM coverage_ledgers WHERE run_id = ?').get('b7-reuse-2')).toEqual({ n: 1 });
    deps.db.prepare('DELETE FROM coverage_ledgers WHERE run_id IN (?, ?)').run('b7-reuse-1', 'b7-reuse-2');
    const again = await run('b7-reuse-3', true);
    expect(again.reusedFromRunId, 'no ledger on record → nothing is reused on faith').toBeUndefined();
    expect(again.coverage.ledger?.gate.passed).toBe(true);
  }, 300_000);
});
