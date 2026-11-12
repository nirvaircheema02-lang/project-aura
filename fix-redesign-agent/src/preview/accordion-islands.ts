import type { IslandPlan } from './plan.ts';
import type { ElementLayout, ExtractedSection, PreviewNode } from './types.ts';

/**
 * FAQ accordions → the design system's `AccordionItem`.
 *
 * The audit matched the FAQ rows to nothing useful (Button "primary", the prohibited black CTA), but the design system has the
 * component: `molecules/AccordionItem` (question trigger + animated answer panel, ARIA wired). An accordion row on the page is
 * recognised by what it IS, not by tag alone: a list item that holds a question heading and a collapsed answer panel (class `h-0`
 * with an inline height — the page collapses it that way). The row is replaced by the component with the original question and
 * the original answer content; the component keeps its own open/close behaviour.
 */

const el = (n: PreviewNode): n is Extract<PreviewNode, { t: 'el' }> => n.t === 'el';
const textOf = (n: PreviewNode): string => (n.t === 'text' ? n.v : n.children.map(textOf).join(''));
const normText = (s: string) => s.replace(/\s+/g, ' ').trim();

function descendants(n: PreviewNode): PreviewNode[] {
  return n.t === 'el' ? n.children.flatMap((c) => [c, ...descendants(c)]) : [];
}

const isCollapsedPanel = (n: PreviewNode): boolean => el(n) && /(^|\s)h-0(\s|$)/.test(n.attrs['class'] ?? '') && /height\s*:/.test(n.attrs['style'] ?? '') || (el(n) && /(^|\s)h-0(\s|$)/.test(n.attrs['class'] ?? '') && !!n.style && 'height' in n.style);

function findingIdsUnder(n: PreviewNode): string[] {
  const out = new Set<string>();
  const walk = (x: PreviewNode) => { if (el(x)) { x.findingIds?.forEach((id) => out.add(id)); x.children.forEach(walk); } };
  walk(n);
  return [...out];
}

/** Stamps of every element inside `n` (and `n` itself) — islands nested in a replaced row must not be planned too. */
export function stampsUnder(n: PreviewNode): string[] {
  const out: string[] = [];
  const walk = (x: PreviewNode) => { if (el(x)) { if (x.elementStamp) out.push(x.elementStamp); x.children.forEach(walk); } };
  walk(n);
  return out;
}

const DEFAULT_LAYOUT: ElementLayout = { display: 'block', margin: ['0px', '0px', '16px', '0px'], alignSelf: 'auto', flexGrow: '0', fullWidth: true };

export interface AccordionPlans {
  plans: IslandPlan[];
  /** stamps inside the replaced rows (headings, panels): other island planning must skip them */
  covered: Set<string>;
}

export function planAccordionIslands(sections: ExtractedSection[]): AccordionPlans {
  const plans: IslandPlan[] = [];
  const covered = new Set<string>();
  let n = 0;
  for (const section of sections) {
    const visit = (node: PreviewNode): void => {
      if (!el(node)) return;
      if (node.tag === 'li') {
        const kids = descendants(node);
        const heading = kids.find((k) => el(k) && /^h[1-6]$/.test(k.tag));
        const panel = kids.find(isCollapsedPanel);
        const question = heading ? normText(textOf(heading)) : '';
        if (heading && panel && el(panel) && question) {
          n++;
          // the row may carry no stamp of its own; a synthetic one lets the generator find and replace it
          const stamp = node.elementStamp ?? `acc-${section.id}-${n}`;
          node.elementStamp = stamp;
          for (const s of stampsUnder(node)) covered.add(s);
          plans.push({
            slot: `acc${n}`, stamp, sectionId: section.id, findingIds: [], spec: { component: 'AccordionItem', props: { id: `faq-${section.id}-${n}` } },
            label: question, basis: 'audit-match', layout: { ...DEFAULT_LAYOUT }, answer: panel.children,
          });
          return; // never nest accordions
        }
      }
      node.children.forEach(visit);
    };
    visit(section.tree);
  }
  return { plans, covered };
}

export { findingIdsUnder };
