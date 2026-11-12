// Vendored verbatim from audit-agent src/t-layer/element-registry.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Locator, Page } from 'playwright';

/**
 * ARCHITECTURE.md §5.2 B2→B3→B4 handoff contract: B4 consumes B2's exact
 * resolved element reference and never re-derives its own selector — the
 * validated failure this prevents is a naive text query grabbing a
 * zero-padding wrapper instead of the real button, producing a
 * confident-but-wrong Deviation.
 *
 * Two identities, deliberately separate (grounding research):
 *  (a) SESSION identity — Playwright `aria-ref` (bound to the LAST aria
 *      snapshot, fails closed if the node is gone) plus a run-scoped
 *      `data-audit-el` attribute stamped immediately after B2 resolves it, so
 *      the reference survives a later re-snapshot. Valid within one page
 *      session only.
 *  (b) FINDING identity — `finding_id`, content-derived (§2.5 rule 1), the
 *      only identity that survives across runs (§4.4 re-audit diffing).
 *
 * INVARIANT: the registry is frozen per capture state. Any disclosure
 * expansion mutates the DOM and can invalidate aria refs — take a fresh
 * snapshot and re-stamp for every disclosure state; never mix refs across
 * states, and never fall back to a homegrown selector if a ref is gone.
 */

export interface AriaElement {
  ref: string; // e.g. "e12"
  role: string;
  name: string;
  box?: { x: number; y: number; width: number; height: number };
  line: string;
  /**
   * A link's target. Playwright emits it as an indented CHILD line
   * (`- /url: /reports`), not on the element's own line — reading only the
   * element line leaves every href null, which silently disables the
   * off-domain exclusion rule that depends on it.
   */
  url?: string;
  /** Nesting depth in the snapshot (0 = the page root). */
  depth: number;
  /** The nearest ancestor that has a ref — the DOM hierarchy, not a geometric guess. */
  parentRef: string | null;
}

/**
 * Snapshot boxes come from getBoundingClientRect — VIEWPORT-relative (per
 * Playwright's own help text) — so the page must be at scroll 0 when the
 * snapshot is taken, or every y is offset and a sticky header overlaps
 * whatever content happens to sit behind it. Callers that need page-absolute
 * geometry should use `takePageSnapshot`.
 */
export async function takeAriaSnapshot(page: Page): Promise<string> {
  return page.ariaSnapshot({ mode: 'ai', boxes: true });
}

/**
 * A snapshot whose boxes are PAGE-absolute: scrolls to the top first (so
 * top-sticky headers sit in normal flow at y=0), waits a frame, and adds any
 * residual scroll offset to every parsed box.
 */
export async function takePageSnapshot(page: Page): Promise<{ snapshot: string; elements: AriaElement[] }> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const snapshot = await takeAriaSnapshot(page);
  const offset = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const elements = parseAriaSnapshot(snapshot).map((e) => (e.box ? { ...e, box: { ...e.box, x: e.box.x + offset.x, y: e.box.y + offset.y } } : e));
  return { snapshot, elements };
}

/** Parses `- role "name" [ref=e12] [box=x,y,w,h]` lines from an AI-mode aria snapshot. */
/**
 * The snapshot is YAML: an element line whose text itself contains `: ` is
 * emitted as a QUOTED scalar — `- 'heading "Q: why?" [level=3] [ref=e628]'`
 * (single quotes, `''` for a literal quote) or `- "…"` (double quotes,
 * backslash escapes). Read raw, such a line has no role and no name, and the
 * element silently stops being a candidate for anything.
 */
function unquoteYamlScalar(body: string): string {
  const trimmed = body.replace(/:\s*$/, '');
  if (trimmed.startsWith("'")) {
    let out = '';
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i] as string;
      if (ch === "'") {
        if (trimmed[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return out;
      }
      out += ch;
    }
    return out;
  }
  if (trimmed.startsWith('"')) {
    let out = '';
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i] as string;
      if (ch === '\\' && i + 1 < trimmed.length) {
        out += trimmed[i + 1] as string;
        i++;
        continue;
      }
      if (ch === '"') return out;
      out += ch;
    }
    return out;
  }
  return body;
}

export function parseAriaSnapshot(snapshot: string): AriaElement[] {
  const out: AriaElement[] = [];
  const lines = snapshot.split('\n');
  // Open ancestors by indentation. Element lines without a ref still count as
  // levels, so a child's parentRef is its nearest REFERENCEABLE ancestor.
  const stack: Array<{ depth: number; ref: string | null }> = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const refMatch = raw.match(/\[ref=(e\d+)\]/);
    const indent = raw.match(/^(\s*)-/)?.[1]?.length;
    if (!refMatch) {
      // `- /url: <href>` belongs to the most recently parsed element.
      const urlMatch = raw.match(/^\s*-\s*\/url:\s*(\S+)\s*$/);
      const last = out[out.length - 1];
      if (urlMatch && last && last.url === undefined) last.url = urlMatch[1] as string;
      // A ref-less ELEMENT line (e.g. `- region "Notifications"`) is still a hierarchy level.
      if (indent !== undefined && /^\s*-\s+[a-zA-Z]/.test(raw)) {
        const depth = indent / 2;
        while (stack.length && (stack.at(-1)?.depth ?? -1) >= depth) stack.pop();
        stack.push({ depth, ref: null });
      }
      continue;
    }
    const depth = (indent ?? 0) / 2;
    while (stack.length && (stack.at(-1)?.depth ?? -1) >= depth) stack.pop();
    const parentRef = [...stack].reverse().find((s) => s.ref !== null)?.ref ?? null;
    stack.push({ depth, ref: refMatch[1] as string });

    const body = unquoteYamlScalar(raw.replace(/^\s*-\s*/, ''));
    const roleMatch = body.match(/^([a-zA-Z]+)/);
    const nameMatch = body.match(/^[a-zA-Z]+\s+"((?:[^"\\]|\\.)*)"/);
    const boxMatch = raw.match(/\[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/);
    out.push({
      ref: refMatch[1] as string,
      role: roleMatch ? (roleMatch[1] as string) : 'unknown',
      name: nameMatch ? (nameMatch[1] as string) : '',
      ...(boxMatch
        ? { box: { x: Number(boxMatch[1]), y: Number(boxMatch[2]), width: Number(boxMatch[3]), height: Number(boxMatch[4]) } }
        : {}),
      line: raw.trim(),
      depth,
      parentRef,
    });
  }
  return out;
}

/** Stamps a run-scoped id on the element an aria ref resolves to. Throws (fails closed) if the ref no longer resolves. */
export async function stampRef(page: Page, ref: string, auditElId: string): Promise<void> {
  await page.locator(`aria-ref=${ref}`).evaluate((el, id) => el.setAttribute('data-audit-el', id), auditElId, { timeout: 2_000 });
}

export function locatorFor(page: Page, auditElId: string): Locator {
  return page.locator(`[data-audit-el="${auditElId}"]`);
}

export interface ElementFingerprint {
  structuralPath: string; // tag:nth-of-type chain up to the nearest id / data-testid anchor
  role: string;
  accessibleName: string;
  textPrefix: string;
  box: { x: number; y: number; width: number; height: number };
}

/** Content-derived, in-page fingerprint — the stable input to finding_id. */
export async function elementFingerprint(locator: Locator): Promise<ElementFingerprint> {
  return locator.evaluate((el) => {
    if (!el.isConnected) throw new Error('element detached');
    const parts: string[] = [];
    let node: Element | null = el;
    // Anchor only on an id / data-testid the page holds ONCE: real pages duplicate ids
    // (desktop and mobile copies of a menu, repeated widgets), and two elements under
    // two "#promo" anchors would share one path — and one finding id.
    const unique = (selector: string) => document.querySelectorAll(selector).length === 1;
    while (node && node !== document.documentElement) {
      if (node.id && unique(`#${CSS.escape(node.id)}`)) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const testId = node.getAttribute('data-testid');
      if (testId && unique(`[data-testid="${CSS.escape(testId)}"]`)) {
        parts.unshift(`[data-testid="${testId}"]`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parentEl: Element | null = node.parentElement;
      const siblings = parentEl ? Array.from(parentEl.children).filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
      node = parentEl;
    }
    const r = el.getBoundingClientRect();
    const round = (v: number) => Math.round(v / 4) * 4; // tolerate sub-pixel/layout jitter
    return {
      structuralPath: parts.join(' > '),
      role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
      accessibleName: (el.getAttribute('aria-label') ?? '').trim(),
      textPrefix: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 64),
      box: { x: round(r.x + window.scrollX), y: round(r.y + window.scrollY), width: round(r.width), height: round(r.height) },
    };
  });
}

/** §2.5 rule 1 finding_id — canonical JSON + sha256; stable across runs for the same element and rule. */
export const ELEMENT_FINDING = 'element';

/**
 * The id of an element's compliance finding — the SAME across runs whatever its
 * outcome, so S7 can see MATCH→DEVIATION as a REGRESSION and DEVIATION→MATCH
 * as RESOLVED. Baking the classification (or a rule id) into the id made every
 * status change look like one issue vanishing and an unrelated one appearing.
 */
export function elementFindingId(pageId: string, fingerprint: ElementFingerprint): string {
  return findingId({ pageId, nodeId: ELEMENT_FINDING, ruleId: ELEMENT_FINDING, fingerprint });
}

/**
 * Every element's finding id, unique on the page. The fingerprint anchors only
 * on ids the page holds once, but two elements can still fingerprint alike
 * (identical shadow-DOM subtrees, or siblings indistinguishable by role, text
 * and path). Sharing one id would let INSERT OR REPLACE keep one finding in
 * SQLite while C2 publishes both, and B5 would apply one verdict to both. The
 * first occurrence in document order keeps the plain id; later ones get an
 * occurrence-numbered id, so no finding silently replaces another.
 */
export function assignElementFindingIds(pageId: string, fingerprints: ElementFingerprint[]): { ids: string[]; collisions: number } {
  const order = fingerprints
    .map((fp, index) => ({ fp, index }))
    .sort((a, b) => a.fp.box.y - b.fp.box.y || a.fp.box.x - b.fp.box.x || a.index - b.index);
  const ids: string[] = new Array<string>(fingerprints.length);
  const seen = new Map<string, number>();
  let collisions = 0;
  for (const { fp, index } of order) {
    const base = elementFindingId(pageId, fp);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) collisions++;
    ids[index] = n === 1 ? base : findingId({ pageId, nodeId: ELEMENT_FINDING, ruleId: `${ELEMENT_FINDING}#${n}`, fingerprint: fp });
  }
  return { ids, collisions };
}

export function findingId(input: { pageId: string; nodeId: string; ruleId: string; fingerprint: ElementFingerprint }): string {
  // Box is deliberately excluded: position shifts with unrelated content above the
  // element and would break §4.4 STILL OPEN/RESOLVED diffing across runs.
  const { box: _box, ...stable } = input.fingerprint;
  const canonical = canonicalize({ pageId: input.pageId, nodeId: input.nodeId, ruleId: input.ruleId, fingerprint: stable });
  if (canonical === undefined) throw new Error('canonicalize() returned undefined');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
