import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { loadDsRegistry } from '../../src/ds/d2-registry/index.ts';
import { openDb } from '../../src/db/index.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';
import { runCoverageQa } from '../../src/agents/b7-coverage-qa/index.ts';
import { startLocalServer } from '../helpers/local-server.ts';
import { withFirstPass, type LivePipelineDeps } from '../helpers/live-pipeline.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';
import type { B4Output } from '../../src/agents/types.ts';

/**
 * GLOBAL HEADER / GLOBAL FOOTER ownership, end to end (real Chromium, the real Design System, no-api mode, a local page).
 * Global chrome is identified before the page's own sections: everything in the banner and everything opened from it —
 * the menus, the search overlay, the account menu — is the Global Header's even while it lies over the hero; the hero owns
 * only its own subtree; a footer drawer is the Global Footer's; a detached overlay nothing owns is outside any section.
 */

const css = `
body{margin:0;font:16px 'DM Sans',Arial,sans-serif;color:#111;background:#fff}
section{padding:40px;min-height:200px}
h1,h2,h3,p{margin:0 0 12px}
header.site{position:sticky;top:0;background:#fff;z-index:5;height:56px}
.menu{list-style:none;margin:0;padding:12px 24px} .grp{display:inline-block;position:relative;margin-right:16px}
.panel{position:absolute;top:100%;left:0;width:300px;background:#fff;border:1px solid #ddd;opacity:0;pointer-events:none}
.grp:hover .panel{opacity:1;pointer-events:auto}
.panel a,.panel p{display:block;padding:6px 10px;color:#111;font-size:14px;text-decoration:none;margin:0}
.up .panel{top:auto;bottom:100%}
.slide{display:none} .slide.on{display:block}
`;

const chromeHtml = `<!doctype html><html><head><style>${css}</style></head><body>
<header class="site"><nav aria-label="Main"><ul class="menu">
  <li class="grp"><a href="#home" style="font-size:15px">Home</a></li>
  <li class="grp"><button type="button" style="font-size:15px;padding:6px 12px">Reports</button><div class="panel"><a href="#r0">All Reports</a><a href="#r1">Dealer Voice</a></div></li>
  <li class="grp"><button type="button" style="font-size:15px;padding:6px 12px">Industries</button><div class="panel"><a href="#i0">Automotive</a><a href="#i1">Energy</a></div></li>
  <li class="grp"><button type="button" aria-label="Search" style="font-size:15px;padding:6px 12px">Search</button><div class="panel" role="search"><input type="search" placeholder="Search reports" style="margin:6px 10px"><p>Popular searches</p></div></li>
  <li class="grp"><button type="button" style="font-size:15px;padding:6px 12px">My account</button><div class="panel"><a href="#p">Profile</a><a href="#o">Sign out</a></div></li>
</ul></nav></header>
<main>
<section aria-label="Hero" style="height:520px"><h1 style="font:300 40px 'Noto Serif',Georgia,serif">Your Dealers Know What Your Data Doesn’t</h1><p>Hear it from them first.</p>
  <div class="swiper" id="car"><div class="swiper-slide slide on"><p>Hero step one</p></div><div class="swiper-slide slide"><p>Hero step two only the next control reveals</p></div><button class="swiper-button-next" id="next" type="button">Next</button></div></section>
<section aria-label="Pricing FAQs" style="height:520px"><h2 style="font:300 31px 'Noto Serif',Georgia,serif">Pricing FAQs</h2>
  <details><summary>How do we price a study?</summary><p>Hidden answer about pricing studies.</p></details>
  <article><header><h3 style="font:300 20px 'Noto Serif',Georgia,serif">Card title inside an article</h3></header><p>Card copy.</p></article></section>
</main>
<footer><ul class="menu"><li class="grp up"><button type="button" style="font-size:15px;padding:6px 12px">Legal</button><div class="panel"><a href="#pp">Privacy policy</a><a href="#tu">Terms of use</a></div></li></ul></footer>
<script>
 const slides=[...document.querySelectorAll('.slide')];let cur=0;
 document.getElementById('next').onclick=()=>{slides[cur].classList.remove('on');cur=(cur+1)%slides.length;slides[cur].classList.add('on');};
</script></body></html>`;

let dir: string;
let deps: LivePipelineDeps;
let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;
const url = (path: string) => `${server.origin}${path}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'audit-b7-chrome-'));
  const config = loadConfig();
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'KenResearchDSAudit/0.1' });
  await pool.start();
  server = await startLocalServer({ '/chrome': { body: chromeHtml } });
  deps = { db: openDb(join(dir, 'audit.db')), registry: await loadDsRegistry(config.designSystemPath), config, pool, politeness: new Politeness(0), evidenceRoot: join(dir, 'shots') };
}, 300_000);

afterAll(async () => {
  await pool?.stop();
  await server?.close();
  deps?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const find = (findings: Finding[], label: string): Finding => {
  const f = findings.find((x) => x.component.productionLabel === label);
  if (!f) throw new Error(`no finding labelled "${label}" (have: ${findings.map((x) => x.component.productionLabel).slice(0, 40).join(' | ')})`);
  return f;
};

/** What a header finding says about where it belongs. */
const at = (f: Finding) => ({ region: f.location.region, group: f.location.group });

const GLOBAL_HEADER = (group: string) => ({ region: 'global-header', group });

describe('a complete audit of a page with global chrome: header, menus, search, account menu, hero, accordion, footer drawer, detached overlay', () => {
  let out: B4Output;
  let heroName: string;
  let ledgerPassed = false;

  beforeAll(async () => {
    await withFirstPass(url('/chrome'), deps, async (session, firstPass) => {
      const hero = firstPass.sections.find((s) => /Hero|Your Dealers/i.test(s.name));
      heroName = hero?.name ?? '';
      // A portal overlay mounted AFTER the page was analysed (a late cookie / chat widget): fixed, outside every section's
      // subtree, opened by no section's control, in no header or footer — nothing in the structure owns it.
      await session.page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'late-overlay';
        d.style.cssText = 'position:fixed;left:24px;top:420px;width:320px;background:#fff;border:1px solid #bbb;padding:12px';
        d.innerHTML = '<p>We use cookies to improve this site.</p><a href="#c">Manage cookie preferences</a>';
        document.body.appendChild(d);
      });
      const result = await runCoverageQa(session, firstPass);
      out = result.state;
      ledgerPassed = result.ledger.gate.passed && result.ledger.gate.unaccounted === 0;
    });
  }, 400_000);

  it('the Coverage Gate passes and no element has two findings', () => {
    expect(ledgerPassed).toBe(true);
    expect(new Set(out.findings.map((f) => f.identity.findingId)).size).toBe(out.findings.length);
  });

  it('every section carries its structural region: the banner is the Global Header, the footer the Global Footer, everything else page content', () => {
    const byName = (re: RegExp) => out.sections.find((s) => re.test(s.name));
    expect(byName(/^Header$/)?.region).toBe('global-header');
    expect(byName(/^Footer$/)?.region).toBe('global-footer');
    expect(heroName).not.toBe('');
    expect(out.sections.find((s) => s.name === heroName)?.region).toBe('page-content');
  });

  it('base navigation: the banner\'s own visible links and the menu triggers → Global Header › Base Navigation', () => {
    for (const label of ['Home', 'Reports', 'Industries']) expect(at(find(out.findings, label)), label).toEqual(GLOBAL_HEADER('Base Navigation'));
  });

  it('a mega-menu opened over the hero → Global Header, never the hero; the Reports menu is its own sub-group', () => {
    for (const label of ['All Reports', 'Dealer Voice']) {
      const f = find(out.findings, label);
      expect(at(f), label).toEqual(GLOBAL_HEADER('Reports Menu'));
      expect(f.location.section, label).toBe('Header');
      expect(f.location.section).not.toBe(heroName);
    }
  });

  it('the Industries menu → Global Header › Industries Menu', () => {
    for (const label of ['Automotive', 'Energy']) expect(at(find(out.findings, label)), label).toEqual(GLOBAL_HEADER('Industries Menu'));
  });

  it('the search control and its overlay → Global Header › Search', () => {
    expect(at(find(out.findings, 'Search'))).toEqual(GLOBAL_HEADER('Search'));
    expect(at(find(out.findings, 'Popular searches'))).toEqual(GLOBAL_HEADER('Search'));
  });

  it('the account / user menu → Global Header › Account/User Menu', () => {
    for (const label of ['My account', 'Profile', 'Sign out']) expect(at(find(out.findings, label)), label).toEqual(GLOBAL_HEADER('Account/User Menu'));
  });

  it('the hero owns ONLY its own content: its heading, and its carousel slide revealed by the carousel\'s next control', () => {
    for (const label of ['Your Dealers Know What Your Data Doesn’t', 'Hero step two only the next control reveals']) {
      const f = find(out.findings, label);
      expect(f.location.section, label).toBe(heroName);
      expect(f.location.region, label).toBe('page-content');
      expect(f.location.group, label).toBeUndefined();
    }
    // …and not one header, menu, search or account finding is filed under it
    const inHero = out.findings.filter((f) => f.location.section === heroName).map((f) => f.component.productionLabel);
    for (const label of ['Home', 'Reports', 'Industries', 'All Reports', 'Dealer Voice', 'Automotive', 'Energy', 'Search', 'Popular searches', 'My account', 'Profile', 'Sign out']) expect(inHero, label).not.toContain(label);
  });

  it('a section accordion panel stays in its parent section; a card\'s own <header> inside an article is NOT the Global Header', () => {
    const answer = find(out.findings, 'Hidden answer about pricing studies.');
    expect(answer.location.section).toMatch(/Pricing FAQs/);
    expect(answer.location.region).toBe('page-content');
    const card = find(out.findings, 'Card title inside an article');
    expect(card.location.section).toMatch(/Pricing FAQs/);
    expect(card.location.region).toBe('page-content');
  });

  it('a footer drawer → Global Footer', () => {
    for (const label of ['Privacy policy', 'Terms of use']) {
      const f = find(out.findings, label);
      expect(f.location.region, label).toBe('global-footer');
      expect(f.location.section, label).toBe('Footer');
    }
  });

  it('a detached overlay no structure owns (a late-mounted fixed cookie notice outside every section) is OUTSIDE ANY SECTION and marked for review — not guessed into the hero', () => {
    for (const label of ['We use cookies to improve this site.', 'Manage cookie preferences']) {
      const f = find(out.findings, label);
      expect(f.location.section, label).toBe('(outside any section)');
      expect(f.location.region, label).toBeUndefined();
      expect(f.review?.status, label).toBe('NEEDS_REVIEW');
      expect(f.review?.reason, label).toMatch(/detached overlay/);
    }
  });
});

describe('a menu opened while the page is scrolled lower stays in the Global Header', () => {
  it('the page scrolled 400px down before B7 runs: the Industries menu is still Global Header › Industries Menu, not the section scrolled under it', async () => {
    await withFirstPass(url('/chrome'), deps, async (session, firstPass) => {
      await session.page.evaluate(() => window.scrollTo(0, 400));
      const { state } = await runCoverageQa(session, firstPass);
      for (const label of ['Automotive', 'Energy']) {
        const f = find(state.findings, label);
        expect(at(f), label).toEqual(GLOBAL_HEADER('Industries Menu'));
        expect(f.location.section, label).toBe('Header');
      }
    });
  }, 400_000);
});
