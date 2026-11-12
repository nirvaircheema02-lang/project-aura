import { describe, expect, it } from 'vitest';
import { scopeCheck, stampsCheck, zeroNetworkCheck, type ExportExpectation } from '../../src/html/export-validate.ts';

/**
 * §8.5's pure, browser-free checks (per the file's own header comment). `parseCheck` /
 * `renderedParityCheck` / `validateExport`'s aggregation need a real Page — those live in
 * test/integration/html-export-validate-parity.test.ts.
 */

describe('zeroNetworkCheck', () => {
  it('passes a document with no live network references', () => {
    expect(zeroNetworkCheck('<html><body><img src="data:image/png;base64,AAAA"><style>.x{color:red}</style></body></html>')).toEqual([]);
  });

  it('flags an absolute http(s) src attribute', () => {
    const failures = zeroNetworkCheck('<img src="https://cdn.example.com/x.png">');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/live network reference in markup/);
  });

  it('flags a protocol-relative href/src', () => {
    const failures = zeroNetworkCheck('<link rel="stylesheet" href="//cdn.example.com/x.css">');
    expect(failures.length).toBeGreaterThan(0);
  });

  it('flags a live network reference inside CSS url(...)', () => {
    const failures = zeroNetworkCheck('<style>body{background:url(https://cdn.example.com/bg.png)}</style>');
    expect(failures.some((f) => /live network reference in CSS/.test(f))).toBe(true);
  });

  it('never flags a content <a href="https://...">  — a link, not a load', () => {
    expect(zeroNetworkCheck('<p>See <a href="https://example.com/report">the report</a>.</p>')).toEqual([]);
  });

  it('never flags a non-loading <link> (canonical, alternate, …), even with a relative href', () => {
    expect(zeroNetworkCheck('<link rel="canonical" href="/page">')).toEqual([]);
    expect(zeroNetworkCheck('<link rel="alternate" href="/page.rss">')).toEqual([]);
  });

  it('§regression: still flags a <link rel="stylesheet"> that survived un-inlined, even with a protocol-relative href', () => {
    expect(zeroNetworkCheck('<link rel="stylesheet" href="//cdn.example.com/x.css">').length).toBeGreaterThan(0);
  });

  it('§regression: flags a RELATIVE <video>/<source>/poster reference — src/poster never have a "reference only" reading, so relative is caught too, not just absolute', () => {
    expect(zeroNetworkCheck('<video src="/videos/hero.mp4"></video>').length).toBeGreaterThan(0);
    expect(zeroNetworkCheck('<video poster="/images/poster.jpg"></video>').length).toBeGreaterThan(0);
    expect(zeroNetworkCheck('<video><source src="/videos/hero.mp4" type="video/mp4"></video>').length).toBeGreaterThan(0);
    expect(zeroNetworkCheck('<audio src="/audio/clip.mp3"></audio>').length).toBeGreaterThan(0);
  });

  it('never flags an already-inlined data: URI on src/poster', () => {
    expect(zeroNetworkCheck('<video src="data:video/mp4;base64,AAAA" poster="data:image/png;base64,AAAA"></video>')).toEqual([]);
  });

  it('a relative CSS url(...) that escaped inlining is caught, not just absolute ones', () => {
    const failures = zeroNetworkCheck('<style>.x{background:url(/images/bg.png)}</style>');
    expect(failures.some((f) => /live network reference in CSS/.test(f))).toBe(true);
  });
});

describe('stampsCheck', () => {
  it('passes when every data-fra-element stamp is unique', () => {
    expect(stampsCheck('<div data-fra-element="e1"></div><div data-fra-element="e2"></div>')).toEqual([]);
  });

  it('flags a stamp duplicated on more than one element', () => {
    const failures = stampsCheck('<div data-fra-element="e1"></div><span data-fra-element="e1"></span>');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"e1"');
    expect(failures[0]).toMatch(/more than one element/);
  });

  it('ignores repeated stamps inside the injected-edits stylesheet (one CSS rule per edit is not a second element)', () => {
    const html = '<style id="fra-injected-edits" data-fra-injected="edits">[data-fra-element="e1"] { color: red !important; }\n[data-fra-element="e1"] { margin: 0 !important; }</style><div data-fra-element="e1"></div>';
    expect(stampsCheck(html)).toEqual([]);
  });

  it('reports one failure per distinct duplicated id when several are duplicated', () => {
    const html = ['e1', 'e1', 'e2', 'e2', 'e3'].map((id) => `<div data-fra-element="${id}"></div>`).join('');
    const failures = stampsCheck(html);
    expect(failures).toHaveLength(2);
    expect(failures.join(' ')).toContain('"e1"');
    expect(failures.join(' ')).toContain('"e2"');
  });

  it('passes on a document with no stamps at all', () => {
    expect(stampsCheck('<html><body>plain</body></html>')).toEqual([]);
  });
});

describe('scopeCheck', () => {
  it('content-no-header-footer: passes when the header/footer were replaced by inert placeholders and no header tag remains', () => {
    const html = '<html><body><div data-fra-removed="header" hidden></div><main>content</main><div data-fra-removed="footer" hidden></div></body></html>';
    const expectation: ExportExpectation = { file: 'redesign-content.html', scope: 'content-no-header-footer', headerFooterRetained: false };
    expect(scopeCheck(html, expectation)).toEqual([]);
  });

  it('content-no-header-footer: fails when a <header> is still present with no placeholder anywhere', () => {
    const html = '<html><body><header>nav</header><main>content</main></body></html>';
    const expectation: ExportExpectation = { file: 'redesign-content.html', scope: 'content-no-header-footer', headerFooterRetained: false };
    const failures = scopeCheck(html, expectation);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/excluded .* subtree is present but not replaced/);
  });

  it('whole-page, headerFooterRetained=false (original.html): the exclusion check does not apply at all', () => {
    const html = '<html><body><header>nav</header><main>content</main></body></html>';
    const expectation: ExportExpectation = { file: 'original.html', scope: 'whole-page', headerFooterRetained: false };
    expect(scopeCheck(html, expectation)).toEqual([]);
  });

  it('headerFooterRetained=true (redesign.html): passes when a <header> landmark is present', () => {
    const html = '<html><body><header data-fra-section="header">nav</header><main>content</main><footer data-fra-section="footer">f</footer></body></html>';
    const expectation: ExportExpectation = { file: 'redesign.html', scope: 'whole-page', headerFooterRetained: true };
    expect(scopeCheck(html, expectation)).toEqual([]);
  });

  it('headerFooterRetained=true: fails when there is neither a header/banner landmark nor any section stamp', () => {
    const html = '<html><body><main>content only, header stripped</main></body></html>';
    const expectation: ExportExpectation = { file: 'redesign.html', scope: 'whole-page', headerFooterRetained: true };
    const failures = scopeCheck(html, expectation);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/redesign\.html should retain the header\/footer/);
  });

  it('one-section: passes when exactly one distinct section stamp is present, even if repeated on several elements', () => {
    const html = '<div data-fra-section="hero">a</div><div data-fra-section="hero">b</div>';
    const expectation: ExportExpectation = { file: 'sections/hero.html', scope: 'one-section', onlySectionId: 'hero', headerFooterRetained: false };
    expect(scopeCheck(html, expectation)).toEqual([]);
  });

  it('one-section: fails when more than one distinct section stamp is present, naming the count and the expected id', () => {
    const html = '<div data-fra-section="hero">a</div><div data-fra-section="features">b</div>';
    const expectation: ExportExpectation = { file: 'sections/hero.html', scope: 'one-section', onlySectionId: 'hero', headerFooterRetained: false };
    const failures = scopeCheck(html, expectation);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('2 distinct section stamps');
    expect(failures[0]).toContain('"hero"');
  });
});
