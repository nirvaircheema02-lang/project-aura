import type { Finding } from '../audit-link/index.ts';
import { typefaceRuleChecks } from '../style/typeface-rule.ts';
import { exemptionsFrom, type Exemption, type ResolutionFile } from '../resolution/schema.ts';

/**
 * The ONLY changes the fidelity verifier accepts as intentional. Each is identified by finding + property + part +
 * state; none exempts a whole component or section.
 *
 *  - every resolved target (the Resolver's, including the audit's own measured expectations it adopted);
 *  - for a finding whose element is replaced by a design-system component: the properties the audit itself governed
 *    for that finding, in every state (the component defines its own state design) — the component's OTHER
 *    properties, and everything outside the element, stay checked;
 *  - for a finding with an R1.4 typeface violation: `font-family` (the audit's rule authorizes the move; the rule check verifies WHICH typeface);
 *  - with no Resolver output at all (older runs): the audit's measured mismatches, default state only.
 */
export function buildExemptions(args: { resolution: ResolutionFile | null; findings: Finding[]; islandFindingIds: ReadonlySet<string> }): Exemption[] {
  const out = new Map<string, Exemption>();
  const put = (e: Exemption) => { const k = `${e.findingId}|${e.property}|${e.part}|${e.state}|${e.viewport}`; if (!out.has(k)) out.set(k, e); };
  for (const e of exemptionsFrom(args.resolution)) put(e);
  const hasResolution = !!args.resolution && args.resolution.targets.length > 0;
  for (const f of args.findings) {
    const id = f.identity.findingId;
    if (!hasResolution) for (const m of f.comparison.mismatches) put({ findingId: id, property: m.property, part: 'self', state: 'default', viewport: 'any', targetId: `audit:${id}:${m.property}`, reason: `the audit's measured expectation for ${m.property}` });
    // the audit's R1.4 typeface violation authorizes moving this finding's text to a design-system typeface; WHICH typeface is then checked by the
    // finding's own rule check (ds-fix.measured), so this exemption names the property and the finding, never an arbitrary new value
    if (typefaceRuleChecks(f).length > 0) put({ findingId: id, property: 'font-family', part: 'self', state: '*', viewport: 'any', targetId: `rule:${id}:R1.4`, reason: "the audit's R1.4 two-font-pairing violation authorizes a design-system typeface for this text" });
    if (args.islandFindingIds.has(id)) {
      const governed = new Set<string>([...(f.comparison.properties ?? []).map((p) => p.property), ...f.comparison.mismatches.map((m) => m.property)]);
      for (const p of governed) put({ findingId: id, property: p.includes('.') ? p.split('.').slice(1).join('.') : p, part: 'self', state: '*', viewport: 'any', targetId: `island:${id}:${p}`, reason: `a design-system ${f.component.dsComponent ?? 'component'} is mounted for this finding and governs ${p}` });
    }
  }
  return [...out.values()];
}
