import { z } from 'zod';
import type { LlmClient } from '../../llm/client.ts';
import type { AiMode } from '../../llm/provider.ts';
import type { AuditData, GlobalIssueRow } from '../c2-json-writer/index.ts';

/**
 * A4 — Site Consolidator (v1.0 §3): merge page results, deduplicate repeated
 * findings, group by component/template, identify ROOT CAUSES, build the
 * master result.
 *
 * The deduplication and grouping are already deterministic in C2 (same defect
 * signature across pages → one global issue). A4's AI contribution is the part
 * the spec actually calls for: interpreting *why* a cluster exists, so a
 * reviewer gets "one shared Button implementation is 44px on every Report
 * Detail page" instead of forty identical rows.
 */

export const RootCauseSchema = z.object({
  rootCauses: z.array(
    z.object({
      title: z.string().describe('One sentence naming the shared cause'),
      issueSignatures: z.array(z.string()).describe('Signatures of the global issues this explains — from the supplied list, verbatim'),
      likelyOrigin: z.string().describe('Where the fix most likely belongs: a shared component, a template, a token, or a content pattern'),
      affectedTemplates: z.array(z.string()),
      recommendation: z.string(),
      confidence: z.number().describe('0..1 probability; 0.5 = coin flip'),
    }),
  ),
});
export type RootCauses = z.infer<typeof RootCauseSchema>;

const SYSTEM = `You are the Site Consolidator (A4) of a Design System compliance audit.
You are given issues that have ALREADY been deduplicated and counted across pages. Do not recount them and do not re-judge them.
Your job is to explain clusters: which issues share one underlying cause, where a fix belongs, and what to do about it.
Rules:
- Only reference issue signatures from the supplied list, verbatim.
- One root cause should explain several issues or several pages. If an issue stands alone, leave it out rather than inventing a cause.
- likelyOrigin should name a shared component, template, token or content pattern — the thing a developer would actually change once.`;

export interface ConsolidatedResult {
  rootCauses: RootCauses['rootCauses'];
  /** Global issues annotated with the root cause that explains them. */
  issues: Array<GlobalIssueRow & { rootCause: string | null }>;
}

/**
 * no-api strategy (Decision Log #31): clusters, not interpretations. Issues
 * are grouped by what a developer would change ONCE — the same DS rule
 * broken, the same DS token missed, the same DS component deviating — and a
 * group is reported only when it spans several issues or several pages. A
 * lone issue gets no invented cause, exactly as the model contract requires.
 * The "cause" is a measured shared factor, stated at MEDIUM confidence, not
 * an explanation of why it happened.
 */
export function deterministicRootCauses(data: AuditData): RootCauses['rootCauses'] {
  const issues = data.findings.filter((f) => f.classification === 'DEVIATION' || f.classification === 'INCORRECT');
  type Cluster = { title: string; likelyOrigin: string; recommendation: string; signatures: Set<string>; pages: Set<string>; templates: Set<string> };
  const clusters = new Map<string, Cluster>();
  const add = (key: string, make: () => Omit<Cluster, 'signatures' | 'pages' | 'templates'>, f: (typeof issues)[number]) => {
    const cluster = clusters.get(key) ?? { ...make(), signatures: new Set<string>(), pages: new Set<string>(), templates: new Set<string>() };
    cluster.signatures.add(f.component.signature);
    cluster.pages.add(f.location.url);
    if (f.location.templateFamily) cluster.templates.add(f.location.templateFamily);
    clusters.set(key, cluster);
  };
  for (const f of issues) {
    for (const rule of f.comparison.ruleViolations) {
      add(`rule:${rule.ruleId}`, () => ({
        title: `${rule.ruleId} ${rule.title} is broken by several components`,
        likelyOrigin: `a foundation rule (${rule.ruleId}) — most likely one shared setup (a global font/theme/utility) rather than each component`,
        recommendation: `Fix the shared source of the ${rule.ruleId} violation once, then re-audit the listed pages.`,
      }), f);
    }
    for (const m of f.comparison.mismatches) {
      if (!m.expectedToken) continue;
      add(`token:${m.expectedToken}`, () => ({
        title: `Several components miss the DS token ${m.expectedToken}`,
        likelyOrigin: `the DS token ${m.expectedToken} — usages that hardcode a different value instead of referencing it`,
        recommendation: `Replace the hardcoded values with var(${m.expectedToken}).`,
      }), f);
    }
    if (f.component.dsComponent && f.classification === 'DEVIATION') {
      const component = f.component.dsComponent;
      add(`component:${component}`, () => ({
        title: `The ${component} implementation deviates in several places`,
        likelyOrigin: `the shared ${component} component — one implementation reused across the listed pages`,
        recommendation: `Align the shared ${component} implementation with the Design System once.`,
      }), f);
    }
  }
  return [...clusters.values()]
    .filter((c) => c.signatures.size >= 2 || c.pages.size >= 2)
    .sort((a, b) => b.signatures.size - a.signatures.size || b.pages.size - a.pages.size || a.title.localeCompare(b.title))
    .slice(0, 12)
    .map((c) => ({
      title: `${c.title} (${c.signatures.size} issue pattern(s) across ${c.pages.size} page(s))`,
      issueSignatures: [...c.signatures],
      likelyOrigin: `deterministic cluster — ${c.likelyOrigin}`,
      affectedTemplates: [...c.templates],
      recommendation: c.recommendation,
      confidence: 0.6,
    }));
}

export async function consolidateSite(data: AuditData, llm: LlmClient, aiMode: AiMode): Promise<ConsolidatedResult> {
  if (data.globalIssues.length === 0) return { rootCauses: [], issues: [] };
  const rootCauses = aiMode === 'no-api' ? deterministicRootCauses(data) : await modelRootCauses(data, llm);

  const causeBySignature = new Map<string, string>();
  // The largest cluster explains an issue first — a later, narrower cluster does not relabel it.
  for (const rc of rootCauses) for (const signature of rc.issueSignatures) if (!causeBySignature.has(signature)) causeBySignature.set(signature, rc.title);

  return {
    rootCauses,
    issues: data.globalIssues.map((i) => ({ ...i, rootCause: causeBySignature.get(i.signature) ?? null })),
  };
}

async function modelRootCauses(data: AuditData, llm: LlmClient): Promise<RootCauses['rootCauses']> {
  const { data: result } = await llm.structured({
    nodeId: 'A4',
    system: SYSTEM,
    prompt:
      `Site: ${data.run.targetUrl} · ${data.websiteSummary.pagesAudited} pages · compliance ${data.websiteSummary.compliancePercent ?? 'n/a'}%\n\n` +
      `Templates: ${data.templateSummary.map((t) => `${t.templateFamily} (${t.pages} pages, ${t.compliancePercent ?? 'n/a'}%)`).join(', ')}\n\n` +
      `Deduplicated issues:\n${data.globalIssues
        .map((i) => `signature=${i.signature} · ${i.title} · ${i.severity} · ${i.occurrences} occurrence(s) across ${i.affectedPages.length} page(s)`)
        .join('\n')}\n\nIdentify the root causes.`,
    schema: RootCauseSchema,
    effort: 'high',
  });

  const known = new Set(data.globalIssues.map((i) => i.signature));
  return result.rootCauses.map((rc) => ({ ...rc, issueSignatures: rc.issueSignatures.filter((s) => known.has(s)) }));
}
