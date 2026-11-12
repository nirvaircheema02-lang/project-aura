import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { captureDesign, htmlSha256Of, snapshotTargets } from '../../src/fidelity/capture.ts';
import type { DesignCapture } from '../../src/fidelity/types.ts';
import { openOfflineSnapshot } from '../../src/preview/extract.ts';

/**
 * A state is captured only once it has stopped changing. Found on a real page: a card's label inherits its colour from an ANCESTOR
 * whose transition runs ~1 s, so a settle based on the hovered subtree alone sampled the original and the preview at two different
 * frames of the same animation and reported a hover "regression" that did not exist.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:Arial,sans-serif}
.wrap{color:#000;transition:color 900ms linear;padding:20px}
.wrap:hover{color:#fff;background:#222}
.item{display:block;color:inherit;text-decoration:none}
.pulse:hover span{animation:blink 120ms infinite alternate}
@keyframes blink{from{color:#111}to{color:#eee}}
</style></head><body>
<section data-fra-section="s"><div class="wrap"><a class="item" href="#x"><span>Label that inherits an animating colour</span></a></div>
<div class="pulse"><a class="item" href="#y"><span>Never settles</span></a></div></section>
</body></html>`;

let browser: Browser;
let cap: DesignCapture;
beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const { page, close } = await openOfflineSnapshot(ctx, PAGE);
  try {
    cap = await captureDesign({ page, targets: snapshotTargets(['s']), viewports: [{ name: 'desktop', width: 1440, height: 900 }], source: { kind: 'pre-edit-snapshot', htmlSha256: htmlSha256Of(PAGE), url: null } });
  } finally { await close(); await ctx.close(); }
}, 120_000);
afterAll(async () => { await browser?.close(); });

describe('state capture waits for the state to stop changing', () => {
  it("records the hover colour a visitor ends up seeing, even when it animates through an ancestor's transition", () => {
    const sec = cap.sections[0]!;
    const item = sec.elements.find((e) => e.tag === 'a' && e.label.startsWith('Label'))!;
    const hover = item.states.hover;
    expect(hover).toBeDefined();
    const span = Object.entries(hover!.subtree).find(([rel]) => rel !== '')!;
    expect(span[1]['color']).toBe('rgb(255, 255, 255)'); // the settled end value, not a frame of the 900 ms transition
  });

  it('an element that never stops changing is reported as not compared, never captured at an arbitrary frame', () => {
    const sec = cap.sections[0]!;
    const item = sec.elements.find((e) => e.tag === 'a' && e.label.startsWith('Never'))!;
    expect(item.states.hover).toBeUndefined();
    expect(sec.notes.join(' ')).toMatch(/hover on "Never settles".*kept changing.*not compared/);
    expect(sec.coverage.hover.attempted).toBeGreaterThan(sec.coverage.hover.captured);
  });
});
