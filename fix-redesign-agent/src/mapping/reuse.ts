/**
 * Reuse of this run's own earlier mapping picks. A resumed run re-captures the page, and the
 * candidate ids the model is asked to choose between are re-derived every time, so without this
 * every resume asks the same judgment again. A pick is reused only when exactly ONE of the
 * objectively passing candidates still has the same tag, classes and text — the same signature
 * the earlier pick had — so the model's output remains a choice among passing candidates, never
 * an authorization of something new.
 */

export interface PickSignature { tag: string; classes: string[]; text: string }

interface CandidateLike { tagName: string; classes: string[]; text: string }

const CLASS_LIMIT = 6;
const TEXT_LIMIT = 80;

export const signatureOf = (c: CandidateLike): PickSignature => ({ tag: c.tagName, classes: c.classes.slice(0, CLASS_LIMIT), text: c.text.slice(0, TEXT_LIMIT) });

const sameClasses = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function findReusablePick<T extends CandidateLike>(passing: T[], prior: PickSignature | undefined): T | null {
  if (!prior) return null;
  const sameShape = passing.filter((c) => c.tagName === prior.tag && sameClasses(c.classes.slice(0, CLASS_LIMIT), prior.classes));
  const exact = sameShape.filter((c) => c.text.slice(0, TEXT_LIMIT) === prior.text);
  if (exact.length === 1) return exact[0]!;
  if (exact.length === 0 && sameShape.length === 1) return sameShape[0]!; // same element, text changed slightly (live counters, dates)
  return null;
}
