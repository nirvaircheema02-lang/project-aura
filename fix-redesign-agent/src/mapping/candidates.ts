import type { Page } from 'playwright';
import type { Box } from './types.ts';

/** A live DOM element found near an evidence box, with everything the objective checks need. */
export interface LiveCandidate {
  candidateId: string;
  tagName: string;
  role: string | null;
  text: string;
  classes: string[];
  box: Box;
  href: string | null;
  type: string | null;
  tabIndex: number | null;
  ariaExpanded: string | null;
  ariaControls: string | null;
  ariaHaspopup: string | null;
  disabled: boolean;
  cursor: string | null;
  formAssociated: boolean;
}

function hitTestInPage(box: Box): LiveCandidate[] {
  const points = [
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + Math.min(4, box.width * 0.15), y: box.y + Math.min(4, box.height * 0.15) },
    { x: box.x + box.width - Math.min(4, box.width * 0.15), y: box.y + Math.min(4, box.height * 0.15) },
    { x: box.x + Math.min(4, box.width * 0.15), y: box.y + box.height - Math.min(4, box.height * 0.15) },
    { x: box.x + box.width - Math.min(4, box.width * 0.15), y: box.y + box.height - Math.min(4, box.height * 0.15) },
  ];
  const seen = new Set<Element>();
  const out: LiveCandidate[] = [];
  const skip = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE']);
  for (const p of points) {
    const vx = p.x - window.scrollX;
    const vy = p.y - window.scrollY;
    if (vx < 0 || vy < 0 || vx > window.innerWidth || vy > window.innerHeight) continue;
    const stack = document.elementsFromPoint(vx, vy);
    for (const el of stack) {
      if (seen.has(el) || skip.has(el.tagName)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cs = getComputedStyle(el);
      out.push({
        candidateId: 'cand-' + out.length,
        tagName: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
        classes: Array.from(el.classList),
        box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
        href: el.getAttribute('href'),
        type: el.getAttribute('type'),
        tabIndex: el.hasAttribute('tabindex') ? Number(el.getAttribute('tabindex')) : el instanceof HTMLElement ? el.tabIndex : null,
        ariaExpanded: el.getAttribute('aria-expanded'),
        ariaControls: el.getAttribute('aria-controls'),
        ariaHaspopup: el.getAttribute('aria-haspopup'),
        disabled: 'disabled' in el ? Boolean((el as unknown as { disabled: unknown }).disabled) : el.getAttribute('aria-disabled') === 'true',
        cursor: cs.cursor || null,
        formAssociated: Boolean(el.closest('form')),
      });
    }
  }
  return out;
}

/**
 * Scrolls the given page-absolute box into view (with a small margin so it isn't flush
 * against the viewport edge, where `elementsFromPoint` is least reliable), settles briefly,
 * then hit-tests at its center and four inset corners. Discovery mode: broad, for scoring by
 * the objective checks in `objective-checks.ts` — NOT a precise re-locate (see `stamp.ts` for
 * that, once a winning candidate's own box is already known).
 */
export async function findCandidateElements(page: Page, box: Box): Promise<LiveCandidate[]> {
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 200)), box.y);
  await page.waitForTimeout(60);
  return page.evaluate(hitTestInPage, box);
}
