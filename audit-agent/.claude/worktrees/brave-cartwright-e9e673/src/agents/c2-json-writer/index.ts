import { writeFile } from 'node:fs/promises';
import {
  FINDING_STATUSES,
  findingStatus,
  isAbsentThisRun,
  isNotCompared,
  isPriorIssueUnverified,
  scoreCompliance,
  type ComplianceScore,
  type Finding,
  type FindingStatus,
  type PageResult,
} from '../../skills/s0-result-contract.ts';
import type { AiMode } from '../../llm/provider.ts';
import type { RenderingPolicy } from '../../t-layer/browser.ts';

/**
 * C2 — JSON / Audit Data (v1.0 §11). **The canonical source of truth**
 * (ARCHITECTURE.md Decision Log #19): Excel, Figma and the dashboard all
 * read THIS, and each is verified against it independently. C2 computes
 * every aggregate once, so no downstream output can arrive at a different
 * number by recomputing it differently.
 *
 * Structured as the five reporting levels of v1.0 §14 so the same file
 * serves management, designers and developers.
 */

export interface ComponentSummaryRow {
  dsComponent: string | null;
  dsVariant: string | null;
  productionType: string;
  instances: number;
  match: number;
  deviation: number;
  incorrect: number;
  /** Instances nothing could be compared on (UNVERIFIED) — excluded from this row's compliance, as from every score. */
  notCompared: number;
  /** Instances whose status needs a human decision (NEEDS_REVIEW) — excluded from compliance. */
  needsReview: number;
  compliancePercent: number | null;
  affectedPages: string[];
}

export interface GlobalIssueRow {
  signature: string;
  title: string;
  classification: string;
  severity: string;
  occurrences: number;
  affectedPages: string[];
  example: { url: string; section: string; recommendation: string };
}

export interface AuditData {
  schemaVersion: 1;
  run: {
    runId: string;
    auditId: string;
    mode: 'single-page' | 'full-site';
    startedAt: string;
    dsRegistryVersion: string;
    policyVersion: string;
    targetUrl: string;
    /**
     * The exact rendering engine this run used (build step 11 engine lock):
     * Playwright Chromium, its exact build, the Playwright release, viewport,
     * locale, timezone and user agent. Null only when a caller had no browser.
     */
    renderingPolicy: RenderingPolicy | null;
    /**
     * Decision Log #31: which strategy the AI nodes ran — `no-api` (deterministic,
     * zero model calls) or `anthropic-api`. Optional: absent in data.json files
     * written before it existed; null when a caller did not say.
     */
    aiMode?: AiMode | null;
  };
  /**
   * How many findings each output status holds — the single bucketing every
   * output renders (S0 `findingStatus`), including RESOLVED history records.
   * Optional: absent in data.json files written before it existed.
   */
  statusCounts?: Record<FindingStatus, number>;
  /** Level 1 — website summary. */
  websiteSummary: ComplianceScore & {
    pagesAudited: number;
    pagesFailed: number;
    templatesDetected: number;
    componentsChecked: number;
    escalationsQueued: number;
  };
  /** Level 2 — template summary. */
  templateSummary: Array<{ templateFamily: string; pages: number; components: number } & ComplianceScore>;
  /** Level 3 — page summary. */
  pageSummary: Array<{
    pageId: string;
    url: string;
    templateFamily: string | null;
    componentsChecked: number;
    settled: boolean;
    httpStatus: number | null;
    compliance: ComplianceScore;
  }>;
  /** Level 4 — component summary. */
  componentSummary: ComponentSummaryRow[];
  /** Level 5 — every finding, in full S0 form. */
  findings: Finding[];
  globalIssues: GlobalIssueRow[];
  newComponents: Finding[];
  dsCandidates: Finding[];
  /** Findings a human must decide (NEEDS_REVIEW), with their reasons and possible DS matches. Optional for older files. */
  needsReview?: Finding[];
  /** Matched components nothing could be compared on (UNVERIFIED). Optional for older files. */
  unverified?: Finding[];
  failedPages: Array<{ url: string; reason: string }>;
  reAudit: {
    previousRunId: string | null;
    newIssues: number;
    stillOpen: number;
    resolved: number;
    regressions: number;
    /**
     * Prior DEVIATION/INCORRECT findings on elements present this run that were
     * NOT re-verified (not compared, or routed to new-component evaluation) —
     * still open as far as anyone knows. Optional: absent in data.json files
     * written before it existed.
     */
    unverified?: number;
    /**
     * What the comparison itself changed since the previous run (Design System,
     * audit policy / browser, DS match), with how many findings it touches. A
     * status change across one of these is never counted as a regression or a
     * resolution. Optional for the same reason.
     */
    baselineChanges?: Array<{ note: string; findings: number }>;
  };
  /** Per page, in the same order as pageSummary. */
  coverage: PageResult['coverage'][];
  /**
   * The run's coverage boundaries across EVERY page, computed once here so the
   * dashboard, Excel and Figma cannot disagree (the dashboard used to show page 1 only).
   */
  coverageSummary: {
    sectionsAnalyzed: number;
    componentsDetected: number;
    excludedPersonalized: number;
    excludedOffDomain: number;
    unexpandedStates: number;
    droppedRefs: Array<{ pageUrl: string; node: string; ref: string; reason: string }>;
    truncation: Array<{ pageUrl: string; what: string; detail: string }>;
    /**
     * Bounded listings (§2.7) — a repeated group sampled instead of fully
     * enumerated. Previously recorded per page but never surfaced in any
     * output (third-pass review OUT-1): a footer with 29 links and a 5-item
     * sample cap looked, in every deliverable, like all 29 were audited.
     */
    sampledListings: Array<{ pageUrl: string; section: string; sampled: number; totalObserved: number }>;
  };
}

export interface BuildAuditDataInput {
  runId: string;
  auditId: string;
  mode: 'single-page' | 'full-site';
  startedAt: string;
  targetUrl: string;
  pages: PageResult[];
  failedPages: Array<{ url: string; reason: string }>;
  renderingPolicy?: RenderingPolicy | null;
  aiMode?: AiMode | null;
}

export function buildAuditData(input: BuildAuditDataInput): AuditData {
  const findings = input.pages.flatMap((p) => p.findings);
  // Components actually on the page(s) this run — S7's RESOLVED records for elements that
  // are gone are history, reported under reAudit but never counted as checked components.
  const present = findings.filter((f) => !isAbsentThisRun(f));
  const onPage = (list: Finding[]) => list.filter((f) => !isAbsentThisRun(f));
  const first = input.pages[0];

  const componentGroups = new Map<string, ComponentSummaryRow>();
  for (const f of present) {
    const key = `${f.component.dsComponent ?? f.component.productionType}::${f.component.dsVariant ?? ''}`;
    const row = componentGroups.get(key) ?? {
      dsComponent: f.component.dsComponent,
      dsVariant: f.component.dsVariant,
      productionType: f.component.productionType,
      instances: 0,
      match: 0,
      deviation: 0,
      incorrect: 0,
      notCompared: 0,
      needsReview: 0,
      compliancePercent: null,
      affectedPages: [],
    };
    row.instances++;
    if (isNotCompared(f)) row.notCompared++;
    else if (f.classification === 'MATCH') row.match++;
    if (f.classification === 'NEEDS_REVIEW') row.needsReview++;
    if (f.classification === 'DEVIATION') row.deviation++;
    if (f.classification === 'INCORRECT') row.incorrect++;
    if (!row.affectedPages.includes(f.location.url)) row.affectedPages.push(f.location.url);
    componentGroups.set(key, row);
  }
  for (const row of componentGroups.values()) {
    const denominator = row.match + row.deviation + row.incorrect;
    row.compliancePercent = denominator === 0 ? null : Math.round((row.match / denominator) * 1000) / 10;
  }

  // Global issues: the same defect signature seen more than once is a root-cause
  // candidate rather than N unrelated findings (v1.0 §15 tab 06).
  const issueGroups = new Map<string, GlobalIssueRow>();
  for (const f of findings) {
    if (f.classification !== 'DEVIATION' && f.classification !== 'INCORRECT') continue;
    const defect = f.comparison.ruleViolations[0]?.ruleId ?? f.comparison.mismatches.map((m) => m.property).sort().join('+') ?? 'unspecified';
    const key = `${f.component.signature}::${defect}`;
    const row = issueGroups.get(key) ?? {
      signature: f.component.signature,
      title: `${f.component.dsComponent ?? f.component.productionType}: ${defect}`,
      classification: f.classification,
      severity: f.quality.severity,
      occurrences: 0,
      affectedPages: [],
      example: { url: f.location.url, section: f.location.section, recommendation: f.action.recommendation },
    };
    row.occurrences++;
    if (!row.affectedPages.includes(f.location.url)) row.affectedPages.push(f.location.url);
    issueGroups.set(key, row);
  }

  const templateGroups = new Map<string, { pages: Set<string>; findings: Finding[] }>();
  for (const page of input.pages) {
    const family = page.templateFamily ?? 'unclassified';
    const group = templateGroups.get(family) ?? { pages: new Set<string>(), findings: [] };
    group.pages.add(page.pageId);
    group.findings.push(...page.findings);
    templateGroups.set(family, group);
  }

  const deltaCount = (d: string) => findings.filter((f) => f.history.delta === d).length;
  const statusCounts = Object.fromEntries(FINDING_STATUSES.map((status) => [status, 0])) as Record<FindingStatus, number>;
  for (const f of findings) statusCounts[findingStatus(f)]++;
  const baselineChanges = new Map<string, number>();
  for (const f of findings) for (const note of f.history.baselineChanged ?? []) baselineChanges.set(note, (baselineChanges.get(note) ?? 0) + 1);

  return {
    schemaVersion: 1,
    run: {
      runId: input.runId,
      auditId: input.auditId,
      mode: input.mode,
      startedAt: input.startedAt,
      dsRegistryVersion: first?.dsRegistryVersion ?? 'unknown',
      policyVersion: first?.policyVersion ?? 'unknown',
      targetUrl: input.targetUrl,
      renderingPolicy: input.renderingPolicy ?? null,
      aiMode: input.aiMode ?? null,
    },
    statusCounts,
    websiteSummary: {
      ...scoreCompliance(findings),
      pagesAudited: input.pages.length,
      pagesFailed: input.failedPages.length,
      templatesDetected: templateGroups.size,
      componentsChecked: present.length,
      escalationsQueued: present.filter((f) => f.quality.escalationStatus === 'QUEUED').length,
    },
    templateSummary: [...templateGroups.entries()].map(([templateFamily, group]) => ({
      templateFamily,
      pages: group.pages.size,
      components: onPage(group.findings).length,
      ...scoreCompliance(group.findings),
    })),
    pageSummary: input.pages.map((p) => ({
      pageId: p.pageId,
      url: p.url,
      templateFamily: p.templateFamily,
      componentsChecked: onPage(p.findings).length,
      settled: p.capture.settled,
      httpStatus: p.capture.httpStatus,
      compliance: p.compliance,
    })),
    componentSummary: [...componentGroups.values()].sort((a, b) => b.deviation + b.incorrect - (a.deviation + a.incorrect)),
    findings,
    globalIssues: [...issueGroups.values()].sort((a, b) => b.occurrences - a.occurrences),
    newComponents: findings.filter((f) => f.classification === 'NEW_COMPONENT'),
    dsCandidates: findings.filter((f) => f.classification === 'DS_CANDIDATE'),
    needsReview: present.filter((f) => f.classification === 'NEEDS_REVIEW').sort(byConfidenceThenPage),
    unverified: present.filter(isNotCompared).sort(byConfidenceThenPage),
    failedPages: input.failedPages,
    reAudit: {
      previousRunId: findings.find((f) => f.history.previousRunId)?.history.previousRunId ?? null,
      newIssues: deltaCount('NEW_ISSUE'),
      stillOpen: deltaCount('STILL_OPEN'),
      resolved: deltaCount('RESOLVED'),
      regressions: deltaCount('REGRESSION'),
      unverified: present.filter(isPriorIssueUnverified).length,
      baselineChanges: [...baselineChanges.entries()].map(([note, count]) => ({ note, findings: count })).sort((a, b) => b.findings - a.findings),
    },
    coverage: input.pages.map((p) => p.coverage),
    coverageSummary: {
      sectionsAnalyzed: input.pages.reduce((n, p) => n + p.coverage.sectionsAnalyzed, 0),
      componentsDetected: input.pages.reduce((n, p) => n + p.coverage.componentsDetected, 0),
      excludedPersonalized: input.pages.reduce((n, p) => n + p.coverage.excludedPersonalized, 0),
      excludedOffDomain: input.pages.reduce((n, p) => n + p.coverage.excludedOffDomain, 0),
      unexpandedStates: input.pages.reduce((n, p) => n + p.coverage.unexpandedStates.length, 0),
      droppedRefs: input.pages.flatMap((p) => p.coverage.droppedRefs.map((d) => ({ pageUrl: p.url, ...d }))),
      truncation: input.pages.flatMap((p) => p.coverage.truncation.map((t) => ({ pageUrl: p.url, ...t }))),
      sampledListings: input.pages.flatMap((p) => p.coverage.sampledListings.map((s) => ({ pageUrl: p.url, ...s }))),
    },
  };
}

/** Review queues read most-uncertain first, then in page order — a stable order every output shares. */
function byConfidenceThenPage(a: Finding, b: Finding): number {
  return a.quality.confidence - b.quality.confidence || a.location.url.localeCompare(b.location.url) || a.location.section.localeCompare(b.location.section) || a.identity.findingId.localeCompare(b.identity.findingId);
}

/** Writes the canonical audit data for a run. Every other output reads this file. */
export async function writeAuditData(path: string, data: AuditData): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2));
}
