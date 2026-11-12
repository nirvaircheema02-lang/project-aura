import { parseR3Prompt } from './replay.ts';
import type { JudgmentNodeId } from './schema-registry.ts';

/**
 * Deterministic judgment mode (config `deterministicJudgments`). The pipeline answers its own judgment nodes from what is already in
 * the prompt — no model, no Session Agent — and every answer says so. It never invents a design decision:
 *   RV  no decision is added: residual findings stay preserved, stated in `notes`.
 *   R3  every resolved target is applied verbatim as a style edit on the finding's own stamp (that IS the resolved target, nothing more);
 *       a finding with no resolved target is listed as unaddressed.
 *   R5  the picture cannot settle a property-level change, so every finding is UNCERTAIN (0.5) and `overall` is UNCERTAIN: the measured
 *       verdict comes from R8's rendered-preview verification, never from this.
 *   C2  no candidate is picked among several passing ones (a wrong pick edits the wrong element): the finding stays unmapped.
 * Anything else returns null and goes to a Session Agent as usual.
 */
const NOTE = 'deterministic judgment mode';

function targetsOf(block: string): Array<{ property: string; value: string; token: string | null }> {
  const at = block.indexOf('resolved targets (the ONLY properties you may change):');
  if (at < 0) return [];
  const section = block.slice(at).split('not to be changed')[0]!;
  const out: Array<{ property: string; value: string; token: string | null }> = [];
  for (const m of section.matchAll(/^ {4}- ([\w-]+) = (.+?)(?: \(token (--[\w-]+)\))? — /gm)) out.push({ property: m[1]!, value: m[2]!.trim(), token: m[3] ?? null });
  return out;
}

export function deterministicJudgment(nodeId: JudgmentNodeId | string, prompt: string): unknown | null {
  if (nodeId === 'RV') return { decisions: [], notes: [`${NOTE}: no design decision was invented; the residual findings keep their preserved properties.`] };
  if (nodeId === 'R3') {
    const { blocks, order } = parseR3Prompt(prompt);
    if (order.length === 0) return null;
    const edits: unknown[] = []; const unaddressed: unknown[] = [];
    for (const id of order) {
      const block = blocks.get(id)!;
      const stamp = /^stampSelector=(.+)$/m.exec(block)?.[1]?.trim();
      const t = stamp ? targetsOf(block) : [];
      if (!stamp || t.length === 0) { unaddressed.push({ findingId: id, reason: `${NOTE}: no resolved target (or no mapped element) — nothing is changed` }); continue; }
      for (const x of t) edits.push({ findingId: id, selector: stamp, expectedMatches: 1, kind: 'style', property: x.property, value: x.value, removeValue: null, dsComponent: null, dsVariant: null, dsToken: x.token, rationale: 'Applies the resolved target verbatim (audit-measured expectation).', confidence: 0.9 });
    }
    return { edits, unaddressed };
  }
  if (nodeId === 'R5') {
    const ids = [...new Set([...prompt.matchAll(/^findingId=(\w+) section/gm)].map((m) => m[1]!))];
    if (ids.length === 0) return null;
    return { verdicts: ids.map((findingId) => ({ findingId, verdict: 'UNCERTAIN', confidence: 0.5, reasoning: `${NOTE}: a screenshot cannot settle a property-level change; it is verified by measurement in the rendered React preview (R8).` })), regressions: [], overall: 'UNCERTAIN' };
  }
  if (nodeId === 'C2') {
    const ids = [...new Set([...prompt.matchAll(/^findingId=(\w+)/gm)].map((m) => m[1]!))];
    if (ids.length === 0) return null;
    return { proposals: ids.map((findingId) => ({ findingId, selectedCandidateId: null, confidence: 0, reasoning: `${NOTE}: several candidates pass the objective checks and none is picked without a judgment — left unmapped, not guessed.` })) };
  }
  return null;
}
