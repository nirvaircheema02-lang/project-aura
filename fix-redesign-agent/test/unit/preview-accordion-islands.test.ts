import { describe, expect, it } from 'vitest';
import { planAccordionIslands } from '../../src/preview/accordion-islands.ts';
import { emitIsland, emitSectionSource, ISLAND_DIR } from '../../src/preview/jsx.ts';
import { planIslands } from '../../src/preview/plan.ts';
import type { EmitContext } from '../../src/preview/jsx.ts';
import type { ExtractedSection, PreviewNode } from '../../src/preview/types.ts';

const t = (v: string): PreviewNode => ({ t: 'text', v });
const e = (tag: string, attrs: Record<string, string>, children: PreviewNode[] = [], extra: Partial<Extract<PreviewNode, { t: 'el' }>> = {}): PreviewNode => ({ t: 'el', tag, attrs, children, ...extra });
const row = (q: string, answers: string[], stamp?: string) =>
  e('li', { class: 'relative cursor-pointer' }, [
    e('svg', { class: 'absolute' }, [], { ns: 'svg' }),
    e('h3', { class: 'font-medium' }, [t(q)], { elementStamp: `h-${q}`, findingIds: ['F-' + q] }),
    e('p', { class: 'h-0 overflow-hidden', style: 'height: 0px;' }, answers.map((a) => e('p', {}, [t(a)]))),
  ], stamp ? { elementStamp: stamp } : {});
const section = (...rows: PreviewNode[]): ExtractedSection => ({ id: 'faqs', name: 'FAQs', tree: e('ul', {}, rows), findingElements: [] } as unknown as ExtractedSection);
const ctx: EmitContext = { assetUrl: (u: string) => u, islands: new Map(), extraRules: [], importantCounter: { n: 0 }, renameVars: (x: string) => x } as unknown as EmitContext;

describe('FAQ rows become the design system AccordionItem', () => {
  it('recognises a row by what it is (question heading + collapsed answer panel), keeps the question and the original answer content', () => {
    const { plans } = planAccordionIslands([section(row('Why late?', ['A1', 'A2']), row('How?', ['B1']))]);
    expect(plans.map((p) => p.label)).toEqual(['Why late?', 'How?']);
    expect(plans[0]!.spec.component).toBe('AccordionItem');
    expect(plans[0]!.answer).toHaveLength(2);
    expect(plans[1]!.answer).toHaveLength(1);
    expect(new Set(plans.map((p) => p.slot)).size).toBe(2);
  });

  it('gives an unstamped row a stamp so it can be replaced, keeps an existing stamp, and spaces the cards as the DS prescribes (space-y-4)', () => {
    const r1 = row('Q1', ['a']);
    const r2 = row('Q2', ['b'], 'e101');
    const { plans } = planAccordionIslands([section(r1, r2)]);
    expect(plans[0]!.stamp).toMatch(/^acc-faqs-/);
    expect((r1 as Extract<PreviewNode, { t: 'el' }>).elementStamp).toBe(plans[0]!.stamp);
    expect(plans[1]!.stamp).toBe('e101');
    expect(plans[0]!.layout.margin).toEqual(['0px', '0px', '16px', '0px']);
  });

  it('REGRESSION: every stamp inside a replaced row is reported as covered, so the question heading is not ALSO planned as a SectionHeading island', () => {
    const { covered } = planAccordionIslands([section(row('Q1', ['a']))]);
    expect(covered.has('h-Q1')).toBe(true);
  });

  it('leaves list items that are not accordion rows alone (no collapsed panel, or no heading)', () => {
    const noPanel = e('li', {}, [e('h3', {}, [t('Title')]), e('p', {}, [t('text')])]);
    const noHeading = e('li', {}, [e('p', { class: 'h-0', style: 'height: 0px;' }, [t('x')])]);
    expect(planAccordionIslands([section(noPanel, noHeading)]).plans).toEqual([]);
  });

  it('is only used with DS-first: planIslands without the flag plans no accordion', () => {
    const args = { sections: [section(row('Q1', ['a']))], entries: [], findings: [], decisions: null };
    expect(planIslands(args).plans).toEqual([]);
    expect(planIslands({ ...args, dsFirst: true }).plans.map((p) => p.spec.component)).toEqual(['AccordionItem']);
  });

  it('emits the component with the question and the ORIGINAL answer nodes, imported from molecules/', () => {
    const { plans } = planAccordionIslands([section(row('Why late?', ['Answer one']))]);
    const jsx = emitIsland(plans[0]!.spec, plans[0]!.label, { nodes: plans[0]!.answer!, ctx });
    expect(jsx).toMatch(/^<AccordionItem id="faq-faqs-1" question=\{"Why late\?"\} answer=\{<>/);
    expect(jsx).toContain('Answer one');
    expect(ISLAND_DIR.AccordionItem).toBe('molecules');
    const src = emitSectionSource({ id: 'faqs', name: 'FAQs', tree: e('div', {}), ancestors: [] }, ctx, [{ slot: 'acc1', jsx, component: 'AccordionItem', findingIds: '', wrapperStyle: {} }]);
    expect(src.code).toContain("import { AccordionItem } from '@kenresearch/design-system/molecules/AccordionItem';");
  });
});

describe('runtime islands and imports', () => {
  it('CarouselArrow is imported from the preview runtime, CTALink from the DS atoms, and an icon-only island has no text child', () => {
    const src = emitSectionSource({ id: 's', name: 'S', tree: e('div', {}), ancestors: [] }, ctx, [
      { slot: 'i1', jsx: emitIsland({ component: 'CarouselArrow', props: { direction: 'prev' } }, ''), component: 'CarouselArrow', findingIds: '', wrapperStyle: {} },
      { slot: 'i2', jsx: emitIsland({ component: 'CTALink', props: { size: 'md', href: '/x' } }, 'Read More'), component: 'CTALink', findingIds: '', wrapperStyle: {} },
    ]);
    expect(src.code).toContain("import { CarouselArrow } from '../../runtime/CarouselArrow';");
    expect(src.code).toContain("import { CTALink } from '@kenresearch/design-system/atoms/CTALink';");
    expect(emitIsland({ component: 'CarouselArrow', props: { direction: 'next' } }, '')).toBe('<CarouselArrow direction="next" />');
    expect(emitIsland({ component: 'CTALink', props: { size: 'md', href: '/x' } }, 'Read More')).toBe('<CTALink size="md" href="/x">{"Read More"}</CTALink>');
  });
});
