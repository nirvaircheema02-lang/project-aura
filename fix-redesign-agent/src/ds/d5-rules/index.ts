// Vendored verbatim from audit-agent src/ds/d5-rules/index.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
import type { DSRawContent } from '../d1-reader/index.ts';
import type { DSFinding } from '../findings.ts';
import { runCheckerScripts, type CheckerScriptResult } from './checker-scripts.ts';
import { checkAntiPatternsIdsResolve, checkCaseStudyRecipeStaleness, extractRulesMd, type ExtractedRule } from './rules-md.ts';

export interface D5Result {
  checkerScripts: CheckerScriptResult[];
  rules: ExtractedRule[];
  findings: DSFinding[];
}

export async function buildD5(raw: DSRawContent): Promise<D5Result> {
  const findings: DSFinding[] = [];

  const { results: checkerScripts, findings: checkerFindings } = await runCheckerScripts(raw.designSystemPath);
  findings.push(...checkerFindings);

  const rules = extractRulesMd(raw.rulesMdRaw.content);

  findings.push(
    checkAntiPatternsIdsResolve(
      raw.designSystemPath,
      raw.antiPatternsRootRaw.content,
      raw.antiPatternsRootRaw.path,
      raw.antiPatternsCoreV2Raw.content,
      raw.antiPatternsCoreV2Raw.path,
    ),
  );

  const staleness = checkCaseStudyRecipeStaleness(raw.designSystemPath, raw.caseStudyRecipeRaw.content, raw.caseStudyRecipeRaw.path);
  if (staleness) findings.push(staleness);

  return { checkerScripts, rules, findings };
}
