import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { BrowserContext } from 'playwright';

/**
 * Records the original page's scroll-linked movement so the preview can replay it. READ-ONLY on production: one
 * navigation, scrolling only (no click, no submit); every non-GET request and every analytics/tracking call is aborted,
 * exactly like B1's probe. Only effects that are a pure function of the scroll offset are kept: each offset is sampled on
 * the way down and again on the way up, and an element whose value differs between the two (an autoplay carousel, a timer)
 * is NOT a scroll effect and is left out.
 */

export interface ScrollEffectRecord {
  className: string;
  tag: string;
  index: number;
  samples: Array<[number, number]>;
}

export interface ScrollEffectsFile {
  schemaVersion: 1;
  capturedAt: string;
  url: string;
  offsets: number[];
  effects: ScrollEffectRecord[];
  /** elements that move with scroll but are not a plain translateY — disclosed, not replayed */
  unsupported: Array<{ tag: string; className: string; reason: string }>;
  /** replayed, but only along the first-visit (downward) path: scrolling back up does not return to the same values on the original */
  approximated?: Array<{ tag: string; className: string; reason: string }>;
}

const ANALYTICS = /(google-analytics|googletagmanager|doubleclick|clarity\.ms|lfeeder|facebook\.(com|net)|hotjar|segment\.(io|com)|mixpanel|linkedin\.com\/px|snap\.licdn|ipapi\.co|pipedrive)/i;
export const SCROLL_OFFSETS = [0, 40, 80, 120, 160, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 800, 900, 1000, 1200];
const SETTLE_MS = 900; // the page eases its transforms over ~500 ms
const AGREE_PX = 1.5;
const MONO_PX = 1;

/**
 * Is this a scroll-driven movement? Pages often smooth it (a lerp), so going down and coming back up give slightly different
 * values at the same offset — that is still a scroll effect. What it must have: the same direction of change with the scroll
 * offset in BOTH sweeps (each monotonic in the offset), and the same value at both ends. A time-driven mover (marquee, timer)
 * changes in the same direction of TIME, so against the offset its sweeps run opposite ways and it is rejected.
 */
export function isScrollDriven(down: readonly number[], up: readonly number[]): boolean {
  if (down.length < 3 || down.length !== up.length) return false;
  const dir = Math.sign(down[down.length - 1]! - down[0]!);
  if (dir === 0) return false;
  const mono = (v: readonly number[]) => v.every((x, i) => i === 0 || (x - v[i - 1]!) * dir >= -MONO_PX);
  if (!mono(down) || !mono(up)) return false;
  return Math.abs(down[0]! - up[0]!) <= AGREE_PX && Math.abs(down[down.length - 1]! - up[up.length - 1]!) <= AGREE_PX;
}

/**
 * A scroll effect that remembers its path: going down it follows the scroll offset from the page's first-load value, but
 * scrolling back up does not return to that value (the page's handler reads the element's own, already moved, position — a
 * feedback loop). Accepted when both sweeps are monotonic in the SAME direction and agree where the page is scrolled down
 * (a time-driven mover does not: it keeps drifting, so the two sweeps end in different places). The preview replays the
 * first-visit (downward) path — what a visitor sees on load — and the record says the return path is not reproduced.
 */
export function isFirstVisitScrollDriven(down: readonly number[], up: readonly number[]): boolean {
  if (down.length < 3 || down.length !== up.length) return false;
  const dir = Math.sign(down[down.length - 1]! - down[0]!);
  if (dir === 0) return false;
  const mono = (v: readonly number[]) => v.every((x, i) => i === 0 || (x - v[i - 1]!) * dir >= -MONO_PX);
  if (!mono(down) || !mono(up)) return false;
  return Math.abs(down[down.length - 1]! - up[up.length - 1]!) <= AGREE_PX;
}

/** Parses `translateY(Npx)` / `translate3d(0, Npx, 0)` / `matrix(1,0,0,1,0,N)`; null for anything else. */
export function translateYOf(transform: string): number | null {
  const t = transform.trim();
  if (!t || t === 'none') return 0;
  let m = /^translateY\(\s*(-?[\d.]+)px\s*\)$/.exec(t);
  if (m) return Number(m[1]);
  m = /^translate3d\(\s*0(?:px)?\s*,\s*(-?[\d.]+)px\s*,\s*0(?:px)?\s*\)$/.exec(t);
  if (m) return Number(m[1]);
  m = /^matrix\(\s*1,\s*0,\s*0,\s*1,\s*0,\s*(-?[\d.]+)\s*\)$/.exec(t);
  if (m) return Number(m[1]);
  return null;
}

type Reading = { tag: string; className: string; index: number; transform: string };

export async function captureScrollEffects(context: BrowserContext, url: string, log: (line: string) => void = () => {}): Promise<ScrollEffectsFile> {
  const page = await context.newPage();
  try {
    await page.route('**/*', (route) => {
      const r = route.request();
      if (r.method() !== 'GET' || ANALYTICS.test(r.url())) return route.abort();
      return route.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const read = async (): Promise<Reading[]> =>
      page.evaluate(() => {
        const counts = new Map<string, number>();
        const out: Array<{ tag: string; className: string; index: number; transform: string }> = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
          const style = el.getAttribute('style') || '';
          if (!/transform/i.test(style)) continue;
          const tag = el.tagName.toLowerCase();
          const className = el.getAttribute('class') || '';
          const key = `${tag}|${className}`;
          const index = counts.get(key) ?? 0;
          counts.set(key, index + 1);
          out.push({ tag, className, index, transform: getComputedStyle(el).transform === 'none' ? 'none' : (el.style.transform || getComputedStyle(el).transform) });
        }
        return out;
      });
    const at = async (y: number): Promise<Reading[]> => {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(SETTLE_MS);
      return read();
    };
    const key = (r: Reading) => `${r.tag}|${r.className}|${r.index}`;
    const down = new Map<number, Reading[]>();
    for (const y of SCROLL_OFFSETS) down.set(y, await at(y));
    const up = new Map<number, Reading[]>();
    for (const y of [...SCROLL_OFFSETS].reverse()) up.set(y, await at(y));

    const effects: ScrollEffectRecord[] = [];
    const unsupported: ScrollEffectsFile['unsupported'] = [];
    const approximated: NonNullable<ScrollEffectsFile['approximated']> = [];
    const keys = new Set<string>();
    for (const rs of down.values()) for (const r of rs) keys.add(key(r));
    for (const k of keys) {
      const series: Array<{ y: number; d: Reading | undefined; u: Reading | undefined }> = SCROLL_OFFSETS.map((y) => ({ y, d: down.get(y)!.find((r) => key(r) === k), u: up.get(y)!.find((r) => key(r) === k) }));
      if (series.some((s) => !s.d || !s.u)) continue; // not present at every offset
      const first = series[0]!.d!;
      const dvals = series.map((s) => translateYOf(s.d!.transform));
      const uvals = series.map((s) => translateYOf(s.u!.transform));
      const distinctRaw = new Set(series.map((s) => s.d!.transform));
      if (distinctRaw.size < 3) continue; // does not move with scroll
      if (dvals.some((v) => v === null) || uvals.some((v) => v === null)) {
        unsupported.push({ tag: first.tag, className: first.className.slice(0, 80), reason: 'moves with scroll but is not a plain translateY' });
        continue;
      }
      // driven by the scroll offset (smoothing allowed): see isScrollDriven
      const record = (): ScrollEffectRecord => ({ className: first.className, tag: first.tag, index: first.index, samples: series.map((s, i) => [s.y, dvals[i] as number] as [number, number]) });
      if (isScrollDriven(dvals as number[], uvals as number[])) {
        effects.push(record());
      } else if (isFirstVisitScrollDriven(dvals as number[], uvals as number[])) {
        effects.push(record());
        approximated.push({ tag: first.tag, className: first.className.slice(0, 80), reason: 'follows the scroll offset on the way down; on the way back up it does not return to its first-load value — the preview replays the first-visit path only' });
      } else {
        // it moves while scrolling but is not a function of the offset (time-driven, or order-dependent): say so instead of dropping it silently
        unsupported.push({ tag: first.tag, className: first.className.slice(0, 80), reason: 'changes while scrolling but not as a function of the scroll offset (time-driven or path-dependent) — not replayed' });
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    log(`scroll effects · ${effects.length} scroll-linked element(s) recorded (${approximated.length} first-visit path only), ${unsupported.length} unsupported`);
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), url, offsets: SCROLL_OFFSETS, effects, unsupported, approximated };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Captured once per run (the file is reused on resume). A failure returns an empty record and says so; it never stops the run. */
export async function ensureScrollEffects(args: { path: string; context: BrowserContext; url: string; log?: (line: string) => void }): Promise<ScrollEffectsFile> {
  const log = args.log ?? (() => {});
  if (existsSync(args.path)) {
    try {
      const f = JSON.parse(await readFile(args.path, 'utf8')) as ScrollEffectsFile;
      if (f.schemaVersion === 1 && f.url === args.url) return f;
    } catch {
      /* unreadable: capture again */
    }
  }
  try {
    const f = await captureScrollEffects(args.context, args.url, log);
    await writeFile(args.path, JSON.stringify(f, null, 1));
    return f;
  } catch (err) {
    log(`scroll effects · could not be recorded (${(err as Error).message.slice(0, 120)}) — scroll-linked movement will be reported as not reproduced`);
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), url: args.url, offsets: SCROLL_OFFSETS, effects: [], unsupported: [] };
  }
}

/** The recorded effects for the preview generator (empty when none were recorded). */
export async function readScrollEffects(path: string): Promise<ScrollEffectRecord[]> {
  if (!existsSync(path)) return [];
  try {
    const f = JSON.parse(await readFile(path, 'utf8')) as ScrollEffectsFile;
    return f.schemaVersion === 1 ? f.effects : [];
  } catch {
    return [];
  }
}
