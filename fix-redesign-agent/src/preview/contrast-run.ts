import type { ElementHandle, Page } from 'playwright';
import { decodePng, measureRun, textRunsInPage, type RunMeasurement, type TextRun } from './contrast.ts';

/**
 * Measures the text contrast of sections on a rendered page: the real runs (through shadow roots
 * and slots), each against the real pixels behind it (the section rendered with its text made
 * transparent). Used on the running React preview AND on the offline snapshot of the original, so a
 * contrast the redesign made worse can be told apart from one the original page already had.
 *
 * It scrolls, injects stylesheets and screenshots: run it on a page of its own, never on the page
 * the interaction probes used.
 */

export interface ContrastTarget { id: string; root: ElementHandle<Element> }

export interface SectionContrast {
  id: string;
  measured: RunMeasurement[];
  /** Runs found but not measurable (outside the screenshot, unparsable colour). Never counted as passing. */
  unmeasured: number;
  /** The text could not be hidden without moving the layout, or the page was not settled: nothing is reported as measured. */
  unstable: boolean;
  runs: number;
}

const FREEZE = '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}';
const HIDE_TEXT = '*,*::before,*::after,::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important;caret-color:transparent!important}svg text{fill:transparent!important}';

/** Adds (or removes) a stylesheet in the document and in every open shadow root; returns a handle id for removal. */
async function injectEverywhere(page: Page, css: string, key: string): Promise<void> {
  await page.evaluate(([cssText, k]) => {
    const w = window as unknown as { __pvSheets?: Record<string, CSSStyleSheet> };
    w.__pvSheets ??= {};
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText as string);
    w.__pvSheets[k as string] = sheet;
    const roots: Array<Document | ShadowRoot> = [document];
    const visit = (n: Element) => { if (n.shadowRoot) { roots.push(n.shadowRoot); n.shadowRoot.querySelectorAll('*').forEach(visit); } };
    document.querySelectorAll('*').forEach(visit);
    for (const r of roots) r.adoptedStyleSheets = [...r.adoptedStyleSheets, sheet];
  }, [css, key] as const);
}

async function removeEverywhere(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => {
    const w = window as unknown as { __pvSheets?: Record<string, CSSStyleSheet> };
    const sheet = w.__pvSheets?.[k];
    if (!sheet) return;
    const roots: Array<Document | ShadowRoot> = [document];
    const visit = (n: Element) => { if (n.shadowRoot) { roots.push(n.shadowRoot); n.shadowRoot.querySelectorAll('*').forEach(visit); } };
    document.querySelectorAll('*').forEach(visit);
    for (const r of roots) r.adoptedStyleSheets = r.adoptedStyleSheets.filter((s) => s !== sheet);
    delete w.__pvSheets![k];
  }, key);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const imgs: HTMLImageElement[] = [];
    const visit = (root: Document | ShadowRoot) => { root.querySelectorAll('img').forEach((i) => imgs.push(i)); root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) visit(e.shadowRoot); }); };
    visit(document);
    for (const i of imgs) i.loading = 'eager';
    await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
  await page.waitForTimeout(250);
}

export async function measureSectionsContrast(page: Page, targets: ContrastTarget[]): Promise<SectionContrast[]> {
  const out: SectionContrast[] = [];
  await injectEverywhere(page, FREEZE, 'freeze');
  try {
    for (const t of targets) {
      // scroll the section so that a scroll-linked section has reached its lit state, as a reader who has read down to its end would see it
      const geom = await t.root.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top + scrollY, height: r.height, vh: innerHeight }; });
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior }), Math.max(0, geom.top + geom.height - geom.vh * 0.7));
      await settle(page);
      const before = await t.root.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      const runs = (await t.root.evaluate(textRunsInPage, { section: t.id, origin: { x: before.x, y: before.y } })) as TextRun[];
      await injectEverywhere(page, HIDE_TEXT, 'hide-text');
      let shot: Buffer | null = null;
      let unstable = false;
      try {
        await page.waitForTimeout(80);
        const after = await t.root.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, px: r.left + scrollX, py: r.top + scrollY }; });
        unstable = Math.abs(after.w - before.w) > 1 || Math.abs(after.h - before.h) > 1 || Math.abs(after.y - before.y) > 1;
        // a clipped page screenshot, NOT locator.screenshot: that scrolls the element into view, which would change a scroll-linked section's state between the text runs and their pixels
        if (!unstable) shot = await page.screenshot({ clip: { x: after.px, y: after.py, width: after.w, height: after.h }, fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css' });
      } finally {
        await removeEverywhere(page, 'hide-text');
      }
      if (!shot) { out.push({ id: t.id, measured: [], unmeasured: runs.length, unstable: true, runs: runs.length }); continue; }
      const png = decodePng(shot);
      const measured: RunMeasurement[] = [];
      let unmeasured = 0;
      for (const run of runs) { const m = measureRun(run, png); if (m) measured.push(m); else unmeasured++; }
      out.push({ id: t.id, measured, unmeasured, unstable: false, runs: runs.length });
    }
  } finally {
    await removeEverywhere(page, 'freeze').catch(() => undefined);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export type RunVerdict = 'pass' | 'inherited' | 'regression' | 'unbaselined';

export interface ContrastRow {
  section: string;
  text: string;
  tag: string;
  color: string;
  background: string;
  /** 5th-percentile ratio over the pixels behind the run (the gating number) and the worst pixel. */
  ratio: number;
  worst: number;
  required: number;
  requiredAAA: number;
  large: boolean;
  muted: boolean;
  findingIds: string[];
  island: string | null;
  passesAA: boolean;
  passesAAA: boolean;
  /** The same run's ratio on the original page, when it could be matched. */
  baselineRatio: number | null;
  verdict: RunVerdict;
}

/**
 * Pairs each preview run with the same run of the original (same section, same text, in order) and says
 * what a failure means: `regression` (the original was legible and the preview is not, or it got clearly
 * worse), `inherited` (the original already fell short and the preview is no worse), or `unbaselined`
 * (no counterpart on the original to compare with). A run that meets AA is `pass`.
 */
export function classifyRuns(preview: RunMeasurement[], original: RunMeasurement[] | null): ContrastRow[] {
  const pool = new Map<string, RunMeasurement[]>();
  for (const o of original ?? []) { const k = `${o.run.section}|${norm(o.run.text)}`; pool.set(k, [...(pool.get(k) ?? []), o]); }
  const rows: ContrastRow[] = [];
  for (const m of preview) {
    const k = `${m.run.section}|${norm(m.run.text)}`;
    const base = original ? (pool.get(k)?.shift() ?? null) : null;
    let verdict: RunVerdict = 'pass';
    if (!m.passesAA) {
      if (!original || !base) verdict = 'unbaselined';
      else if (base.passesAA) verdict = 'regression';
      else verdict = m.p5 < base.p5 * 0.8 ? 'regression' : 'inherited';
    } else if (base && base.passesAAA && !m.passesAAA && m.p5 < base.p5 * 0.6) {
      // still legible, but far less so than the original (e.g. white text turned into 50% white)
      verdict = 'regression';
    }
    rows.push({
      section: m.run.section, text: m.run.text, tag: m.run.tag, color: m.run.color, background: m.background,
      ratio: Math.round(m.p5 * 100) / 100, worst: Math.round(m.worst * 100) / 100, required: m.aaRequired, requiredAAA: m.aaaRequired,
      large: m.aaRequired === 3, muted: m.run.muted, findingIds: m.run.findingIds, island: m.run.island,
      passesAA: m.passesAA, passesAAA: m.passesAAA, baselineRatio: base ? Math.round(base.p5 * 100) / 100 : null, verdict,
    });
  }
  return rows;
}
