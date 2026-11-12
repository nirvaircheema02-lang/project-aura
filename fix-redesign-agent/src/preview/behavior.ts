import type { ElementHandle, JSHandle, Page } from 'playwright';
import { PROBE_LIB } from './probe-lib.ts';
import type { InteractionResult } from './types.ts';

/**
 * Behaviour probing. The same probes run against the original production page (once, before any
 * edit) and against the generated preview; `compareBehavior` then says, per observed behaviour,
 * whether the preview reproduces it. Nothing here submits a form: submit controls are skipped,
 * links are never clicked, and the caller blocks every non-GET request while probing production.
 */

export interface TextDelta { added: string[]; removed: string[] }

export type ProbeResult =
  | { probe: 'link'; href: string | null }
  | { probe: 'hover'; changed: string[] }
  | { probe: 'click'; changed: boolean; effects: Array<'text' | 'expanded' | 'height' | 'overlay' | 'value'>; delta: TextDelta; overlayDelta: number; heightDelta: number; expandedDelta: number; stateful: boolean }
  | { probe: 'edit'; how: 'range' | 'input' | 'select' | 'checkbox'; delta: TextDelta; changed: boolean }
  | { probe: 'skipped'; reason: string };

export interface ItemObservation { index: number; kind: string; tag: string; label: string; href: string | null; probes: ProbeResult[] }

export interface SectionBehavior {
  sectionId: string;
  located: boolean;
  note?: string;
  items: ItemObservation[];
  scroll: { linked: number; timer: number; examples: string[] } | null;
  animations: Array<{ name: string; durationMs: number; iterations: number | 'infinite'; state: string }>;
  sticky: string[];
}

export interface BehaviorFile {
  schemaVersion: 1;
  capturedAt: string;
  source: 'production' | 'preview';
  url: string;
  reloads: number;
  /** Set when probing could not run (e.g. the page did not load); interaction parity is then reported as not verified. */
  error?: string;
  sections: SectionBehavior[];
}

export interface SectionTarget {
  id: string;
  /** Resolves the section's root element on the current page, or null if it cannot be found. */
  getRoot: (page: Page) => Promise<ElementHandle<Element> | null>;
}

export interface ProbeOptions {
  /** Reloads the page (state reset). Must leave the page ready for `getRoot`. */
  reload: () => Promise<void>;
  maxItems?: number;
  maxReloads?: number;
  log?: (line: string) => void;
}

const sleep = (page: Page, ms: number) => page.waitForTimeout(ms);

async function inventoryMeta(page: Page, root: ElementHandle<Element>): Promise<Array<{ index: number; kind: string; tag: string; label: string; href: string | null }>> {
  return page.evaluate((r) => (window as any).__pvProbe.inventory(r).map((i: any) => ({ index: i.index, kind: i.kind, tag: i.tag, label: i.label, href: i.href })), root);
}

async function itemHandle(page: Page, root: ElementHandle<Element>, index: number): Promise<ElementHandle<Element> | null> {
  const h = (await page.evaluateHandle(([r, i]) => { const inv = (window as any).__pvProbe.inventory(r as Element); return inv[i as number]?.el ?? null; }, [root, index] as const)) as JSHandle<Element | null>;
  return h.asElement() as ElementHandle<Element> | null;
}

const sig = (page: Page, root: ElementHandle<Element>) => page.evaluate((r) => (window as any).__pvProbe.signature(r), root) as Promise<{ text: string; expanded: number; height: number; overlay: number; hidden: number; value: string }>;
const delta = (page: Page, a: string, b: string) => page.evaluate(([x, y]) => (window as any).__pvProbe.textDelta(x as string, y as string), [a, b] as const) as Promise<TextDelta>;

const SKIP_CLICK_KINDS = new Set(['link', 'input', 'textarea', 'range', 'select', 'checkbox']);

async function probeItem(page: Page, root: ElementHandle<Element>, meta: { index: number; kind: string; tag: string; label: string; href: string | null }, opts: ProbeOptions, state: { reloads: number }): Promise<ItemObservation> {
  const probes: ProbeResult[] = [];
  const maxReloads = opts.maxReloads ?? 6;
  let handle = await itemHandle(page, root, meta.index);
  const obs: ItemObservation = { ...meta, probes };
  if (!handle) { probes.push({ probe: 'skipped', reason: 'element not found again' }); return obs; }

  if (meta.kind === 'link') probes.push({ probe: 'link', href: meta.href });

  // hover
  try {
    await handle.scrollIntoViewIfNeeded({ timeout: 2000 });
    const before = await handle.evaluate((el) => (window as any).__pvProbe.styleSnapshot(el));
    await handle.hover({ timeout: 2000 });
    await sleep(page, 450);
    const after = await handle.evaluate((el) => (window as any).__pvProbe.styleSnapshot(el));
    const changed = await page.evaluate(([a, b]) => (window as any).__pvProbe.styleDiff(a, b), [before, after] as const);
    probes.push({ probe: 'hover', changed });
    await page.mouse.move(0, 0);
  } catch { /* an element that cannot be hovered simply has no hover observation */ }

  // value edits (never submit)
  try {
    if (meta.kind === 'range') {
      const before = await sig(page, root);
      const original = await handle.evaluate((el) => (el as HTMLInputElement).value);
      await handle.evaluate((el) => { const i = el as HTMLInputElement; const lo = Number(i.min || 0), hi = Number(i.max || 100); const v = String(Math.round(lo + (hi - lo) * 0.5)); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
      await sleep(page, 400);
      const after = await sig(page, root);
      probes.push({ probe: 'edit', how: 'range', delta: await delta(page, before.text, after.text), changed: before.text !== after.text });
      await handle.evaluate((el, v) => { const i = el as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, original);
      await sleep(page, 200);
    } else if (meta.kind === 'input' || meta.kind === 'textarea') {
      const type = await handle.evaluate((el) => (el as HTMLInputElement).type || 'text');
      const sensitive = await handle.evaluate((el) => /pass|card|ssn|iban|otp|pin/i.test((el.getAttribute('name') ?? '') + (el.getAttribute('autocomplete') ?? '')));
      if (['text', 'number', 'search', 'tel'].includes(type) && !sensitive) {
        const inForm = await handle.evaluate((el) => !!el.closest('form'));
        const before = await sig(page, root);
        const original = await handle.evaluate((el) => (el as HTMLInputElement).value);
        await handle.fill('1250', { timeout: 2000 });
        if (!inForm) await handle.press('Enter');
        await sleep(page, 350);
        const mid = await sig(page, root);
        probes.push({ probe: 'edit', how: 'input', delta: await delta(page, before.text, mid.text), changed: before.text !== mid.text });
        await handle.fill(original, { timeout: 2000 });
        if (!inForm) await handle.press('Enter');
        await sleep(page, 200);
      } else probes.push({ probe: 'skipped', reason: `input type ${type} is not edited` });
    } else if (meta.kind === 'select') {
      const before = await sig(page, root);
      const info = await handle.evaluate((el) => { const s = el as HTMLSelectElement; return { current: s.selectedIndex, count: s.options.length }; });
      if (info.count > 1) {
        await handle.selectOption({ index: info.current === 0 ? 1 : 0 }, { timeout: 2000 });
        await sleep(page, 300);
        const after = await sig(page, root);
        probes.push({ probe: 'edit', how: 'select', delta: await delta(page, before.text, after.text), changed: before.text !== after.text });
        await handle.selectOption({ index: info.current }, { timeout: 2000 });
      }
    }
  } catch { /* an edit that cannot be performed is not an observation */ }

  // click: never on links or submit controls
  if (!SKIP_CLICK_KINDS.has(meta.kind)) {
    const isSubmit = await handle.evaluate((el) => (el as HTMLButtonElement).type === 'submit');
    // a click on something that IS or CONTAINS a navigating link would leave the page: links are never clicked, and neither is anything wrapped around one
    const linkHref = await handle.evaluate((el) => {
      const a = el.closest('a[href]') ?? el.querySelector('a[href]');
      const h = a?.getAttribute('href') ?? '';
      return a && h && !h.startsWith('#') && !/^javascript:/i.test(h) ? h : null;
    });
    if (isSubmit) probes.push({ probe: 'skipped', reason: 'submit control is never clicked' });
    else if (linkHref) probes.push({ probe: 'skipped', reason: `is or contains a link (${linkHref.slice(0, 60)}): a click would navigate, so it is never clicked` });
    else {
      try {
        const before = await sig(page, root);
        const urlBefore = page.url().split('#')[0];
        await handle.click({ timeout: 2500 });
        await sleep(page, 600);
        // belt and braces: if scripts navigated anyway, do not keep probing the page we landed on
        if (page.url().split('#')[0] !== urlBefore) {
          probes.push({ probe: 'skipped', reason: 'the click navigated away from the page; it is not repeated' });
          state.reloads++;
          await opts.reload();
          return obs;
        }
        const after = await sig(page, root);
        const d = await delta(page, before.text, after.text);
        const effects: Array<'text' | 'expanded' | 'height' | 'overlay' | 'value'> = [];
        if (before.text !== after.text) effects.push('text');
        if (before.expanded !== after.expanded) effects.push('expanded');
        if (Math.abs(before.height - after.height) > 2) effects.push('height');
        if (before.overlay !== after.overlay) effects.push('overlay');
        if (before.value !== after.value) effects.push('value');
        // try to revert: Escape for overlays, a second click for toggles
        let stateful = false;
        if (effects.length) {
          if (after.overlay > before.overlay) await page.keyboard.press('Escape');
          else await handle.click({ timeout: 2000 }).catch(() => {});
          await sleep(page, 500);
          const reverted = await sig(page, root);
          stateful = reverted.text !== before.text || reverted.overlay !== before.overlay;
        }
        probes.push({ probe: 'click', changed: effects.length > 0, effects, delta: d, overlayDelta: after.overlay - before.overlay, heightDelta: after.height - before.height, expandedDelta: after.expanded - before.expanded, stateful });
        if (stateful && state.reloads < maxReloads) { state.reloads++; await opts.reload(); }
      } catch { /* an element that cannot be clicked has no click observation */ }
    }
  }
  return obs;
}

async function scrollProbe(page: Page, root: ElementHandle<Element>): Promise<SectionBehavior['scroll']> {
  const info = await root.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top + scrollY, h: r.height, vh: innerHeight }; });
  const positions = Array.from({ length: 6 }, (_v, i) => Math.max(0, info.top - info.vh * 0.9 + ((info.h + info.vh * 0.8) * i) / 5));
  const fps: string[][] = [];
  for (const y of positions) { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(page, 750); fps.push(await root.evaluate((el) => (window as any).__pvProbe.scrollFingerprint(el))); }
  // baseline: how much changes with time alone at the first position
  await page.evaluate((v) => window.scrollTo(0, v), positions[0]!);
  await sleep(page, 700);
  const t0 = await root.evaluate((el) => (window as any).__pvProbe.scrollFingerprint(el));
  await sleep(page, 1300);
  const t1 = await root.evaluate((el) => (window as any).__pvProbe.scrollFingerprint(el));
  const n = Math.min(...fps.map((f) => f.length), t0.length, t1.length);
  const timer = new Set<number>();
  for (let i = 0; i < n; i++) if (t0[i] !== t1[i]) timer.add(i);
  const linkedIdx: number[] = [];
  for (let i = 0; i < n; i++) { if (timer.has(i)) continue; if (new Set(fps.map((f) => f[i])).size > 1) linkedIdx.push(i); }
  const examples = linkedIdx.length ? await root.evaluate((el, idx) => { const els = (window as any).__pvProbe.elementsForFingerprint(el); return (idx as number[]).slice(0, 8).map((i) => (window as any).__pvProbe.describe(els[i])); }, linkedIdx) : [];
  return { linked: linkedIdx.length, timer: timer.size, examples };
}

export async function probeSections(page: Page, targets: SectionTarget[], opts: ProbeOptions): Promise<{ sections: SectionBehavior[]; reloads: number }> {
  await page.evaluate(PROBE_LIB);
  const state = { reloads: 0 };
  const out: SectionBehavior[] = [];
  const maxItems = opts.maxItems ?? 24;
  for (const t of targets) {
    let root = await t.getRoot(page);
    if (!root) { out.push({ sectionId: t.id, located: false, note: 'section root not found on this page', items: [], scroll: null, animations: [], sticky: [] }); continue; }
    await root.scrollIntoViewIfNeeded().catch(() => {});
    const meta = (await inventoryMeta(page, root)).slice(0, maxItems);
    const items: ItemObservation[] = [];
    for (const m of meta) {
      opts.log?.(`probe ${t.id} #${m.index} ${m.kind} "${m.label.slice(0, 40)}"`);
      items.push(await probeItem(page, root, m, opts, state));
      // after any reload the page, its probe library and the root handle are new
      const stillThere = await root.evaluate((el) => el.isConnected).catch(() => false);
      if (!stillThere) { await page.evaluate(PROBE_LIB); const r2 = await t.getRoot(page); if (!r2) break; root = r2; }
    }
    const scroll = await scrollProbe(page, root).catch(() => null);
    const animations = await root.evaluate((el) => (window as any).__pvProbe.animations(el)).catch(() => []);
    const sticky = await root.evaluate((el) => (window as any).__pvProbe.sticky(el)).catch(() => []);
    out.push({ sectionId: t.id, located: true, items, scroll, animations, sticky });
  }
  return { sections: out, reloads: state.reloads };
}

// ── comparison ────────────────────────────────────────────────────────────────────────────

const normHrefFor = (base?: string) => (h: string | null): string => {
  if (!h) return '';
  try {
    const u = new URL(h, base ?? 'http://site.invalid/');
    if (!/^https?:$/.test(u.protocol)) return h;
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
  } catch { return h; }
};

function matchItem(orig: ItemObservation, preview: ItemObservation[], used: Set<number>): ItemObservation | null {
  const same = preview.find((p) => p.index === orig.index && p.kind === orig.kind && p.label === orig.label && !used.has(p.index));
  const hit = same ?? preview.find((p) => p.kind === orig.kind && p.label === orig.label && !used.has(p.index)) ?? null;
  if (hit) used.add(hit.index);
  return hit;
}

export function compareBehavior(original: SectionBehavior[], preview: SectionBehavior[], opts: { overrideSectionIds?: ReadonlySet<string>; siteBase?: string } = {}): InteractionResult[] {
  const results: InteractionResult[] = [];
  const normHref = normHrefFor(opts.siteBase);
  for (const o of original) {
    const p = preview.find((s) => s.sectionId === o.sectionId);
    if (!o.located) { results.push({ sectionId: o.sectionId, probe: 'section', label: o.sectionId, verdict: 'not-probed', detail: o.note ?? 'section could not be located on the original page, so its behaviour was not probed' }); continue; }
    if (!p || !p.located) { results.push({ sectionId: o.sectionId, probe: 'section', label: o.sectionId, verdict: 'mismatch', detail: 'the section is not rendered in the preview' }); continue; }
    const used = new Set<number>();
    for (const item of o.items) {
      const pi = matchItem(item, p.items, used);
      for (const probe of item.probes) {
        if (probe.probe === 'skipped') continue;
        const base = { sectionId: o.sectionId, probe: probe.probe, label: `${item.kind} "${item.label.slice(0, 40)}"` };
        if (!pi) {
          // a hand-authored section rebuilds its controls with different markup; those are covered by its own checks, never silently passed
          if (opts.overrideSectionIds?.has(o.sectionId)) results.push({ ...base, verdict: 'not-probed', detail: 'hand-authored section: this control has no structural counterpart; covered by the section\'s own checks, if any' });
          else results.push({ ...base, verdict: 'unavailable', detail: 'the control exists on the original page but not in the preview' });
          continue;
        }
        const pp = pi.probes.find((x) => x.probe === probe.probe && (x.probe !== 'edit' || (probe.probe === 'edit' && x.how === probe.how)));
        if (probe.probe === 'link') {
          const got = pp && pp.probe === 'link' ? pp.href : pi.href;
          results.push({ ...base, verdict: normHref(got) === normHref(probe.href) ? 'match' : 'mismatch', detail: `href ${probe.href ?? '(none)'} → ${got ?? '(none)'}` });
        } else if (probe.probe === 'hover') {
          const got = pp && pp.probe === 'hover' ? pp.changed : [];
          if (probe.changed.length === 0) results.push({ ...base, verdict: 'match', detail: 'no hover effect on the original' });
          else if (got.some((g) => probe.changed.includes(g))) results.push({ ...base, verdict: 'match', detail: `hover changes ${probe.changed.join(', ')}; preview changes ${got.join(', ')}` });
          else results.push({ ...base, verdict: 'unavailable', detail: `hover changes ${probe.changed.join(', ')} on the original; ${got.length ? 'different properties' : 'nothing'} in the preview` });
        } else if (probe.probe === 'click') {
          const got = pp && pp.probe === 'click' ? pp : null;
          if (!probe.changed) results.push({ ...base, verdict: 'match', detail: 'no observable reaction to a click on the original' });
          else if (!got || !got.changed) results.push({ ...base, verdict: 'unavailable', detail: `clicking changes ${probe.effects.join(', ')} on the original${probe.delta.added.length ? ` (adds: ${probe.delta.added.slice(0, 5).join(' ')})` : ''}; nothing happens in the preview` });
          else {
            // the SAME KIND of reaction, not the same words: production and the preview legitimately show different currencies/values
            const kindsOk = probe.effects.some((e) => got.effects.includes(e));
            results.push({ ...base, verdict: kindsOk ? 'match' : 'mismatch', detail: `original: ${probe.effects.join(', ')}; preview: ${got.effects.join(', ')}` });
          }
        } else if (probe.probe === 'edit') {
          const got = pp && pp.probe === 'edit' ? pp : null;
          const origTokens = [...probe.delta.added, ...probe.delta.removed];
          if (!probe.changed) results.push({ ...base, verdict: 'match', detail: 'editing has no observable effect on the original' });
          else if (!got || !got.changed) results.push({ ...base, verdict: 'unavailable', detail: `editing this ${probe.how} changes the page text on the original (${origTokens.slice(0, 6).join(' ')}); no change in the preview` });
          else results.push({ ...base, verdict: 'match', detail: `editing changes the page text on both (original: ${origTokens.slice(0, 4).join(' ')}; preview: ${[...got.delta.added, ...got.delta.removed].slice(0, 4).join(' ')})` });
        }
      }
    }
    if (o.scroll && (o.scroll.linked > 0 || o.scroll.timer > 0)) {
      const label = o.scroll.examples.slice(0, 3).join('; ');
      if (o.scroll.linked > 0) results.push({ sectionId: o.sectionId, probe: 'scroll', label: 'scroll-linked changes', verdict: p.scroll && p.scroll.linked > 0 ? 'match' : 'unavailable', detail: `${o.scroll.linked} element(s) change as the page scrolls on the original (${label}); ${p.scroll?.linked ?? 0} in the preview` });
      if (o.scroll.timer > 0) results.push({ sectionId: o.sectionId, probe: 'timer', label: 'script-driven changes over time', verdict: p.scroll && p.scroll.timer > 0 ? 'match' : 'unavailable', detail: `${o.scroll.timer} element(s) change over time on the original; ${p.scroll?.timer ?? 0} in the preview` });
    }
    for (const a of o.animations) {
      const has = p.animations.some((x) => x.durationMs === a.durationMs && x.iterations === a.iterations);
      results.push({ sectionId: o.sectionId, probe: 'animation', label: `animation ${a.name}`, verdict: has ? 'match' : 'unavailable', detail: `${a.durationMs}ms × ${a.iterations} on the original; ${has ? 'present' : 'absent'} in the preview` });
    }
    for (const s of o.sticky) {
      const ok = p.sticky.length >= o.sticky.length;
      // a hand-authored section rebuilds its panels (a menu's sticky search box only exists while the menu is open): not comparable structurally
      const verdict = ok ? 'match' : opts.overrideSectionIds?.has(o.sectionId) ? 'not-probed' : 'mismatch';
      results.push({ sectionId: o.sectionId, probe: 'sticky', label: s, verdict, detail: `position: sticky on the original; ${p.sticky.length} sticky element(s) in the preview${verdict === 'not-probed' ? ' (hand-authored section: covered by its own checks, if any)' : ''}` });
    }
  }
  return results;
}

/** One human sentence per behaviour the preview does not reproduce — what the review screen lists as "not reproduced". */
export function unavailableSummary(results: InteractionResult[]): string[] {
  const grouped = new Map<string, string[]>();
  for (const r of results) {
    if (r.verdict !== 'unavailable' && r.verdict !== 'mismatch') continue;
    const key = `${r.sectionId}|${r.probe}`;
    grouped.set(key, [...(grouped.get(key) ?? []), `${r.label}: ${r.detail}`]);
  }
  const out: string[] = [];
  for (const [key, lines] of grouped) {
    const [section, probe] = key.split('|');
    out.push(`${section} · ${probe}: ${lines.length === 1 ? lines[0] : `${lines.length} items, e.g. ${lines.slice(0, 2).join(' | ')}`}`);
  }
  return out;
}
