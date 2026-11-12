import type { Finding, FixPlanEntry } from '../audit-link/index.ts';
import type { AppliedEdit, IterationRecord } from '../agents/types.ts';

/**
 * `change-list.md` — human-readable, regenerated, never a source of truth (§13's format
 * table). Applied / unaddressed / out-of-scope, each with its reason, so nothing authorized
 * is ever silently missing from the record.
 */

export interface ChangeListInput {
  fixFindings: Finding[];
  fixEntries: FixPlanEntry[];
  allFindings: Finding[];
  iterations: IterationRecord[];
  outOfScope: Array<{ findingId: string; reason: string }>;
}

export function renderChangeListMd(input: ChangeListInput): string {
  const lastValidation = input.iterations.at(-1)?.validation;
  const appliedByFinding = new Map<string, AppliedEdit[]>();
  for (const it of input.iterations) {
    for (const a of it.applied.applied) {
      const list = appliedByFinding.get(a.edit.findingId) ?? [];
      list.push(a);
      appliedByFinding.set(a.edit.findingId, list);
    }
  }
  const unaddressedByFinding = new Map<string, string>();
  for (const it of input.iterations) for (const u of it.plan.plan.unaddressed) unaddressedByFinding.set(u.findingId, u.reason);
  const verifiedByFinding = new Map<string, boolean>(lastValidation?.checks.map((c) => [c.findingId, c.fixed] as const) ?? []);
  const findingById = new Map(input.allFindings.map((f) => [f.identity.findingId, f] as const));

  const lines: string[] = ['# Change list', ''];

  lines.push('## Applied', '');
  for (const f of input.fixFindings) {
    const applied = (appliedByFinding.get(f.identity.findingId) ?? []).filter((a) => a.applied);
    if (applied.length === 0) continue;
    const verified = verifiedByFinding.get(f.identity.findingId);
    lines.push(`- **${f.identity.findingId.slice(0, 8)}…** ${f.location.section} · ${f.component.productionType} "${f.component.productionLabel}" — ${applied.length} edit(s) applied${verified === true ? ' — verified fixed' : verified === false ? ' — NOT verified fixed' : ''}`);
    for (const a of applied) lines.push(`  - ${a.edit.kind}${a.edit.property ? ` ${a.edit.property}` : ''}: "${a.previousValue ?? '(unknown)'}" → "${a.edit.value}" (${a.edit.rationale})`);
  }

  lines.push('', '## Unaddressed', '');
  for (const [findingId, reason] of unaddressedByFinding) {
    const f = findingById.get(findingId);
    lines.push(`- **${findingId.slice(0, 8)}…** ${f ? `${f.location.section} · ${f.component.productionType} "${f.component.productionLabel}"` : ''} — ${reason}`);
  }
  if (unaddressedByFinding.size === 0) lines.push('(none)');

  lines.push('', '## Out of scope', '');
  for (const o of input.outOfScope) {
    const f = findingById.get(o.findingId);
    lines.push(`- **${o.findingId.slice(0, 8)}…** ${f ? `${f.location.section} · ${f.component.productionType} "${f.component.productionLabel}"` : ''} — ${o.reason}`);
  }
  if (input.outOfScope.length === 0) lines.push('(none)');

  lines.push('', '## Every fix decision', '');
  for (const e of input.fixEntries) {
    const f = findingById.get(e.findingId);
    lines.push(`- ${e.findingId.slice(0, 8)}… (${e.decision}) — ${f ? `${f.location.section} · ${f.component.productionType}` : '(unknown finding)'}${e.note ? ` — note: ${e.note}` : ''}`);
  }

  return lines.join('\n');
}
