import type { Page } from 'playwright';
import { expandSafely, findDisclosureCandidates } from '../../t-layer/disclosure.ts';
import type { PageObserver } from '../../t-layer/render-settled.ts';
import { CAROUSEL_SELECTOR, type RawManifestItem } from './manifest.ts';

/**
 * B7's TARGETED STATE PASS. Content that is not painted in the default capture — a hover layer, a scroll-in
 * reveal, an accordion or tab panel behind its control, a carousel slide — is still meaningful content, so
 * B7 does not wave it through: it reveals it, hands the revealed element to the NORMAL audit flow (B2 → B3 →
 * B4 | B6) while it is shown, and puts the page back as it found it.
 *
 * Every interaction is the least invasive one that can work, tried in this order, and every one is bounded:
 *   scroll the item into view (a scroll-in animation)  →  hover its host (a hover layer)  →
 *   open its disclosure / select its tab through the SAME safety predicate B1 uses (never a form submit, a
 *   download, a link to another page)  →  advance its carousel with the carousel's own "next" control.
 * What nothing reveals is reported, never guessed at.
 */

/**
 * `reapply` puts a reveal back after something closed it (capturing the next member of the same hover layer scrolls
 * the page under the pointer) — B7 reveals a LAYER once and captures every member of it while it is open.
 */
export type RevealOutcome = { ok: true; how: string; restore: () => Promise<void>; reapply?: () => Promise<void> } | { ok: false; reason: string };

/** Is the element painted right now: not display:none, visible, effectively opaque and larger than a sr-only sliver? */
export async function isShown(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      let opacity = 1;
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none') return false;
        opacity *= Number.parseFloat(cs.opacity);
      }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return opacity > 0.5 && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && r.width > 2 && r.height > 2;
    }, undefined, QUICK)
    .catch(() => false);
}

const NEXT_CONTROLS = '[aria-label*="next" i],.swiper-button-next,.slick-next,.splide__arrow--next,.embla__button--next,[data-slide="next"],[data-carousel-next]';
const SETTLE_MS = 350;
/** A selector that no longer resolves must cost milliseconds, not Playwright's 30 s default — a stale one fails fast and is reported. */
const QUICK = { timeout: 1_500 } as const;

interface PointerHit { how: string; restore: () => Promise<void>; reapply: () => Promise<void> }

/**
 * Opens the layer behind `hostSelector` the way a visitor does and says which way worked. Hover only moves a pointer and
 * focus only focuses — neither can submit, download or navigate. Each way is tried once, cheaply; a layer none of them
 * opens (one only a click opens) is reported, not guessed at.
 */
async function revealByPointer(page: Page, hostSelector: string, selector: string): Promise<PointerHit | null> {
  const points = await page
    .locator(hostSelector)
    .first()
    .evaluate((host) => {
      host.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number.parseFloat(cs.opacity) > 0.5;
      };
      const out: Array<{ how: string; x: number; y: number }> = [];
      // a point counts only where the pointer would really land inside the element — a layer that ignores pointer events lets it fall through
      const consider = (how: string, el: Element | null) => {
        if (!el || !shown(el)) return;
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return;
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit)) out.push({ how, x, y });
      };
      consider('hovered its trigger', host);
      const controls = 'a[href],button,[role="button"],[role="menuitem"],[aria-haspopup],[aria-expanded],summary';
      for (const el of Array.from(host.querySelectorAll(controls)).slice(0, 12)) {
        if (out.length >= 3) break;
        consider('hovered a control inside its trigger', el);
      }
      consider('hovered its trigger’s parent', host.parentElement);
      return out;
    }, undefined, QUICK)
    .catch(() => [] as Array<{ how: string; x: number; y: number }>);

  const enter = async (x: number, y: number) => {
    await page.mouse.move(0, 0);
    await page.mouse.move(x, y, { steps: 4 });
  };
  for (const point of points) {
    await enter(point.x, point.y);
    await page.waitForTimeout(SETTLE_MS);
    if (await isShown(page, selector)) {
      return {
        how: point.how,
        restore: async () => { await page.mouse.move(0, 0); },
        reapply: async () => { await enter(point.x, point.y); await page.waitForTimeout(150); },
      };
    }
  }
  // keyboard: a layer that opens on :focus-within / focus
  const focused = await page
    .locator(hostSelector)
    .first()
    .evaluate((host) => {
      const target = host.querySelector('a[href],button,[role="button"],[role="menuitem"],[aria-haspopup],[aria-expanded],summary,input,[tabindex]') as HTMLElement | null;
      if (!target) return false;
      target.setAttribute('data-audit-b7-focus', '1');
      target.focus({ preventScroll: true });
      return document.activeElement === target;
    }, undefined, QUICK)
    .catch(() => false);
  if (focused) {
    await page.waitForTimeout(SETTLE_MS);
    const unfocus = async () => { await page.evaluate(() => { (document.querySelector('[data-audit-b7-focus]') as HTMLElement | null)?.blur(); document.querySelectorAll('[data-audit-b7-focus]').forEach((e) => e.removeAttribute('data-audit-b7-focus')); }).catch(() => {}); };
    if (await isShown(page, selector)) {
      return { how: 'focused a control in its trigger', restore: unfocus, reapply: async () => { await page.evaluate(() => (document.querySelector('[data-audit-b7-focus]') as HTMLElement | null)?.focus({ preventScroll: true })).catch(() => {}); await page.waitForTimeout(150); } };
    }
    await unfocus();
  }
  return null;
}

export async function revealItem(page: Page, observer: PageObserver, url: string, item: RawManifestItem): Promise<RevealOutcome> {
  const selector = `[data-audit-b7="${item.id}"]`;
  const noop = async () => {};
  try {
    if ((await page.locator(selector).count()) !== 1) return { ok: false, reason: 'the element is no longer on the page' };
    if (await isShown(page, selector)) return { ok: true, how: 'already shown', restore: noop };

    // 1. A scroll-in reveal (IntersectionObserver fade-ins).
    await page.locator(selector).first().evaluate((el) => (el.parentElement ?? el).scrollIntoView({ block: 'center' }), undefined, QUICK).catch(() => {});
    await page.waitForTimeout(SETTLE_MS + 250);
    if (await isShown(page, selector)) return { ok: true, how: 'scrolled into view', restore: async () => { await page.evaluate(() => window.scrollTo(0, 0)); } };

    // 2. A hover layer: the TRIGGER (the visible parent of the layer whose opacity hides it), a control inside it, its
    //    own parent — wherever a pointer would really land on them — and keyboard focus, the twin of hover.
    if (item.reveal.kind === 'hover' && item.reveal.hostSelector) {
      const opened = await revealByPointer(page, item.reveal.hostSelector, selector);
      if (opened) return { ok: true, how: opened.how, restore: opened.restore, reapply: opened.reapply };
      await page.mouse.move(0, 0);
    }

    // 3. A disclosure or a tab, through B1's safety predicate — never a click that could submit, download or navigate.
    if ((item.reveal.kind === 'accordion' || item.reveal.kind === 'tab-panel') && item.reveal.controlSelector) {
      const wasSelected = await page
        .locator(item.reveal.controlSelector)
        .first()
        .evaluate((trigger) => {
          const list = trigger.closest('[role="tablist"]');
          const current = list?.querySelector('[role="tab"][aria-selected="true"]');
          if (current && !current.hasAttribute('data-audit-b7-prev')) current.setAttribute('data-audit-b7-prev', '1');
          return Boolean(current);
        }, undefined, QUICK)
        .catch(() => false);
      const candidates = await findDisclosureCandidates(page);
      const marked = await page.locator(item.reveal.controlSelector).first().evaluate((el) => el.getAttribute('data-audit-disclosure'), undefined, QUICK).catch(() => null);
      const candidate = candidates.find((c) => c.id === marked);
      if (!candidate) return { ok: false, reason: 'its control is not a disclosure B7 may operate (no safe expand/select action was found)' };
      const outcome = await expandSafely(page, observer, candidate, url);
      if (!outcome.expanded) return { ok: false, reason: `its control could not be operated safely: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}` };
      await page.waitForTimeout(SETTLE_MS);
      if (await isShown(page, selector)) {
        return {
          ok: true,
          how: item.reveal.kind === 'tab-panel' ? 'selected its tab' : 'opened its disclosure',
          // a tab is mutually exclusive: put the originally selected one back
          restore: async () => {
            if (!wasSelected) return;
            await page.locator('[data-audit-b7-prev="1"]').first().click({ timeout: 1_500 }).catch(() => {});
            await page.evaluate(() => document.querySelectorAll('[data-audit-b7-prev]').forEach((e) => e.removeAttribute('data-audit-b7-prev')));
          },
        };
      }
    }

    // 4. A carousel: ITS OWN "next" control (the nearest one around the item — never the first on the page), judged by
    //    the same safety predicate as step 3 (never a "next page" link, a form step that submits, a download or
    //    anything that leaves the page) and operated by the same safe click, a few times at most.
    let carouselNote = '';
    if (item.reveal.kind === 'carousel' || item.where.includes('carousel')) {
      const found = await page
        .locator(selector)
        .first()
        .evaluate((el, sels) => {
          document.querySelectorAll('[data-audit-carousel-next]').forEach((e) => e.removeAttribute('data-audit-carousel-next'));
          // the OUTERMOST carousel-marked ancestor is the carousel itself (a slide sits inside it); its arrows are inside it or just outside the track
          let root: Element | null = null;
          for (let n: Element | null = el; n; n = n.parentElement) if (n.matches(sels.carousel)) root = n;
          const next = root?.querySelector(sels.next) ?? root?.parentElement?.querySelector(sels.next) ?? null;
          if (!next) return false;
          next.setAttribute('data-audit-carousel-next', '1');
          return true;
        }, { carousel: CAROUSEL_SELECTOR, next: NEXT_CONTROLS }, QUICK)
        .catch(() => false);
      if (!found) carouselNote = 'the carousel has no "next" control B7 recognises';
      else {
        const candidate = (await findDisclosureCandidates(page, { carouselNext: '[data-audit-carousel-next="1"]' })).find((c) => c.kind === 'carousel-next');
        if (!candidate) carouselNote = 'the carousel\'s "next" control could not be read';
        else if (!candidate.safe) carouselNote = `its carousel's "next" control is not safe to operate (${candidate.unsafeReason ?? 'unsafe'})`;
        else {
          for (let i = 0; i < 8; i++) {
            const outcome = await expandSafely(page, observer, candidate, url, { networkCapMs: 1_500, domCapMs: 1_000 });
            if (!outcome.expanded) {
              carouselNote = `the carousel's "next" control stopped working after ${i} click(s): ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}`;
              break;
            }
            await page.waitForTimeout(SETTLE_MS);
            if (await isShown(page, selector)) return { ok: true, how: `advanced the carousel ${i + 1}×`, restore: noop };
          }
        }
      }
    }
    return { ok: false, reason: `nothing revealed it: scroll${item.reveal.kind === 'hover' ? ', hover (its trigger, a control inside it, its parent) and keyboard focus' : ''}${item.reveal.kind === 'accordion' || item.reveal.kind === 'tab-panel' ? ', its disclosure control' : ''}${item.where.includes('carousel') ? ' and the carousel controls' : ''} were tried${carouselNote ? ` — ${carouselNote}` : ''}` };
  } catch (err) {
    return { ok: false, reason: `the interaction failed (${err instanceof Error ? (err.message.split('\n')[0] ?? '').slice(0, 100) : 'unknown'})` };
  }
}

/**
 * Scrolls the whole page once, top to bottom, so every scroll-triggered reveal has fired before the manifest
 * is read — and back to the top (the audit's boxes are page-absolute and its snapshot was taken at scroll 0).
 * Bounded: at most `maxSteps` steps.
 */
export async function scrollThrough(page: Page, maxSteps = 40): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
  const view = page.viewportSize()?.height ?? 900;
  const steps = Math.min(maxSteps, Math.ceil(height / Math.max(view * 0.8, 1)));
  for (let i = 1; i <= steps; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(i * view * 0.8)).catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(150);
}
