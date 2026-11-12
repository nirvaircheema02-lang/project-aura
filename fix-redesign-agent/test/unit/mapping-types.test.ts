import { describe, expect, it } from 'vitest';
import { captureFingerprintsEqual, type CaptureFingerprint } from '../../src/mapping/types.ts';

/**
 * Regression coverage for a real bug: the equality check used to compare stylesheets/fonts/
 * assets ONLY by `contentHash`, never by their identifying url/src. A cross-origin resource
 * this page context can't `fetch` (CORS) routinely has `contentHash: null` — comparing
 * null===null reported two entirely DIFFERENT resources (different urls) as unchanged, which
 * defeats §6.6's whole point: a swapped stylesheet/font/asset must count as a real change.
 */

const base = (): CaptureFingerprint => ({
  domHash: 'dom-1',
  stylesheets: [{ url: '/a.css', contentHash: 'css-hash-1' }],
  fonts: [{ src: '/font.woff2', contentHash: null }],
  assets: [{ url: '/img.png', contentHash: null }],
  viewport: { width: 1440, height: 900 },
  renderingPolicyHash: 'policy-1',
});

describe('captureFingerprintsEqual', () => {
  it('true for two independently-built, byte-identical fingerprints', () => {
    expect(captureFingerprintsEqual(base(), base())).toBe(true);
  });

  it('false when domHash, renderingPolicyHash, or viewport differ', () => {
    expect(captureFingerprintsEqual(base(), { ...base(), domHash: 'dom-2' })).toBe(false);
    expect(captureFingerprintsEqual(base(), { ...base(), renderingPolicyHash: 'policy-2' })).toBe(false);
    expect(captureFingerprintsEqual(base(), { ...base(), viewport: { width: 375, height: 900 } })).toBe(false);
  });

  it('regression: a swapped stylesheet URL is caught even when the content hash happens to match (two different files with identical bytes)', () => {
    const a = base();
    const b = { ...base(), stylesheets: [{ url: '/different.css', contentHash: 'css-hash-1' }] };
    expect(captureFingerprintsEqual(a, b)).toBe(false);
  });

  it('regression: a swapped font src is caught even with contentHash null on both sides', () => {
    const a = base();
    const b = { ...base(), fonts: [{ src: '/different-font.woff2', contentHash: null }] };
    expect(captureFingerprintsEqual(a, b)).toBe(false);
  });

  it('regression: a swapped asset URL is caught even with contentHash null on both sides', () => {
    const a = base();
    const b = { ...base(), assets: [{ url: '/different.png', contentHash: null }] };
    expect(captureFingerprintsEqual(a, b)).toBe(false);
  });

  it('a genuinely changed content hash is still caught when the url is unchanged', () => {
    const a = { ...base(), stylesheets: [{ url: '/a.css', contentHash: 'h1' }] };
    const b = { ...base(), stylesheets: [{ url: '/a.css', contentHash: 'h2' }] };
    expect(captureFingerprintsEqual(a, b)).toBe(false);
  });

  it('false when a list length differs', () => {
    const a = base();
    const b = { ...base(), assets: [...base().assets, { url: '/extra.png', contentHash: null }] };
    expect(captureFingerprintsEqual(a, b)).toBe(false);
  });
});
