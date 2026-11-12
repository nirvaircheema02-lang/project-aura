import { writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import type { Config } from '../../config/index.ts';
import { standaloneOriginalHtml } from '../../html/standalone-original.ts';
import { ensureDesignBaseline } from '../../fidelity/baseline-run.ts';
import { probeSections, type BehaviorFile } from '../../preview/behavior.ts';
import { locateRegions } from '../../preview/extract.ts';
import type { BrowserPool } from '../../t-layer/browser.ts';
import type { Politeness } from '../../t-layer/politeness.ts';
import type { B1Input, B1Output } from '../types.ts';

/**
 * B1 — Behaviour capture (deterministic). Before any edit, records how the ORIGINAL page's
 * in-scope sections actually behave (hover, clicks, edits to inputs/sliders/selects, scroll-linked
 * changes, CSS animations, sticky elements) so the React Preview can be compared against it.
 *
 * Production safety: one fresh page load (politeness-paced), every non-GET request aborted,
 * analytics aborted, links never clicked, submit controls never clicked, sensitive inputs never
 * edited. A failure here does not fail the run: it is recorded in behavior.json and interaction
 * parity is then reported as NOT verified at G2.
 */

export const B1_STATUS = 'implemented' as const;

export interface B1Deps {
  pool: BrowserPool;
  politeness: Politeness;
  enabled: boolean;
  /** Bounds of the offline design-baseline capture. */
  fidelity?: Config['fidelity'];
  log?: (line: string) => void;
}

const ANALYTICS = /(google-analytics|googletagmanager|doubleclick|clarity\.ms|lfeeder|facebook\.(com|net)|hotjar|segment\.(io|com)|mixpanel|linkedin\.com\/px|snap\.licdn|ipapi\.co|pipedrive)/i;

export async function runB1(deps: B1Deps, input: B1Input): Promise<B1Output> {
  const log = deps.log ?? (() => {});
  // Design/state/composition baseline of the ORIGINAL, from the pre-edit snapshot (offline, write-once). Independent of the production probe below.
  if (input.session.originalHtml) {
    const ids = input.mode === 'full-page' ? (await locateRegions(input.session.page, { sectionIds: null, fullPage: true })).filter((r) => !r.unlabelled).map((r) => r.id) : input.sectionIds;
    const f = deps.fidelity;
    // Measured on the STYLED standalone form (the one R7 writes and R8 builds from), never on the raw DOM that has no CSS offline.
    let baselineHtml: string | null = null;
    try {
      baselineHtml = await standaloneOriginalHtml(input.session.context, input.r1.targetUrl, input.session.originalHtml);
    } catch (err) {
      log(`B1 · the styled original could not be assembled for the design baseline (${(err as Error).message.slice(0, 120)}) — design and state fidelity will be reported as NOT verified`);
    }
    const res = !baselineHtml ? { error: null as string | null, reused: false } : await ensureDesignBaseline({ context: input.session.context, originalHtml: baselineHtml, sectionIds: ids, path: input.paths.designBaselineJson, ...(f ? { limits: { maxElements: f.maxElementsPerSection, maxHoverTargets: f.maxHoverTargets, maxFocusTargets: f.maxFocusTargets } } : {}), log });
    if (res.error) log(`B1 · ${res.error} — design and state fidelity will be reported as NOT verified`);
    else if (res.reused) log('B1 · reusing this run\'s stored design baseline (immutable)');
  } else {
    log('B1 · no pre-edit snapshot is available, so no design baseline was captured: design and state fidelity will be reported as NOT verified');
  }
  const url = input.r1.targetUrl;
  if (!deps.enabled) {
    log('B1 · production behaviour probing is disabled in config (preview.behaviorProbes=false): interaction parity will be reported as NOT verified');
    return null;
  }
  const base: BehaviorFile = { schemaVersion: 1, capturedAt: new Date().toISOString(), source: 'production', url, reloads: 0, sections: [] };
  try {
    const regions = await locateRegions(input.session.page, { sectionIds: input.mode === 'full-page' ? null : input.sectionIds, fullPage: input.mode === 'full-page' });
    const context = await deps.pool.newIsolatedContext();
    try {
      await context.route('**/*', (route) => {
        const req = route.request();
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || ANALYTICS.test(req.url())) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      await deps.politeness.beforeNavigation(url);
      log(`B1 · probing the original page's behaviour (read-only, no submissions): ${url}`);
      const load = async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1500);
      };
      await load();
      const targets = regions.map((r) => ({
        id: r.id,
        getRoot: async (p: Page) => {
          const h = await p.evaluateHandle((loc) => {
            const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
            // the same section is the element whose text starts the same AND is about as long: an ancestor or a header block can share the start
            const fits = (el: Element | null) => !!el && norm(el.textContent).startsWith(loc.textStart) && Math.abs(norm(el.textContent).length - loc.textLength) <= Math.max(40, loc.textLength * 0.1);
            const direct = document.querySelector(loc.cssPath);
            if (fits(direct)) return direct;
            const tag = (loc.cssPath.split(' > ').pop() ?? '').split(':')[0] ?? '';
            const matches = Array.from(document.querySelectorAll(tag)).filter((e) => fits(e));
            return matches.sort((a, b) => Math.abs(norm(a.textContent).length - loc.textLength) - Math.abs(norm(b.textContent).length - loc.textLength))[0] ?? null;
          }, r.locator);
          return h.asElement();
        },
      }));
      const { sections, reloads } = await probeSections(page, targets, {
        reload: async () => { await deps.politeness.beforeNavigation(url); await load(); },
        maxItems: 24,
        maxReloads: 6,
        log: (l) => log(`B1 · ${l}`),
      });
      const file: BehaviorFile = { ...base, reloads, sections };
      await writeFile(input.paths.behaviorJson, JSON.stringify(file, null, 2));
      const probed = sections.reduce((n, s) => n + s.items.reduce((m, i) => m + i.probes.length, 0), 0);
      log(`B1 · ${sections.filter((s) => s.located).length}/${sections.length} section(s) located, ${probed} probe(s) recorded, ${reloads} reload(s)`);
      return file;
    } finally {
      await context.close();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
    log(`B1 · behaviour capture failed (${error}); interaction parity will be reported as NOT verified`);
    const file: BehaviorFile = { ...base, error };
    await writeFile(input.paths.behaviorJson, JSON.stringify(file, null, 2));
    return file;
  }
}
