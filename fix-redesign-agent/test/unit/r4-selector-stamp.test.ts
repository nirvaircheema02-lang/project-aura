import { describe, expect, it } from 'vitest';
import { isSingleSelector } from '../../src/dom/apply-edit.ts';
import { selectorStaysWithinStamp } from '../../src/agents/r4-apply-render/index.ts';

/**
 * Reference lane round 3: a selector LIST after the stamp (`[data-fra-element="e1"] , #o`) passed the "stays within the stamp" check - its rest starts with
 * whitespace - and, with expectedMatches 2, the style reached another element. The remainder must be ONE selector: no comma outside brackets, parentheses and
 * strings, and every bracket / string closed.
 */

const S = '[data-fra-element="e1"]';

describe('isSingleSelector', () => {
  it.each([
    '.a', '.a .b', '.a > .b', '.a + .b ~ .c', '[title="a,b"]', "[title='a,b']", ':is(.a, .b)', '.a:not(.b, .c) .d', ':is(:not(.a, .b), .c)', '.a\\,b', '[data-x="a\\"b,c"]', '.a:hover', 'ul > li:nth-child(2n + 1)',
    // a comment is read as the parser reads it: what is inside it is not a selector (round 4)
    '.a /* , */ .b', '.a /* " */ .b', '.a /* \' */ .b',
  ])('accepts %s', (s) => expect(isSingleSelector(s)).toBe(true));

  it.each([
    '.a, .b', '.a , .b', ',', '.a,', '#o,.a', '.a:is(.b),.c', '[title="a"], #o',
    '[title="a', ':is(.a', '.a)', '.a]', '[a="b"', "[a='b",
    // a quote pair INSIDE two comments used to open a string that swallowed the top-level comma between them
    '.a /*"*/, #o /*"*/', '.a /*\'*/, #o /*\'*/', '.a /* unterminated', '.a, /* x */ #o',
  ])('refuses %s', (s) => expect(isSingleSelector(s)).toBe(false));
});

describe('selectorStaysWithinStamp', () => {
  it.each([
    S, `${S}:hover`, `${S}:focus-visible`, `${S} .icon`, `${S} > .icon`, `${S}>.icon`, `${S}:hover .icon`, `${S} :is(.a, .b)`, `${S} [title="a,b"]`, `${S} .a:not(.b, .c)`, `${S} ul > li:nth-child(2n + 1)`,
    // sibling combinators LATER in the selector stay inside the subtree: both sides are descendants
    `${S} .a ~ .b`, `${S} .a + .b`,
  ])('accepts %s', (s) => expect(selectorStaysWithinStamp(s, 'e1')).toBe(true));

  it.each([
    `${S} , #o`, `${S}, #o`, `${S} .icon, #o`, `${S} .icon , .other .x`, `${S}:hover , #o`, `${S} > .a, ${S} > .b`, `${S} [title="a`, `${S} :is(.a`,
    `#o ${S}`, `.x${S}`, `${S}x`, `[data-fra-element="e10"]`, `[data-fra-element="e1"x`,
    // round 4: the first combinator after the stamp is a descendant (whitespace) or a child (">"), never a sibling
    `${S} + li`, `${S} ~ #o`, `${S}+#o`, `${S}~#o`, `${S}:hover + #o`, `${S} > + #o`, `${S} ++ #o`,
    // a comment hides nothing: a selector never carries one
    `${S} .a /*"*/, #o /*"*/`, `${S} /* x */ .a`, `${S} .a /* x */`, `${S}/**/ ~ #o`,
  ])('refuses %s', (s) => expect(selectorStaysWithinStamp(s, 'e1')).toBe(false));
});
