/**
 * A page whose elements each exercise one no-api outcome (Decision Log #31),
 * measured against the REAL Design System:
 *  - a Button built FROM the DS (its own class strings) with the DS's exact
 *    brand/md values → MATCH;
 *  - the same Button at 44px tall → DEVIATION (--button-height-md is 48px);
 *  - a hand-rolled link in Manrope → INCORRECT (R1.4 two-font pairing), whatever
 *    DS component it would be;
 *  - a single clickable card on DS foundations that resembles no DS card
 *    closely → NEEDS_REVIEW, with its possible matches;
 *  - three identical tabs on DS foundations with no DS equivalent → DS_CANDIDATE.
 */

/** The class string DS Button (atoms/Button.tsx) renders for variant=brand, size=md — copied from its sharedClassName. */
export const DS_BUTTON_BRAND_MD_CLASSES = [
  'group relative inline-flex items-center justify-center font-medium tracking-[0.0875px]',
  'transition-all duration-300 rounded-[var(--radius-button)] overflow-hidden whitespace-nowrap',
  'gap-2 px-[var(--button-px-md)] h-[var(--button-height-md)] min-w-[var(--button-min-width-md)]',
  'text-[var(--color-foundation-white)] disabled:opacity-50 w-full sm:w-auto cursor-pointer',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-red)] focus-visible:ring-offset-2',
].join(' ');

const dsButtonStyle = (height: number) =>
  `height:${height}px;padding:0 28px;min-width:112px;font-weight:500;letter-spacing:0.0875px;border-radius:5px;display:inline-flex;` +
  `align-items:center;justify-content:center;gap:8px;column-gap:8px;row-gap:8px;color:#fff;font-family:'DM Sans',sans-serif;font-size:16px;border:0;` +
  `background-image:linear-gradient(90deg,#b01f24 0%,#eb484e 50%,#b01f24 100%);box-shadow:0 4px 16px rgba(176,31,36,0.15);overflow:hidden;white-space:nowrap;cursor:pointer`;

export const NO_API_PAGE = `<!doctype html><html><head><title>No-API fixture</title><style>
  body { margin: 0; font-family: 'DM Sans', sans-serif; color: #000; background: #fff; }
  section { padding: 32px; }
  .tab { cursor: pointer; font-family: 'DM Sans', sans-serif; font-size: 16px; color: #000000; padding: 10px 20px; border: 0; background: transparent; }
</style></head><body>
<main>
  <section aria-label="Actions">
    <h2 style="font-family:'Noto Serif',serif;font-size:31.25px;font-weight:300;margin:0 0 16px">Talk to us</h2>
    <button type="button" class="${DS_BUTTON_BRAND_MD_CLASSES}" style="${dsButtonStyle(48)}">Book discovery call</button>
    <button type="button" class="${DS_BUTTON_BRAND_MD_CLASSES}" style="${dsButtonStyle(44)}">Talk to a Strategy Expert</button>
    <a href="/reports" style="font-family:Manrope,sans-serif;font-size:13px;color:#b01f24">Explore all reports</a>
  </section>
  <section aria-label="Offer">
    <div style="cursor:pointer;border:1px solid #d9d1ce;padding:16px;width:320px;height:120px;font-family:'DM Sans',sans-serif;font-size:16px;color:#000">Market sizing workshop</div>
  </section>
  <section aria-label="Views">
    <div role="tablist"><button role="tab" class="tab">Overview</button><button role="tab" class="tab">Method</button><button role="tab" class="tab">Pricing</button></div>
  </section>
</main>
</body></html>`;
