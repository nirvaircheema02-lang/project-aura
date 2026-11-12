import { relativeToDs } from '../d1-reader/index.ts';
import { finding, type DSFinding } from '../findings.ts';

/**
 * D5 Track B (IMPLEMENTATION-PLAN.md §4): extract RULES.md into structured
 * rules keyed by its own native R#.# IDs, each carrying a source line range
 * so a finding is traceable back to the actual prose. Read-only — parses
 * text, never rewrites RULES.md.
 */

export interface ExtractedRule {
  id: string; // e.g. "R1.2"
  title: string;
  fields: Record<string, string>; // WHY/WHAT/WHEN/WHEN NOT/WHERE/... -> content
  startLine: number; // 1-indexed
  endLine: number;
}

const HEADING_RE = /^###\s+(R\d+\.\d+)\s*·\s*(.+)$/;
const FIELD_RE = /^-\s+\*\*([A-Z ]+)\*\*\s*·\s*(.+)$/;

export function extractRulesMd(rulesMdContent: string): ExtractedRule[] {
  const lines = rulesMdContent.split('\n');
  const rules: ExtractedRule[] = [];
  let current: ExtractedRule | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      if (current) {
        current.endLine = i; // 1-indexed line just before this heading
        rules.push(current);
      }
      current = { id: headingMatch[1] as string, title: (headingMatch[2] as string).trim(), fields: {}, startLine: i + 1, endLine: i + 1 };
      continue;
    }
    if (current) {
      const fieldMatch = line.match(FIELD_RE);
      if (fieldMatch) {
        current.fields[(fieldMatch[1] as string).trim()] = (fieldMatch[2] as string).trim();
      }
    }
  }
  if (current) {
    current.endLine = lines.length;
    rules.push(current);
  }
  return rules;
}

/**
 * ANTI_PATTERNS.md ID structure — corrects IMPLEMENTATION-PLAN.md §4's
 * specific claim. The plan describes "Cat N.N" decimal sub-IDs (e.g. a
 * citation like "Cat 13.8") that "do not resolve to any literal anchor."
 * Verified (2026-09-11) against the actual current file: no such decimal
 * sub-numbering exists anywhere in either copy — the real structure is
 * whole-number `## Category N — <title>` section headings only, which DO
 * resolve as ordinary markdown anchors. What's real and worth flagging
 * instead: the two copies have diverged in COUNT — root has 13 categories
 * (1–13), core-v2 has 14 (adds "Category 14 — Gradients & Backgrounds
 * (NEW v2)", absent from the root copy). Do not build rule-lookup logic
 * assuming a "Cat N.N" scheme exists; do not assume the two copies cover
 * the same categories.
 */
export function checkAntiPatternsIdsResolve(
  designSystemPath: string,
  rootContent: string,
  rootPath: string,
  coreV2Content: string,
  coreV2Path: string,
): DSFinding {
  const categoryHeadingRe = /^##\s+Category\s+(\d+)\s*—\s*(.+)$/gm;
  const extractCategories = (content: string) => {
    const out = new Map<number, string>();
    let m: RegExpExecArray | null;
    categoryHeadingRe.lastIndex = 0;
    while ((m = categoryHeadingRe.exec(content))) out.set(Number(m[1]), (m[2] as string).trim());
    return out;
  };
  const decimalSubIdRe = /Cat(?:egory)?\s*\d+\.\d+/;
  const rootCategories = extractCategories(rootContent);
  const coreV2Categories = extractCategories(coreV2Content);
  const rootHasDecimalIds = decimalSubIdRe.test(rootContent);
  const coreV2HasDecimalIds = decimalSubIdRe.test(coreV2Content);
  const onlyInCoreV2 = [...coreV2Categories.entries()].filter(([n]) => !rootCategories.has(n));

  return finding({
    module: 'D5',
    severity: 'warning',
    summary:
      `IMPLEMENTATION-PLAN.md §4's "Cat N.N" ID claim does not match the current file — real structure is whole-number ` +
      `"Category N" headings (root: ${rootCategories.size}, core-v2: ${coreV2Categories.size}), which DO resolve as anchors`,
    detail:
      `No decimal "Cat N.N" sub-numbering exists in either copy (root: ${rootHasDecimalIds ? 'found' : 'none found'}; ` +
      `core-v2: ${coreV2HasDecimalIds ? 'found' : 'none found'}) — the plan's specific citation format doesn't exist in the ` +
      `current file, superseded by this finding. What IS real: the two copies have diverged in category count — core-v2 has ` +
      `${onlyInCoreV2.length} categor${onlyInCoreV2.length === 1 ? 'y' : 'ies'} absent from the root copy ` +
      `(${onlyInCoreV2.map(([n, title]) => `Category ${n} — ${title}`).join(', ') || 'none'}). Do not assume the two copies ` +
      `cover the same ground for a shared category number.`,
    sources: [relativeToDs(designSystemPath, rootPath), relativeToDs(designSystemPath, coreV2Path)],
  });
}

/**
 * case-study.md recipe staleness (IMPLEMENTATION-PLAN.md §4): verified
 * (2026-09-11) it still points at `design-system/core/src/app/components/`,
 * which does not exist, and still cites GSAP (removed from the workspace
 * per project_aura1-main's own CLAUDE.md, 2026-05-08). Recorded as a
 * finding so any template-expectation logic checks staleness before
 * trusting this recipe as ground truth, per the plan's explicit guardrail.
 */
export function checkCaseStudyRecipeStaleness(
  designSystemPath: string,
  caseStudyContent: string,
  caseStudyPath: string,
): DSFinding | null {
  const referencesStaleDir = caseStudyContent.includes('design-system/core/src/app/components');
  const gsapMentions = (caseStudyContent.match(/GSAP/g) ?? []).length;
  const lenisMentions = (caseStudyContent.match(/Lenis/g) ?? []).length;
  if (!referencesStaleDir && gsapMentions === 0 && lenisMentions === 0) return null;

  return finding({
    module: 'D5',
    severity: 'warning',
    summary: 'recipes/case-study.md is stale — references a removed directory and/or removed animation libraries',
    detail:
      `${referencesStaleDir ? 'References "design-system/core/src/app/components/" as its source-of-truth directory — verified not to exist on disk. ' : ''}` +
      `${gsapMentions > 0 ? `${gsapMentions} GSAP mention(s). ` : ''}${lenisMentions > 0 ? `${lenisMentions} Lenis mention(s). ` : ''}` +
      `GSAP+Lenis were removed from the workspace (project_aura1-main CLAUDE.md, 2026-05-08). Any recipe-derived ` +
      `template expectation from this file needs a staleness check before being trusted as ground truth.`,
    sources: [relativeToDs(designSystemPath, caseStudyPath)],
  });
}
