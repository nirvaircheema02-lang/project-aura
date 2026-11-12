import { describe, expect, it } from 'vitest';
import { findReusablePick, signatureOf } from '../../src/mapping/reuse.ts';

const cand = (candidateId: string, tagName: string, classes: string[], text: string) => ({ candidateId, tagName, classes, text });

describe('C2 pick reuse — a resumed run does not ask the same mapping judgment again', () => {
  const picked = cand('cand-3', 'a', ['px-1', 'flex', 'gap-2', 'py-2'], 'Get in Touch');
  const sig = signatureOf(picked);

  it('reuses the earlier pick when exactly one passing candidate has the same tag, classes and text — even under a new candidate id', () => {
    const passing = [cand('cand-0', 'div', ['flex', 'mt-4'], 'Get in Touch Connect via Mail'), cand('cand-7', 'a', ['px-1', 'flex', 'gap-2', 'py-2'], 'Get in Touch')];
    expect(findReusablePick(passing, sig)?.candidateId).toBe('cand-7');
  });
  it('never reuses when the signature is ambiguous (two identical candidates) or absent', () => {
    const twins = [cand('cand-0', 'a', ['px-1', 'flex', 'gap-2', 'py-2'], 'Get in Touch'), cand('cand-1', 'a', ['px-1', 'flex', 'gap-2', 'py-2'], 'Get in Touch')];
    expect(findReusablePick(twins, sig)).toBeNull();
    expect(findReusablePick(twins, undefined)).toBeNull();
  });
  it('never reuses a different element: other tag, other classes', () => {
    expect(findReusablePick([cand('c', 'div', ['px-1', 'flex', 'gap-2', 'py-2'], 'Get in Touch')], sig)).toBeNull();
    expect(findReusablePick([cand('c', 'a', ['px-2', 'flex'], 'Get in Touch')], sig)).toBeNull();
  });
  it('tolerates changed text only when it is still the only element of that shape (live counters, dates)', () => {
    expect(findReusablePick([cand('c', 'a', ['px-1', 'flex', 'gap-2', 'py-2'], 'Get in Touch (3)')], sig)?.candidateId).toBe('c');
    const two = [cand('a', 'a', ['px-1', 'flex', 'gap-2', 'py-2'], 'Other text'), cand('b', 'a', ['px-1', 'flex', 'gap-2', 'py-2'], 'More text')];
    expect(findReusablePick(two, sig)).toBeNull();
  });
  it('the signature keeps the same bounded view the model prompt shows (6 classes, 80 characters)', () => {
    const long = cand('x', 'span', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'x'.repeat(200));
    const s = signatureOf(long);
    expect(s.classes).toHaveLength(6);
    expect(s.text).toHaveLength(80);
    expect(findReusablePick([long], s)?.candidateId).toBe('x');
  });
});
