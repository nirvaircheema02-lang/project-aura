import type { Page } from 'playwright';
import { waitForRenderSettled, type PageObserver } from './render-settled.ts';

/**
 * ARCHITECTURE.md §2.7 interactive-disclosure expansion (tabs, accordions,
 * <details>, "Read More") before capture. The safety predicate below is a
 * CORRECTNESS requirement, not a nicety (grounding risk): kenresearch.com is
 * a lead-generation site, so an expansion pass that clicks the wrong thing
 * can create a real CRM record, trigger a download, or navigate away.
 *
 * Candidates are found primarily by ROLE + ARIA state; "Read More" buttons
 * without aria-expanded are a secondary, text-based candidate kind because
 * the validated report-detail truncation needed it. Every candidate — of any
 * kind — passes the same safety predicate before any click.
 */

export type DisclosureKind = 'tab' | 'accordion' | 'details' | 'read-more';

export interface DisclosureCandidate {
  id: string; // stamped as data-audit-disclosure
  kind: DisclosureKind;
  label: string;
  safe: boolean;
  unsafeReason?: string;
}

export async function findDisclosureCandidates(page: Page): Promise<DisclosureCandidate[]> {
  return page.evaluate(() => {
    const out: Array<{ id: string; kind: string; label: string; safe: boolean; unsafeReason?: string }> = [];
    const seen = new Set<Element>();
    let n = 0;

    function unsafeReason(el: Element): string | null {
      const anchor = el.closest('a[href]') as HTMLAnchorElement | null;
      if (anchor) {
        let target: URL;
        try {
          target = new URL(anchor.href, document.baseURI);
        } catch {
          return 'unparseable link';
        }
        if (target.origin !== location.origin || target.pathname !== location.pathname) return 'link to another page';
        if (anchor.target === '_blank') return 'opens a new window';
        if (anchor.hasAttribute('download')) return 'triggers a download';
      }
      if (el.closest('[download]')) return 'triggers a download';
      const form = el.closest('form');
      if (form) {
        if (form.querySelector('input[type="email"], input[type="tel"], input[type="password"]')) return 'inside a form collecting personal data';
        const button = el.closest('button, input[type="submit"], input[type="image"]');
        if (button) {
          const type = (button.getAttribute('type') ?? 'submit').toLowerCase(); // a <button> in a <form> defaults to submit
          if (type === 'submit' || type === 'image') return 'would submit a form';
        }
      }
      return null;
    }

    // Idempotent under a node retry (§2.4): stamps from a previous attempt would otherwise
    // collide with the d0, d1, … ids this pass assigns.
    document.querySelectorAll('[data-audit-disclosure]').forEach((el) => el.removeAttribute('data-audit-disclosure'));

    function push(el: Element, kind: string) {
      if (seen.has(el)) return;
      seen.add(el);
      const id = `d${n++}`;
      el.setAttribute('data-audit-disclosure', id);
      const reason = unsafeReason(el);
      out.push({
        id,
        kind,
        label: ((el.getAttribute('aria-label') ?? el.textContent) || '').trim().slice(0, 80),
        safe: reason === null,
        ...(reason ? { unsafeReason: reason } : {}),
      });
    }

    document.querySelectorAll('[role="tab"]:not([aria-selected="true"])').forEach((el) => push(el, 'tab'));
    document.querySelectorAll('[aria-expanded="false"]').forEach((el) => push(el, 'accordion'));
    document.querySelectorAll('details:not([open]) > summary').forEach((el) => push(el, 'details'));
    document.querySelectorAll('button, [role="button"]').forEach((el) => {
      if (/^\s*read\s+more\s*$/i.test(el.textContent ?? '')) push(el, 'read-more');
    });
    return out;
  }) as Promise<DisclosureCandidate[]>;
}

export type ExpandOutcome =
  | { expanded: true; settled: boolean }
  | { expanded: false; reason: 'unsafe' | 'not-actionable' | 'navigated-away-restored' | 'not-found'; detail?: string };

/**
 * Expands one candidate: re-checks it's safe, runs a trial click (actionability
 * checks without acting), clicks, then asserts the URL did not change — SPA
 * navigations via next/link produce no document request, so URL comparison +
 * a framenavigated listener is the reliable detector. If the page moved, it
 * is restored to `originalUrl` and the expansion is reported as not done.
 */
export async function expandSafely(
  page: Page,
  observer: PageObserver,
  candidate: DisclosureCandidate,
  originalUrl: string,
): Promise<ExpandOutcome> {
  if (!candidate.safe) return { expanded: false, reason: 'unsafe', ...(candidate.unsafeReason ? { detail: candidate.unsafeReason } : {}) };
  const locator = page.locator(`[data-audit-disclosure="${candidate.id}"]`);
  if ((await locator.count()) === 0) return { expanded: false, reason: 'not-found' };

  if (candidate.kind === 'details') {
    await locator.evaluate((el) => {
      const d = el.closest('details');
      if (d) d.open = true;
    });
    const s = await waitForRenderSettled(page, observer, { networkCapMs: 8_000 });
    return { expanded: true, settled: s.settled };
  }

  try {
    await locator.click({ trial: true, timeout: 3_000 });
  } catch (err) {
    const detail = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
    return { expanded: false, reason: 'not-actionable', detail };
  }

  const before = page.url();
  let navigated = false;
  const onNav = (frame: import('playwright').Frame) => {
    if (frame === page.mainFrame() && frame.url() !== before) navigated = true;
  };
  page.on('framenavigated', onNav);
  try {
    await locator.click({ timeout: 3_000 });
    const s = await waitForRenderSettled(page, observer, { networkCapMs: 8_000 });
    if (navigated || page.url() !== before) {
      const landedOn = page.url();
      await page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
      await waitForRenderSettled(page, observer, { networkCapMs: 8_000 });
      return { expanded: false, reason: 'navigated-away-restored', detail: `click navigated to ${landedOn}` };
    }
    return { expanded: true, settled: s.settled };
  } finally {
    page.off('framenavigated', onNav);
  }
}
