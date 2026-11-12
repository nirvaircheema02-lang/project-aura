import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { noiseReason } from '../../src/t-layer/network-noise.ts';
import { summarizeConsole, type ConsoleFacts } from '../../src/t-layer/console-noise.ts';
import type { RecordedRequest } from '../../src/t-layer/render-settled.ts';

/**
 * Replays the T-layer's pure classifiers against REAL production captures
 * (test/fixtures/templates/, recorded by scripts/record-fixtures.ts from the
 * 4 templates validated in docs/VALIDATION-NOTES.md) — IMPLEMENTATION-PLAN.md
 * §10 step 3: "independently testable against the fixture captures ...
 * before any agent uses them." Offline: no production traffic per test run.
 */

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'templates');
const TEMPLATES = ['consulting-subpage', 'report-detail', 'report-store-listing', 'survey-landing'] as const;

function load(slug: string) {
  const dir = join(ROOT, slug);
  return {
    capture: JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf-8')),
    requests: JSON.parse(readFileSync(join(dir, 'requests.json'), 'utf-8')) as RecordedRequest[],
    console: JSON.parse(readFileSync(join(dir, 'console.json'), 'utf-8')) as ConsoleFacts[],
    html: gunzipSync(readFileSync(join(dir, 'page.html.gz'))).toString('utf-8'),
  };
}

/** The pathname the observer was auditing at the end: the last successful main-frame document (after any redirect). */
function finalPathname(requests: RecordedRequest[]): string {
  const docs = requests.filter((r) => r.isMainFrame && r.isNavigationRequest && r.status !== null && r.status < 300);
  const last = docs[docs.length - 1];
  if (!last) throw new Error('fixture has no successful main-frame navigation');
  return new URL(last.url).pathname;
}

describe.each(TEMPLATES)('fixture replay — %s', (slug) => {
  const f = load(slug);

  it('network-noise replay reproduces the recorded critical/noise split for every request', () => {
    const pathname = finalPathname(f.requests);
    const mismatches = f.requests.filter((r) => {
      const replayed = noiseReason(
        { url: r.url, resourceType: r.resourceType, headers: r.headers, isMainFrame: r.isMainFrame, isNavigationRequest: r.isNavigationRequest },
        pathname,
      );
      return (replayed === null) !== (r.noise === null);
    });
    expect(mismatches.map((m) => m.url)).toEqual([]);
  });

  it('has zero critical-path failures — every recorded failure is speculative noise (Part D prefetch-abort finding, on live production)', () => {
    expect(f.capture.network.criticalFailures).toEqual([]);
    expect(f.capture.network.speculativeFailures.length).toBeGreaterThan(0);
  });

  it('console-noise replay keeps exactly what the live capture kept', () => {
    const replayed = summarizeConsole(f.console, {
      auditedOrigin: 'https://www.kenresearch.com',
      speculativeUrls: new Set(f.requests.filter((r) => r.noise !== null).map((r) => r.url)),
    });
    expect(replayed.kept.length).toBe(f.capture.console.kept.length);
    expect(replayed.total).toBe(f.capture.console.total);
  });

  it('render-settled gate settled on the real page', () => {
    expect(f.capture.renderSettled.settled).toBe(true);
  });

  /**
   * IMPLEMENTATION-PLAN.md §12 open decision #5, resolved by evidence: the
   * production site emits NO data-component / data-variant attributes (the
   * DS repo has 161/289 — authoring intent that never reaches production).
   * If this ever starts failing, production began emitting them and B2/B3
   * may reconsider it as a secondary signal.
   */
  it('production HTML carries zero data-component / data-variant attributes', () => {
    expect(f.html.match(/data-component="/g) ?? []).toHaveLength(0);
    expect(f.html.match(/data-variant(-section)?="/g) ?? []).toHaveLength(0);
  });
});

describe('fixture evidence that corrects earlier validation findings', () => {
  it('survey-landing: the real Swiper loop misconfiguration survives the console noise policy (Part D finding, live)', () => {
    const f = load('survey-landing');
    const patterns = f.capture.console.kept.map((k: { verdict: { pattern?: string } }) => k.verdict.pattern);
    expect(patterns).toContain('swiper-loop-misconfiguration');
  });

  it('count-up placeholders DO resolve under real wheel scrolling (VALIDATION-NOTES used a synthetic scroll event, which cannot trigger them)', () => {
    // `changed` compares against the value at settle time, and scrolling to the first counter also
    // animates its neighbours in the same stats row — so later ones read changed:false while already
    // final. Resolution is judged against the value first DETECTED, plus `stillPlaceholder` (the only
    // field S8's LOW-confidence routing reads).
    for (const slug of ['consulting-subpage', 'survey-landing'] as const) {
      const placeholders = load(slug).capture.placeholders as Array<{ detectedAs: string; after: string; stillPlaceholder: boolean }>;
      expect(placeholders.length, `${slug} should have had count-up placeholders`).toBeGreaterThan(0);
      expect(placeholders.every((p) => p.after !== p.detectedAs && !p.stillPlaceholder)).toBe(true);
    }
  });

  it('report-detail: the 308 redirect is followed and the final page (not the requested path) becomes the audited identity', () => {
    const f = load('report-detail');
    expect(finalPathname(f.requests)).toBe('/industry-reports/malaysia-industrial-packaging-pallets-supply-chain-packaging-solutions-market');
    expect(f.capture.canonical.pageUrl).toContain('/industry-reports/');
  });
});
