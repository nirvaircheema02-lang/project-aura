import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { Finding } from '../audit-link/index.ts';
import { propertyMatchesExpected } from '../style/compare-expected.ts';
import { checkPopupControls, type PopupControlResult } from './popup-check.ts';
import { classifyRuns, measureSectionsContrast, type ContrastRow } from './contrast-run.ts';
import { visibleTextOf } from './visible-text.ts';
import { DS_TYPEFACES, typefaceInPage, typefaceRuleChecks } from '../style/typeface-rule.ts';
import { compareBehavior, probeSections, unavailableSummary, type BehaviorFile, type SectionBehavior } from './behavior.ts';
import type { IslandPlan, IslandSkip, Route } from './plan.ts';
import { PROBE_LIB } from './probe-lib.ts';
import { applyOverallStatus, checkGapsOf, statusFields } from './status.ts';
import { measureResolvedTarget } from './targets.ts';
import { coveredProperties } from '../fidelity/compare.ts';
import { parseUserStyle } from './user-style-rules.ts';
import { preserveCheck, reconcilePreserve, summarizePreserve } from '../fidelity/accounting.ts';
import type { PreserveResult } from '../fidelity/types.ts';
import type { ResolutionFile, VerificationStatus } from '../resolution/schema.ts';
import { PREVIEW_SCHEMA_VERSION, type ContrastReport, type DesignDecisionsFile, type ExpectedScope, type ExtractionResult, type FindingOutcome, type InteractionResult, type PreviewCheck, type PreviewNode, type PreviewVerification } from './types.ts';
import type { DesignMode } from '../session/types.ts';

/**
 * Verifies a generated, running React preview BEFORE gate G2: scope, content preservation, each
 * Fix finding (measured in the rendered page, not merely "an element exists"), interaction parity
 * with the original page, and runtime hygiene. Pure measurement: it never edits the preview.
 */

export interface VerifyInput {
  browser: Browser;
  url: string;
  mode: DesignMode;
  expected: ExpectedScope;
  extraction: ExtractionResult;
  fixFindings: Finding[];
  routes: Map<string, { route: Route; sectionId: string; stamp: string | null }>;
  decisions: DesignDecisionsFile | null;
  islands: IslandPlan[];
  skippedIslands: IslandSkip[];
  originalBehavior: BehaviorFile | null;
  /** Optional preview-overrides/checks.mjs: extra checks authored with a hand-built section. */
  customChecksFile?: string | null;
  sectionNames: Record<string, string>;
  /** The run's pre-edit snapshot (original.html): the baseline the preview's text contrast is compared with. */
  originalHtml?: string | null;
  /** The audited page's URL: relative and absolute links to the same destination are the same link. */
  siteBase?: string;
  /** The planner's own "unaddressed" reasons (recorded conflicts), by finding id — a known, explained gap. */
  plannerGaps?: ReadonlyMap<string, string>;
  /** The Resolver's derived targets: every resolved target is measured in the rendered page, and a finding is never reported fixed while one is open. */
  resolution?: ResolutionFile | null;
  /**
   * The verdict of every PRESERVE decision, judged from the fidelity evidence (`evaluatePreserveTargets`). When given, finding statuses and tallies,
   * the `ds-fix.preserved-unchanged` check and `targetResults` all include them, so property, finding and overall verification agree.
   */
  preserveResults?: PreserveResult[];
  simulated: string[];
  generation: { assetsFailed: Array<{ url: string; reason: string }>; remoteLeft: string[] };
  log?: (line: string) => void;
}

const HELPERS = String.raw`(() => {
  if (window.__pvVerify) return;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sectionRoot = (host) => host.shadowRoot ? (host.shadowRoot.querySelector('[data-pv-mount]') ? host.shadowRoot.querySelector('[data-pv-mount]').firstElementChild : null) : host;
  const NOT_CONTENT = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE']);
  function walk(node, visit) {
    if (node.nodeType === 1) {
      const el = node;
      if (NOT_CONTENT.has(el.tagName)) return;
      if (el.tagName === 'SLOT') { for (const n of el.assignedNodes({ flatten: true })) walk(n, visit); return; }
      visit(el);
      // a section host renders its shadow tree (light children only appear through its slots)
      for (const c of (el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes)) walk(c, visit);
    } else visit(node);
  }
  function deepText(root) { let out = ''; walk(root, (n) => { if (n.nodeType === 3) out += n.nodeValue + ' '; }); return norm(out); }
  function deepElements(root, pred) { const out = []; walk(root, (n) => { if (n.nodeType === 1 && pred(n)) out.push(n); }); return out; }
  function findByFinding(id) {
    const roots = [document, ...Array.from(document.querySelectorAll('[data-pv-section]')).map((h) => h.shadowRoot).filter(Boolean)];
    for (const r of roots) { const el = r.querySelector('[data-finding-ids~="' + id + '"]'); if (el) return el; }
    return null;
  }
  window.__pvVerify = { norm, sectionRoot, deepText, deepElements, findByFinding, walk };
})()`;

const normText = (s: string) => s.replace(/\s+/g, ' ').trim();
const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const jaccard = (a: string[], b: string[]) => { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 1; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
const treeHasTag = (n: PreviewNode, tag: string): boolean => n.t === 'el' && (n.tag === tag || n.children.some((c) => treeHasTag(c, tag)));
/** The distinct whitespace-normalised text nodes under a section tree (what the original SAYS, independent of how often a carousel repeats it or in what order). */
const leafTexts = (n: PreviewNode, out: Set<string> = new Set()): Set<string> => {
  if (n.t === 'text') { const v = n.v.replace(/\s+/g, ' ').trim().toLowerCase(); if (v) out.add(v); } else if (n.t === 'el') for (const c of n.children) leafTexts(c, out);
  return out;
};
const squeeze = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const shingles = (s: string, k = 6) => { const t = squeeze(s); const out: string[] = []; for (let i = 0; i + k <= t.length; i++) out.push(t.slice(i, i + k)); return out; };
export const hrefKeyFor = (base?: string) => (h: string): string => {
  try {
    const u = new URL(h, base ?? 'http://site.invalid/');
    if (!/^https?:$/.test(u.protocol)) return h;
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
  } catch { return h; }
};

async function measure(page: Page, findingId: string, mismatches: Array<{ property: string; expected: string; comparison: 'exact' | 'color-deltaE' | 'length-px' | 'unsupported' }>): Promise<{ found: boolean; rows: Array<{ property: string; actual: string; expected: string; matches: boolean; note: string }> }> {
  const raw = await page.evaluate(([id, props]) => {
    const v = (window as any).__pvVerify;
    const wrapper = v.findByFinding(id) as Element | null;
    if (!wrapper) return { found: false, rows: [] as Array<{ property: string; actual: string; resolved: string }> };
    // a design-system island is wrapped in a display:contents element; the thing to measure is the component inside it
    const comp = wrapper.getAttribute('data-pv-island');
    const inner = wrapper.firstElementChild ?? wrapper;
    const el: Element = !comp ? wrapper : comp === 'Button' ? (wrapper.querySelector('a,button') ?? inner) : (wrapper.querySelector('h1,h2,h3,h4,h5,h6') ?? inner);
    const rows = (props as Array<{ property: string; expected: string }>).map((m) => {
      let target: Element = el;
      let prop = m.property;
      if (prop.includes('.')) {
        const [scope, p] = prop.split('.', 2) as [string, string];
        prop = p;
        if (scope === 'label') {
          const label = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          const all = [el, ...Array.from(el.querySelectorAll('*'))];
          const exact = all.reverse().find((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim() === label && e.children.length === 0);
          if (exact) target = exact;
        }
      }
      const actual = getComputedStyle(target).getPropertyValue(prop);
      const probe = document.createElement('span');
      probe.style.setProperty(prop, m.expected);
      (target.parentElement ?? target).appendChild(probe);
      const resolved = probe.style.getPropertyValue(prop) ? getComputedStyle(probe).getPropertyValue(prop) : m.expected;
      probe.remove();
      return { property: m.property, actual, resolved };
    });
    return { found: true, rows };
  }, [findingId, mismatches.map((m) => ({ property: m.property, expected: m.expected }))] as const);
  if (!raw.found) return { found: false, rows: [] };
  return {
    found: true,
    rows: raw.rows.map((r, i) => {
      const m = mismatches[i]!;
      const cmp = propertyMatchesExpected(m.comparison, r.actual, r.resolved);
      return { property: r.property, actual: r.actual, expected: r.resolved, matches: cmp.matches, note: cmp.note };
    }),
  };
}

/** Every text-bearing node of the finding's element must be set in a design-system typeface, and not in the offending one. */
async function measureTypeface(page: Page, findingId: string, offending: string): Promise<{ found: boolean; row: { property: string; actual: string; expected: string; matches: boolean; note: string } | null }> {
  const handle = await page.evaluateHandle((id) => {
    const wrapper = (window as any).__pvVerify.findByFinding(id) as Element | null;
    if (!wrapper) return null;
    // a design-system island is wrapped in an element; the thing to measure is the component inside it
    const comp = wrapper.getAttribute('data-pv-island');
    return !comp ? wrapper : comp === 'Button' ? (wrapper.querySelector('a,button') ?? wrapper) : (wrapper.querySelector('h1,h2,h3,h4,h5,h6') ?? wrapper);
  }, findingId);
  const el = handle.asElement();
  if (!el) return { found: false, row: null };
  const raw = await el.evaluate(typefaceInPage, { bad: offending, ds: DS_TYPEFACES });
  return { found: true, row: { property: 'font-family', actual: raw.families.join(', '), expected: 'a design-system typeface (DM Sans or Noto Serif), not ' + offending, matches: raw.ok, note: '' } };
}

/**
 * The `contrast.measured` gate. A measurement that failed to run, or a section that moved while it was taken, is NOT checked; a selection with no
 * text at all (an image or logo strip) has nothing to measure, which is a pass that says so; text that exists but could not be sampled is NOT checked.
 */
export function contrastMeasuredCheck(report: ContrastReport | undefined, unstable: boolean, hasOriginal: boolean): { status: 'pass' | 'not-checked'; detail: string } {
  if (unstable) return { status: 'not-checked', detail: 'a section moved when its text was hidden, so its pixels could not be sampled' };
  if (!report) return { status: 'not-checked', detail: 'the contrast measurement could not run' };
  if (report.measuredRuns === 0) return report.unmeasuredRuns > 0 ? { status: 'not-checked', detail: `${report.unmeasuredRuns} text run(s) were found but none could be measured against the pixels behind them` } : { status: 'pass', detail: 'no text in these sections, so there is nothing to measure' };
  return { status: 'pass', detail: `${report.measuredRuns} text run(s) measured against the pixels behind them${hasOriginal ? ', compared with the original page' : ' (no original snapshot, so no comparison)'}${report.unmeasuredRuns ? `; ${report.unmeasuredRuns} could not be measured` : ''}` };
}

export async function verifyPreview(input: VerifyInput): Promise<PreviewVerification> {
  const log = input.log ?? (() => {});
  const checks: PreviewCheck[] = [];
  const add = (group: PreviewCheck['group'], id: string, name: string, status: PreviewCheck['status'], detail: string) => checks.push({ id, group, name, status, detail });
  const ctx = await input.browser.newContext({ viewport: { width: 1440, height: 900 } });
  // verification must never contact anything but the preview itself: other hosts are refused (and still reported by the runtime check)
  const previewHost = new URL(input.url).host;
  await ctx.route('**/*', (route) => { try { return new URL(route.request().url()).host === previewHost || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort(); } catch { return route.abort(); } });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); });
  page.on('request', (r) => requests.push(r.url()));

  try {
    await page.goto(input.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(HELPERS);

    // ── scope ───────────────────────────────────────────────────────────────────────────
    const hosts = await page.evaluate(() => Array.from(document.querySelectorAll('[data-pv-section]')).map((h) => h.getAttribute('data-pv-section') as string));
    const pageOrder = input.extraction.sections.map((s) => s.id);
    const expectedInOrder = pageOrder.filter((id) => input.expected.expectedSectionIds.includes(id));
    const missing = input.expected.expectedSectionIds.filter((id) => !hosts.includes(id));
    const extra = hosts.filter((id) => !input.expected.expectedSectionIds.includes(id) && !(input.mode === 'full-page' && id.startsWith('region-')));
    add('scope', 'scope.sections', `Rendered sections are exactly the expected ${input.mode === 'full-page' ? 'page' : 'Fix'} sections`, missing.length === 0 && extra.length === 0 && hosts.length === new Set(hosts).size ? 'pass' : 'fail',
      `expected ${input.expected.expectedSectionIds.length} (${input.expected.expectedSectionIds.join(', ') || 'none'}); rendered ${hosts.length} (${hosts.join(', ') || 'none'})${missing.length ? `; MISSING ${missing.join(', ')}` : ''}${extra.length ? `; UNEXPECTED ${extra.join(', ')}` : ''}`);
    const hostsInExpected = hosts.filter((id) => expectedInOrder.includes(id));
    add('scope', 'scope.order', 'Sections appear in their original page order', JSON.stringify(hostsInExpected) === JSON.stringify(expectedInOrder.filter((id) => hosts.includes(id))) ? 'pass' : 'fail', `rendered order: ${hosts.join(' → ')}`);
    const forbiddenHit = input.expected.forbiddenSectionIds.filter((id) => hosts.includes(id));
    add('scope', 'scope.forbidden', 'No unselected or global section is rendered', forbiddenHit.length === 0 ? 'pass' : 'fail', forbiddenHit.length ? `rendered forbidden section(s): ${forbiddenHit.join(', ')}` : `${input.expected.forbiddenSectionIds.length} forbidden section id(s) checked`);
    const bodyText = normText(await page.evaluate(() => { const v = (window as any).__pvVerify; let t = ''; for (const h of Array.from(document.querySelectorAll('[data-pv-section]'))) t += ' ' + v.deepText(h); return t; }));
    // Out-of-scope text is searched for in the whole rendered text — including inside shadow roots, where a landmark query on the document cannot see.
    const squeezed = squeeze(bodyText);
    const stray = input.extraction.outOfScopeText.filter((o) => squeezed.includes(squeeze(o.snippet)));
    const strayGlobal = stray.filter((o) => o.scope === 'excluded' || input.expected.globalSectionIds.includes(o.id));
    const strayContent = stray.filter((o) => !strayGlobal.includes(o));
    const leakedNames = Object.entries(input.sectionNames).filter(([id, name]) => input.expected.forbiddenSectionIds.includes(id) && !input.expected.globalSectionIds.includes(id) && name.length >= 12 && bodyText.includes(name)).map(([, n]) => n);
    const leaked = [...strayContent.map((o) => `${o.id}: "${o.snippet.slice(0, 40)}…"`), ...leakedNames];
    add('scope', 'scope.no-leaked-text', 'No text of an excluded section appears in the rendered sections', leaked.length === 0 ? 'pass' : 'fail', leaked.length ? `found: ${leaked.join('; ')}` : `checked the text of ${input.extraction.outOfScopeText.filter((o) => o.scope !== 'excluded').length} unselected section(s) and the titles of every excluded content section`);
    const chrome = await page.evaluate(() => Array.from(document.querySelectorAll('header,footer,[role=banner],[role=contentinfo]')).filter((e) => !e.hasAttribute('data-pv-chrome')).map((e) => e.tagName.toLowerCase()));
    const chromeProblems = [...chrome.map((c) => `<${c}> landmark outside the sections`), ...strayGlobal.map((o) => `text of the global "${o.id}" section: "${o.snippet.slice(0, 40)}…"`)];
    add('scope', 'scope.no-global-chrome', 'The site header and footer are not rendered', chromeProblems.length === 0 ? 'pass' : 'fail', chromeProblems.length ? chromeProblems.join('; ') : `no landmark outside the preview bar and none of the ${input.extraction.outOfScopeText.filter((o) => o.scope === 'excluded').length} global section text(s) is present`);
    const orphans = input.extraction.orphanContent;
    add('scope', 'scope.no-orphan-content', 'No content sits directly beside a selected section without belonging to a section', orphans.length === 0 ? 'pass' : 'not-checked', orphans.length ? `${orphans.length} unowned block(s): ${orphans.slice(0, 3).map((o) => `<${o.tag}> ${o.between}: "${o.text.slice(0, 50)}"`).join(' | ')}` : 'none found');

    // ── content preservation ────────────────────────────────────────────────────────────
    const overrides = input.decisions?.overrides ?? {};
    // lazy images below the fold would otherwise count as "not loaded"
    await page.evaluate(async () => {
      const v = (window as any).__pvVerify;
      const imgs: HTMLImageElement[] = [];
      for (const h of Array.from(document.querySelectorAll('[data-pv-section]'))) { const root = v.sectionRoot(h) as Element | null; if (root) imgs.push(...(v.deepElements(root, (e: Element) => e.tagName === 'IMG') as HTMLImageElement[])); }
      for (const i of imgs) { i.loading = 'eager'; }
      await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
    });
    const rendered = await page.evaluate(() => {
      const v = (window as any).__pvVerify;
      return Array.from(document.querySelectorAll('[data-pv-section]')).map((h) => {
        const root = v.sectionRoot(h) as Element | null;
        if (!root) return { id: h.getAttribute('data-pv-section') as string, ok: false };
        const links = v.deepElements(root, (e: Element) => e.tagName === 'A' && e.hasAttribute('href')).map((a: Element) => a.getAttribute('href'));
        const imgs = v.deepElements(root, (e: Element) => e.tagName === 'IMG') as HTMLImageElement[];
        // a design-system AccordionItem's question is its trigger <button aria-controls="faq-answer-…"> rather than an <h3>: it is the question's heading
        const headings = v.deepElements(root, (e: Element) => /^H[1-6]$/.test(e.tagName) || e.getAttribute('role') === 'heading' || (e.tagName === 'BUTTON' && /^faq-answer-/.test(e.getAttribute('aria-controls') ?? ''))).map((e: Element) => v.deepText(e));
        const leaves: string[] = []; v.walk(root, (n: Node) => { if (n.nodeType === 3) { const t = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim().toLowerCase(); if (t) leaves.push(t); } });
        return { id: h.getAttribute('data-pv-section') as string, ok: true, text: v.deepText(root), leaves: Array.from(new Set(leaves)), links, images: imgs.length, imagesLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length, headings, height: Math.round(root.getBoundingClientRect().height) };
      });
    });
    // A design-system AccordionItem mounts its answer only while it is open (framer-motion AnimatePresence), so a collapsed FAQ row has no answer text in the DOM. The
    // answer is original content: open every collapsed row, read the section text, and close the rows again (height, hover and focus are measured collapsed).
    const openedText = await page.evaluate(async () => {
      const v = (window as any).__pvVerify;
      const sections = Array.from(document.querySelectorAll('[data-pv-section]'));
      const isTrigger = (e: Element) => e.tagName === 'BUTTON' && /^faq-answer-/.test(e.getAttribute('aria-controls') ?? '');
      const closed: HTMLElement[] = [];
      for (const h of sections) { const root = v.sectionRoot(h) as Element | null; if (!root) continue; for (const t of v.deepElements(root, isTrigger) as HTMLElement[]) if (t.getAttribute('aria-expanded') === 'false') { t.click(); closed.push(t); } }
      if (closed.length === 0) return {} as Record<string, { text: string; leaves: string[] }>;
      await new Promise((r) => setTimeout(r, 700));
      const out: Record<string, { text: string; leaves: string[] }> = {};
      for (const h of sections) {
        const root = v.sectionRoot(h) as Element | null;
        if (!root || v.deepElements(root, isTrigger).length === 0) continue;
        const leaves: string[] = []; v.walk(root, (n: Node) => { if (n.nodeType === 3) { const t = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim().toLowerCase(); if (t) leaves.push(t); } });
        out[h.getAttribute('data-pv-section') as string] = { text: v.deepText(root), leaves: Array.from(new Set(leaves)) };
      }
      for (const t of closed) if (t.getAttribute('aria-expanded') === 'true') t.click();
      await new Promise((r) => setTimeout(r, 700));
      return out;
    });
    for (const r of rendered as Array<{ id: string; text?: string; leaves?: string[] }>) { const o = openedText[r.id]; if (o) { r.text = o.text; r.leaves = o.leaves; } }
    // a hand-authored section is compared on what a visitor can read, by the same code that measured the original
    const visibleBySection = new Map<string, string>();
    for (const id of Object.keys(overrides)) {
      const h = await page.evaluateHandle((sid) => { const host = document.querySelector(`[data-pv-section="${sid}"]`); return host ? (window as any).__pvVerify.sectionRoot(host) : null; }, id);
      const el = h.asElement();
      if (el) visibleBySection.set(id, await el.evaluate(visibleTextOf));
    }
    for (const section of input.extraction.sections) {
      const r = rendered.find((x) => x.id === section.id);
      const isOverride = !!overrides[section.id];
      if (!r || !r.ok) { add('content', `content.${section.id}`, `Section "${section.name}" renders`, 'fail', 'the section is not rendered'); continue; }
      // a hand-authored section may keep its closed menus empty, so it is compared on what a visitor can read
      const baselineText = isOverride ? section.visibleText : section.text;
      const gotText = isOverride ? (visibleBySection.get(section.id) ?? '') : (r.text ?? '');
      const similarity = jaccard(shingles(baselineText), shingles(gotText));
      // A carousel's repeated slides (Swiper's loop duplicates on the original, the generator's own seamless clones in the preview — carousel.ts) are counted
      // differently, so the two texts differ in LENGTH while every original passage is there. "All original text is present" is then decided on presence:
      // every distinct text node of the original must occur in the preview. Text that is really missing still fails.
      const exactText = squeeze(gotText) === squeeze(baselineText);
      const gotLeaves = new Set((r.leaves ?? []) as string[]);
      const missingLeaves = exactText ? [] : [...leafTexts(section.tree)].filter((t) => !gotLeaves.has(t));
      const allPresent = !exactText && !isOverride && gotLeaves.size > 0 && missingLeaves.length === 0;
      const textOk = isOverride ? similarity >= 0.9 : exactText || allPresent;
      add('content', `content.${section.id}.text`, `"${section.name}": all original text is present${isOverride ? ' (hand-authored section: visible text, ≥90% similarity)' : ''}`, textOk ? 'pass' : 'fail',
        textOk ? (allPresent ? `every passage of the original is present; repeated carousel slides are counted differently (original ${squeeze(baselineText).length} characters, preview ${squeeze(gotText).length})` : `${squeeze(baselineText).length} characters, whitespace-insensitive`) : `original ${squeeze(baselineText).length} characters, preview ${squeeze(gotText).length}; similarity ${(similarity * 100).toFixed(0)}%${missingLeaves.length ? `; ${missingLeaves.length} original text(s) not found, e.g. "${missingLeaves[0]!.slice(0, 60)}"` : ''}`);
      const hrefKey = hrefKeyFor(input.siteBase);
      const origLinks = section.links.map(hrefKey).sort();
      const gotLinks = ((r.links ?? []) as string[]).map(hrefKey).sort();
      const linksOk = isOverride ? jaccard(origLinks, gotLinks) >= 0.9 : JSON.stringify(origLinks) === JSON.stringify(gotLinks);
      add('content', `content.${section.id}.links`, `"${section.name}": every original link is present with its destination`, linksOk ? 'pass' : 'fail', `${origLinks.length} original link(s), ${gotLinks.length} in the preview`);
      const imgOk = (r.images ?? 0) >= section.images && (r.imagesLoaded ?? 0) === (r.images ?? 0);
      add('content', `content.${section.id}.images`, `"${section.name}": every image is present and loads`, imgOk ? 'pass' : 'fail', `${section.images} original image(s); ${r.images ?? 0} rendered, ${r.imagesLoaded ?? 0} loaded`);
      const headOk = JSON.stringify(section.headings.map(squeeze)) === JSON.stringify((r.headings ?? []).map((h: string) => squeeze(h))) || (isOverride && jaccard(section.headings.flatMap((h) => shingles(h)), (r.headings ?? []).flatMap((h: string) => shingles(h))) >= 0.9);
      add('content', `content.${section.id}.headings`, `"${section.name}": the heading structure is preserved`, headOk ? 'pass' : 'fail', `${section.headings.length} original heading(s); ${(r.headings ?? []).length} rendered`);
      const tol = isOverride ? 0.15 : section.id.startsWith('region-') ? 0.1 : 0.1;
      const heightOk = section.height === 0 || Math.abs((r.height ?? 0) - section.height) / section.height <= tol;
      // The original's height is read from the offline snapshot, where a <video> has no loaded size (it collapses to its container), so a section with a video
      // can measure shorter there than on the live page (Sweet Spot: 456px offline, 690px live and in the preview). That is not evidence of a layout change, and
      // it is not evidence of a match either: it is reported NOT checked, never passed.
      const videoUnsized = !heightOk && treeHasTag(section.tree, 'video');
      add('content', `content.${section.id}.height`, `"${section.name}": rendered height is within ${(tol * 100).toFixed(0)}% of the original`, heightOk ? 'pass' : videoUnsized ? 'not-checked' : 'fail', videoUnsized ? `original ${section.height}px was measured on an offline snapshot where the section's <video> has no loaded size; preview ${r.height ?? 0}px — compare on the live original` : `original ${section.height}px, preview ${r.height ?? 0}px`);
    }

    // ── contrast: every readable run, measured on real pixels, compared with the original page ─────────────
    let contrastReport: ContrastReport | undefined;
    let contrastRowsAll: ContrastRow[] = [];
    let contrastUnstable = false;
    try {
      const cp = await ctx.newPage();
      let previewMeasured: Awaited<ReturnType<typeof measureSectionsContrast>> = [];
      try {
        await cp.setViewportSize({ width: 1440, height: 900 });
        await cp.goto(input.url, { waitUntil: 'networkidle' });
        const targets = [];
        for (const sec of input.extraction.sections) { const h = await cp.$(`[data-pv-section="${sec.id}"]`); if (h) targets.push({ id: sec.id, root: h }); }
        previewMeasured = await measureSectionsContrast(cp, targets);
      } finally { await cp.close(); }
      contrastUnstable = previewMeasured.some((x) => x.unstable);
      let originalMeasured: Awaited<ReturnType<typeof measureSectionsContrast>> | null = null;
      if (input.originalHtml) {
        const octx = await input.browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } });
        try {
          const op = await octx.newPage();
          await op.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
          await op.setContent(input.originalHtml, { waitUntil: 'domcontentloaded' });
          await op.waitForTimeout(800);
          const otargets = [];
          for (const sec of input.extraction.sections) { const h = await op.$(`[data-fra-section="${sec.id}"]`); if (h) otargets.push({ id: sec.id, root: h }); }
          originalMeasured = await measureSectionsContrast(op, otargets);
        } finally { await octx.close(); }
      }
      const prevRuns = previewMeasured.flatMap((x) => x.measured);
      contrastRowsAll = classifyRuns(prevRuns, originalMeasured ? originalMeasured.flatMap((x) => x.measured) : null);
      const failing = contrastRowsAll.filter((r) => !r.passesAAA).sort((a, b) => a.ratio - b.ratio);
      const muted = contrastRowsAll.filter((r) => r.muted);
      contrastReport = {
        gate: 'AA', measuredRuns: prevRuns.length, unmeasuredRuns: previewMeasured.reduce((n, x) => n + x.unmeasured, 0),
        failAA: contrastRowsAll.filter((r) => !r.passesAA).length, failAAA: failing.length,
        regressions: contrastRowsAll.filter((r) => r.verdict === 'regression').length, inherited: contrastRowsAll.filter((r) => r.verdict === 'inherited').length, unbaselined: contrastRowsAll.filter((r) => r.verdict === 'unbaselined').length,
        mutedRuns: muted.length, mutedBelowAA: muted.filter((r) => !r.passesAA).length, mutedBelowAAA: muted.filter((r) => !r.passesAAA).length, rows: failing,
      };
    } catch (err) {
      log(`contrast measurement failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    const acceptedFor = (ids: string[]) => ids.length > 0 && ids.every((id) => !!input.decisions?.findings[id]?.acceptContrast);
    const gating = contrastRowsAll.filter((r) => (r.verdict === 'regression' || r.verdict === 'unbaselined') && !acceptedFor(r.findingIds));
    const measured = contrastMeasuredCheck(contrastReport, contrastUnstable, !!input.originalHtml);
    add('contrast', 'contrast.measured', 'Text contrast was measured on the rendered preview', measured.status, measured.detail);
    if (contrastReport && measured.status === 'pass') {
      const fixIds = new Set(input.fixFindings.map((f) => f.identity.findingId));
      const gatingFix = gating.filter((r) => r.findingIds.some((id) => fixIds.has(id)));
      const line = (r: ContrastRow) => `${r.section}: "${r.text.slice(0, 40)}" ${r.ratio}:1 (needs ${r.required}:1${r.baselineRatio !== null ? `; the original measures ${r.baselineRatio}:1` : ''})`;
      add('contrast', 'contrast.fix-findings-legible', 'Text inside every Fix finding is legible (WCAG AA) and no worse than the original', gatingFix.length === 0 ? 'pass' : 'fail', gatingFix.length ? gatingFix.slice(0, 4).map(line).join(' | ') : 'every Fix finding element that holds text meets AA, or is no worse than the original');
      const gatingOther = gating.filter((r) => !r.findingIds.some((id) => fixIds.has(id)));
      add('contrast', 'contrast.no-regression', 'No other text became less legible than on the original page', gatingOther.length === 0 ? 'pass' : 'fail', gatingOther.length ? `${gatingOther.length} run(s): ${gatingOther.slice(0, 4).map(line).join(' | ')}` : 'no run is below AA where the original was legible, and none is clearly worse than its original');
      const inh = contrastReport.inherited;
      add('contrast', 'contrast.inherited', 'Text below AA that is inherited unchanged from the original page', inh === 0 && contrastReport.failAA === 0 ? 'pass' : 'not-checked', `${contrastReport.failAA} run(s) are below AA (${inh} inherited from the original, ${contrastReport.regressions} introduced, ${contrastReport.unbaselined} without an original counterpart); ${contrastReport.failAAA} miss the design system's 7:1 rule R7.1; muted labels: ${contrastReport.mutedBelowAA}/${contrastReport.mutedRuns} below AA, ${contrastReport.mutedBelowAAA}/${contrastReport.mutedRuns} below 7:1. Inherited text is left as designed — it is outside the selected findings. Rows are in verification.json → contrast.`);
    }

    // ── Fix findings, measured ──────────────────────────────────────────────────────────
    const findings: FindingOutcome[] = [];
    const targetResults: NonNullable<PreviewVerification['targetResults']> = [];
    for (const f of input.fixFindings) {
      const id = f.identity.findingId;
      const route = input.routes.get(id);
      const base = { findingId: id, section: f.location.section, type: f.component.productionType, label: (f.component.productionLabel ?? '').slice(0, 60) };
      const decision = input.decisions?.findings[id];
      // a user style rule (user-style-rules.json) on the finding's element supersedes the audit's expectation for the properties it names: the USER's value is measured
      const userPairs = parseUserStyle(await page.evaluate((fid) => (window as any).__pvVerify?.findByFinding(fid)?.getAttribute('data-pv-user-style') ?? null, id).catch(() => null));
      const userOverridden = new Map<string, string>();
      const mismatches: Array<{ property: string; expected: string; comparison: 'exact' | 'color-deltaE' | 'length-px' | 'unsupported' }> = [];
      for (const m of f.comparison.mismatches) {
        const comparison = m.comparison as 'exact' | 'color-deltaE' | 'length-px' | 'unsupported';
        const u = userPairs.find(([p]) => coveredProperties(p).has(m.property.trim().toLowerCase()));
        if (!u) { mismatches.push({ property: m.property, expected: m.expected, comparison }); continue; }
        userOverridden.set(m.property, m.expected ?? '');
        // the user's value (0, transparent, var(--token)) as the browser computes it for this property, so it is compared like any other expectation
        const resolved = await page.evaluate(([fid, prop, val]) => {
          const el = (window as any).__pvVerify?.findByFinding(fid) as Element | null;
          if (!el) return val as string;
          const probe = document.createElement('span');
          probe.style.setProperty(prop as string, val as string);
          (el.parentElement ?? el).appendChild(probe);
          const out = getComputedStyle(probe).getPropertyValue(prop as string);
          probe.remove();
          return out || (val as string);
        }, [id, m.property, u[1]] as const).catch(() => u[1]);
        mismatches.push({ property: m.property, expected: resolved, comparison });
      }
      const island = input.islands.find((i) => i.findingIds.includes(id));
      const plannerReason = input.plannerGaps?.get(id);
      // a recorded decision that says "unresolved" or "preserve" is the answer: say so, do not measure a wrapper the decision explains away
      if (decision?.resolution === 'unresolved') {
        findings.push({ ...base, status: 'unresolved', route: (route?.route ?? 'none') as FindingOutcome['route'], reported: 'decision', detail: `recorded decision: ${decision.note ?? 'unresolved, no note'}` });
        continue;
      }
      const m = await measure(page, id, mismatches);
      const faces = typefaceRuleChecks(f);
      for (const c of faces) {
        const t = await measureTypeface(page, id, c.offending);
        if (t.row) m.rows.push(t.row);
      }
      // ── resolved targets (the Resolver's): the audit's own expectations are measured above; the others here, in their state
      const mine = input.resolution?.targets.filter((t) => t.findingId === id) ?? [];
      const resolvedMine = mine.filter((t) => t.outcome === 'resolved-target');
      const extraMeasured = [];
      if (m.found) for (const t of resolvedMine.filter((x) => x.provenance.kind !== 'audit-expected')) extraMeasured.push(await measureResolvedTarget(page, t));
      for (const x of extraMeasured) if (x.measured) m.rows.push({ property: `${x.property}${x.state === 'default' ? '' : ` [${x.state}]`}`, actual: x.actual ?? '', expected: x.expected, matches: x.matches, note: x.note });
      const openExtra = extraMeasured.filter((x) => !x.measured);
      // per-target verification statuses: verified against the AUDIT's target, against a separately RESOLVED target, failed, or unverified
      const stat = (targetId: string, verification: VerificationStatus, detail: string) => targetResults.push({ targetId, findingId: id, verification, detail });
      for (const t of resolvedMine) {
        if (t.provenance.kind === 'audit-expected') {
          const row = m.rows.find((r) => r.property === (t.part === 'self' ? t.property : `${t.part}.${t.property}`));
          if (!m.found || !row) stat(t.id, 'unverified', m.found ? 'the audit property was not measured in the preview' : 'no element carrying this finding is rendered in the preview');
          else stat(t.id, row.matches ? 'verified-original-target' : 'failed', userOverridden.has(t.property) ? `rendered ${row.actual}; the user style rule expects ${row.expected} (it supersedes the audit's ${userOverridden.get(t.property)})` : `rendered ${row.actual}; the audit expects ${row.expected}`);
        } else {
          const x = extraMeasured.find((e) => e.targetId === t.id);
          if (!x) stat(t.id, 'unverified', 'no element carrying this finding is rendered in the preview');
          else if (!x.measured) stat(t.id, 'unverified', x.note);
          else stat(t.id, x.matches ? 'verified-resolved-target' : 'failed', `rendered ${x.actual}; the resolved target is ${x.expected} (${t.provenance.kind})`);
        }
      }
      const tally = { resolved: resolvedMine.length, verified: 0, failed: 0, unmeasurable: openExtra.length + (m.found ? 0 : resolvedMine.length), preserved: mine.filter((t) => t.outcome === 'preserve-existing').length, unresolved: mine.filter((t) => t.outcome === 'unresolved').length };
      for (const r of targetResults.filter((x) => x.findingId === id)) { if (r.verification === 'verified-original-target' || r.verification === 'verified-resolved-target') tally.verified++; else if (r.verification === 'failed') tally.failed++; }
      const targetsField = mine.length ? { targets: tally } : {};
      const measurable = mismatches.length + faces.length + extraMeasured.filter((x) => x.measured).length;
      const where = (route?.route ?? 'none') as FindingOutcome['route'];
      // an element that is not rendered cannot be "kept by decision": absence is not preservation
      if (!m.found) {
        findings.push({ ...base, ...targetsField, status: 'not-represented', route: where, ...(plannerReason ? { reported: 'planner' as const } : {}), detail: route?.route === 'none' && !route.stamp ? 'the audit element could not be mapped to a live element, so it has no counterpart in the captured markup (e.g. a control inside a closed panel)' : 'no element carrying this finding is rendered in the preview' });
        continue;
      }
      if (decision?.resolution === 'preserve-existing') {
        findings.push({ ...base, ...targetsField, status: 'preserved-by-decision', route: where, reported: 'decision', detail: `a recorded decision keeps the original (${decision.note ?? 'no note'})${m.rows.some((r) => !r.matches) ? `; ${m.rows.filter((r) => !r.matches).length}/${m.rows.length} audit target(s) deliberately not applied` : ''}` });
        continue;
      }
      if (measurable === 0 && openExtra.length === 0) {
        const preserved = mine.filter((t) => t.outcome === 'preserve-existing'), open = mine.filter((t) => t.outcome === 'unresolved');
        const reasons = (ts: ResolutionFile['targets']) => [...ts.reduce((a, t) => a.set(t.reason, (a.get(t.reason) ?? 0) + 1), new Map<string, number>())].map(([r, n]) => `${r} ×${n}`).join(', ');
        if (decision) findings.push({ ...base, ...targetsField, status: 'applied-unverified', route: where, reported: 'decision', detail: `design decision "${decision.resolution}" recorded${decision.note ? ` (${decision.note})` : ''}; the audit has no measurable mismatch, so nothing could be measured` });
        else if (mine.length > 0) findings.push({ ...base, ...targetsField, status: open.length === 0 ? 'preserved-by-decision' : 'unresolved', route: where, reported: 'resolver', detail: `the Resolver changed nothing: ${preserved.length} propert(y/ies) preserved (${reasons(preserved) || '—'})${open.length ? `, ${open.length} unresolved (${reasons(open)})` : ''}` });
        else findings.push({ ...base, status: 'unresolved', route: where, ...(plannerReason ? { reported: 'planner' as const } : {}), detail: plannerReason ? `no measurable mismatch; the planner left it unaddressed: ${plannerReason}` : 'no measurable mismatch and no design decision recorded: the original markup is kept, not claimed as fixed' });
        continue;
      }
      const bad = m.rows.filter((r) => !r.matches);
      const good = m.rows.length - bad.length;
      if (bad.length === 0 && openExtra.length === 0) findings.push({ ...base, ...targetsField, status: island ? 'component-verified' : 'fixed-verified', route: where, detail: `${m.rows.length} measured propert${m.rows.length === 1 ? 'y' : 'ies'} match the audit's expected values${extraMeasured.length ? ` and ${extraMeasured.length} resolved target(s)` : ''}${faces.length ? ` and its typeface rule (${faces.map((c) => c.ruleId).join(', ')})` : ''}${island ? ` (DS ${island.spec.component} mounted)` : ''}${tally.unresolved ? `; ${tally.unresolved} propert(y/ies) remain unresolved (not changed)` : ''}` });
      else {
        const why = decision ? `recorded decision "${decision.resolution}"${decision.note ? ` (${decision.note})` : ''}` : plannerReason ? `the planner left part of it unaddressed (${plannerReason})` : null;
        const openNote = openExtra.length ? `${openExtra.length} resolved target(s) could not be measured: ${openExtra.slice(0, 2).map((x) => `${x.property} (${x.note})`).join('; ')}` : '';
        // an unmeasurable target is only EXPLAINED when its implementation status already says why (blocked / not representable)
        const explainedByResolver = bad.length === 0 && openExtra.length > 0 && openExtra.every((x) => input.resolution?.targets.find((t) => t.id === x.targetId)?.status.implementation === 'blocked');
        findings.push({ ...base, ...targetsField, status: good > 0 && input.resolution ? 'partially-verified' : 'unresolved', route: where, ...(decision ? { reported: 'decision' as const } : plannerReason ? { reported: 'planner' as const } : explainedByResolver ? { reported: 'resolver' as const } : {}), detail: `${[bad.length ? `${bad.length}/${m.rows.length} not matching: ${bad.slice(0, 3).map((r) => `${r.property} is ${r.actual}, expected ${r.expected}`).join('; ')}` : '', openNote].filter(Boolean).join('; ')}${why ? ` — ${why}` : ''}` });
      }
    }
    // preserve decisions: a finding that breaks something it was told to keep is never fixed; decisions without evidence are surfaced, not hidden
    if (input.preserveResults) {
      reconcilePreserve(findings, input.resolution ?? null, input.preserveResults);
      for (const r of input.preserveResults) targetResults.push({ targetId: r.targetId, findingId: r.findingId, verification: r.verification, detail: r.detail });
    }
    // finding-level legibility: matching the audit's values is not enough if the finding's own text cannot be read
    for (const o of findings) {
      const rows = contrastRowsAll.filter((r) => r.findingIds.includes(o.findingId));
      if (rows.length === 0) continue;
      const worst = rows.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
      const baselines = rows.map((r) => r.baselineRatio).filter((x): x is number => x !== null);
      o.contrast = { ratio: worst.ratio, required: worst.required, passes: rows.every((r) => r.passesAA), baselineRatio: baselines.length ? Math.min(...baselines) : null, runs: rows.length, text: worst.text };
      const bad = rows.filter((r) => (r.verdict === 'regression' || r.verdict === 'unbaselined') && !r.passesAA);
      if (bad.length === 0) continue;
      const accepted = input.decisions?.findings[o.findingId]?.acceptContrast;
      const msg = `text contrast ${worst.ratio}:1 is below ${worst.required}:1${o.contrast.baselineRatio !== null ? ` (the original page measures ${o.contrast.baselineRatio}:1)` : ''}`;
      if (accepted) { o.reported = 'decision'; o.detail += ` — ${msg}; accepted by a recorded decision: ${accepted}`; continue; }
      if (o.status === 'fixed-verified' || o.status === 'component-verified' || o.status === 'applied-unverified' || o.status === 'partially-verified') o.status = 'unresolved';
      o.detail = `${o.status === 'unresolved' ? 'the audit values match, but the text is not legible: ' : ''}${msg}${o.detail ? ` — ${o.detail}` : ''}`;
    }
    const fixedN = findings.filter((x) => x.status === 'fixed-verified' || x.status === 'component-verified').length;
    const unexplainedGaps = findings.filter((x) => (x.status === 'unresolved' || x.status === 'partially-verified') && !x.reported && (/not matching|could not be measured/.test(x.detail) || (x.contrast && !x.contrast.passes)));
    add('ds-fix', 'ds-fix.every-finding-accounted', 'Every Fix finding is accounted for (rendered, preserved by decision, or listed as not represented)', findings.length === input.fixFindings.length ? 'pass' : 'fail', `${findings.length}/${input.fixFindings.length} findings have an outcome`);
    add('ds-fix', 'ds-fix.measured', 'Fix findings with measurable mismatches match the audit’s expected values in the rendered preview', unexplainedGaps.length === 0 ? 'pass' : 'fail',
      `${fixedN} verified by measurement; ${unexplainedGaps.length} measured, not matching (or not legible) and not explained by a decision or a recorded conflict; ${findings.filter((x) => (x.status === 'unresolved' || x.status === 'partially-verified') && x.reported).length} unresolved/partial but explained`);
    const preserveSummary = input.preserveResults ? summarizePreserve(input.preserveResults) : null;
    if (preserveSummary) { const pc = preserveCheck(preserveSummary); add('ds-fix', 'ds-fix.preserved-unchanged', 'Properties the Resolver kept are verified unchanged from positive evidence', pc.status, pc.detail); }
    add('ds-fix', 'ds-fix.no-silent-gaps', 'Findings that are not verified fixed are reported with a reason', 'pass', `${findings.filter((x) => !['fixed-verified', 'component-verified'].includes(x.status)).length} finding(s) are not verified fixed: ${[...new Set(findings.filter((x) => !['fixed-verified', 'component-verified'].includes(x.status)).map((x) => x.status))].join(', ') || 'none'}`);
    for (const s of input.skippedIslands) log(`island skipped: ${s.reason}`);
    const blackPrimary = await page.evaluate(() => Array.from(document.querySelectorAll('[data-pv-section] [data-variant="primary"], [data-pv-section][data-variant="primary"]')).length);
    add('ds-fix', 'ds-fix.no-black-primary-cta', 'No design-system Button "primary" (the prohibited black CTA) is mounted', blackPrimary === 0 ? 'pass' : 'fail', `${blackPrimary} found`);

    // ── interaction parity ──────────────────────────────────────────────────────────────
    let interactions: InteractionResult[] = [];
    let previewBehavior: SectionBehavior[] = [];
    if (!input.originalBehavior) {
      add('interaction', 'interaction.parity', 'Interactions behave as on the original page', 'not-checked', 'the original page’s behaviour was not captured for this run, so interaction parity could not be verified');
    } else {
      const targets = input.extraction.sections.map((s) => ({
        id: s.id,
        getRoot: async (p: Page) => { await p.evaluate(HELPERS); const h = await p.evaluateHandle((id) => { const host = document.querySelector(`[data-pv-section="${id}"]`); return host ? (window as any).__pvVerify.sectionRoot(host) : null; }, s.id); return h.asElement(); },
      }));
      const probed = await probeSections(page, targets, { reload: async () => { await page.goto(input.url, { waitUntil: 'networkidle' }); await page.evaluate(HELPERS); }, maxReloads: 12, log });
      previewBehavior = probed.sections;
      interactions = compareBehavior(input.originalBehavior.sections, previewBehavior, { overrideSectionIds: new Set(Object.keys(overrides)), ...(input.siteBase ? { siteBase: input.siteBase } : {}) });
      const mism = interactions.filter((r) => r.verdict === 'mismatch');
      const unav = interactions.filter((r) => r.verdict === 'unavailable');
      const notProbed = interactions.filter((r) => r.verdict === 'not-probed');
      const matched = interactions.filter((r) => r.verdict === 'match');
      add('interaction', 'interaction.parity', 'Probed interactions behave as on the original page', mism.length === 0 ? 'pass' : 'fail', `${matched.length} match, ${unav.length} not reproduced, ${mism.length} behave differently${notProbed.length ? `, ${notProbed.length} not probed (hand-authored controls)` : ''}, out of ${interactions.length}`);
      add('interaction', 'interaction.unavailable-listed', 'Behaviour that is not reproduced is listed for the reviewer', 'pass', unav.length ? `${unav.length} item(s) listed on the preview's notes and at G2` : 'nothing to list');
    }

    // ── popup controls (selects/comboboxes): opened and used the way a visitor does ─────────────────────────
    let popupControls: PopupControlResult[] = [];
    let popupFailure: string | null = null;
    try {
      const pp = await ctx.newPage();
      try {
        await pp.setViewportSize({ width: 1440, height: 900 });
        await pp.goto(input.url, { waitUntil: 'networkidle' });
        popupControls = await checkPopupControls(pp, input.extraction.sections.map((x) => x.id));
      } finally { await pp.close(); }
    } catch (err) {
      popupFailure = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      log(`popup-control check failed: ${popupFailure}`);
    }
    if (popupFailure !== null) {
      // a probe that crashed measured nothing: that is missing required evidence (an unverified gap), never "no select or combobox control here"
      add('interaction', 'interaction.popup-controls', 'Select / combobox controls open and can be used', 'not-checked', `the popup-control probe failed, so selects and comboboxes could not be verified: ${popupFailure}`);
    } else if (popupControls.length === 0) {
      add('interaction', 'interaction.popup-controls', 'Select / combobox controls open and can be used', 'pass', 'no select or combobox control in these sections');
    } else {
      const bad = (f: (c: PopupControlResult) => boolean) => popupControls.filter(f).map((c) => `${c.section.slice(0, 18)}: "${c.label}"`);
      const noOpen = bad((c) => !c.clickOpens || c.optionsVisible === 0 || !c.panelFilled || !c.escapeCloses);
      add('interaction', 'interaction.popup-controls', 'Selects open on click with visible, readable options over a painted panel, and close on Escape', noOpen.length === 0 ? 'pass' : 'fail',
        noOpen.length ? `${noOpen.length}/${popupControls.length} fail: ${popupControls.filter((c) => !c.clickOpens || c.optionsVisible === 0 || !c.panelFilled || !c.escapeCloses).slice(0, 4).map((c) => `"${c.label}" (opens ${c.clickOpens}, options visible ${c.optionsVisible}/${c.optionsInDom}, panel painted ${c.panelFilled}, Escape closes ${c.escapeCloses})`).join('; ')}` : `${popupControls.length} control(s): ${popupControls.map((c) => `"${c.label}" ${c.optionsVisible}/${c.optionsInDom} options visible`).join('; ')}`);
      const noKey = bad((c) => !c.keyboard.enter || !c.keyboard.space || !c.keyboard.arrowDown || c.keyboardSelects === false || c.clickSelects === false);
      add('interaction', 'interaction.popup-controls-keyboard', 'Selects open with Enter, Space and ArrowDown, and an option can be chosen by keyboard and by click', noKey.length === 0 ? 'pass' : 'fail',
        noKey.length ? `${noKey.length}/${popupControls.length} fail: ${popupControls.filter((c) => !c.keyboard.enter || !c.keyboard.space || !c.keyboard.arrowDown || c.keyboardSelects === false || c.clickSelects === false).slice(0, 4).map((c) => `"${c.label}" (Enter ${c.keyboard.enter}, Space ${c.keyboard.space}, ArrowDown ${c.keyboard.arrowDown}, keyboard pick ${c.keyboardSelects}, click pick ${c.clickSelects})`).join('; ')}` : 'every control opens by all three keys and changes its value by keyboard and by click');
      const noFocus = bad((c) => !c.focusIndicator.present);
      add('interaction', 'interaction.popup-controls-focus', 'Selects show a focus indicator when keyboard-focused', noFocus.length === 0 ? 'pass' : 'fail', noFocus.length ? `no visible change on focus: ${noFocus.join(', ')}` : 'each control (or its frame) changes when keyboard-focused');
    }

    // ── section-authored checks: a hand-authored override may ship its own behavioural checks (price maths, accordion rules…) ──
    if (input.customChecksFile && existsSync(input.customChecksFile)) {
      try {
        const mod = (await import(`${input.customChecksFile}?t=${Date.now()}`)) as { default?: (page: Page, ctx: { url: string; add: (c: { id: string; name: string; status: 'pass' | 'fail' | 'not-checked'; detail: string }) => void }) => Promise<void> };
        if (typeof mod.default !== 'function') throw new Error('the checks module has no default export function');
        await mod.default(page, { url: input.url, add: (c) => add('interaction', `custom.${c.id}`, c.name, c.status, c.detail) });
      } catch (err) {
        add('interaction', 'custom.load', 'Section-authored checks ran', 'fail', `preview-overrides/checks.mjs failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await page.goto(input.url, { waitUntil: 'networkidle' });
    }

    // ── runtime hygiene ─────────────────────────────────────────────────────────────────
    const origin = new URL(input.url).host;
    const external = [...new Set(requests.map((u) => { try { return new URL(u).host; } catch { return ''; } }))].filter((h) => h && h !== origin);
    add('runtime', 'runtime.no-external-requests', 'The preview contacts nothing but itself (no production, analytics, fonts or third-party calls)', external.length === 0 ? 'pass' : 'fail', external.length ? `external hosts: ${external.join(', ')}` : `${requests.length} request(s), all to ${origin}`);
    add('runtime', 'runtime.no-console-errors', 'No console or page errors', consoleErrors.length === 0 ? 'pass' : 'fail', consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'clean');
    const overflow: Array<{ w: number; scrollW: number }> = [];
    // each width is a fresh load at that width — what a visitor on that device gets; the probes above deliberately open menus and move things
    for (const w of [1440, 390]) {
      const p = await ctx.newPage();
      try {
        await p.setViewportSize({ width: w, height: 900 });
        await p.goto(input.url, { waitUntil: 'networkidle' });
        await p.waitForTimeout(250);
        overflow.push({ w, scrollW: await p.evaluate(() => document.documentElement.scrollWidth) });
      } finally { await p.close(); }
    }
    add('runtime', 'runtime.no-horizontal-overflow', 'No horizontal overflow at 1440px and 390px', overflow.every((o) => o.scrollW <= o.w) ? 'pass' : 'fail', overflow.map((o) => `${o.w}px → ${o.scrollW}px`).join(', '));
    add('runtime', 'runtime.assets', 'Every referenced asset was embedded or downloaded', input.generation.assetsFailed.length === 0 && input.generation.remoteLeft.length === 0 ? 'pass' : 'fail', `${input.generation.assetsFailed.length} download failure(s), ${input.generation.remoteLeft.length} URL(s) left pointing at the site`);

    const unavailable = unavailableSummary(interactions);
    const passed = checks.filter((c) => c.status === 'pass').length;
    const failed = checks.filter((c) => c.status === 'fail').length;
    const result: PreviewVerification = {
      schemaVersion: PREVIEW_SCHEMA_VERSION, generatedAt: new Date().toISOString(), url: input.url, mode: input.mode, expectedSectionIds: input.expected.expectedSectionIds, renderedSectionIds: hosts,
      checks, findings, ...(targetResults.length ? { targetResults } : {}), ...(preserveSummary && preserveSummary.total > 0 ? { preserve: preserveSummary } : {}), interactions, unavailable, simulated: input.simulated, ...(contrastReport ? { contrast: contrastReport } : {}), ...(popupControls.length ? { popupControls } : {}),
      summary: { passed, failed, notChecked: checks.filter((c) => c.status === 'not-checked').length, findingsVerified: fixedN, findingsTotal: input.fixFindings.length, interactionsMatched: interactions.filter((r) => r.verdict === 'match').length, interactionsTotal: interactions.length, interactionsUnavailable: interactions.filter((r) => r.verdict === 'unavailable').length },
      verdict: 'pass',
    };
    // The verdict here is what THESE checks say: a failed check is FAIL, a gate that could not run (interaction parity, the preserve check, contrast) is INCOMPLETE.
    // Design/state fidelity and the resolved targets are not known yet - R8 finalizes the status with them (settleStatus) before anything is written.
    applyOverallStatus(result, checkGapsOf(result));
    return result;
  } finally {
    await ctx.close();
  }
}

/** Writes the status file the running preview fetches, into both public/ (source) and dist/ (what `vite preview` serves). */
export async function writePreviewStatus(previewDir: string, runId: string, mode: DesignMode, v: PreviewVerification, sections: readonly string[] = v.renderedSectionIds): Promise<void> {
  // the same verdict, counts and gaps as verification.json (statusFields reads the one status), so the running preview cannot say anything else
  const body = JSON.stringify({ runId, mode, sections, simulated: v.simulated, unavailable: v.unavailable, ...statusFields(v) }, null, 2);
  for (const dir of ['public', 'dist']) {
    const target = join(previewDir, dir, 'pv-status.json');
    if (dir === 'dist' && !existsSync(join(previewDir, 'dist'))) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

export { PROBE_LIB };
