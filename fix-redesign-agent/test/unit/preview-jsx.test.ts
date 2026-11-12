import { describe, expect, it } from 'vitest';
import { cssPropName, emitIsland, emitNode, emitSectionSource, islandWrapperStyle, propName, type EmitContext } from '../../src/preview/jsx.ts';
import type { PreviewNode } from '../../src/preview/types.ts';

const ctx = (over: Partial<EmitContext> = {}): EmitContext => ({ assetUrl: (v) => (v.startsWith('data:') ? '/assets/x.png' : v), islands: new Map(), extraRules: [], importantCounter: { n: 0 }, ...over });
const el = (tag: string, attrs: Record<string, string> = {}, children: PreviewNode[] = [], extra: Partial<PreviewNode & { t: 'el' }> = {}): PreviewNode => ({ t: 'el', tag, attrs, children, ...extra }) as PreviewNode;
const text = (v: string): PreviewNode => ({ t: 'text', v });

describe('attribute and style names', () => {
  it('maps HTML attributes to React props', () => {
    expect(propName('class', false, 'div')).toBe('className');
    expect(propName('for', false, 'label')).toBe('htmlFor');
    expect(propName('tabindex', false, 'a')).toBe('tabIndex');
    expect(propName('data-x', false, 'a')).toBe('data-x');
    expect(propName('aria-label', false, 'a')).toBe('aria-label');
  });
  it('drops inline event handlers and attributes React cannot represent', () => {
    expect(propName('onclick', false, 'a')).toBeNull();
    expect(propName('x:y', false, 'a')).toBeNull();
  });
  it('maps SVG attributes and leaves the namespace to React', () => {
    expect(propName('stroke-width', true, 'path')).toBe('strokeWidth');
    expect(propName('xlink:href', true, 'use')).toBe('xlinkHref');
    expect(propName('xmlns', true, 'svg')).toBeNull();
  });
  it('maps CSS property names, keeping custom properties verbatim', () => {
    expect(cssPropName('background-color')).toBe('backgroundColor');
    expect(cssPropName('--pv-x')).toBe('--pv-x');
    expect(cssPropName('-webkit-line-clamp')).toBe('WebkitLineClamp');
  });
});

describe('emitNode', () => {
  it('emits text as a string expression so braces and quotes cannot break the JSX', () => {
    const out = emitNode(el('p', {}, [text('a {brace} "quote" <tag>')]), ctx(), 0);
    expect(out).toContain('{"a {brace} \\"quote\\" <tag>"}');
  });
  it('uses an expression for attribute values JSX would misread (backslashes, newlines)', () => {
    const out = emitNode(el('path', { d: 'M0 0\nL1 1' }, [], { ns: 'svg' } as never), ctx(), 0);
    expect(out).toContain('d={"M0 0\\nL1 1"}');
  });
  it('emits void elements self-closed and boolean attributes bare', () => {
    expect(emitNode(el('input', { type: 'text', disabled: '' }), ctx(), 0)).toBe('<input type="text" disabled />');
  });
  it('turns an input value into defaultValue and keeps the select choice', () => {
    const select = el('select', {}, [el('option', { value: 'a' }, [text('A')]), el('option', { value: 'b', selected: '' }, [text('B')])]);
    expect(emitNode(select, ctx(), 0)).toContain('defaultValue="b"');
  });
  it('externalizes asset URLs through the context', () => {
    expect(emitNode(el('img', { src: 'data:image/png;base64,AAAA' }), ctx(), 0)).toContain('src="/assets/x.png"');
  });
  it('carries finding ids as data attributes so verification can find the element', () => {
    const out = emitNode(el('a', { href: '/x' }, [text('Go')], { findingIds: ['f1', 'f2'] }), ctx(), 0);
    expect(out).toContain('data-finding-ids="f1 f2"');
    expect(out).not.toContain('data-finding-id=');
    expect(emitNode(el('a', {}, [], { findingIds: ['only'] }), ctx(), 0)).toContain('data-finding-id="only"');
  });
  it('REGRESSION: an image is never lazy-loaded (a lazy image inside a shadow root can stay un-requested on a phone viewport and leave a blank hero)', () => {
    const out = emitNode(el('img', { src: '/a.png', loading: 'lazy', alt: 'x' }, []), ctx(), 0);
    expect(out).not.toContain('loading');
    expect(out).toContain('src=');
    expect(emitNode(el('img', { src: '/a.png', loading: 'eager' }, []), ctx(), 0)).toContain('loading="eager"');
  });

  it('moves !important inline declarations into a generated rule', () => {
    const c = ctx();
    const out = emitNode(el('div', {}, [], { style: { color: 'red !important', 'margin-top': '4px' } }), c, 0);
    expect(out).toContain('style={{ "marginTop": "4px" }}');
    expect(out).toContain('data-pv-i="1"');
    expect(c.extraRules[0]).toBe('[data-pv-i="1"] { color: red !important; }');
  });
  it('renames the page custom properties inside inline styles', () => {
    const out = emitNode(el('div', {}, [], { style: { '--a': '1', color: 'var(--a)' } }), ctx({ renameVars: (t) => t.replace(/--a\b/g, '--pv-a') }), 0);
    expect(out).toContain('"--pv-a": "1"');
    expect(out).toContain('"color": "var(--pv-a)"');
  });
  it('replaces an element that an island takes over with a named slot', () => {
    const out = emitNode(el('button', {}, [text('Go')], { elementStamp: 'e1' }), ctx({ islands: new Map([['e1', { slot: 'island1' }]]) }), 0);
    expect(out).toBe('<Slot name="island1" />');
  });
});

describe('islands', () => {
  it('emits a design-system Button with its props, never inventing a variant', () => {
    const jsx = emitIsland({ component: 'Button', props: { variant: 'brand', size: 'md', background: 'light', href: '/go', animatedArrow: true, fullWidth: true } }, 'Book a call');
    expect(jsx).toBe('<Button variant="brand" size="md" background="light" href="/go" animatedArrow fullWidth>{"Book a call"}</Button>');
  });
  it('keeps the replaced element\'s place in its parent on the island wrapper', () => {
    expect(islandWrapperStyle({ display: 'inline-flex', margin: ['0px', '0px', '0px', '0px'], alignSelf: 'auto', flexGrow: '0', fullWidth: false })).toEqual({ display: 'inline-flex' });
    expect(islandWrapperStyle({ display: 'flex', margin: ['20px', '0px', '0px', '0px'], alignSelf: 'center', flexGrow: '1', fullWidth: true })).toEqual({ display: 'flex', margin: '20px 0px 0px 0px', alignSelf: 'center', flexGrow: '1', width: '100%' });
    expect(islandWrapperStyle({ display: 'contents', margin: ['0px', '0px', '0px', '0px'], alignSelf: 'normal', flexGrow: '0', fullWidth: false }).display).toBe('block');
  });
  it('emits a section module that renders inside the section shell and imports only the components it uses', () => {
    const tree = el('section', { class: 'hero' }, [el('h1', {}, [text('Title')]), el('button', {}, [text('Go')], { elementStamp: 'e1' })]);
    const src = emitSectionSource({ id: 'hero', name: 'Hero', tree, ancestors: [{ tag: 'div', attrs: { class: 'root' } }] }, ctx({ islands: new Map([['e1', { slot: 'island1' }]]) }), [{ slot: 'island1', jsx: '<Button variant="brand">{"Go"}</Button>', component: 'Button', findingIds: 'f1', wrapperStyle: { display: 'flex' } }]);
    expect(src.componentName).toBe('SectionHero');
    expect(src.code).toContain("import { OriginalSection, Slot } from '../../runtime/OriginalSection';");
    expect(src.code).toContain("import { Button } from '@kenresearch/design-system/atoms/Button';");
    expect(src.code).toContain('<Slot name="island1" />');
    expect(src.code).toContain('"island1": { node: <Button variant="brand">{"Go"}</Button>, findingIds: "f1", component: "Button", style: {"display":"flex"} }');
    expect(src.code).not.toContain('SectionHeading');
  });
});
