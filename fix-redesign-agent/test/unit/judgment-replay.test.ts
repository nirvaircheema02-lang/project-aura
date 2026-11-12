import { describe, expect, it } from 'vitest';
import { composeR3Replay, parseR3Prompt } from '../../src/judgment/replay.ts';

const block = (id: string, extra = '') => `findingId=${id}\nstampSelector=[data-fra-element="e1"]\nsection="S" type=button label="L"\n  mismatches:\n    - font-weight: actual="400" expected="500"${extra}\n`;
const prompt = (blocks: string[], tail = '') => `Project rules...\n\n${blocks.join('\n')}${tail}`;
const prior = (blocks: string[], data: { edits?: { findingId: string; selector?: string }[]; unaddressed?: { findingId: string }[] }, tail = '') => ({ prompt: prompt(blocks, tail), data });
const CON = (x: string) => `\n\nConstraints from a rejected prior preview (hard requirements this iteration):\n- ${x}`;

describe('composeR3Replay — stamp ids renumbered between captures', () => {
  const at = (id: string, stamp: string, extra = '') => block(id, extra).replace('[data-fra-element="e1"]', `[data-fra-element="${stamp}"]`);
  it('replays onto the new stamp (e130 -> e131), keeping descendant and state parts', () => {
    const old = prior([at('a', 'e130')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e130"]' }, { findingId: 'a', selector: '[data-fra-element="e130"]:hover' }] });
    const out = composeR3Replay(prompt([at('a', 'e131')]), [old]);
    expect((out?.edits as { selector: string }[]).map((e) => e.selector)).toEqual(['[data-fra-element="e131"]', '[data-fra-element="e131"]:hover']);
  });
  it('still refuses when anything other than the stamp changed', () => {
    const old = prior([at('a', 'e130')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e130"]' }] });
    expect(composeR3Replay(prompt([at('a', 'e131', ' (changed)')]), [old])).toBeNull();
  });
  it('REGRESSION: an old answer aimed at a different element than its own stamp is not replayed even after renumbering', () => {
    const bad = prior([at('a', 'e130')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e131"]' }] });
    expect(composeR3Replay(prompt([at('a', 'e131')]), [bad])).toBeNull();
  });
});

describe('composeR3Replay — never replays an edit aimed at another element', () => {
  it('REGRESSION: an earlier answer whose selector is outside the finding\'s own stamp (e131 vs e130) is not replayed', () => {
    const bad = prior([block('a')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e131"]' }] });
    expect(composeR3Replay(prompt([block('a')]), [bad])).toBeNull();
  });
  it('replays a selector equal to the stamp or beneath it', () => {
    const ok = prior([block('a')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e1"]' }, { findingId: 'a', selector: '[data-fra-element="e1"]:hover' }, { findingId: 'a', selector: '[data-fra-element="e1"] span' }] });
    expect(composeR3Replay(prompt([block('a')]), [ok])?.edits).toHaveLength(3);
  });
  it('does not treat e10 as being within e1', () => {
    const bad = prior([block('a')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e1"]x' }] });
    expect(composeR3Replay(prompt([block('a')]), [bad])).toBeNull();
  });
});

describe('composeR3Replay — only on byte-identical evidence', () => {
  it("replays each finding's answer when its block and the constraints are identical, even if the chunk composition differs", () => {
    const priorA = prior([block('a'), block('b')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e1"]' }], unaddressed: [{ findingId: 'b' }] });
    const out = composeR3Replay(prompt([block('b'), block('a')]), [priorA]);
    expect(out).toEqual({ edits: [{ findingId: 'a', selector: '[data-fra-element="e1"]' }], unaddressed: [{ findingId: 'b' }] });
  });

  it("REGRESSION: one changed character in a finding's block (live page drift) means no replay for the chunk", () => {
    const priorA = prior([block('a'), block('b')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e1"]' }], unaddressed: [{ findingId: 'b' }] });
    expect(composeR3Replay(prompt([block('a'), block('b', ' (changed)')]), [priorA])).toBeNull();
  });

  it('does not replay when the trailing constraints differ', () => {
    const priorA = prior([block('a')], { edits: [{ findingId: 'a', selector: '[data-fra-element="e1"]' }] }, CON('x'));
    expect(composeR3Replay(prompt([block('a')], CON('y')), [priorA])).toBeNull();
    expect(composeR3Replay(prompt([block('a')]), [priorA])).toBeNull();
  });

  it('does not replay a finding the earlier answer never covered, and never invents one', () => {
    const priorA = prior([block('a')], { edits: [] });
    expect(composeR3Replay(prompt([block('a')]), [priorA])).toBeNull();
    expect(composeR3Replay('no findings here', [priorA])).toBeNull();
  });

  it('splits the trailing constraints off the last block', () => {
    const p = parseR3Prompt(prompt([block('a')], CON('x')));
    expect(p.order).toEqual(['a']);
    expect(p.tail).toContain('- x');
    expect(p.blocks.get('a')).not.toContain('Constraints');
  });
});
