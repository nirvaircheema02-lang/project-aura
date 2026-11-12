import { describe, expect, it } from 'vitest';
import { definedCustomProperties, makeVarRenamer, normalizeForMatching, referencedAnimationNames, renderRuleItems, rewriteSelectorForShadow, splitSelectorList, type RuleItem } from '../../src/preview/css.ts';

describe('splitSelectorList', () => {
  it('splits only on top-level commas', () => {
    expect(splitSelectorList('a, b > c,.d')).toEqual(['a', 'b > c', '.d']);
    expect(splitSelectorList(':is(a, b) c, d')).toEqual([':is(a, b) c', 'd']);
    expect(splitSelectorList('a[title="x,y"], b')).toEqual(['a[title="x,y"]', 'b']);
    expect(splitSelectorList('.a\\,b, .c')).toEqual(['.a\\,b', '.c']);
  });
});

describe('normalizeForMatching', () => {
  it('drops interaction states and pseudo-elements so the rule can be tested statically', () => {
    expect(normalizeForMatching('.btn:hover')).toBe('.btn');
    expect(normalizeForMatching('.btn:focus-visible')).toBe('.btn');
    expect(normalizeForMatching('.card::before')).toBe('.card');
    expect(normalizeForMatching('input::placeholder')).toBe('input');
    expect(normalizeForMatching('a:hover > span::after')).toBe('a > span');
  });
  it('keeps structural pseudo-classes', () => {
    expect(normalizeForMatching('li:first-child')).toBe('li:first-child');
    expect(normalizeForMatching('.x:not(.y)')).toBe('.x:not(.y)');
  });
  it('never returns an empty selector', () => {
    expect(normalizeForMatching(':hover')).toBe('*');
    expect(normalizeForMatching('.a >:hover')).toBe('.a > *');
  });
});

describe('rewriteSelectorForShadow', () => {
  it(':root becomes :host and html/body become attribute stand-ins', () => {
    expect(rewriteSelectorForShadow(':root')).toBe(':host');
    expect(rewriteSelectorForShadow('html body .x')).toBe('[data-pv-html] [data-pv-body] .x');
    expect(rewriteSelectorForShadow('html.dark .x')).toBe('[data-pv-html].dark .x');
    expect(rewriteSelectorForShadow('body > main')).toBe('[data-pv-body] > main');
  });
  it('leaves class names, attribute values and other type selectors alone', () => {
    expect(rewriteSelectorForShadow('.body')).toBe('.body');
    expect(rewriteSelectorForShadow('.html-x')).toBe('.html-x');
    expect(rewriteSelectorForShadow('[data-x="body"]')).toBe('[data-x="body"]');
    expect(rewriteSelectorForShadow('section h2')).toBe('section h2');
    expect(rewriteSelectorForShadow('.a, .b')).toBe('.a, .b');
  });
});

describe('renderRuleItems', () => {
  const style = (groups: string[], sel: string, body: string): RuleItem => ({ kind: 'style', groups, selectors: [sel], body });
  it('re-opens wrapper groups only when the path changes and closes them at the end', () => {
    const css = renderRuleItems([
      style([], '.a', 'color: red;'),
      style(['@media (min-width: 640px)'], '.a', 'color: blue;'),
      style(['@media (min-width: 640px)'], '.b', 'color: green;'),
      style([], '.c', 'color: black;'),
    ], (s) => s);
    expect(css).toBe('.a { color: red; }\n@media (min-width: 640px) {\n.a { color: blue; }\n.b { color: green; }\n}\n.c { color: black; }');
  });
  it('drops a rule whose selectors all transform to nothing', () => {
    expect(renderRuleItems([style([], '.a', 'x: y;')], () => '')).toBe('');
  });
  it('passes font-face and keyframes text through inside their groups', () => {
    const css = renderRuleItems([{ kind: 'keyframes', groups: [], text: '@keyframes spin { to { transform: rotate(1turn); } }', name: 'spin' }], (s) => s);
    expect(css).toContain('@keyframes spin');
  });
});

describe('animations and custom properties', () => {
  it('finds animation names referenced by declarations, only among the available ones', () => {
    const used = referencedAnimationNames('.a{animation: spin 1s linear infinite} .b{animation-name: fade, other}', new Set(['spin', 'fade', 'unused']));
    expect([...used].sort()).toEqual(['fade', 'spin']);
  });
  it('lists declared custom properties including @property registrations', () => {
    const defined = definedCustomProperties(':root{--a:1;--b-c: 2} .x{ --d:3 } @property --e { syntax: "<color>"; }');
    expect([...defined].sort()).toEqual(['--a', '--b-c', '--d', '--e']);
  });
  it('renames only the properties the page itself defines, never prefixes of other names', () => {
    const rename = makeVarRenamer(new Set(['--a', '--tw-gradient-from']));
    expect(rename('color: var(--a); background: linear-gradient(var(--tw-gradient-from))')).toBe('color: var(--pv-a); background: linear-gradient(var(--pv-tw-gradient-from))');
    expect(rename('var(--a-long) var(--b)')).toBe('var(--a-long) var(--b)');
  });
  it('is the identity when the page defines no custom properties', () => {
    expect(makeVarRenamer(new Set())('var(--x)')).toBe('var(--x)');
  });
});
