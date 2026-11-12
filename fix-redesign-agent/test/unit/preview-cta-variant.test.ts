import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/audit-link/index.ts';
import { ctaStyleFor, hasBrandGradientLayer, isBrandRedOutline, paintsOwnBrandFill, surfaceOf } from '../../src/preview/cta-variant.ts';
import { planIslands } from '../../src/preview/plan.ts';
import type { ExtractedSection, PreviewNode } from '../../src/preview/types.ts';

type El = Extract<PreviewNode, { t: 'el' }>;
const el = (tag: string, cls: string, children: PreviewNode[] = [], extra: Partial<El> = {}): El => ({ t: 'el', tag, attrs: { class: cls }, children, ...extra });
const GRADIENT = 'absolute -z-10 left-0 w-[200%] h-full bg-[linear-gradient(90deg,#B01F24_0%,#F57478_50.38%,#B01F24_100%)]';

const finding = (id: string, type: string, label: string, section: string, props: Record<string, string>, ds: { dsComponent?: string; dsVariant?: string } = {}): Finding =>
  ({ identity: { findingId: id }, location: { section }, component: { productionType: type, productionLabel: label, dsComponent: ds.dsComponent ?? null, dsVariant: ds.dsVariant ?? null, signature: null },
    comparison: { mismatches: [], properties: Object.entries(props).map(([property, actual]) => ({ property, actual })) } }) as unknown as Finding;

describe('which DS Button variant a CTA is (decided from the original, not only the audit label)', () => {
  const GHOST = { variant: 'ghost', background: 'light' };

  it('REGRESSION: a control with a brand-red gradient layer inside is `brand`, although the audit measured a transparent box and matched `ghost`', () => {
    const node = el('a', 'relative overflow-hidden', [el('div', GRADIENT), el('span', '', [{ t: 'text', v: 'Get Pricing' }])]);
    expect(hasBrandGradientLayer(node)).toBe(true);
    const f = finding('F1', 'button', 'Get Pricing', 'Hero', { 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(255, 255, 255)' });
    expect(ctaStyleFor(node, f, GHOST, 'light')).toMatchObject({ variant: 'brand', background: 'light' });
  });

  it('REGRESSION (survey home page): a control whose OWN inline background is the brand-red gradient is `brand`, not the audit\'s `ghost`', () => {
    const node = el('a', 'relative border border-[#B01F24]', [{ t: 'text', v: 'Book Strategy Call' }], { style: { background: 'linear-gradient(270deg, rgb(215, 43, 49) 0%, rgb(176, 31, 36) 100%)' } });
    expect(paintsOwnBrandFill(node)).toBe(true);
    const f = finding('F0', 'button', 'Book Strategy Call', 'Hero', { 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(255, 255, 255)' });
    expect(ctaStyleFor(node, f, GHOST, 'light')).toMatchObject({ variant: 'brand', background: 'light' });
    // a red OUTLINE with transparent fill is the secondary action: Button `secondary`, not the audit's `ghost`
    const outline = el('a', 'border border-[#B01F24] text-[#B01F24]', [{ t: 'text', v: 'Get Pricing' }], { style: { color: 'rgb(176, 31, 36)' } });
    expect(paintsOwnBrandFill(outline)).toBe(false);
    expect(isBrandRedOutline(outline)).toBe(true);
    expect(ctaStyleFor(outline, f, GHOST, 'light')).toMatchObject({ variant: 'secondary', background: 'light' });
    // a plain control without red keeps the audit's variant
    expect(isBrandRedOutline(el('a', 'border border-black text-black', []))).toBe(false);
  });

  it('a white-filled control with dark text is `secondary`, and its background follows the (dark) surface it sits on', () => {
    const node = el('a', 'relative', [{ t: 'text', v: 'View More' }]);
    const f = finding('F2', 'button', 'View More', 'Our Resources', { 'background-color': 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' });
    expect(ctaStyleFor(node, f, GHOST, 'dark')).toMatchObject({ variant: 'secondary', background: 'dark' });
  });

  it('otherwise the audit\'s matched variant is kept', () => {
    const node = el('a', 'relative', [{ t: 'text', v: 'Go' }]);
    const f = finding('F3', 'button', 'Go', 'S', { 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(0, 0, 0)' });
    expect(ctaStyleFor(node, f, { variant: 'secondary', background: 'light' }, 'light')).toMatchObject({ variant: 'secondary', background: 'light' });
    expect(ctaStyleFor(node, f, GHOST, 'light')).toMatchObject({ variant: 'ghost' });
  });

  it('a section whose headings are light text is a dark surface; dark text is a light surface; no heading evidence is light', () => {
    const white = finding('H1', 'section-heading', 'Our Resources', 'Our Resources', { color: 'rgb(255, 255, 255)' });
    const dark = finding('H2', 'section-heading', 'FAQs', 'FAQs', { color: 'rgb(20, 16, 22)' });
    expect(surfaceOf('Our Resources', [white, dark])).toBe('dark');
    expect(surfaceOf('FAQs', [white, dark])).toBe('light');
    expect(surfaceOf('Nothing', [white, dark])).toBe('light');
  });

  it('planIslands with DS-first mounts the hero CTA as `brand` and the dark-surface white button as `secondary` dark; without DS-first it keeps the audit variant', () => {
    const hero = el('a', 'relative', [el('div', GRADIENT), { t: 'text', v: 'Get Pricing' }], { elementStamp: 'e5', attrs: { class: 'relative', href: '/p' } });
    const more = el('a', 'relative', [{ t: 'text', v: 'View More' }], { elementStamp: 'e6', attrs: { class: 'relative', href: '/m' } });
    const fh = finding('FH', 'button', 'Get Pricing', 'Hero', { 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(255, 255, 255)' }, { dsComponent: 'Button', dsVariant: 'ghost · md · light' });
    const fm = finding('FM', 'button', 'View More', 'Our Resources', { 'background-color': 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' }, { dsComponent: 'Button', dsVariant: 'ghost · md · light' });
    const head = finding('HD', 'section-heading', 'Our Resources', 'Our Resources', { color: 'rgb(255, 255, 255)' });
    const layout = { display: 'inline-flex', margin: ['0px', '0px', '0px', '0px'], alignSelf: 'auto', flexGrow: '0', fullWidth: false };
    const sec = (id: string, name: string, node: PreviewNode, stamp: string, fid: string): ExtractedSection => ({ id, name, tree: el('div', '', [node]), findingElements: [{ stamp, findingIds: [fid], tag: 'a', textAlign: 'center', layout }] } as unknown as ExtractedSection);
    const args = { sections: [sec('hero', 'Hero', hero, 'e5', 'FH'), sec('our-resources', 'Our Resources', more, 'e6', 'FM')], entries: [], findings: [fh, fm, head], decisions: null };
    expect(planIslands(args).plans.map((p) => p.spec.props['variant'])).toEqual(['ghost', 'ghost']);
    const ds = planIslands({ ...args, dsFirst: true }).plans;
    expect(ds.map((p) => [p.spec.props['variant'], p.spec.props['background']])).toEqual([['brand', 'light'], ['secondary', 'dark']]);
  });
});

describe('standalone "text + arrow" links are CTALink (the DS doc reserves InlineLink for links inside prose)', () => {
  const layout = { display: 'flex', margin: ['0px', '0px', '0px', 'auto'], alignSelf: 'auto', flexGrow: '0', fullWidth: false };
  const svg = (): PreviewNode => el('svg', '', [], { ns: 'svg' });
  const sec = (node: PreviewNode, name: string): ExtractedSection => ({ id: 'our-impact', name, tree: el('div', '', [node]), findingElements: [{ stamp: 'e9', findingIds: ['FR'], tag: 'a', textAlign: 'right', layout }] } as unknown as ExtractedSection);
  const read = finding('FR', 'link', 'Read More', 'Our Impact', {}, { dsComponent: 'InlineLink', dsVariant: 'muted' });
  const heading = finding('HD', 'section-heading', 'Our Impact', 'Our Impact', { color: 'rgb(20, 16, 22)' });

  it('mounts CTALink (light surface: no onDark) for a link that carries an arrow, keeping its href and label', () => {
    const node = el('a', 'group', [{ t: 'text', v: 'Read More' }, svg()], { elementStamp: 'e9', attrs: { class: 'group', href: '/case-study' } });
    const plans = planIslands({ sections: [sec(node, 'Our Impact')], entries: [], findings: [read, heading], decisions: null, dsFirst: true }).plans;
    expect(plans).toHaveLength(1);
    expect(plans[0]!.spec).toEqual({ component: 'CTALink', props: { size: 'md', href: '/case-study' } });
    expect(plans[0]!.label).toBe('Read More');
  });

  it('a link without an arrow stays an InlineLink as the audit matched (nothing mounted, reason recorded); without DS-first nothing changes', () => {
    const node = el('a', '', [{ t: 'text', v: 'Read More' }], { elementStamp: 'e9', attrs: { class: '', href: '/x' } });
    const out = planIslands({ sections: [sec(node, 'Our Impact')], entries: [], findings: [read, heading], decisions: null, dsFirst: true });
    expect(out.plans).toEqual([]);
    expect(out.skipped[0]!.reason).toMatch(/InlineLink is kept/);
    const withArrow = el('a', 'group', [{ t: 'text', v: 'Read More' }, svg()], { elementStamp: 'e9', attrs: { class: 'group', href: '/x' } });
    expect(planIslands({ sections: [sec(withArrow, 'Our Impact')], entries: [], findings: [read, heading], decisions: null }).plans).toEqual([]);
  });
});

describe('carousel previous/next controls are built the way the DS builds them (ui/carousel)', () => {
  const layout = { display: 'flex', margin: ['0px', '0px', '0px', '0px'], alignSelf: 'auto', flexGrow: '0', fullWidth: false };
  const arrow = (stamp: string): PreviewNode => el('div', 'cursor-pointer', [el('svg', '', [], { ns: 'svg' })], { elementStamp: stamp });
  const sec = (kids: PreviewNode[]): ExtractedSection => ({ id: 'what-our-clients-say', name: 'What Our Clients Say', tree: el('div', 'flex', kids), findingElements: kids.map((k) => ({ stamp: (k as El).elementStamp!, findingIds: ['I' + (k as El).elementStamp], tag: 'div', textAlign: 'start', layout })) } as unknown as ExtractedSection);
  const fi = (stamp: string) => finding('I' + stamp, 'icon-button', '(unlabelled icon-button generic)', 'What Our Clients Say', {});

  it('mounts CarouselArrow prev then next for an icon-only pair (the DS: outline Button, size-8 rounded-full, lucide ArrowLeft / ArrowRight)', () => {
    const plans = planIslands({ sections: [sec([arrow('a'), arrow('b')])], entries: [], findings: [fi('a'), fi('b')], decisions: null, dsFirst: true }).plans;
    expect(plans.map((p) => [p.spec.component, p.spec.props['direction']])).toEqual([['CarouselArrow', 'prev'], ['CarouselArrow', 'next']]);
  });

  it('a lone icon-only control (no pair) has no DS component: nothing is mounted and the reason is recorded; without DS-first nothing changes', () => {
    const out = planIslands({ sections: [sec([arrow('a')])], entries: [], findings: [fi('a')], decisions: null, dsFirst: true });
    expect(out.plans).toEqual([]);
    expect(out.skipped[0]!.reason).toMatch(/no design-system component matches/);
    expect(planIslands({ sections: [sec([arrow('a'), arrow('b')])], entries: [], findings: [fi('a'), fi('b')], decisions: null }).plans).toEqual([]);
  });
});
