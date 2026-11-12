import { describe, expect, it } from 'vitest';
import { noiseReason, speculativeReason, type RequestFacts } from '../../src/t-layer/network-noise.ts';
import { classifyConsoleMessage, summarizeConsole } from '../../src/t-layer/console-noise.ts';
import { genericNormalize, resolveCanonical } from '../../src/t-layer/canonicalize.ts';
import { isPlaceholderValue } from '../../src/t-layer/dynamic-content.ts';
import { colorDeltaE, lengthToPx, lineHeightRatio, normalizeColor } from '../../src/t-layer/computed-style.ts';
import { assignElementFindingIds, elementFindingId, findingId, parseAriaSnapshot } from '../../src/t-layer/element-registry.ts';
import { Politeness } from '../../src/t-layer/politeness.ts';

const req = (over: Partial<RequestFacts>): RequestFacts => ({
  url: 'https://www.kenresearch.com/consulting/x',
  resourceType: 'fetch',
  headers: {},
  isMainFrame: true,
  isNavigationRequest: false,
  ...over,
});

describe('network-noise (§2.4)', () => {
  const audited = '/malaysia-industrial-packaging-pallets-supply-chain-packaging-solutions-market';

  it('classifies the validated real case — an RSC fetch for an unrelated page — as speculative', () => {
    const r = req({ url: 'https://www.kenresearch.com/survey/plant-based-dairy-alternative-perception-survey?_rsc=abc12', headers: { rsc: '1' } });
    expect(speculativeReason(r, audited)).toBe('rsc-fetch-for-other-pathname');
  });

  it('keeps a same-pathname RSC fetch (router.refresh) on the critical path', () => {
    const r = req({ url: `https://www.kenresearch.com${audited}?_rsc=zz`, headers: { rsc: '1' } });
    expect(noiseReason(r, audited)).toBeNull();
  });

  it('detects the pathname rule even with NO prefetch header (header-only detection is insufficient)', () => {
    const r = req({ url: 'https://www.kenresearch.com/report-store?_rsc=1' });
    expect(speculativeReason(r, audited)).toBe('rsc-fetch-for-other-pathname');
  });

  it('honours next-router-prefetch, segment-prefetch and sec-purpose headers', () => {
    expect(speculativeReason(req({ headers: { 'next-router-prefetch': '1' } }), audited)).toBe('next-router-prefetch-header');
    expect(speculativeReason(req({ headers: { 'next-router-segment-prefetch': '/_tree' } }), audited)).toBe('next-router-segment-prefetch-header');
    expect(speculativeReason(req({ headers: { 'sec-purpose': 'prefetch;prerender' } }), audited)).toBe('sec-purpose-prefetch');
  });

  it('excludes long-lived streams, non-main-frame requests and analytics hosts from the critical path', () => {
    expect(noiseReason(req({ resourceType: 'eventsource' }), audited)).toBe('long-lived-stream');
    expect(noiseReason(req({ isMainFrame: false }), audited)).toBe('non-main-frame');
    expect(noiseReason(req({ url: 'https://www.google-analytics.com/g/collect?v=2' }), audited)).toBe('third-party-analytics');
  });

  it('regression (live capture): GA4 beacons on analytics.google.com are analytics, not critical-page failures', () => {
    const ga4 = req({ url: 'https://analytics.google.com/g/collect?v=2&tid=G-0QKPLDBKRE&en=page_view', resourceType: 'ping' });
    expect(noiseReason(ga4, audited)).toBe('third-party-analytics');
  });

  it('keeps an ordinary first-party API call critical', () => {
    expect(noiseReason(req({ url: 'https://www.kenresearch.com/api/auth/session' }), audited)).toBeNull();
  });
});

describe('console-noise (§2.4)', () => {
  const ctx = { auditedOrigin: 'https://www.kenresearch.com', speculativeUrls: new Set(['https://www.kenresearch.com/survey/x?_rsc=1']) };

  it('keeps the validated real signal buried in 1198 messages — the Swiper loop misconfiguration', () => {
    const v = classifyConsoleMessage({ type: 'warning', text: 'Swiper Loop Warning: The number of slides is not enough for loop mode, it will be disabled and not function properly.' }, ctx);
    expect(v).toEqual({ keep: true, reason: 'known-meaningful-pattern', pattern: 'swiper-loop-misconfiguration' });
  });

  it('suppresses the preload-not-used noise family', () => {
    const v = classifyConsoleMessage({ type: 'warning', text: 'The resource https://www.kenresearch.com/_next/static/media/x.woff2 was preloaded using link preload but not used within a few seconds from the window\'s load event.' }, ctx);
    expect(v.keep).toBe(false);
  });

  it('drops a failure log for a request already classified speculative', () => {
    const v = classifyConsoleMessage({ type: 'error', text: 'Failed to load resource: net::ERR_ABORTED', locationUrl: 'https://www.kenresearch.com/survey/x?_rsc=1' }, ctx);
    expect(v).toEqual({ keep: false, reason: 'speculative-resource' });
  });

  it('never crashes on a type outside the declared union (verbose) — default branch', () => {
    expect(classifyConsoleMessage({ type: 'verbose', text: 'something' }, ctx)).toEqual({ keep: false, reason: 'below-threshold' });
    expect(classifyConsoleMessage({ type: 'totally-new-level', text: 'x' }, ctx).keep).toBe(false);
  });

  it('summarizes suppressed counts instead of dropping invisibly', () => {
    const msgs = [
      ...Array.from({ length: 5 }, () => ({ type: 'warning', text: 'x was preloaded using link preload but not used within a few seconds' })),
      { type: 'error', text: 'Uncaught TypeError: foo', locationUrl: 'https://www.kenresearch.com/_next/a.js' },
    ];
    const s = summarizeConsole(msgs, ctx);
    expect(s.total).toBe(6);
    expect(s.kept).toHaveLength(1);
    expect(s.suppressedByReason['benign-preload-warning']).toBe(5);
    expect(s.summary).toBe('6 messages, 5 suppressed by policy, 1 kept as evidence');
  });
});

describe('canonicalization (§0)', () => {
  it('generic normalization: case, default port, fragment, tracking params, trailing slash — never other params', () => {
    expect(genericNormalize('HTTPS://WWW.KenResearch.com:443/Report-Store/?utm_source=x&tab=new_this_week&gclid=1#top')).toBe(
      'https://www.kenresearch.com/Report-Store?tab=new_this_week',
    );
  });

  it('prefers the declared <link rel=canonical> — the validated real case (two paths, one page)', () => {
    const r = resolveCanonical({
      requestedUrl: 'https://www.kenresearch.com/market-entry-consulting',
      finalUrl: 'https://www.kenresearch.com/market-entry-consulting',
      linkHeader: null,
      linkRelCanonical: ['https://www.kenresearch.com/consulting/strategy-consulting/market-entry-consulting'],
      ogUrl: null,
    });
    expect(r.pageUrl).toBe('https://www.kenresearch.com/consulting/strategy-consulting/market-entry-consulting');
    expect(r.source).toBe('link-rel-canonical');
  });

  it('KEEPS the observed URL when the canonical drops a state-changing query param (tab) — explicit conflict rule', () => {
    const r = resolveCanonical({
      requestedUrl: 'https://www.kenresearch.com/report-store?tab=new_this_week',
      finalUrl: 'https://www.kenresearch.com/report-store?tab=new_this_week',
      linkHeader: null,
      linkRelCanonical: ['https://www.kenresearch.com/report-store'],
      ogUrl: null,
    });
    expect(r.pageUrl).toBe('https://www.kenresearch.com/report-store?tab=new_this_week');
    expect(r.declaredCanonical).toBe('https://www.kenresearch.com/report-store');
    expect(r.notes.join(' ')).toContain('[tab]');
  });

  it('ignores an off-site canonical (misconfigured metadataBase) and an ambiguous double canonical', () => {
    const off = resolveCanonical({
      requestedUrl: 'https://www.kenresearch.com/a',
      finalUrl: 'https://www.kenresearch.com/a',
      linkHeader: null,
      linkRelCanonical: ['http://localhost:3000/a'],
      ogUrl: null,
    });
    expect(off.pageUrl).toBe('https://www.kenresearch.com/a');
    expect(off.source).toBe('generic');

    const dbl = resolveCanonical({
      requestedUrl: 'https://www.kenresearch.com/a',
      finalUrl: 'https://www.kenresearch.com/a',
      linkHeader: null,
      linkRelCanonical: ['https://www.kenresearch.com/b', 'https://www.kenresearch.com/c'],
      ogUrl: 'https://www.kenresearch.com/d',
    });
    expect(dbl.pageUrl).toBe('https://www.kenresearch.com/d'); // falls through to og:url
    expect(dbl.notes[0]).toContain('treated as absent');
  });

  it('HTTP Link header outranks the in-page tag', () => {
    const r = resolveCanonical({
      requestedUrl: 'https://www.kenresearch.com/a',
      finalUrl: 'https://www.kenresearch.com/a',
      linkHeader: '<https://www.kenresearch.com/from-header>; rel="canonical"',
      linkRelCanonical: ['https://www.kenresearch.com/from-tag'],
      ogUrl: null,
    });
    expect(r.pageUrl).toBe('https://www.kenresearch.com/from-header');
    expect(r.source).toBe('http-link-header');
  });
});

describe('placeholder detection (§2.7)', () => {
  it('matches every validated real signature and close variants', () => {
    for (const v of ['0+', '$0Mn', '0%', ' 0+ ', '₹0Cr', '0.0K', '0x']) expect(isPlaceholderValue(v), v).toBe(true);
  });
  it('does not match real values', () => {
    for (const v of ['10+', '$2.4Mn', '35%', '2,00,000+', 'Reports', '0 results found']) expect(isPlaceholderValue(v), v).toBe(false);
  });
});

describe('computed-style normalization', () => {
  it('normalizes rgb()/hex/oklch to one canonical form and compares perceptually', () => {
    expect(normalizeColor('rgb(176, 31, 36)')).toBe('#b01f24ff');
    expect(normalizeColor('#b01f24')).toBe('#b01f24ff');
    const oklchRed = 'oklch(0.4911 0.1796 25.62)'; // #b01f24 as Tailwind v4 would author it (computed via culori)
    expect(colorDeltaE(oklchRed, '#b01f24')!).toBeLessThan(1);
    expect(normalizeColor(oklchRed)).toBe('#b01f24ff'); // string-inequal input, same color
    expect(colorDeltaE('#b01f24', '#6c5bc0')!).toBeGreaterThan(20);
  });
  it('lengths: px/rem/em/0, and refuses non-lengths', () => {
    expect(lengthToPx('48px')).toBe(48);
    expect(lengthToPx('3rem')).toBe(48);
    expect(lengthToPx('1.5em', 16, 20)).toBe(30);
    expect(lengthToPx('0')).toBe(0);
    expect(lengthToPx('auto')).toBeNull();
  });
  it('line-height: unitless, px and "normal" (all three forms browsers return)', () => {
    expect(lineHeightRatio('1.6', 16)).toBe(1.6);
    expect(lineHeightRatio('25.6px', 16)).toBe(1.6);
    expect(lineHeightRatio('normal', 16)).toBeNull();
  });
});

describe('element registry (pure parts)', () => {
  it('parses refs, roles, names and boxes from an AI-mode aria snapshot', () => {
    const snap = [
      '- banner [ref=e1] [box=0,0,1440,64]:',
      '  - link "Ken Research" [ref=e2] [box=16,12,120,40]',
      '  - button "Talk to a Strategy Expert" [ref=e12] [box=24,320,210,48]',
      '- heading "Accelerate Market Entry" [level=1] [ref=e13]',
    ].join('\n');
    const els = parseAriaSnapshot(snap);
    expect(els).toHaveLength(4);
    expect(els[2]).toMatchObject({ ref: 'e12', role: 'button', name: 'Talk to a Strategy Expert', box: { x: 24, y: 320, width: 210, height: 48 } });
    expect(els[3]).toMatchObject({ ref: 'e13', role: 'heading', name: 'Accelerate Market Entry' });
  });

  it('reads YAML-quoted lines (text containing ": ") — role, name and box survive the quoting', () => {
    const snap = [
      '- generic [ref=e1] [box=0,0,1440,900]:',
      `  - 'heading "Clinical Trial Survey: Why India''s Sponsors Pick Sites" [level=3] [ref=e628] [box=212,7210,508,164]'`,
      '  - "link \\"Q: what\\" [ref=e7] [box=1,2,3,4]"',
    ].join('\n');
    const els = parseAriaSnapshot(snap);
    expect(els[1]).toMatchObject({ ref: 'e628', role: 'heading', name: "Clinical Trial Survey: Why India's Sponsors Pick Sites", box: { x: 212, y: 7210, width: 508, height: 164 }, parentRef: 'e1' });
    expect(els[2]).toMatchObject({ ref: 'e7', role: 'link', name: 'Q: what' });
  });

  it('finding_id is stable across runs and ignores layout position', () => {
    const fp = { structuralPath: 'main > section:nth-of-type(1) > a', role: 'a', accessibleName: '', textPrefix: 'Talk to a Strategy Expert', box: { x: 24, y: 320, width: 208, height: 48 } };
    const a = findingId({ pageId: 'p', nodeId: 'B4', ruleId: 'R1.2', fingerprint: fp });
    const moved = findingId({ pageId: 'p', nodeId: 'B4', ruleId: 'R1.2', fingerprint: { ...fp, box: { ...fp.box, y: 900 } } });
    const otherRule = findingId({ pageId: 'p', nodeId: 'B4', ruleId: 'R1.3', fingerprint: fp });
    expect(a).toBe(moved);
    expect(a).not.toBe(otherRule);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('elements that fingerprint alike still get unique ids — the first in document order keeps the plain one', () => {
    const fp = (y: number) => ({ structuralPath: '#promo > button', role: 'button', accessibleName: '', textPrefix: 'Talk to us', box: { x: 24, y, width: 120, height: 44 } });
    const other = { ...fp(40), structuralPath: 'footer > a', textPrefix: 'Contact' };
    // Listed bottom-first, as a model's section order might list them.
    const { ids, collisions } = assignElementFindingIds('p', [fp(900), other, fp(100)]);
    expect(collisions).toBe(1);
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(elementFindingId('p', fp(100))); // the upper one — stable whatever the listing order
    expect(ids[1]).toBe(elementFindingId('p', other));
    expect(ids[0]).not.toBe(ids[2]);
    expect(assignElementFindingIds('p', [fp(100), fp(900)]).ids).toEqual([ids[2], ids[0]]);
  });
});

describe('politeness', () => {
  it('parses Retry-After as seconds or HTTP-date', () => {
    const p = new Politeness(0);
    expect(p.backOff('https://www.kenresearch.com/x', '5')).toBe(5000);
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = p.backOff('https://www.kenresearch.com/x', future);
    expect(ms).toBeGreaterThan(8000);
    expect(ms).toBeLessThanOrEqual(10_000);
    expect(p.backOff('https://www.kenresearch.com/x', null, 1234)).toBe(1234);
  });

  it('spaces navigations to the same origin by at least the minimum interval', async () => {
    const p = new Politeness(150);
    const t0 = Date.now();
    await p.beforeNavigation('https://a.example/1');
    await p.beforeNavigation('https://a.example/2');
    await p.beforeNavigation('https://b.example/1'); // different origin — not delayed by a.example
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});
