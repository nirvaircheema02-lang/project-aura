/**
 * A page built with KNOWN-WRONG values measured against the real Design
 * System: the hero CTA is 44px tall where the DS's effective
 * --button-height-md is 48px (the exact 26-token override D3 resolves), so a
 * real deviation must be found by measurement, not by the script. Shared by
 * every end-to-end B-graph test so they all exercise the same page.
 */
export const KNOWN_WRONG_PAGE = `<!doctype html><html><head><style>
  :root { --ken-red: #b01f24; }
  body { margin: 0; font-family: 'DM Sans', sans-serif; }
  .cta { height: 44px; background: #b01f24; color: #fff; border: 0; padding: 0 24px; }
  .cta-ok { height: 48px; background: #b01f24; color: #fff; border: 0; padding: 0 24px; }
  .card { cursor: pointer; border: 1px solid #d9d1ce; padding: 16px; margin: 8px; width: 200px; }
  .stat { cursor: pointer; padding: 12px; }
</style></head><body>
<nav aria-label="Main"><a href="/reports">Reports</a><a href="/consulting">Consulting</a></nav>
<main>
  <section aria-label="Hero">
    <h1>Accelerate Market Entry</h1>
    <button type="button" class="cta">Talk to a Strategy Expert</button>
    <button type="button" class="cta-ok">Book discovery call</button>
    <button type="button" class="cta-ok">Decorative red accent</button>
  </section>
  <section aria-label="Cards">
    <div class="card">Report card one</div>
    <div class="card">Report card two</div>
    <div class="card">Report card three</div>
  </section>
  <section aria-label="Stats"><div class="stat"><span>0+</span> Clients Served</div></section>
</main>
<footer aria-label="Footer"><a href="https://forms.office.com/ticket">IT Support</a></footer>
</body></html>`;
