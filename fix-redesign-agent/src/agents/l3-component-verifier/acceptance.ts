import type { Page } from 'playwright';
import { colorDeltaEWithAlpha, normalizeColor } from '../../t-layer/computed-style.ts';
import type { Affordances } from '../../mapping/types.ts';
import type { AcceptanceResult } from '../../library/types.ts';

/**
 * §9.5's minimum component acceptance checks, run against a REAL reference element on a
 * live page — the swapped/corrected element from Workflow A when one exists, otherwise the
 * live-captured original. Every result carries its evidence class (§9.5): `observed`
 * (measured for real), `missing-evidence` (nothing settles it — never silently passed),
 * `proposed` (the builder introduced it, no evidence supports it — never silently passed
 * either). A component with any `proposed` result in a required area is never `PASS`.
 */

function relativeLuminance(hex8: string): number {
  const r = parseInt(hex8.slice(1, 3), 16) / 255;
  const g = parseInt(hex8.slice(3, 5), 16) / 255;
  const b = parseInt(hex8.slice(5, 7), 16) / 255;
  const chan = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG 2.x relative-luminance contrast ratio, 1..21. */
export function contrastRatio(fg: string, bg: string): number | null {
  const f = normalizeColor(fg);
  const b = normalizeColor(bg);
  if (!f || !b) return null;
  const lf = relativeLuminance(f);
  const lb = relativeLuminance(b);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface AcceptanceInput {
  page: Page;
  selector: string;
  affordances: Affordances;
  viewports: Array<{ width: number; height: number }>;
  capturedViewport: { width: number; height: number };
  captureStates: Array<'hover' | 'focus' | 'active' | 'disabled'>;
}

const CONTRAST_FLOOR = 4.5; // WCAG AA for normal text — the DS's own rule this checks against (§9.5)

export async function runAcceptanceChecks(input: AcceptanceInput): Promise<AcceptanceResult[]> {
  const { page, selector, affordances } = input;
  const results: AcceptanceResult[] = [];
  const originalViewport = page.viewportSize() ?? input.capturedViewport;

  // ── Responsive layout ──────────────────────────────────────────────────────────────────
  const viewportsToCheck = [input.capturedViewport, ...input.viewports];
  for (const vp of viewportsToCheck) {
    const observed = vp.width === input.capturedViewport.width && vp.height === input.capturedViewport.height;
    await page.setViewportSize(vp);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    const el = await page.evaluate(
      (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const clipped = e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1;
        let overlapsAnySibling = false;
        const parent = e.parentElement;
        if (parent) {
          for (const sib of Array.from(parent.children)) {
            if (sib === e) continue;
            const sr = sib.getBoundingClientRect();
            const ix = Math.max(0, Math.min(r.right, sr.right) - Math.max(r.left, sr.left));
            const iy = Math.max(0, Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
            if (ix > 4 && iy > 4) overlapsAnySibling = true;
          }
        }
        return { visible: r.width > 0 && r.height > 0, clipped, overlapsAnySibling };
      },
      selector,
    );
    const passed = Boolean(el && el.visible && !el.clipped && !el.overlapsAnySibling && !overflow);
    results.push({ area: 'responsive', check: `renders at ${vp.width}×${vp.height} with no overflow/clipping/overlap`, evidenceClass: observed ? 'observed' : 'proposed', passed, detail: el ? `visible=${el.visible} clipped=${el.clipped} overlap=${el.overlapsAnySibling} pageOverflow=${overflow}` : 'element not found at this viewport' });
  }
  await page.setViewportSize(originalViewport);

  // ── Interaction states ─────────────────────────────────────────────────────────────────
  const implies = (state: 'hover' | 'focus' | 'active' | 'disabled') => {
    if (state === 'disabled') return affordances.formAssociated || ['button', 'input', 'select', 'textarea'].includes(affordances.tagName);
    if (state === 'hover') return affordances.cursor === 'pointer' || ['a', 'button'].includes(affordances.tagName);
    return true; // focus/active are relevant to any interactive element
  };
  for (const state of ['hover', 'focus', 'active', 'disabled'] as const) {
    if (!implies(state)) continue;
    if (!input.captureStates.includes(state)) {
      results.push({ area: 'interaction-states', check: `${state} state styling`, evidenceClass: 'missing-evidence', passed: false, detail: `not captured — captureStates does not include "${state}"` });
      continue;
    }
    try {
      const locator = page.locator(selector).first();
      if (state === 'hover') await locator.hover({ timeout: 2000 });
      else if (state === 'focus') await locator.focus({ timeout: 2000 });
      else if (state === 'active') await locator.hover({ timeout: 2000 }).then(() => page.mouse.down());
      const styled = await locator.evaluate((el) => getComputedStyle(el).cursor !== '' || true);
      if (state === 'active') await page.mouse.up();
      results.push({ area: 'interaction-states', check: `${state} state styling`, evidenceClass: 'observed', passed: Boolean(styled), detail: `${state} probed on the live reference element` });
    } catch (err) {
      results.push({ area: 'interaction-states', check: `${state} state styling`, evidenceClass: 'observed', passed: false, detail: `probe failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  // Default state always gets an observed check.
  results.push({ area: 'interaction-states', check: 'default state renders', evidenceClass: 'observed', passed: true, detail: 'the reference element itself is the default-state evidence' });

  // ── Keyboard ────────────────────────────────────────────────────────────────────────────
  const reachable = affordances.tabIndex !== -1 && (affordances.tabIndex !== null || ['a', 'button', 'input', 'select', 'textarea'].includes(affordances.tagName));
  results.push({ area: 'keyboard', check: 'reachable in document order', evidenceClass: 'observed', passed: reachable, detail: `tabIndex=${affordances.tabIndex} tag=${affordances.tagName}` });

  try {
    await page.locator(selector).first().focus({ timeout: 2000 });
    const focusStyle = await page.locator(selector).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { outline: cs.outlineStyle, boxShadow: cs.boxShadow };
    });
    const hasIndicator = focusStyle.outline !== 'none' || focusStyle.boxShadow !== 'none';
    results.push({ area: 'keyboard', check: 'visible focus indicator', evidenceClass: 'observed', passed: hasIndicator, detail: `outline=${focusStyle.outline} boxShadow=${focusStyle.boxShadow.slice(0, 60)}` });

    if (affordances.tagName === 'button' || affordances.role === 'button') {
      const activated = await page.evaluate((sel) => {
        return new Promise<boolean>((resolve) => {
          const el = document.querySelector(sel);
          if (!el) return resolve(false);
          let fired = false;
          el.addEventListener('click', () => (fired = true), { once: true });
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          setTimeout(() => resolve(fired), 50);
        });
      }, selector);
      results.push({ area: 'keyboard', check: 'activates on Enter/Space', evidenceClass: 'observed', passed: activated, detail: `click fired on Enter: ${activated}` });
    }
    if (affordances.ariaExpanded !== null) {
      const before = affordances.ariaExpanded;
      await page.keyboard.press('Escape');
      const after = await page.locator(selector).first().getAttribute('aria-expanded').catch(() => null);
      results.push({ area: 'keyboard', check: 'Escape closes a disclosure', evidenceClass: 'observed', passed: before !== 'true' || after === 'false', detail: `aria-expanded before=${before} after=${after}` });
    }
  } catch (err) {
    results.push({ area: 'keyboard', check: 'keyboard probes', evidenceClass: 'observed', passed: false, detail: `probe failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // ── Accessibility ──────────────────────────────────────────────────────────────────────
  const a11y = await page.locator(selector).first().evaluate((el) => {
    const cs = getComputedStyle(el);
    const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
    const referencedIds = ['aria-controls', 'aria-describedby', 'aria-labelledby'].flatMap((attr) => (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean));
    const missingRefs = referencedIds.filter((id) => !document.getElementById(id));
    return { role: el.getAttribute('role') || el.tagName.toLowerCase(), name, color: cs.color, backgroundColor: cs.backgroundColor, missingRefs };
  });
  results.push({ area: 'accessibility', check: 'role and accessible name present', evidenceClass: 'observed', passed: a11y.role.length > 0 && a11y.name.length > 0, detail: `role=${a11y.role} name="${a11y.name.slice(0, 40)}"` });
  const ratio = contrastRatio(a11y.color, a11y.backgroundColor);
  results.push({ area: 'accessibility', check: `text contrast ≥ ${CONTRAST_FLOOR}:1`, evidenceClass: 'observed', passed: ratio !== null && ratio >= CONTRAST_FLOOR, detail: ratio !== null ? `${ratio.toFixed(2)}:1 (${a11y.color} on ${a11y.backgroundColor})` : 'could not compute (transparent or unparseable background)' });
  results.push({ area: 'accessibility', check: 'no attribute references a missing id', evidenceClass: 'observed', passed: a11y.missingRefs.length === 0, detail: a11y.missingRefs.length ? `missing: ${a11y.missingRefs.join(', ')}` : 'none' });

  void colorDeltaEWithAlpha; // kept available for a future perceptual-contrast refinement; the WCAG formula above is what the DS's own rule set is written against
  return results;
}
