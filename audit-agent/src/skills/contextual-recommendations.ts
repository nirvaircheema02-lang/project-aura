import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DetectedComponent } from '../agents/types.ts';
import type { Finding } from './s0-result-contract.ts';
import type { DsRegistry } from '../ds/d2-registry/index.ts';

/** Advice is separate from measured violations; uncertain identity cannot justify invented values. */
export async function enrichRecommendations(findings: Finding[], components: DetectedComponent[], registry: DsRegistry, allowedIconLibraries?: string[]): Promise<Finding[]> {
  const source = 'core-v2/docs/ICONS.md';
  const iconPolicy = await readFile(join(registry.designSystemPath, source), 'utf8').catch(() => '');
  const lucideApproved = /Lucide React.*sole icon library/i.test(iconPolicy);
  const libraries = allowedIconLibraries ?? (lucideApproved ? ['lucide-react'] : []);
  const policySource = allowedIconLibraries ? 'audit-agent.config.json#allowedIconLibraries' : source;
  const byId = new Map(components.map(c => [c.findingId, c]));
  return findings.map(f => {
    const c = byId.get(f.identity.findingId);
    if (!c) return f;
    const properties = [...(f.comparison.properties ?? [])];
    const readings = [['', c.style], ...Object.entries(c.parts ?? {})] as const;
    for (const [part, style] of readings) {
      const keys = part === 'icon' ? ['color','width','height'] : ['font-family','font-size','font-weight','line-height','letter-spacing','color','width','height'];
      for (const key of keys) {
        const property = `${part ? part + '.' : c.parts?.label ? 'container.' : ''}${key}`;
        if (properties.some(p => p.property === property)) continue;
        properties.push({ property, actual: style?.connected ? style.raw[key] ?? null : null, expected: null, expectedToken: null, source: null, status: 'UNRESOLVED',
          note: style?.connected ? 'Observed value; no verified DS requirement for this property/part.' : 'Element/part could not be measured.' });
      }
    }
    f = { ...f, comparison: { ...f.comparison, properties }, action: { ...f.action, recommendation: [f.action.recommendation, ...(f.comparison.coverageNotes ?? [])].join(' ') } };
    const facts = c.domFacts;
    const name = facts?.context?.accessibleName || facts?.imgAlt || '';
    const brandAsset = /logo|brand|avatar|portrait|photo|linkedin|whatsapp|facebook|youtube/i.test(`${name} ${facts?.context?.imageSource ?? ''}`);
    const imageControl = c.componentType === 'icon-button' && (facts?.hasImg || facts?.hasSvg) && !brandAsset;
    if (imageControl && libraries.length) {
      const rendering = facts?.hasImg ? 'This UI control uses an image asset.' : facts?.context?.lucideMarker ? 'This SVG carries a Lucide class marker; retain the existing glyph if its meaning is correct.' : 'This UI control renders an SVG; its source React library is not verified from the DOM.';
      const semantics = facts?.tag === 'svg' || facts?.tag === 'img' ? ' Put the clickable graphic inside a semantic button with an accessible action name and keyboard behavior.' : '';
      const advice = `Icon consistency proposal — ${rendering} Allowed icon libraries: ${libraries.join(' or ')} (source: ${policySource}${allowedIconLibraries ? '; explicit project override of the DS default' : ''}). ${name ? `Verify the existing glyph for the “${name}” action; if replacement is needed, select an equivalent only from the allowed libraries.` : 'The icon has no readable action label: identify its action from the UI/handler, add an accessible name, then select an equivalent only from the allowed libraries; the exact glyph is not verified.'}${semantics} Preserve the existing library/style where valid, along with the control’s behavior and DS size, stroke and color. No other icon library or arbitrary image substitute is allowed. This is implementation guidance, not a measured glyph mismatch.`;
      const measured = f.comparison.mismatches.length || f.comparison.ruleViolations.length ? `${f.action.recommendation} ` : '';
      return { ...f, action: { ...f.action, recommendation: measured + advice }, quality: { ...f.quality, evidence: [...f.quality.evidence, { kind: 'ds-source' as const, ref: policySource, note: `Allowed libraries: ${libraries.join(', ')}. Image/SVG UI control observed; glyph equivalence requires verification.` }] } };
    }
    if (f.classification === 'NEEDS_REVIEW' && !f.component.dsComponent) {
      const plausible = (f.review?.possibleMatches ?? []).filter(m => m.score >= 0.35).slice(0, 3);
      const recommendation = plausible.length
        ? `Candidate recommendation: inspect ${plausible.map(m => `${m.dsComponent}${m.dsVariant ? ` (${m.dsVariant})` : ''} from ${m.dsFile}`).join(' or ')} against this element’s purpose, parent and interaction state. Reuse the compatible existing component and preserve matching properties; visual similarity alone does not confirm identity. ${plausible.map(m => m.why).join('; ')}`
        : 'No compatible DS component is verified from the captured evidence. Check the parent composition and approved page recipes first. If no existing pattern fits, propose a composition of approved DS atoms/tokens with the same purpose, behavior and surface; record any missing component as a design gap for review. Preserve valid existing styling; do not invent colors, dimensions or mark the proposal DS-approved.';
      return { ...f, action: { ...f.action, recommendation } };
    }
    return f;
  });
}
