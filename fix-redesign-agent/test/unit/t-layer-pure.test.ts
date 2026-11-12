import { describe, expect, it } from 'vitest';
import { genericNormalize, resolveCanonical } from '../../src/t-layer/canonicalize.ts';
import { classifyConsoleMessage, summarizeConsole } from '../../src/t-layer/console-noise.ts';
import { isPlaceholderValue } from '../../src/t-layer/dynamic-content.ts';
import { assignElementFindingIds, elementFindingId, findingId, parseAriaSnapshot } from '../../src/t-layer/element-registry.ts';
import { noiseReason, speculativeReason, type RequestFacts } from '../../src/t-layer/network-noise.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';

/**
 * Mirrors audit-agent's `test/unit/t-layer-pure.test.ts` for the vendored subset — behavior
 * unchanged post-copy. (Its computed-style block is absent because computed-style.ts is not
 * vendored yet; it arrives with R5's deterministic re-measurement.)
 */

const req = (over: Partial<RequestFacts>): RequestFacts => ({ url: 'https://www.kenresearch.com/consulting/x', resourceType: 'fetch', headers: {}, isMainFrame: true, isNavigationRequest: false, ...over });

describe('network-noise', () => {
  const audited = '/malaysia-industrial-packaging-pallets-supply-chain-packaging-solutions-market';
  it('classifies an RSC fetch for an unrelated page as speculative, keeps a same-pathname one critical', () => {
    expect(speculativeReason(req({ url: 'https://www.kenresearch.com/survey/x?_rsc=abc12', headers: { rsc: '1' } }), audited)).toBe('rsc-fetch-for-other-pathname');
    expect(noiseReason(req({ url: `https://www.kenresearch.com${audited}?_rsc=zz`, headers: { rsc: '1' } }), audited)).toBeNull();
  });
  it('honours prefetch headers and excludes streams / non-main-frame / analytics', () => {
    expect(speculativeReason(req({ headers: { 'next-router-prefetch': '1' } }), audited)).toBe('next-router-prefetch-header');
    expect(noiseReason(req({ resourceType: 'eventsource' }), audited)).toBe('long-lived-stream');
    expect(noiseReason(req({ isMainFrame: false }), audited)).toBe('non-main-frame');
    expect(noiseReason(req({ url: 'https://analytics.google.com/g/collect?v=2', resourceType: 'ping' }), audited)).toBe('third-party-analytics');
    expect(noiseReason(req({ url: 'https://www.kenresearch.com/api/auth/session' }), audited)).toBeNull();
  });
});

describe('console-noise', () => {
  const ctx = { auditedOrigin: 'https://www.kenresearch.com', speculativeUrls: new Set(['https://www.kenresearch.com/survey/x?_rsc=1']) };
  it('keeps the Swiper loop misconfiguration, suppresses preload noise, drops speculative-resource failures', () => {
    expect(classifyConsoleMessage({ type: 'warning', text: 'Swiper Loop Warning: The number of slides is not enough for loop mode, it will be disabled and not function properly.' }, ctx)).toEqual({ keep: true, reason: 'known-meaningful-pattern', pattern: 'swiper-loop-misconfiguration' });
    expect(classifyConsoleMessage({ type: 'warning', text: "The resource https://www.kenresearch.com/_next/static/media/x.woff2 was preloaded using link preload but not used within a few seconds from the window's load event." }, ctx).keep).toBe(false);
    expect(classifyConsoleMessage({ type: 'error', text: 'Failed to load resource: net::ERR_ABORTED', locationUrl: 'https://www.kenresearch.com/survey/x?_rsc=1' }, ctx)).toEqual({ keep: false, reason: 'speculative-resource' });
  });
  it('summarizes suppressed counts instead of dropping invisibly', () => {
    const msgs = [...Array.from({ length: 5 }, () => ({ type: 'warning', text: 'x was preloaded using link preload but not used within a few seconds' })), { type: 'error', text: 'Uncaught TypeError: foo', locationUrl: 'https://www.kenresearch.com/_next/a.js' }];
    const s = summarizeConsole(msgs, ctx);
    expect(s.summary).toBe('6 messages, 5 suppressed by policy, 1 kept as evidence');
  });
});

describe('canonicalization', () => {
  it('generic normalization and declared-canonical precedence', () => {
    expect(genericNormalize('HTTPS://WWW.KenResearch.com:443/Report-Store/?utm_source=x&tab=new_this_week&gclid=1#top')).toBe('https://www.kenresearch.com/Report-Store?tab=new_this_week');
    const r = resolveCanonical({ requestedUrl: 'https://www.kenresearch.com/market-entry-consulting', finalUrl: 'https://www.kenresearch.com/market-entry-consulting', linkHeader: null, linkRelCanonical: ['https://www.kenresearch.com/consulting/strategy-consulting/market-entry-consulting'], ogUrl: null });
    expect(r.pageUrl).toBe('https://www.kenresearch.com/consulting/strategy-consulting/market-entry-consulting');
    expect(r.source).toBe('link-rel-canonical');
  });
  it('keeps the observed URL when the canonical drops a state-changing param', () => {
    const r = resolveCanonical({ requestedUrl: 'https://www.kenresearch.com/report-store?tab=new_this_week', finalUrl: 'https://www.kenresearch.com/report-store?tab=new_this_week', linkHeader: null, linkRelCanonical: ['https://www.kenresearch.com/report-store'], ogUrl: null });
    expect(r.pageUrl).toBe('https://www.kenresearch.com/report-store?tab=new_this_week');
  });
});

describe('placeholder detection', () => {
  it('matches placeholder signatures and not real values', () => {
    for (const v of ['0+', '$0Mn', '0%', ' 0+ ', '₹0Cr', '0.0K', '0x']) expect(isPlaceholderValue(v), v).toBe(true);
    for (const v of ['10+', '$2.4Mn', '35%', '2,00,000+', 'Reports', '0 results found']) expect(isPlaceholderValue(v), v).toBe(false);
  });
});

describe('element registry (pure parts)', () => {
  it('parses refs, roles, names and boxes from an aria snapshot', () => {
    const els = parseAriaSnapshot(['- banner [ref=e1] [box=0,0,1440,64]:', '  - link "Ken Research" [ref=e2] [box=16,12,120,40]', '  - button "Talk to a Strategy Expert" [ref=e12] [box=24,320,210,48]'].join('\n'));
    expect(els).toHaveLength(3);
    expect(els[2]).toMatchObject({ ref: 'e12', role: 'button', name: 'Talk to a Strategy Expert', box: { x: 24, y: 320, width: 210, height: 48 } });
  });
  it('finding ids are stable across layout moves and unique across look-alike elements', () => {
    const fp = { structuralPath: 'main > section:nth-of-type(1) > a', role: 'a', accessibleName: '', textPrefix: 'Talk to a Strategy Expert', box: { x: 24, y: 320, width: 208, height: 48 } };
    const a = findingId({ pageId: 'p', nodeId: 'B4', ruleId: 'R1.2', fingerprint: fp });
    expect(a).toBe(findingId({ pageId: 'p', nodeId: 'B4', ruleId: 'R1.2', fingerprint: { ...fp, box: { ...fp.box, y: 900 } } }));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    const btn = (y: number) => ({ structuralPath: '#promo > button', role: 'button', accessibleName: '', textPrefix: 'Talk to us', box: { x: 24, y, width: 120, height: 44 } });
    const { ids, collisions } = assignElementFindingIds('p', [btn(900), btn(100)]);
    expect(collisions).toBe(1);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toBe(elementFindingId('p', btn(100)));
  });
});

describe('politeness', () => {
  it('parses Retry-After and spaces same-origin navigations', async () => {
    const p = new Politeness(0);
    expect(p.backOff('https://www.kenresearch.com/x', '5')).toBe(5000);
    expect(p.backOff('https://www.kenresearch.com/x', null, 1234)).toBe(1234);
    const q = new Politeness(150);
    const t0 = Date.now();
    await q.beforeNavigation('https://a.example/1');
    await q.beforeNavigation('https://a.example/2');
    await q.beforeNavigation('https://b.example/1');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});
