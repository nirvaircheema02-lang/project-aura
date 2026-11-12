import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findCandidateElements, type LiveCandidate } from '../../src/mapping/candidates.ts';
import {
  affordancesOf,
  bestCandidateFor,
  computeCaptureFingerprint,
  landmarkSaysGlobal,
  locateAndStampSectionWrapper,
  locateSectionByHeading,
  stampElement,
  stampedElementIdAt,
  STAMP_ATTR_ELEMENT,
  STAMP_ATTR_FINDINGS,
  STAMP_ATTR_INSTANCE,
  STAMP_ATTR_SCOPE,
  STAMP_ATTR_SECTION,
  STAMP_ATTR_SIGNATURE,
  STAMP_ATTR_TYPE,
} from '../../src/mapping/stamp.ts';
import type { Box } from '../../src/mapping/types.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Real Chromium against a local fixture page — no mocking. Covers §6.4's element mapping
 * mechanics (stamping, candidate discovery, affordances, section wrappers, global-landmark
 * detection) and §6.6's capture fingerprint.
 */

const FIXTURE = `<!doctype html><html><head><title>stamp-fixture</title>
<style id="page-style">body { margin: 0; font-family: sans-serif; } .card { padding: 8px; display: inline-block; }</style>
</head>
<body>
<header id="site-header">
  <span id="logo">Ken Research</span>
  <nav id="primary-nav" aria-label="primary"><a id="nav-link" href="/">Home</a></nav>
</header>
<main>
  <section id="cards">
    <div class="cards-row">
      <div class="card card-a">
        <button id="buy-btn" class="btn btn-primary" type="button">Buy now</button>
      </div>
      <div class="card card-b">
        <button id="disabled-btn" class="btn btn-secondary" disabled>Disabled</button>
      </div>
    </div>
  </section>
  <div class="toolbar">
    <button id="menu-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="menu-panel" style="cursor:pointer">Menu</button>
    <a id="plain-link" href="https://example.com" tabindex="0">Learn more</a>
  </div>
  <div id="menu-panel" hidden></div>
  <form id="contact-form">
    <button id="submit-btn" type="submit">Submit</button>
  </form>
</main>
<footer id="site-footer"><span id="footer-text">Footer text</span></footer>
</body></html>`;

let pool: BrowserPool;
let server: Awaited<ReturnType<typeof startLocalServer>>;

beforeAll(async () => {
  server = await startLocalServer({ '/fixture': { body: FIXTURE } });
  pool = new BrowserPool({ channel: 'chromium', userAgentProduct: 'FixRedesignAgentTest/0.1' });
  await pool.start();
});

afterAll(async () => {
  await pool?.stop();
  await server?.close();
});

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return pool.withIsolatedPage(async (page) => {
    await page.goto(`${server.origin}/fixture`);
    return fn(page);
  });
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`fixture selector not found: ${sel}`);
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
  }, selector);
}

/**
 * Builds a real `LiveCandidate` for one exact element (by selector), reading the same fields
 * `findCandidateElements` would. Used as fixture data for `stamp.ts`'s own functions so their
 * tests don't depend on `findCandidateElements` (see the dedicated, separately-failing
 * `findCandidateElements` describe block below for that function's own bug).
 */
async function candidateFor(page: Page, selector: string): Promise<LiveCandidate> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    if (!el) throw new Error(`fixture selector not found: ${sel}`);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      candidateId: `cand-${sel}`,
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
      classes: Array.from(el.classList),
      box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
      href: el.getAttribute('href'),
      type: el.getAttribute('type'),
      tabIndex: el.hasAttribute('tabindex') ? Number(el.getAttribute('tabindex')) : el.tabIndex,
      ariaExpanded: el.getAttribute('aria-expanded'),
      ariaControls: el.getAttribute('aria-controls'),
      ariaHaspopup: el.getAttribute('aria-haspopup'),
      disabled: 'disabled' in el ? Boolean((el as unknown as { disabled: boolean }).disabled) : el.getAttribute('aria-disabled') === 'true',
      cursor: cs.cursor || null,
      formAssociated: Boolean(el.closest('form')),
    };
  }, selector);
}

async function stampBySelector(
  page: Page,
  selector: string,
  attrs: { elementId: string; findingId: string; signature: string | null; instanceIndex: number | null; productionType: string },
): Promise<{ ok: boolean; box: Box }> {
  const candidate = await candidateFor(page, selector);
  const ok = await stampElement(page, candidate, attrs);
  return { ok, box: candidate.box };
}

describe('findCandidateElements', () => {
  it('hit-tests a box and returns role/href/type/tabindex/aria-*/disabled/cursor/formAssociated affordances', async () => {
    await withPage(async (page) => {
      const box = await boxOf(page, '#menu-btn');
      const candidates = await findCandidateElements(page, box);
      const menuBtn = candidates.find((c) => c.tagName === 'button' && c.text === 'Menu');
      expect(menuBtn).toBeDefined();
      expect(menuBtn).toMatchObject({
        tagName: 'button',
        type: 'button',
        ariaHaspopup: 'true',
        ariaExpanded: 'false',
        ariaControls: 'menu-panel',
        cursor: 'pointer',
        disabled: false,
        formAssociated: false,
      });
    });
  });

  it('reports disabled state and form association', async () => {
    await withPage(async (page) => {
      const disabledBox = await boxOf(page, '#disabled-btn');
      const disabledCandidates = await findCandidateElements(page, disabledBox);
      const disabledBtn = disabledCandidates.find((c) => c.tagName === 'button' && c.text === 'Disabled');
      expect(disabledBtn?.disabled).toBe(true);

      const submitBox = await boxOf(page, '#submit-btn');
      const submitCandidates = await findCandidateElements(page, submitBox);
      const submitBtn = submitCandidates.find((c) => c.tagName === 'button' && c.text === 'Submit');
      expect(submitBtn?.formAssociated).toBe(true);
      expect(submitBtn?.type).toBe('submit');
    });
  });

  it('reports explicit tabindex and href on a link', async () => {
    await withPage(async (page) => {
      const box = await boxOf(page, '#plain-link');
      const candidates = await findCandidateElements(page, box);
      const link = candidates.find((c) => c.tagName === 'a' && c.text === 'Learn more');
      expect(link).toMatchObject({ href: 'https://example.com', tabIndex: 0 });
    });
  });

  it('discovers the stacked ancestors too, not just the topmost element', async () => {
    await withPage(async (page) => {
      const box = await boxOf(page, '#buy-btn');
      const candidates = await findCandidateElements(page, box);
      const tags = candidates.map((c) => c.tagName);
      expect(tags).toContain('button');
      expect(tags).toContain('div'); // .card-a and/or .cards-row wrap the button at that point
    });
  });
});

describe('bestCandidateFor', () => {
  it('picks the real candidate whose box best overlaps the target, among several real elements', async () => {
    await withPage(async (page) => {
      const [buyBtn, disabledBtn, menuBtn] = await Promise.all([candidateFor(page, '#buy-btn'), candidateFor(page, '#disabled-btn'), candidateFor(page, '#menu-btn')]);
      const candidates = [buyBtn, disabledBtn, menuBtn];
      const targetBox = await boxOf(page, '#disabled-btn');
      expect(bestCandidateFor(candidates, targetBox)?.candidateId).toBe(disabledBtn.candidateId);
      expect(bestCandidateFor(candidates, targetBox)?.text).toBe('Disabled');
    });
  });

  it('is a pure max-IoU pick over a synthetic candidate list, and null on an empty list', () => {
    const c = (id: string, x: number): LiveCandidate => ({
      candidateId: id,
      tagName: 'div',
      role: null,
      text: '',
      classes: [],
      box: { x, y: 0, width: 10, height: 10 },
      href: null,
      type: null,
      tabIndex: null,
      ariaExpanded: null,
      ariaControls: null,
      ariaHaspopup: null,
      disabled: false,
      cursor: null,
      formAssociated: false,
    });
    const candidates = [c('far', 100), c('exact', 0), c('near', 2)];
    expect(bestCandidateFor(candidates, { x: 0, y: 0, width: 10, height: 10 })?.candidateId).toBe('exact');
    expect(bestCandidateFor([], { x: 0, y: 0, width: 10, height: 10 })).toBeNull();
  });
});

describe('affordancesOf', () => {
  it('projects a LiveCandidate down to just its Affordances fields', () => {
    const candidate: LiveCandidate = {
      candidateId: 'cand-0',
      tagName: 'button',
      role: 'button',
      text: 'Buy now',
      classes: ['btn', 'btn-primary'],
      box: { x: 0, y: 0, width: 10, height: 10 },
      href: null,
      type: 'button',
      tabIndex: 0,
      ariaExpanded: 'false',
      ariaControls: 'panel-1',
      ariaHaspopup: 'true',
      disabled: false,
      cursor: 'pointer',
      formAssociated: true,
    };
    expect(affordancesOf(candidate)).toEqual({
      tagName: 'button',
      role: 'button',
      href: null,
      type: 'button',
      tabIndex: 0,
      ariaExpanded: 'false',
      ariaControls: 'panel-1',
      ariaHaspopup: 'true',
      disabled: false,
      cursor: 'pointer',
      formAssociated: true,
    });
  });
});

describe('stampElement / stampedElementIdAt', () => {
  it('is unstamped before stampElement runs', async () => {
    await withPage(async (page) => {
      const box = await boxOf(page, '#buy-btn');
      expect(await stampedElementIdAt(page, box)).toBeNull();
    });
  });

  it('stamps the element with data-fra-* attributes and can be re-located by box', async () => {
    await withPage(async (page) => {
      const { ok, box } = await stampBySelector(page, '#buy-btn', {
        elementId: 'e1',
        findingId: 'f1',
        signature: 'sig-1',
        instanceIndex: 0,
        productionType: 'button',
      });
      expect(ok).toBe(true);

      const attrs = await page.evaluate(
        ({ sel, elAttr, findAttr, sigAttr, instAttr, typeAttr }) => {
          const el = document.querySelector(sel)!;
          return {
            element: el.getAttribute(elAttr),
            findings: el.getAttribute(findAttr),
            signature: el.getAttribute(sigAttr),
            instance: el.getAttribute(instAttr),
            type: el.getAttribute(typeAttr),
          };
        },
        { sel: '#buy-btn', elAttr: STAMP_ATTR_ELEMENT, findAttr: STAMP_ATTR_FINDINGS, sigAttr: STAMP_ATTR_SIGNATURE, instAttr: STAMP_ATTR_INSTANCE, typeAttr: STAMP_ATTR_TYPE },
      );
      expect(attrs).toEqual({ element: 'e1', findings: 'f1', signature: 'sig-1', instance: '0', type: 'button' });

      expect(await stampedElementIdAt(page, box)).toBe('e1');
    });
  });

  it('a second finding resolving to the same element appends to data-fra-findings rather than overwriting the stamp', async () => {
    await withPage(async (page) => {
      await stampBySelector(page, '#buy-btn', { elementId: 'e1', findingId: 'f1', signature: 'sig-1', instanceIndex: 0, productionType: 'button' });
      // Same live element, a different finding, and a DIFFERENT elementId/signature/type — those
      // must be ignored: the element is already stamped, so only the findings list grows.
      await stampBySelector(page, '#buy-btn', { elementId: 'e-should-be-ignored', findingId: 'f2', signature: 'sig-should-be-ignored', instanceIndex: 9, productionType: 'should-be-ignored' });

      const findings = await page.locator('#buy-btn').getAttribute(STAMP_ATTR_FINDINGS);
      expect(findings).toBe('f1 f2');
      const element = await page.locator('#buy-btn').getAttribute(STAMP_ATTR_ELEMENT);
      expect(element).toBe('e1'); // unchanged — first stamp wins

      // replaying the SAME findingId again must not duplicate it
      await stampBySelector(page, '#buy-btn', { elementId: 'e1', findingId: 'f1', signature: 'sig-1', instanceIndex: 0, productionType: 'button' });
      expect(await page.locator('#buy-btn').getAttribute(STAMP_ATTR_FINDINGS)).toBe('f1 f2');
    });
  });

  it('regression: a stamped ANCESTOR does not make a smaller, nested box read as "already stamped" — only a box that actually corresponds (IoU) to the stamped element does', async () => {
    await withPage(async (page) => {
      // .card-a (the ancestor) gets stamped; #buy-btn (its child, a much smaller box) must NOT
      // be reported as already-stamped just because elementsFromPoint at its center also
      // returns the stamped ancestor.
      await stampBySelector(page, '.card-a', { elementId: 'card-1', findingId: 'f-card', signature: 'sig-card', instanceIndex: 0, productionType: 'card' });
      const buttonBox = await boxOf(page, '#buy-btn');
      expect(await stampedElementIdAt(page, buttonBox)).toBeNull();

      // But the card's OWN box still correctly reads as stamped.
      const cardBox = await boxOf(page, '.card-a');
      expect(await stampedElementIdAt(page, cardBox)).toBe('card-1');
    });
  });
});

describe('locateAndStampSectionWrapper', () => {
  it('returns located:false immediately when there are no member ids', async () => {
    await withPage(async (page) => {
      const result = await locateAndStampSectionWrapper(page, 'sec-empty', 'content', []);
      expect(result).toEqual({ located: false, stamp: null, tagName: null, box: null });
    });
  });

  it('widens the LCA of stamped members up to the nearest sectioning ancestor', async () => {
    await withPage(async (page) => {
      await stampBySelector(page, '#buy-btn', { elementId: 'e1', findingId: 'f1', signature: null, instanceIndex: null, productionType: 'button' });
      await stampBySelector(page, '#disabled-btn', { elementId: 'e2', findingId: 'f2', signature: null, instanceIndex: null, productionType: 'button' });

      const result = await locateAndStampSectionWrapper(page, 'sec-cards', 'content', ['e1', 'e2']);
      expect(result.located).toBe(true);
      expect(result.tagName).toBe('section'); // LCA is .cards-row (a plain div); widens up to <section id="cards">
      expect(result.box).not.toBeNull();

      const sectionAttrs = await page.evaluate(
        ({ secAttr, scopeAttr }) => {
          const el = document.getElementById('cards')!;
          return { section: el.getAttribute(secAttr), scope: el.getAttribute(scopeAttr) };
        },
        { secAttr: STAMP_ATTR_SECTION, scopeAttr: STAMP_ATTR_SCOPE },
      );
      expect(sectionAttrs).toEqual({ section: 'sec-cards', scope: 'content' });
    });
  });

  it('falls back to the nearest direct child of <main> when no sectioning ancestor sits below it', async () => {
    await withPage(async (page) => {
      await stampBySelector(page, '#menu-btn', { elementId: 'e3', findingId: 'f3', signature: null, instanceIndex: null, productionType: 'button' });
      await stampBySelector(page, '#plain-link', { elementId: 'e4', findingId: 'f4', signature: null, instanceIndex: null, productionType: 'link' });

      const result = await locateAndStampSectionWrapper(page, 'sec-toolbar', 'excluded', ['e3', 'e4']);
      expect(result.located).toBe(true);
      expect(result.tagName).toBe('div'); // .toolbar — a direct child of <main>, never widened past it

      const scope = await page.locator('.toolbar').getAttribute(STAMP_ATTR_SCOPE);
      expect(scope).toBe('excluded');
    });
  });
});

describe('locateAndStampSectionWrapper — div-only sections under a shared page root', () => {
  const DIV_PAGE = `<!doctype html><body><div id="root">
    <div id="hero"><h1>Hero</h1><div class="row"><button id="a1">A1</button><button id="a2">A2</button></div></div>
    <div id="mid"><h2>Middle</h2><p>Copy</p><div class="box"><button id="m1">M1</button></div></div>
    <div id="ref"><h2>Reference</h2><p>Sub</p><div class="cards"><div class="card"><button id="r1">R1</button></div><div class="card"><button id="r2">R2</button></div></div></div>
  </div></body>`;
  const mark = (page: Page, pairs: Array<[string, string]>) =>
    page.evaluate(([attr, list]) => { for (const [sel, id] of list as Array<[string, string]>) document.querySelector(sel)!.setAttribute(attr as string, id); }, [STAMP_ATTR_ELEMENT, pairs] as const);

  it('stops at each section container instead of widening to the page root, and stamps every section', async () => {
    await withPage(async (page) => {
      await page.setContent(DIV_PAGE);
      await mark(page, [['#a1', 'e1'], ['#a2', 'e2'], ['#m1', 'e3'], ['#r1', 'e4'], ['#r2', 'e5']]);
      const hero = await locateAndStampSectionWrapper(page, 'hero', 'content', ['e1', 'e2'], ['e3', 'e4', 'e5']);
      const mid = await locateAndStampSectionWrapper(page, 'mid', 'content', ['e3'], ['e1', 'e2', 'e4', 'e5']);
      const ref = await locateAndStampSectionWrapper(page, 'ref', 'content', ['e4', 'e5'], ['e1', 'e2', 'e3']);
      expect([hero.located, mid.located, ref.located]).toEqual([true, true, true]);
      const stamps = await page.evaluate((attr) => Array.from(document.querySelectorAll(`[${attr}]`)).map((e) => `${e.id}=${e.getAttribute(attr)}`), STAMP_ATTR_SECTION);
      expect(stamps).toEqual(['hero=hero', 'mid=mid', 'ref=ref']);
    });
  });

  it('includes the section heading and copy that sit outside the members’ own common ancestor', async () => {
    await withPage(async (page) => {
      await page.setContent(DIV_PAGE);
      await mark(page, [['#a1', 'e1'], ['#m1', 'e3'], ['#r1', 'e4'], ['#r2', 'e5']]);
      await locateAndStampSectionWrapper(page, 'ref', 'content', ['e4', 'e5'], ['e1', 'e3']);
      const text = await page.locator(`[${STAMP_ATTR_SECTION}="ref"]`).innerText();
      expect(text).toContain('Reference');
      expect(text).toContain('Sub');
    });
  });

  it('never overwrites a stamp that another section already owns', async () => {
    await withPage(async (page) => {
      await page.setContent(DIV_PAGE);
      await mark(page, [['#a1', 'e1'], ['#m1', 'e3']]);
      await page.evaluate((attr) => document.querySelector('#hero .row')!.setAttribute(attr, 'someone-else'), STAMP_ATTR_SECTION);
      const result = await locateAndStampSectionWrapper(page, 'hero2', 'content', ['e1'], ['e3']);
      expect(result).toMatchObject({ located: false, conflictWith: 'someone-else' });
      expect(await page.locator('#hero .row').getAttribute(STAMP_ATTR_SECTION)).toBe('someone-else');
      expect(await page.locator('#a1').getAttribute(STAMP_ATTR_SECTION)).toBeNull();
    });
  });
});

describe('locateSectionByHeading — a section none of whose findings could be mapped', () => {
  const PAGE = `<!doctype html><body><header><h2>Our Header</h2></header><div id="root">
    <div id="hero"><h1>Hero</h1><div class="row"><button id="a1">A1</button></div></div>
    <div id="faq"><h2>FAQs</h2><div class="q"><h3>How do I know?</h3><p>Just tell us.</p></div></div>
    <section id="diff"><h2>Our Differentiators <span>What Distinguishes Us.</span></h2><p>We listen.</p></section>
  </div><footer><h2>FAQs</h2></footer></body>`;
  const stampedIds = (page: Page) => page.evaluate((attr) => Array.from(document.querySelectorAll(`[${attr}]`)).map((e) => `${e.tagName.toLowerCase()}#${e.id}=${e.getAttribute(attr)}`), STAMP_ATTR_SECTION);

  it('finds the wrapper from the heading text, without crossing into the mapped section, and leaves no stamp on the heading', async () => {
    await withPage(async (page) => {
      await page.setContent(PAGE);
      await page.evaluate(([el, sec]) => { document.querySelector('#a1')!.setAttribute(el!, 'e1'); document.querySelector('#hero')!.setAttribute(sec!, 'hero'); }, [STAMP_ATTR_ELEMENT, STAMP_ATTR_SECTION]);
      const faq = await locateSectionByHeading(page, 'faqs', 'FAQs', 'content', ['e1']);
      expect(faq).toMatchObject({ located: true, tagName: 'div', headingText: 'FAQs' });
      expect(await stampedIds(page)).toEqual(['div#hero=hero', 'div#faq=faqs']);
      expect(await page.locator(`[${STAMP_ATTR_ELEMENT}^="hs-"]`).count()).toBe(0);
      expect(await page.locator(`[${STAMP_ATTR_SECTION}="faqs"]`).innerText()).toContain('Just tell us.');
    });
  });

  it('matches a heading that holds the start of a longer section name, and a long name against its short heading, ignoring the trailing full stop', async () => {
    await withPage(async (page) => {
      await page.setContent(PAGE);
      const diff = await locateSectionByHeading(page, 'our-differentiators', 'Our Differentiators What Distinguishes Us.', 'content');
      expect(diff).toMatchObject({ located: true, tagName: 'section' });
      expect(await stampedIds(page)).toContain('section#diff=our-differentiators');
    });
  });

  it('ignores headings inside the header/footer and reports a section with no matching heading as not located', async () => {
    await withPage(async (page) => {
      await page.setContent(PAGE.replace('<div id="faq"><h2>FAQs</h2>', '<div id="faq"><h2>Frequently</h2>'));
      expect(await locateSectionByHeading(page, 'faqs', 'FAQs', 'content')).toEqual({ located: false, stamp: null, tagName: null, box: null });
      expect(await stampedIds(page)).toEqual([]);
    });
  });
});

describe('locateAndStampSectionWrapper — never stamps the document', () => {
  // REGRESSION (brand-perception-survey run): a header whose members (logo, menu) sit in different top-level blocks has no common ancestor below <body>;
  // the walk ended on <body> and stamped it as the excluded "header" section, which then structurally contained every content section.
  const PAGE = `<!doctype html><body><div id="logo-bar"><a id="logo" href="/">Logo</a></div><div id="menu-bar"><a id="menu" href="/x">Menu</a></div>
    <div id="content"><h2>Body</h2><button id="b1">B1</button></div></body>`;
  const mark = (page: Page, pairs: Array<[string, string]>) =>
    page.evaluate(([attr, list]) => { for (const [sel, id] of list as Array<[string, string]>) document.querySelector(sel)!.setAttribute(attr as string, id); }, [STAMP_ATTR_ELEMENT, pairs] as const);

  it('refuses <body> as a wrapper (documentRoot) and stamps nothing', async () => {
    await withPage(async (page) => {
      await page.setContent(PAGE);
      await mark(page, [['#logo', 'e1'], ['#menu', 'e2'], ['#b1', 'e3']]);
      const result = await locateAndStampSectionWrapper(page, 'header', 'excluded', ['e1', 'e2'], ['e3']);
      expect(result).toEqual({ located: false, stamp: null, tagName: null, box: null, documentRoot: true });
      expect(await page.locator('body').getAttribute(STAMP_ATTR_SECTION)).toBeNull();
      expect(await page.locator('html').getAttribute(STAMP_ATTR_SECTION)).toBeNull();
    });
  });

  it('a section whose members share a block below <body> is still stamped normally', async () => {
    await withPage(async (page) => {
      await page.setContent(PAGE);
      await mark(page, [['#logo', 'e1'], ['#menu', 'e2'], ['#b1', 'e3']]);
      const result = await locateAndStampSectionWrapper(page, 'content', 'content', ['e3'], ['e1', 'e2']);
      expect(result).toMatchObject({ located: true, tagName: 'div' });
      expect(await page.locator('#content').getAttribute(STAMP_ATTR_SECTION)).toBe('content');
    });
  });
});

describe('landmarkSaysGlobal', () => {
  it('identifies contentinfo (footer)', async () => {
    await withPage(async (page) => {
      await stampBySelector(page, '#footer-text', { elementId: 'e-footer', findingId: 'f-footer', signature: null, instanceIndex: null, productionType: 'text' });
      expect(await landmarkSaysGlobal(page, 'e-footer')).toBe('contentinfo');
    });
  });

  it('identifies banner (header content outside any nav)', async () => {
    await withPage(async (page) => {
      await stampBySelector(page, '#logo', { elementId: 'e-logo', findingId: 'f-logo', signature: null, instanceIndex: null, productionType: 'text' });
      expect(await landmarkSaysGlobal(page, 'e-logo')).toBe('banner');
    });
  });

  it('identifies nav-in-banner for a nav nested inside the header', async () => {
    await withPage(async (page) => {
      await stampBySelector(page, '#nav-link', { elementId: 'e-nav', findingId: 'f-nav', signature: null, instanceIndex: null, productionType: 'link' });
      expect(await landmarkSaysGlobal(page, 'e-nav')).toBe('nav-in-banner');
    });
  });

  it('returns null for content outside any landmark, and null for an unknown element id', async () => {
    await withPage(async (page) => {
      await stampBySelector(page, '#buy-btn', { elementId: 'e-buy', findingId: 'f-buy', signature: null, instanceIndex: null, productionType: 'button' });
      expect(await landmarkSaysGlobal(page, 'e-buy')).toBeNull();
      expect(await landmarkSaysGlobal(page, 'never-stamped')).toBeNull();
    });
  });
});

describe('computeCaptureFingerprint', () => {
  it('is stable across two reads of the unchanged page', async () => {
    await withPage(async (page) => {
      const policy = pool.renderingPolicy();
      const first = await computeCaptureFingerprint(page, policy);
      const second = await computeCaptureFingerprint(page, policy);
      expect(second.domHash).toBe(first.domHash);
      expect(second.stylesheets).toEqual(first.stylesheets);
      expect(second.renderingPolicyHash).toBe(first.renderingPolicyHash);
    });
  });

  it('changes the stylesheet hash (not necessarily the DOM hash) after a stylesheet is mutated via CSSOM', async () => {
    await withPage(async (page) => {
      const policy = pool.renderingPolicy();
      const before = await computeCaptureFingerprint(page, policy);
      await page.evaluate(() => {
        const style = document.getElementById('page-style') as HTMLStyleElement;
        style.sheet!.insertRule('body { color: red; }', style.sheet!.cssRules.length);
      });
      const after = await computeCaptureFingerprint(page, policy);
      expect(after.stylesheets).not.toEqual(before.stylesheets);
      expect(after.domHash).toBe(before.domHash); // CSSOM insertRule doesn't touch the <style> tag's serialized text
    });
  });

  it('changes the DOM hash after the DOM itself is mutated', async () => {
    await withPage(async (page) => {
      const policy = pool.renderingPolicy();
      const before = await computeCaptureFingerprint(page, policy);
      await page.evaluate(() => document.body.setAttribute('data-mutated', '1'));
      const after = await computeCaptureFingerprint(page, policy);
      expect(after.domHash).not.toBe(before.domHash);
    });
  });
});

describe('locateAndStampSectionWrapper — members rendered inside another section', () => {
  // REGRESSION (brand-perception run): two audit elements attributed to "Our Resources" are <li>s of an FAQ answer; their common ancestor with the real Our Resources
  // elements was the page container, which already held the FAQs — so the section got "no wrapper of its own" and was dropped from the preview.
  const PAGE = `<!doctype html><body><div id="root">
    <div id="faqs"><h2>FAQs</h2><ul><li id="stray1">Segment-wise perception scores</li><li id="stray2">Recommended actions</li></ul><button id="f1">Q1</button></div>
    <div id="resources"><h2 id="r0">Our Resources</h2><a id="r1">View More</a><button id="r2">All</button><button id="r3">Blogs</button><button id="r4">Articles</button><p id="r5">card</p><p id="r6">card</p><p id="r7">card</p><p id="r8">card</p><p id="r9">card</p><p id="r10">card</p><p id="r11">card</p><p id="r12">card</p><p id="r13">card</p><p id="r14">card</p><p id="r15">card</p><p id="r16">card</p><p id="r17">card</p><p id="r18">card</p><p id="r19">card</p><p id="r20">card</p></div>
    <div id="explore"><h2>Explore</h2><button id="x1">X</button></div>
  </div></body>`;
  const mark = (page: Page, pairs: Array<[string, string]>) =>
    page.evaluate(([attr, list]) => { for (const [sel, id] of list as Array<[string, string]>) document.querySelector(sel)!.setAttribute(attr as string, id); }, [STAMP_ATTR_ELEMENT, pairs] as const);
  const resourceIds = ['#r0', '#r1', '#r2', '#r3', '#r4', '#r5', '#r6', '#r7', '#r8', '#r9', '#r10', '#r11', '#r12', '#r13', '#r14', '#r15', '#r16', '#r17', '#r18', '#r19', '#r20'];

  it('sets the outliers aside, stamps the section\'s own wrapper, and reports them', async () => {
    await withPage(async (page) => {
      await page.setContent(PAGE);
      await mark(page, [['#stray1', 's1'], ['#stray2', 's2'], ['#f1', 'e-f'], ['#x1', 'e-x'], ...resourceIds.map((sel, i): [string, string] => [sel, `r${i}`])]);
      // the FAQs wrapper is stamped first (as C2 does for the sections that come earlier in the page)
      await page.evaluate((attr) => document.querySelector('#faqs')!.setAttribute(attr, 'faqs'), STAMP_ATTR_SECTION);
      const members = ['s1', 's2', ...resourceIds.map((_s, i) => `r${i}`)];
      const result = await locateAndStampSectionWrapper(page, 'our-resources', 'content', members, ['e-f', 'e-x']);
      expect(result).toMatchObject({ located: true, tagName: 'div' });
      expect(await page.locator('#resources').getAttribute(STAMP_ATTR_SECTION)).toBe('our-resources');
      expect(await page.locator('#faqs').getAttribute(STAMP_ATTR_SECTION)).toBe('faqs');
      expect(new Set(result.outliers)).toEqual(new Set(['s1', 's2']));
    });
  });

  it('a section with a genuine conflict and no outliers to set aside is still refused', async () => {
    await withPage(async (page) => {
      await page.setContent(PAGE);
      await mark(page, [['#stray1', 's1'], ['#r1', 'm1']]);
      await page.evaluate((attr) => document.querySelector('#faqs')!.setAttribute(attr, 'faqs'), STAMP_ATTR_SECTION);
      const result = await locateAndStampSectionWrapper(page, 'mixed', 'content', ['s1', 'm1']);
      expect(result.located).toBe(false);
    });
  });
});

describe('locateAndStampSectionWrapper — many members rendered in neighbouring sections', () => {
  // REGRESSION (brand-perception run, second cause): the audit also attributed a NEIGHBOUR's card headings to "Our Resources" — more than a handful of strays.
  const cards = Array.from({ length: 24 }, (_v, i) => `<p id="c${i}">card ${i}</p>`).join('');
  const PAGE = `<!doctype html><body><div id="root">
    <div id="faqs"><h2>FAQs</h2><li id="f1">a</li><li id="f2">b</li></div>
    <div id="resources"><h2 id="r0">Our Resources</h2>${cards}</div>
    <div id="explore"><h2 id="x0">Explore</h2><h3 id="x1">Employee</h3><h3 id="x2">Customer</h3><h3 id="x3">Dealer</h3><button id="x4">Go</button></div>
  </div></body>`;
  const mark = (page: Page, pairs: Array<[string, string]>) =>
    page.evaluate(([attr, list]) => { for (const [sel, id] of list as Array<[string, string]>) document.querySelector(sel)!.setAttribute(attr as string, id); }, [STAMP_ATTR_ELEMENT, pairs] as const);

  it('takes the majority cluster as the section and reports the 6 strays', async () => {
    await withPage(async (page) => {
      await page.setContent(PAGE);
      const mine: Array<[string, string]> = [['#r0', 'm0'], ...Array.from({ length: 24 }, (_v, i): [string, string] => [`#c${i}`, `m${i + 1}`]), ['#f1', 's1'], ['#f2', 's2'], ['#x1', 's3'], ['#x2', 's4'], ['#x3', 's5'], ['#x4', 's6']];
      await mark(page, [...mine, ['#x0', 'e-x']]);
      await page.evaluate((attr) => { document.querySelector('#faqs')!.setAttribute(attr, 'faqs'); document.querySelector('#explore')!.setAttribute(attr, 'explore'); }, STAMP_ATTR_SECTION);
      const result = await locateAndStampSectionWrapper(page, 'our-resources', 'content', mine.map(([, id]) => id), ['e-x']);
      expect(result).toMatchObject({ located: true, tagName: 'div' });
      expect(new Set(result.outliers)).toEqual(new Set(['s1', 's2', 's3', 's4', 's5', 's6']));
      expect(await page.locator('#resources').getAttribute(STAMP_ATTR_SECTION)).toBe('our-resources');
    });
  });
});
