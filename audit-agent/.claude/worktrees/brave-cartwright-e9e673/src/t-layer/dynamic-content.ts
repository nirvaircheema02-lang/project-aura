import type { Locator, Page } from 'playwright';

/**
 * ARCHITECTURE.md §2.7 dynamic-content settling. Primary safeguard is
 * confidence-flagging, not waiting — validated: scroll-into-view + a real
 * scroll + 3 s wait did NOT make a real count-up counter leave its "0+"
 * placeholder. So this is a bounded best-effort first pass; anything still
 * matching the placeholder signature afterwards must be routed as LOW
 * confidence via S8 (the caller's job, B1/B4), never reported as a real
 * compliance measurement and never silently discarded.
 */

/** Covers the validated signatures "0+", "$0Mn", "0%" plus close variants (₹0Cr, 0x, 0.0K…). */
export const PLACEHOLDER_VALUE = /^(?:[$₹€£]?\s*0(?:[.,]0+)?)\s*(?:\+|%|[KMB]n?|Mn|Bn|Cr|x)?$/i;

export function isPlaceholderValue(text: string): boolean {
  return PLACEHOLDER_VALUE.test(text.trim());
}

export interface SettleOutcome {
  /** Text when the candidate was first detected — may differ from `before` if an earlier candidate's scroll already started its animation. */
  detectedAs?: string;
  before: string;
  /** The STABLE value (unchanged for `stableMs`) — a count-up's first change is only an intermediate frame. */
  after: string;
  /** Relative to `before`, NOT `detectedAs` — false for a neighbour already animated by an earlier candidate's scroll. Use `stillPlaceholder` for routing. */
  changed: boolean;
  /** False when the value was still changing at the timeout — `after` is then a mid-animation frame, not final. */
  stabilized: boolean;
  /** True when the value still looks like a placeholder after settling — caller must flag LOW confidence. */
  stillPlaceholder: boolean;
}

/**
 * v0 → scroll into view → REAL wheel events (a dispatched synthetic 'scroll'
 * event neither moves the scroll position nor re-runs IntersectionObserver)
 * → bounded wait for finite animations → poll until the value is STABLE.
 *
 * Live evidence (2026-09-11, 4 real templates): with real wheel events the
 * count-up counters DO animate to their real values ("0+" → "80+", "$140Mn" →
 * "$290Mn") — contradicting VALIDATION-NOTES' finding, whose test dispatched
 * a synthetic scroll event (ineffective, as above). Flagging persistent
 * placeholders LOW via S8 remains the backstop, unchanged.
 */
export async function settleAndRecheck(page: Page, locator: Locator, timeoutMs = 4_000, stableMs = 750): Promise<SettleOutcome> {
  const before = ((await locator.textContent()) ?? '').trim();
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.mouse.wheel(0, 200);
  await page.mouse.wheel(0, -200);
  await locator
    .evaluate(
      (el, ms) =>
        Promise.race([
          Promise.all(
            el
              .getAnimations({ subtree: true })
              .filter((a) => {
                const t = a.effect?.getComputedTiming();
                return t ? Number.isFinite(t.endTime as number) : false; // infinite animations never finish
              })
              .map((a) => a.finished.catch(() => undefined)),
          ),
          new Promise((r) => setTimeout(r, ms)),
        ]),
      timeoutMs,
    )
    .catch(() => {});

  // Poll until the value has been unchanged for `stableMs` (or the deadline).
  // An unchanged-from-the-start value also counts as stable once `stableMs`
  // passes AFTER the settle attempt — a persistent placeholder is stable too.
  const deadline = Date.now() + timeoutMs;
  let after = before;
  let lastChangeAt = Date.now();
  let stabilized = false;
  while (Date.now() < deadline) {
    const now = ((await locator.textContent()) ?? '').trim();
    if (now !== after) {
      after = now;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= stableMs && (after !== before || Date.now() - lastChangeAt >= stableMs * 2)) {
      stabilized = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { before, after, changed: after !== before, stabilized, stillPlaceholder: isPlaceholderValue(after) };
}

/**
 * Finds short, numeric-looking leaf text nodes currently showing a
 * placeholder value — candidates for settleAndRecheck. Returns stamped
 * `data-audit-placeholder` ids so the caller can address each one.
 */
export async function findPlaceholderCandidates(page: Page): Promise<Array<{ id: string; text: string }>> {
  return page.evaluate((source) => {
    const re = new RegExp(source, 'i');
    const out: Array<{ id: string; text: string }> = [];
    let n = 0;
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (el.children.length > 0) continue;
      const text = (el.textContent ?? '').trim();
      if (text.length === 0 || text.length > 12 || !re.test(text)) continue;
      const id = `ph${n++}`;
      el.setAttribute('data-audit-placeholder', id);
      out.push({ id, text });
    }
    return out;
  }, PLACEHOLDER_VALUE.source);
}
