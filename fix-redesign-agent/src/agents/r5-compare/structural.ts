import type { BrowserContext, Page } from 'playwright';
import { openStandinPage, waitForStylesheets } from '../../html/temp-page.ts';
import type { StructuralDiff } from '../types.ts';

/**
 * §8.9's structural diff: proves an edit did not silently lose an interactive element or
 * text content. The "before" baseline is captured from `session.originalHtml` — the document
 * serialized right after C2 stamped it, BEFORE any R4 edit in this run — replayed into a
 * throwaway page in the SAME isolated context (real DOM parsing, not a hand-rolled regex
 * scanner), so before/after are measured with the identical method.
 */

export interface StructuralSnapshot {
  interactiveCount: number;
  textLength: number;
  interactiveDescriptions: string[];
}

const INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], summary, [tabindex]:not([tabindex="-1"])';

function snapshotInPage(selector: string) {
  const els = Array.from(document.querySelectorAll(selector));
  const visible = els.filter((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
  });
  const interactiveDescriptions = visible.map((el) => {
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return `${el.tagName.toLowerCase()}${label ? ` "${label}"` : ''}`;
  });
  const textLength = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().length;
  return { interactiveCount: visible.length, textLength, interactiveDescriptions };
}

export async function captureStructuralSnapshot(page: Page): Promise<StructuralSnapshot> {
  return page.evaluate(snapshotInPage, INTERACTIVE_SELECTOR);
}

export async function captureBaselineFromHtml(context: BrowserContext, html: string, baseUrl: string): Promise<StructuralSnapshot> {
  const tempPage = await openStandinPage(context, baseUrl);
  try {
    await tempPage.setContent(html, { waitUntil: 'domcontentloaded' });
    await waitForStylesheets(tempPage);
    return await tempPage.evaluate(snapshotInPage, INTERACTIVE_SELECTOR);
  } finally {
    await tempPage.close();
  }
}

/** `textLossFloor`: below this fraction of the original text length, the page is treated as having lost content, not just reflowed it. */
export function diffStructural(before: StructuralSnapshot, after: StructuralSnapshot, textLossFloor = 0.85): StructuralDiff {
  const beforeSet = new Set(before.interactiveDescriptions);
  const afterSet = new Set(after.interactiveDescriptions);
  const byLabel = before.interactiveDescriptions.filter((d) => !afterSet.has(d));
  const countDropped = after.interactiveCount < before.interactiveCount;
  const lostInteractive = byLabel.length > 0 ? byLabel : countDropped ? [`interactive element count dropped from ${before.interactiveCount} to ${after.interactiveCount} (no single element's description changed, but fewer remain)`] : [];

  const textRatio = before.textLength === 0 ? 1 : after.textLength / before.textLength;
  const lostText = textRatio < textLossFloor ? [`page text dropped from ${before.textLength} to ${after.textLength} characters (${Math.round(textRatio * 100)}% of original)`] : [];

  const ok = lostInteractive.length === 0 && lostText.length === 0;
  void afterSet; // kept for readability of the set-difference above
  return { ok, lostInteractive, lostText, note: ok ? 'interactive inventory and text coverage unchanged' : `${lostInteractive.length} interactive element(s), ${lostText.length} text check(s) flagged` };
}
