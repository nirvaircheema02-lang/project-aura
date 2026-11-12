/**
 * Evidence-preserving replay of an R3 judgment.
 *
 * A claude-session bundle id is a hash of the WHOLE prompt, so a resume that re-captures the
 * live page (carousels, counters) changes one finding's text and invalidates every answer in
 * its chunk, restarting the plan loop forever. R3's answer is per finding, so an earlier
 * answer is replayed for a finding ONLY when that finding's block — stamp selector, mismatches,
 * rule violations, resolved targets, recommendation, any preview feedback — is byte-identical
 * to the block it was answered on, and the trailing constraints are identical too. Anything
 * that differs (even one character) is not replayed and asks for a fresh judgment.
 */

export interface PriorR3 {
  prompt: string;
  data: { edits?: Array<{ findingId: string; selector?: string }>; unaddressed?: Array<{ findingId: string }> };
}

interface ParsedPrompt {
  blocks: Map<string, string>;
  tail: string;
  order: string[];
}

const TAIL_MARK = '\n\nConstraints from a rejected prior preview';

export function parseR3Prompt(prompt: string): ParsedPrompt {
  const parts = prompt.split('\nfindingId=');
  const blocks = new Map<string, string>();
  const order: string[] = [];
  let tail = '';
  for (let i = 1; i < parts.length; i++) {
    let text = parts[i]!;
    // iteration >= 2 prompts also list "findingId=…: not fixed by the previous iteration" summary lines: not finding blocks
    if (!/^[^\n]*\nstampSelector=/.test(text)) continue;
    if (i === parts.length - 1) {
      const t = text.indexOf(TAIL_MARK);
      if (t >= 0) {
        tail = text.slice(t).trim();
        text = text.slice(0, t);
      }
    }
    const id = text.split('\n', 1)[0]!.trim();
    blocks.set(id, text.trim());
    order.push(id);
  }
  return { blocks, tail, order };
}

/** An edit may only target the finding's own stamp or something beneath it — the same rule R4 enforces. */
export function selectorWithinStamp(selector: string, stamp: string): boolean {
  if (!selector.startsWith(stamp)) return false;
  const next = selector.charAt(stamp.length);
  return next === '' || /[\s>+~:.\[]/.test(next);
}

function stampOf(block: string): string | null {
  return /^stampSelector=(.+)$/m.exec(block)?.[1]?.trim() ?? null;
}

/** The block without its stamp line: stamp ids are renumbered between captures, everything else must match. */
function withoutStamp(block: string): string {
  return block.replace(/^stampSelector=.*$/m, 'stampSelector=<stamp>');
}

/** The composed answer, or null when any finding cannot be replayed on identical evidence. */
export function composeR3Replay(prompt: string, priors: PriorR3[]): { edits: unknown[]; unaddressed: unknown[] } | null {
  const now = parseR3Prompt(prompt);
  if (now.order.length === 0) return null;
  const parsedPriors = priors.map((p) => ({ p, parsed: parseR3Prompt(p.prompt) }));
  const edits: unknown[] = [];
  const unaddressed: unknown[] = [];
  for (const id of now.order) {
    const block = now.blocks.get(id)!;
    const hit = parsedPriors.find(({ p, parsed }) => {
      const before = parsed.blocks.get(id);
      if (before === undefined || withoutStamp(before) !== withoutStamp(block) || parsed.tail !== now.tail) return false;
      const answered = (p.data.edits ?? []).some((e) => e.findingId === id) || (p.data.unaddressed ?? []).some((u) => u.findingId === id);
      return answered;
    });
    if (!hit) return null;
    const mine = (hit.p.data.edits ?? []).filter((e) => e.findingId === id);
    const stamp = stampOf(block);
    const oldStamp = stampOf(hit.parsed.blocks.get(id) ?? '');
    // an earlier answer that targeted another element than its own stamp (stale/wrong) is never replayed
    if (!stamp || !oldStamp || mine.some((e) => !e.selector || !selectorWithinStamp(e.selector, oldStamp))) return null;
    // the same finding on a renumbered stamp: move each edit onto the new stamp, keeping its descendant/state part
    edits.push(...mine.map((e) => ({ ...e, selector: stamp + (e.selector as string).slice(oldStamp.length) })));
    unaddressed.push(...(hit.p.data.unaddressed ?? []).filter((u) => u.findingId === id));
  }
  return { edits, unaddressed };
}
