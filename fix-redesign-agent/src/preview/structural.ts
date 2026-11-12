import type { IslandPlan } from './plan.ts';
import type { ExtractedSection, PreviewNode } from './types.ts';

/**
 * Rules for elements the generator recognises by what they ARE, with no audit finding mapped to them (docs/REDESIGN_RULES.md "Structural DS rules").
 * The extractor (extract.ts `markStructural`) finds and stamps them in the snapshot; this module turns them into the design system's components or style.
 * Pure: no I/O.
 *
 *  - Arrow link ("Read More ↗", "Learn more", "View all"…): the DS builds that control as CTALink (atoms/CTALink.md: "Exploratory navigation"), so it is mounted
 *    as an island that keeps the original's slot (display, margins, alignment, padding) and its href. Only when no finding is mapped to the link: a mapped one
 *    keeps its finding's route (planIslands).
 *  - Eyebrow label (short ALL-CAPS label whose only sibling is a decorative icon): the icon is dropped and the label takes the DS SectionLabel treatment.
 *    "Step NN" labels are a different rule (Step labels) and are excluded.
 */

const textOf = (n: PreviewNode): string => (n.t === 'text' ? n.v : n.children.map(textOf).join(''));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const hasSvg = (n: PreviewNode): boolean => n.t === 'el' && (n.tag === 'svg' || n.children.some(hasSvg));

function find(root: PreviewNode, stamp: string): (PreviewNode & { t: 'el' }) | null {
  if (root.t !== 'el') return null;
  if (root.elementStamp === stamp) return root;
  for (const c of root.children) { const r = find(c, stamp); if (r) return r; }
  return null;
}
function parentOf(root: PreviewNode, stamp: string): (PreviewNode & { t: 'el' }) | null {
  if (root.t !== 'el') return null;
  if (root.children.some((c) => c.t === 'el' && c.elementStamp === stamp)) return root;
  for (const c of root.children) { const r = parentOf(c, stamp); if (r) return r; }
  return null;
}

/**
 * DS `Button variant="brand"` islands for the CTA buttons no finding is mapped to (a link drawn as a brand-red filled or red-bordered box): the project's rule for a primary action is `brand`
 * (never `primary`); the arrow svg becomes `animatedArrow`. The wrapper keeps the original's slot (right-aligned CTAs keep `margin-left: auto`).
 */
export function planCtaButtonIslands(sections: readonly ExtractedSection[], taken: ReadonlySet<string> = new Set(), startAt = 0): IslandPlan[] {
  const plans: IslandPlan[] = [];
  let n = startAt;
  for (const section of sections) {
    for (const se of section.structural ?? []) {
      if (se.kind !== 'cta-button' || taken.has(se.stamp)) continue;
      const node = find(section.tree, se.stamp);
      if (!node || node.tag !== 'a' || !node.attrs['href']) continue;
      const withoutSvg = (x: PreviewNode): string => (x.t === 'text' ? x.v : x.t === 'el' && x.tag === 'svg' ? '' : x.children.map(withoutSvg).join(''));
      const label = norm(withoutSvg(node));
      if (!label) continue;
      const props: Record<string, string | number | boolean> = { variant: 'brand', size: 'md', href: node.attrs['href'] };
      if (hasSvg(node)) props['animatedArrow'] = true;
      plans.push({ slot: `structural${++n}`, stamp: se.stamp, sectionId: section.id, findingIds: [], spec: { component: 'Button', props }, label, basis: 'structural', layout: se.layout });
    }
  }
  return plans;
}

/** DS `Badge` islands for the pill chips no finding is mapped to ("Featured Post" over an image): variant pill, size sm, neutral; on a dark surface `mode="dark"` with the overlay treatment (DS tokens, backdrop blur). */
export function planBadgeIslands(sections: readonly ExtractedSection[], taken: ReadonlySet<string> = new Set(), startAt = 0): IslandPlan[] {
  const plans: IslandPlan[] = [];
  let n = startAt;
  for (const section of sections) {
    for (const se of section.structural ?? []) {
      if (se.kind !== 'badge' || taken.has(se.stamp)) continue;
      const node = find(section.tree, se.stamp);
      if (!node || node.children.some((c) => c.t === 'el')) continue;
      const label = norm(textOf(node));
      if (!label) continue;
      const props: Record<string, string | number | boolean> = { variant: 'pill', size: 'sm', theme: 'neutral', mode: se.onDark ? 'dark' : 'light' };
      if (se.onDark) props['overlay'] = true;
      plans.push({ slot: `structural${++n}`, stamp: se.stamp, sectionId: section.id, findingIds: [], spec: { component: 'Badge', props }, label, basis: 'structural', layout: { ...se.layout, widthRules: [] } }); // a badge sizes to its label: the original's fixed w-[111px] would clip the DS badge's uppercase text
    }
  }
  return plans;
}

/**
 * DS colours for carousel indicator bars. The extractor found, per group, the class tokens that make one bar "active"; the CSS selects by those classes, so the colours follow the
 * carousel script as it moves the active class. Light surface: active `--black-900`, rest `--black-300`; dark surface: active `--semantic-ink-on-dark-strong`, rest
 * `--semantic-ink-on-dark-faint` (DS tokens; the original's purple is not a DS indicator colour). Bars are made 28px wide (swiper bullets: 24px, square, 8px apart), as on the Dealer Voice page; height is kept.
 */
export function indicatorCss(sections: readonly ExtractedSection[]): string {
  const sel = (tokens: string[]) => tokens.map((t) => `[class~=${JSON.stringify(t)}]`).join('');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const section of sections) {
    for (const g of section.indicators ?? []) {
      const shared = sel(g.shared);
      const active = g.active.length ? `${shared}${sel(g.active)}` : `${shared}:not(${g.rest.map((t) => `[class~=${JSON.stringify(t)}]`).join('')})`;
      const rest = g.rest.length ? `${shared}${sel(g.rest)}` : `${shared}:not(${g.active.map((t) => `[class~=${JSON.stringify(t)}]`).join('')})`;
      const [a, r] = g.dark ? ['var(--semantic-ink-on-dark-strong)', 'var(--semantic-ink-on-dark-faint)'] : ['var(--black-900)', 'var(--black-300)'];
      // Swiper bullets: the live CSS spaces them with a nested `margin: 0 4px` rule that the preview's flattened CSS loses, which left a merged rail instead of separate bars (Dealer Voice shape: 24×3, square, 8px between)
      const swiper = g.shared.includes('swiper-pagination-bullet');
      const shape = swiper ? `${shared} { width: 24px !important; margin: 0 4px !important; border-radius: 0 !important; }` : `${shared} { width: 28px !important; }`;
      const css = `${shape}\n${active} { background: ${a} !important; opacity: 1 !important; }\n${rest} { background: ${r} !important; opacity: 1 !important; }`;
      if (!seen.has(css)) { seen.add(css); out.push(css); }
    }
  }
  return out.length ? `/* Carousel indicators: DS colours, small bars (structural DS rule) */\n${out.join('\n')}` : '';
}

/** CTALink islands for the arrow links no finding is mapped to. Slots are `sl<N>` so they never collide with the planner's `island<N>`. */
export function planArrowLinkIslands(sections: readonly ExtractedSection[], taken: ReadonlySet<string> = new Set()): IslandPlan[] {
  const plans: IslandPlan[] = [];
  let n = 0;
  for (const section of sections) {
    for (const se of section.structural ?? []) {
      if (se.kind !== 'arrow-link' || taken.has(se.stamp)) continue;
      const node = find(section.tree, se.stamp);
      if (!node || node.tag !== 'a' || !node.attrs['href'] || !hasSvg(node)) continue;
      const label = norm(textOf(node));
      if (!label) continue;
      const props: Record<string, string | number | boolean> = { size: 'md', href: node.attrs['href'] };
      if (se.onDark) props['onDark'] = true;
      plans.push({ slot: `structural${++n}`, stamp: se.stamp, sectionId: section.id, findingIds: [], spec: { component: 'CTALink', props }, label, basis: 'structural', layout: se.layout });
    }
  }
  return plans;
}

/** The DS SectionLabel treatment an eyebrow takes (values of the DS SectionLabel the audit matches: --brand-red, --text-xs, bold, wide tracking, caps). Tokens are the preview's own `--pv-*` copies of the DS tokens. */
export const EYEBROW_CSS = `[data-pv-eyebrow] { color: var(--pv-brand-red) !important; font-size: var(--pv-text-xs) !important; font-weight: 700 !important; letter-spacing: 0.15em !important; text-transform: uppercase !important; display: inline-flex !important; align-items: center !important; }`;

/**
 * Drops the decorative icon in front of each eyebrow label and marks the label `data-pv-eyebrow` (the CSS above styles it). Mutates the section trees.
 * Returns how many eyebrows were changed, per section, for the preview notes.
 */
export function applyEyebrowRule(sections: readonly ExtractedSection[]): Array<{ sectionId: string; label: string }> {
  const out: Array<{ sectionId: string; label: string }> = [];
  for (const section of sections) {
    for (const se of section.structural ?? []) {
      if (se.kind !== 'eyebrow') continue;
      const label = find(section.tree, se.stamp);
      const parent = parentOf(section.tree, se.stamp);
      if (!label || !parent) continue;
      const at = parent.children.indexOf(label);
      const icon = parent.children.slice(0, at).reverse().find((c) => c.t === 'el');
      if (!icon || icon.t !== 'el' || !hasSvg(icon) || norm(textOf(icon)) !== '') continue;
      parent.children = parent.children.filter((c) => c !== icon);
      label.attrs = { ...label.attrs, 'data-pv-eyebrow': '' };
      out.push({ sectionId: section.id, label: norm(textOf(label)) });
    }
  }
  return out;
}

/**
 * Marks the carousel indicator bars of each group (`data-pv-indicator`) so the fidelity comparison can tell the DS colours and width from a regression. A bar is an empty element
 * carrying every class token the group shares. Mutates the section trees; returns how many bars were marked.
 */
export function markIndicatorBars(sections: readonly ExtractedSection[]): number {
  let marked = 0;
  const walk = (n: PreviewNode, shared: string[]) => {
    if (n.t !== 'el') return;
    const cls = (n.attrs['class'] ?? '').split(/\s+/);
    if (n.children.length === 0 && shared.every((t) => cls.includes(t))) { n.attrs = { ...n.attrs, 'data-pv-indicator': '' }; marked++; }
    n.children.forEach((c) => walk(c, shared));
  };
  for (const section of sections) for (const g of section.indicators ?? []) walk(section.tree, g.shared);
  return marked;
}
