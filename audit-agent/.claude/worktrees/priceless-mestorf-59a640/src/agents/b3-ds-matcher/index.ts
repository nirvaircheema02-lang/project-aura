import { B3MatchesSchema } from '../../llm/schemas/b-nodes.ts';
import { buildComponentCatalog, catalogKey, renderCatalogForPrompt, resolveCatalogEntry, resolveVariant, type CatalogComponent } from '../../ds/catalog.ts';
import { BANDS, normalizeConfidence, routesToNewComponentEvaluator } from '../../skills/s8-confidence-escalation-policy.ts';
import { normalizeRef } from '../refs.ts';
import { decideMatch, dsIndex } from './deterministic.ts';
import type { NodeContext } from '../../graph/engine.ts';
import type { B2Output, B3Output, DetectedComponent, DsMatch, PageSession } from '../types.ts';

/**
 * B3 — DS Matcher (v1.0 §4): find the closest approved DS component and
 * variant, and assign match confidence. The routing rule lives in S8, not
 * here: a match below the MEDIUM band goes down B6's "no DS match" branch
 * rather than becoming a shaky Match/Deviation call (ARCHITECTURE.md §3).
 *
 * Note the site reality this must work under: production emits no
 * `data-component`/`data-variant` attributes at all (verified across 4
 * templates), so matching is semantic — type, label, structure and rendered
 * style — never attribute lookup.
 *
 * The model's answer is never used raw. It is resolved to exactly one
 * catalog FILE (names are not unique in this DS — nine collide between atoms
 * and shadcn/ui), an unknown name is "no match" rather than a guess, and a
 * ref the model skipped is asked about again rather than being routed as a
 * confident "no DS equivalent".
 *
 * In no-api mode (Decision Log #31) the match comes from evidence a reviewer
 * can check instead — class fingerprints against the DS's own sources, DS-rule
 * mappings confirmed by a variant fit — and anything else is undecided, with
 * its candidates, for B6 to publish as NEEDS_REVIEW (deterministic.ts).
 */

const SYSTEM = `You are the DS Matcher (B3) of a Design System compliance audit.
For each detected production component, name the closest approved Design System component and variant, or null if the DS has no equivalent.
Rules:
- Answer dsComponent with the catalog KEY exactly as listed before the "—" (e.g. "atoms/Button", not "Button"). Never invent a component.
- dsVariant must be one of that component's listed variant values, or null if you cannot tell.
- Return one entry for EVERY ref you are given. Answer with the bare ref (e.g. "e42").
- confidence is your honest probability (0 to 1) that this production element is an implementation of that DS component. Below 0.5 means "no usable match" — say so with a low number rather than guessing.
- The production site does NOT annotate components in markup. Match on semantics: element type, label, structure and rendered appearance.`;

function describe(component: DetectedComponent): string {
  const style = component.style.connected ? component.style.raw : {};
  const facts = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'border-top-left-radius', 'height', 'padding-top']
    .map((p) => `${p}=${style[p] ?? '?'}`)
    .join(' ');
  return `ref=${component.ref} type=${component.componentType} label="${component.label.slice(0, 60)}" section="${component.sectionName}" dom=[${component.domSignals.join(', ')}] visual="${component.visualSignals.slice(0, 120)}" style{${facts}}`;
}

function resolveAnswer(
  catalog: CatalogComponent[],
  answer: { dsComponent: string | null; dsVariant: string | null; confidence: number; rationale: string },
): DsMatch {
  const confidence = normalizeConfidence(answer.confidence);
  if (answer.dsComponent === null || !answer.dsComponent.trim()) {
    return { dsComponent: null, dsFile: null, dsVariant: null, confidence: confidence.value, rationale: answer.rationale, unanswered: false, confidenceOutOfContract: confidence.outOfContract };
  }
  const entry = resolveCatalogEntry(catalog, answer.dsComponent);
  if (!entry) {
    // A name the catalog does not contain is not a match — and never a substring guess.
    return {
      dsComponent: null,
      dsFile: null,
      dsVariant: null,
      confidence: 0,
      rationale: `unknown DS component "${answer.dsComponent}" (not in the catalog) — ${answer.rationale}`,
      unanswered: false,
      confidenceOutOfContract: confidence.outOfContract,
    };
  }
  return {
    dsComponent: entry.name,
    dsFile: entry.file,
    dsVariant: resolveVariant(entry, answer.dsVariant),
    // An untrusted number must not make the ROUTING decision: the model named a real
    // catalog component, so the component is still measured against it (at the MEDIUM
    // floor) — and the out-of-contract flag forces the finding into human review.
    // Forcing it LOW instead would route a real DS Button to B6 as a "DS candidate".
    confidence: confidence.outOfContract ? BANDS.MEDIUM : confidence.value,
    rationale: `${catalogKey(entry)} — ${answer.rationale}`,
    unanswered: false,
    confidenceOutOfContract: confidence.outOfContract,
  };
}

export async function runB3(ctx: NodeContext, input: B2Output & { session: PageSession }): Promise<B3Output> {
  const session = input.session;
  const matches = new Map<string, DsMatch>();
  const droppedRefs = [...input.coverage.droppedRefs];

  if (input.components.length > 0 && session.aiMode === 'no-api') {
    // no-api (Decision Log #31): matched only on evidence a reviewer can check — see deterministic.ts.
    const index = await dsIndex(session.registry);
    const viewportWidth = session.page.viewportSize()?.width ?? 1440;
    for (const component of input.components) matches.set(component.ref, decideMatch(component, index, session.registry, viewportWidth));
  } else if (input.components.length > 0) {
    const catalog = buildComponentCatalog(session.registry);
    const expected = new Set(input.components.map((c) => c.ref));

    const ask = async (components: DetectedComponent[], followUp: boolean) => {
      const { data } = await session.llm.structured({
        nodeId: 'B3',
        system: SYSTEM,
        prompt:
          `Design System catalog (KEY — name, variants):\n${renderCatalogForPrompt(catalog)}\n\n` +
          `${followUp ? 'These components were missing from your previous answer. ' : ''}Detected production components:\n${components.map(describe).join('\n')}\n\n` +
          `Match each ref to a DS component and variant.`,
        schema: B3MatchesSchema,
        effort: 'high',
      });
      for (const m of data.matches) {
        const ref = normalizeRef(m.ref);
        if (!ref || !expected.has(ref)) {
          droppedRefs.push({ node: 'B3', ref: m.ref, reason: 'match returned for a ref that was not asked about' });
          continue;
        }
        if (matches.has(ref)) continue;
        // A DS name the catalog cannot resolve is not "no match" — it is an answer that
        // could not be used. Treat the ref as missing so the follow-up asks again.
        if (m.dsComponent !== null && m.dsComponent.trim() && !resolveCatalogEntry(catalog, m.dsComponent)) {
          unresolvedNames.set(ref, m.dsComponent);
          continue;
        }
        matches.set(ref, resolveAnswer(catalog, m));
      }
    };

    const unresolvedNames = new Map<string, string>();
    await ask(input.components, false);
    const missing = input.components.filter((c) => !matches.has(c.ref));
    if (missing.length > 0) await ask(missing, true);
    for (const [ref, name] of unresolvedNames) {
      if (matches.has(ref)) continue;
      matches.set(ref, {
        dsComponent: null,
        dsFile: null,
        dsVariant: null,
        confidence: 0,
        rationale: `B3 named "${name}", which is not a catalog component, even after a follow-up ask`,
        unanswered: true,
        confidenceOutOfContract: false,
      });
    }
  }

  const matched: DetectedComponent[] = [];
  const unmatched: DetectedComponent[] = [];
  for (const component of input.components) {
    const match: DsMatch = matches.get(component.ref) ?? {
      dsComponent: null,
      dsFile: null,
      dsVariant: null,
      confidence: 0,
      rationale: 'B3 returned no match for this ref, even after a follow-up ask',
      unanswered: true,
      confidenceOutOfContract: false,
    };
    matches.set(component.ref, match);
    if (routesToNewComponentEvaluator(match)) unmatched.push(component);
    else matched.push(component);
  }

  return { ...input, matches, matched, unmatched, coverage: { ...input.coverage, droppedRefs } };
}
