import type { BrowserContext, Page } from 'playwright';

/**
 * §8.5 — every exported document validated before G2, per its OWN declared scope (never one
 * blanket rule). `zeroNetworkCheck`/`scopeCheck`/`stampsCheck` are pure string checks so they
 * are unit-testable without a browser; `parseCheck`/`renderedParityCheck` need a real one.
 */

export interface ExportExpectation {
  file: string;
  /** What this file's content root should contain — used by the scope check. */
  scope: 'whole-page' | 'content-no-header-footer' | 'one-section';
  /** Required for `scope: 'one-section'`. */
  onlySectionId?: string;
  /** True only for `redesign.html`, the one export that keeps header/footer. */
  headerFooterRetained: boolean;
}

export interface ExportCheckResult {
  file: string;
  ok: boolean;
  failures: string[];
}

// ── Pure checks ──────────────────────────────────────────────────────────────────────────

// `src`/`poster` NEVER have a "reference only, not a load" reading in HTML — every element that
// carries one (img, script, video, audio, source, iframe, track, embed, …) fetches it, so ANY
// non-inlined value (absolute, protocol-relative, or a plain relative path — the common case
// for a real site's own media, which is exactly what `<video>`/`<source>`/`poster` were never
// being inlined for) is a live reference. `href` is different — an anchor link and a
// `rel="canonical"`/`alternate`/… link are legitimate references the browser never loads, so
// `href` is scanned for absolute/protocol-relative URLs only, matching what a `<link
// rel="stylesheet">` (the one href-based case that WOULD load) looks like before it gets
// inlined away by serializeInPage — by the time this check runs, a stylesheet link should
// already be gone, replaced by an inline `<style>`.
const NETWORK_SRC_POSTER_RE = /\b(?:src|poster)\s*=\s*["'](?!data:|#)([^"']+)["']/gi;
const NETWORK_HREF_RE = /\bhref\s*=\s*["'](https?:)?\/\/[^"']+["']/gi;
const NETWORK_URL_RE = /url\(\s*["']?(?!data:|#)([^"')]+)["']?\s*\)/gi;

/** `<link>` relations that never cause the browser to fetch anything — everything else (stylesheet, icon, preload, manifest, an absent/unrecognized rel, …) is treated as loading, the safer default. */
const NON_LOADING_LINK_RELS = new Set(['canonical', 'alternate', 'author', 'license', 'search', 'me', 'next', 'prev', 'help', 'bookmark', 'tag', 'nofollow', 'noopener', 'noreferrer']);

function isNonLoadingLinkTag(tag: string): boolean {
  const relMatch = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
  if (!relMatch?.[1]) return false;
  return relMatch[1].toLowerCase().split(/\s+/).every((r) => NON_LOADING_LINK_RELS.has(r));
}

export function zeroNetworkCheck(html: string): string[] {
  const failures: string[] = [];
  let m: RegExpExecArray | null;
  NETWORK_SRC_POSTER_RE.lastIndex = 0;
  while ((m = NETWORK_SRC_POSTER_RE.exec(html))) failures.push(`live network reference in markup: ${m[0].slice(0, 120)}`);
  NETWORK_HREF_RE.lastIndex = 0;
  while ((m = NETWORK_HREF_RE.exec(html))) {
    const tagStart = html.lastIndexOf('<', m.index);
    const tag = html.slice(tagStart, m.index + m[0].length + 1);
    if (/^<a\s/i.test(tag)) continue; // a content anchor — a link, not a load
    if (/^<link\s/i.test(tag) && isNonLoadingLinkTag(tag)) continue; // canonical/alternate/… — a reference, never a load
    failures.push(`live network reference in markup: ${m[0].slice(0, 120)}`);
  }
  NETWORK_URL_RE.lastIndex = 0;
  while ((m = NETWORK_URL_RE.exec(html))) failures.push(`live network reference in CSS: ${m[0].slice(0, 120)}`);
  return failures;
}

export function stampsCheck(html: string): string[] {
  // The injected-edits stylesheet repeats an element's stamp once per CSS rule; that is not a second element.
  const markup = html.replace(/<style\b[^>]*\bdata-fra-injected=[^>]*>[\s\S]*?<\/style>/gi, '');
  const ids = [...markup.matchAll(/data-fra-element="([^"]+)"/g)].map((m) => m[1] as string);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes].map((id) => `stamp "${id}" appears on more than one element in this export`);
}

export function scopeCheck(html: string, expectation: ExportExpectation): string[] {
  const failures: string[] = [];
  const excludedPresent = /data-fra-scope="excluded"/.test(html) && !/<div[^>]*data-fra-removed=/.test(html.replace(/data-fra-scope="excluded"[^>]*>[\s\S]*?(?=<div[^>]*data-fra-removed=|$)/, ''));
  if (expectation.scope === 'content-no-header-footer' && (/\bdata-fra-scope="excluded"[^>]*>(?!<\/div>)/.test(html) || (!expectation.headerFooterRetained && /<header\b/i.test(html) && !/data-fra-removed/.test(html)))) {
    failures.push('an excluded (header/footer) subtree is present but not replaced by an inert placeholder');
  }
  if (expectation.headerFooterRetained && !/<header\b|role=["']banner["']/i.test(html) && !/data-fra-section/.test(html)) {
    failures.push('redesign.html should retain the header/footer for QA context, but no header landmark or section stamp was found');
  }
  if (expectation.scope === 'one-section' && expectation.onlySectionId) {
    const sectionCount = new Set([...html.matchAll(/data-fra-section="([^"]+)"/g)].map((m) => m[1])).size;
    if (sectionCount > 1) failures.push(`a section fragment export contains ${sectionCount} distinct section stamps, expected exactly 1 ("${expectation.onlySectionId}")`);
  }
  void excludedPresent;
  return failures;
}

// ── Browser-backed checks ───────────────────────────────────────────────────────────────────

/**
 * §8.5's scope rule for Selected Sections mode: an `unselected` section (marked by R7,
 * §8.1) must be unmodified. Checkable purely from the exported document's own artifacts —
 * the injected-edits `<style>` block and the section subtree are both in the same
 * document — by cross-referencing which `data-fra-element` ids the injected stylesheet(s)
 * actually target against which ones live inside an `unselected` subtree. This catches R3's
 * primary edit kind (`style`, applied via the injected stylesheet); an attribute/text/class
 * edit leaves no such cross-referenceable trace in the export alone, so this is a real but
 * partial defense-in-depth check — the actual guarantee is R3 never planning an edit for an
 * out-of-scope finding in the first place (§8.1).
 */
export async function unselectedUntouchedOnPage(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const failures: string[] = [];
    const editedIds = new Set<string>();
    for (const style of Array.from(document.querySelectorAll('style'))) {
      const sheet = (style as HTMLStyleElement).sheet;
      if (!sheet) continue;
      for (const rule of Array.from(sheet.cssRules)) {
        const m = (rule as CSSStyleRule).selectorText?.match(/data-fra-element="([^"]+)"/);
        if (m?.[1]) editedIds.add(m[1]);
      }
    }
    for (const section of Array.from(document.querySelectorAll('[data-fra-scope="unselected"]'))) {
      for (const el of Array.from(section.querySelectorAll('[data-fra-element]'))) {
        const id = el.getAttribute('data-fra-element');
        if (id && editedIds.has(id)) failures.push(`element "${id}" inside an unselected section carries an injected style edit — an unselected section must be unmodified`);
      }
    }
    return failures;
  });
}

export async function unselectedSectionsUntouchedCheck(context: BrowserContext, html: string): Promise<string[]> {
  if (!html.includes('data-fra-scope="unselected"')) return [];
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await unselectedUntouchedOnPage(page);
  } finally {
    await page.close();
  }
}

export async function parseCheck(context: BrowserContext, html: string): Promise<string[]> {
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const bodyExists = await page.evaluate(() => Boolean(document.body));
    return bodyExists ? [] : ['the document did not parse to a <body>'];
  } catch (err) {
    return [`failed to parse: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    await page.close();
  }
}

export interface ParityTarget {
  stamp: string;
  properties: string[];
}

/** Reopens the export at the same viewport and compares each mapped element's key computed styles/geometry against the live post-edit page. */
export async function renderedParityCheck(context: BrowserContext, html: string, viewport: { width: number; height: number }, targets: ParityTarget[], liveValues: Map<string, Record<string, string>>): Promise<string[]> {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const failures: string[] = [];
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    for (const target of targets) {
      const live = liveValues.get(target.stamp);
      if (!live) continue;
      const exported = await page.evaluate(
        ({ stamp, props }) => {
          const el = document.querySelector(`[data-fra-element="${stamp}"]`);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const out: Record<string, string> = {};
          for (const p of props) out[p] = cs.getPropertyValue(p);
          return out;
        },
        { stamp: target.stamp, props: target.properties },
      );
      if (!exported) {
        failures.push(`element ${target.stamp}: present in the live page but not found in the export`);
        continue;
      }
      for (const prop of target.properties) {
        if (exported[prop] !== live[prop]) failures.push(`element ${target.stamp} property ${prop}: export="${exported[prop]}" live="${live[prop]}"`);
      }
    }
    return failures;
  } finally {
    await page.close();
  }
}

export async function validateExport(context: BrowserContext, html: string, expectation: ExportExpectation, parityOpts: { viewport: { width: number; height: number }; targets: ParityTarget[]; liveValues: Map<string, Record<string, string>> } | null): Promise<ExportCheckResult> {
  const failures = [
    ...(await parseCheck(context, html)),
    ...zeroNetworkCheck(html),
    ...scopeCheck(html, expectation),
    ...stampsCheck(html),
    ...(await unselectedSectionsUntouchedCheck(context, html)),
    ...(parityOpts ? await renderedParityCheck(context, html, parityOpts.viewport, parityOpts.targets, parityOpts.liveValues) : []),
  ];
  return { file: expectation.file, ok: failures.length === 0, failures };
}
