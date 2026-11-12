import { findStatNumerals, STAT_NUMERAL } from './counters';

/**
 * Stat numeral colour (docs/REDESIGN_RULES.md "Stat numerals and counters"). A numeral is a neutral ink in every state: it does not change colour, and the
 * original's brand gradient (`text-transparent` + `background-clip: text` on group hover) is removed. The resting colour and size are resolved targets
 * (src/resolution/resolve.ts `withStatNumeralTargets`); this only pins them against the state rules the page's own CSS applies.
 * The ink is a DS token: `--pv-black-900` on a light surface, `--pv-white` on a dark one (measured from the first painted ancestor background).
 */
const CSS = `
[data-pv-stat] { --pv-stat-ink: var(--pv-black-900); }
[data-pv-stat="dark"] { --pv-stat-ink: var(--pv-white); }
/* Colour is NOT !important: the contrast verifier hides all text with \`*{color:transparent!important}\` to read the backdrop, and an !important ink here would survive that
   (the text would be measured against itself, 1:1). This sheet is adopted after the page's own, so on equal specificity it wins over the page's hover rule. */
[data-pv-stat], [data-pv-stat]:hover, [data-pv-stat]:focus-visible, .group:hover [data-pv-stat] {
  background-image: none !important; -webkit-text-fill-color: currentcolor; color: var(--pv-stat-ink);
}`;
let sheet: CSSStyleSheet | null = null;

function surfaceIsDark(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(getComputedStyle(n).backgroundColor);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
    return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 < 0.4;
  }
  return false;
}

export function attachStatNumerals(shadow: ShadowRoot): () => void {
  const els = findStatNumerals(shadow, STAT_NUMERAL);
  if (els.length === 0) return () => {};
  if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); }
  if (!shadow.adoptedStyleSheets.includes(sheet)) shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  for (const el of els) el.setAttribute('data-pv-stat', surfaceIsDark(el) ? 'dark' : 'light');
  return () => { for (const el of els) el.removeAttribute('data-pv-stat'); };
}
