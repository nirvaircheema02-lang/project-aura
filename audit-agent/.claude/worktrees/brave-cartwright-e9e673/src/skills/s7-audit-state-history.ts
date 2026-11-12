import type Database from 'better-sqlite3';
import {
  isAbsentThisRun,
  isNotCompared,
  isPriorIssueUnverified,
  PRIOR_ISSUE_UNVERIFIED,
  scoreCompliance,
  type Classification,
  type Finding,
  type ReAuditDelta,
} from './s0-result-contract.ts';

/**
 * S7 — Audit State / History. Stores runs/findings/baselines and computes the
 * re-audit delta model (v1.0 §10): NEW ISSUE / STILL OPEN / RESOLVED /
 * REGRESSION. Findings are matched across runs by `finding_id`, which is
 * content-derived and deliberately excludes layout position, so unrelated
 * content shifting above an element does not read as a new issue.
 */

const NON_COMPLIANT: Classification[] = ['DEVIATION', 'INCORRECT'];
/** Outcomes of an actual comparison against the DS. NEW_COMPONENT / DS_CANDIDATE (B6) compared nothing. */
const MEASURED: Classification[] = ['MATCH', 'DEVIATION', 'INCORRECT'];

export interface PriorFinding {
  findingId: string;
  classification: Classification;
  runId: string;
  /** The prior finding in full — a RESOLVED entry describes THIS issue, not some other finding. */
  payload: Finding | null;
}

/** The most recent completed run for this page, if any — the baseline a re-audit diffs against. */
export function previousRunFor(db: Database.Database, pageId: string, excludeRunId: string): string | null {
  const row = db
    .prepare(
      `SELECT run_id FROM audit_history WHERE page_id = ? AND run_id != ? ORDER BY completed_at DESC LIMIT 1`,
    )
    .get(pageId, excludeRunId) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

export function priorFindings(db: Database.Database, runId: string, pageId: string): PriorFinding[] {
  return db
    .prepare(`SELECT finding_id, classification, run_id, payload_json FROM findings WHERE run_id = ? AND page_id = ?`)
    .all(runId, pageId)
    .map((r) => {
      const row = r as { finding_id: string; classification: Classification; run_id: string; payload_json: string | null };
      let payload: Finding | null = null;
      try {
        payload = row.payload_json ? (JSON.parse(row.payload_json) as Finding) : null;
      } catch {
        payload = null;
      }
      return { findingId: row.finding_id, classification: row.classification, runId: row.run_id, payload };
    });
}

/**
 * The re-audit delta between two statuses of one element. Only a MEASURED
 * prior is a baseline: a component B3 routed to new-component evaluation was
 * never compared to the DS, so a deviation found once B3 does match it is a
 * NEW ISSUE, not a regression. A measured prior with a current status that
 * compared nothing (routed to B6) has no knowable delta — null.
 */
export function deltaFor(previous: Classification | null, current: Classification): ReAuditDelta | null {
  const baseline = previous !== null && MEASURED.includes(previous) ? previous : null;
  if (!MEASURED.includes(current)) return baseline === null ? 'UNCHANGED_COMPLIANT' : null;
  const wasBad = baseline !== null && NON_COMPLIANT.includes(baseline);
  const isBad = NON_COMPLIANT.includes(current);
  if (baseline === null) return isBad ? 'NEW_ISSUE' : 'UNCHANGED_COMPLIANT';
  if (wasBad && isBad) return 'STILL_OPEN';
  if (wasBad && !isBad) return 'RESOLVED';
  if (!wasBad && isBad) return 'REGRESSION';
  return 'UNCHANGED_COMPLIANT';
}

/**
 * The status a prior record stands for. A record that verified nothing — a
 * MATCH not actually compared, or a component routed to B6 — stands for the
 * last status that WAS verified, which it carries (otherwise DEVIATION → not
 * compared → DEVIATION would read as a brand-new issue instead of STILL OPEN).
 * A B6 record carries only an open issue forward: it was never compliant.
 * S7's own record of an element that was gone says nothing about compliance.
 */
function effectivePrior(p: PriorFinding | undefined): Classification | null {
  if (!p) return null;
  const f = p.payload;
  if (f && isAbsentThisRun(f)) return null;
  // UNVERIFIED and NEEDS_REVIEW records decided nothing — they stand for what was last verified.
  if (f && (isNotCompared(f) || p.classification === 'NEEDS_REVIEW')) return f.history.previousStatus ?? null;
  if (!MEASURED.includes(p.classification)) {
    const carried = f?.history.previousStatus ?? null;
    return carried !== null && NON_COMPLIANT.includes(carried) ? carried : null;
  }
  return p.classification;
}

/** The status shown as "previous": the verified one when there is one, else what the prior record said. */
function displayedPrior(p: PriorFinding | undefined, effective: Classification | null): Classification | null {
  if (effective !== null) return effective;
  if (!p || (p.payload && isAbsentThisRun(p.payload))) return null;
  return p.classification;
}

const shortVersion = (v: string) => (v.length > 16 ? v.slice(0, 12) : v);
const dsTarget = (t: { dsComponent: string | null; dsVariant: string | null }) => (t.dsComponent ? `${t.dsComponent}${t.dsVariant ? `/${t.dsVariant}` : ''}` : null);

/** The identity a baseline comparison needs from a finding — either a real one, or a carried `baselineOf`. */
interface BaselineIdentity {
  runId: string;
  dsRegistryVersion: string;
  policyVersion: string;
  dsComponent: string | null;
  dsVariant: string | null;
}

function identityOf(f: Finding): BaselineIdentity {
  return {
    runId: f.identity.runId,
    dsRegistryVersion: f.identity.dsRegistryVersion,
    policyVersion: f.identity.policyVersion,
    dsComponent: f.component.dsComponent,
    dsVariant: f.component.dsVariant,
  };
}

/**
 * What changed about the comparison itself between a prior baseline and this
 * finding: the DS (content hash), the audit policy / browser, or the DS
 * component B3 matched. Any of these moves the goalposts, so a status change
 * across it says nothing about the page (s0 identity.policyVersion, Decision
 * Log #22). `prior` is the run that actually MEASURED the previous status —
 * see `baselineIdentityOf`, which chains through undecided runs to find it.
 */
export function baselineChange(prior: BaselineIdentity, current: Finding): string[] {
  const notes: string[] = [];
  if (prior.dsRegistryVersion !== current.identity.dsRegistryVersion) {
    notes.push(`Design System changed since run ${prior.runId} (${shortVersion(prior.dsRegistryVersion)} → ${shortVersion(current.identity.dsRegistryVersion)})`);
  }
  if (prior.policyVersion !== current.identity.policyVersion) {
    notes.push(`audit policy / browser changed since run ${prior.runId} (${prior.policyVersion} → ${current.identity.policyVersion})`);
  }
  const was = dsTarget(prior);
  const now = dsTarget(current.component);
  if (was && now && was !== now) notes.push(`compared against ${now} this run, ${was} in run ${prior.runId}`);
  return notes;
}

/**
 * The identity of the run that actually MEASURED a prior finding's status —
 * chained through however many undecided (NOT_COMPARED / NEEDS_REVIEW) runs
 * sit between it and now (third-pass review CH-1). A direct prior that was
 * itself measured IS the baseline; an undecided direct prior carries the
 * baseline it was itself given (`history.baselineOf`), all the way back to
 * whichever run last actually compared this element.
 */
function baselineIdentityOf(p: PriorFinding | undefined): BaselineIdentity | null {
  const f = p?.payload;
  if (!f) return null;
  if (f.history.baselineOf) return f.history.baselineOf;
  if (MEASURED.includes(p!.classification)) return identityOf(f);
  return null;
}

/** What a prior issue was, in one line — so a RESOLVED record says WHAT was resolved. */
function describeIssue(f: Finding): string {
  const rule = f.comparison.ruleViolations[0];
  if (rule) return `${rule.ruleId} ${rule.title}`;
  const props = f.comparison.mismatches.map((m) => m.property).join(', ');
  return props ? `${f.component.dsComponent ?? f.component.productionType}: ${props}` : f.classification;
}

/**
 * Applies history to this run's findings. Findings are matched across runs by
 * their element id (stable whatever the outcome), so a status change is a
 * delta on ONE finding: STILL OPEN, RESOLVED, or REGRESSION — and only when
 * both runs actually MEASURED the element against the same baseline.
 *
 * A prior issue whose element is not on the page this run gets its own
 * RESOLVED record — the fix is a result and must be visible — flagged
 * `absentThisRun` so it is never scored as a component. A component that is
 * present but was not compared this run (NOT_COMPARED, or routed to B6) keeps
 * its prior issue attached as PRIOR_ISSUE_UNVERIFIED instead of either hiding
 * it or calling it fixed. Across a baseline change (DS, policy/browser, DS
 * match) a compliant→non-compliant change is a NEW ISSUE, not a regression,
 * and a non-compliant→compliant one is not claimed as RESOLVED.
 */
export function applyHistory(db: Database.Database, pageId: string, runId: string, findings: Finding[]): Finding[] {
  const previousRunId = previousRunFor(db, pageId, runId);
  if (!previousRunId) return findings;

  const prior = new Map(priorFindings(db, previousRunId, pageId).map((p) => [p.findingId, p]));
  const withHistory: Finding[] = findings.map((f) => {
    const p = prior.get(f.identity.findingId);
    const previous = effectivePrior(p);
    const previousStatus = displayedPrior(p, previous);
    const comparedNothing = isNotCompared(f) || !MEASURED.includes(f.classification);
    if (comparedNothing) {
      const unverifiedIssue = previous !== null && NON_COMPLIANT.includes(previous);
      // Undecided this run (UNVERIFIED / NEEDS_REVIEW): no knowable delta, and the last verified status rides on.
      const undecided = isNotCompared(f) || f.classification === 'NEEDS_REVIEW';
      const escalationReasons = unverifiedIssue ? [...new Set([...f.quality.escalationReasons, PRIOR_ISSUE_UNVERIFIED])] : f.quality.escalationReasons;
      // Carry forward WHICH run actually measured `previousStatus` — chained through however many
      // undecided runs sit between it and now (CH-1) — so a later re-measurement can still tell
      // whether the comparison itself changed in between, not only whether the page did.
      const carriedBaseline = baselineIdentityOf(p) ?? undefined;
      return {
        ...f,
        quality: { ...f.quality, escalationReasons, escalationStatus: escalationReasons.length > 0 ? 'QUEUED' : f.quality.escalationStatus },
        // Nothing was compared, so there is no knowable delta — but the last verified status is carried.
        history: {
          previousStatus,
          currentStatus: f.classification,
          delta: undecided || unverifiedIssue ? null : deltaFor(previous, f.classification),
          previousRunId,
          ...(carriedBaseline ? { baselineOf: carriedBaseline } : {}),
        },
      };
    }
    let delta = deltaFor(previous, f.classification);
    // The run that ACTUALLY measured `previous` — never just the direct prior record, which may
    // itself have been undecided and carrying a status (and baseline) from further back (CH-1).
    const measuredPrior = previous !== null && MEASURED.includes(previous) ? baselineIdentityOf(p) : null;
    const changed = measuredPrior ? baselineChange(measuredPrior, f) : [];
    if (changed.length > 0 && delta === 'REGRESSION') delta = 'NEW_ISSUE';
    if (changed.length > 0 && delta === 'RESOLVED') delta = null;
    return {
      ...f,
      history: { previousStatus, currentStatus: f.classification, delta, previousRunId, ...(changed.length > 0 ? { baselineChanged: changed } : {}) },
    };
  });

  const seen = new Set(findings.map((f) => f.identity.findingId));
  for (const [findingId, p] of prior) {
    if (seen.has(findingId)) continue;
    const previous = effectivePrior(p);
    const base = p.payload;
    if (previous === null || !NON_COMPLIANT.includes(previous) || !base) continue; // nothing open, or no record of what it was
    withHistory.push({
      ...base,
      identity: { ...base.identity, runId, findingId, timestamp: new Date().toISOString() },
      classification: 'MATCH',
      comparison: { mismatches: [], ruleViolations: [] },
      quality: { ...base.quality, severity: 'INFO', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
      action: {
        recommendation: `Previously reported (${
          NON_COMPLIANT.includes(base.classification) ? describeIssue(base) : `${previous} on ${base.component.dsComponent ?? base.component.productionType}, carried unverified from an earlier run`
        }) — the element was not found on this run: fixed, removed, or no longer detected.`,
        rootCauseRef: null,
        dsCandidateNote: null,
        registryUpdateRef: null,
      },
      history: { previousStatus: previous, currentStatus: 'MATCH', delta: 'RESOLVED', previousRunId, absentThisRun: true },
    });
  }
  return withHistory;
}

/** Which node produced a finding — B6 for its evaluations, whatever their outcome, B4 otherwise. */
function nodeOf(f: Finding): string {
  if (f.classification === 'NEW_COMPONENT' || f.classification === 'DS_CANDIDATE') return 'B6';
  return f.review?.node === 'B6' ? 'B6' : 'B4';
}

export function writeFindings(db: Database.Database, findings: Finding[]): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO findings
     (run_id, page_id, node_id, finding_id, classification, confidence, confidence_band, escalation_status, registry_update_ref, payload_json)
     VALUES (@run_id, @page_id, @node_id, @finding_id, @classification, @confidence, @confidence_band, @escalation_status, @registry_update_ref, @payload_json)`,
  );
  const escalate = db.prepare(
    `INSERT INTO escalation_queue (run_id, page_id, node_id, finding_id, reason, detail_json, created_at) VALUES (?, ?, ?, ?, 'LOW_CONFIDENCE', ?, ?)`,
  );
  const tx = db.transaction((all: Finding[]) => {
    for (const f of all) {
      insert.run({
        run_id: f.identity.runId,
        page_id: f.location.pageId,
        node_id: nodeOf(f),
        finding_id: f.identity.findingId,
        classification: f.classification,
        confidence: f.quality.confidence,
        confidence_band: f.quality.confidenceBand,
        escalation_status: f.quality.escalationStatus,
        registry_update_ref: f.action.registryUpdateRef,
        payload_json: JSON.stringify(f),
      });
      if (f.quality.escalationStatus === 'QUEUED') {
        escalate.run(
          f.identity.runId,
          f.location.pageId,
          nodeOf(f),
          f.identity.findingId,
          JSON.stringify({ reasons: f.quality.escalationReasons, classification: f.classification }),
          Date.now(),
        );
      }
    }
  });
  tx(findings);
}

/**
 * Reconstructs this run's page results from durable storage. A run resumed in
 * a NEW process has an empty in-memory collector — pages finished before the
 * pause are in SQLite, not in RAM — so A4 must read them back or it would
 * consolidate nothing and report a site with zero audited pages.
 */
export function pageResultsFromDb(db: Database.Database, runId: string): import('./s0-result-contract.ts').PageResult[] {
  const rows = db.prepare('SELECT payload_json FROM findings WHERE run_id = ?').all(runId) as Array<{ payload_json: string }>;
  const byPage = new Map<string, Finding[]>();
  for (const row of rows) {
    const finding = JSON.parse(row.payload_json) as Finding;
    byPage.set(finding.location.pageId, [...(byPage.get(finding.location.pageId) ?? []), finding]);
  }
  const history = db.prepare('SELECT page_id, dom_hash, ds_registry_version FROM audit_history WHERE run_id = ?').all(runId) as Array<{
    page_id: string;
    dom_hash: string;
    ds_registry_version: string;
  }>;
  const historyByPage = new Map(history.map((h) => [h.page_id, h]));

  return [...byPage.entries()].map(([pageId, findings]) => {
    const first = findings[0]!;
    return {
      runId,
      pageId,
      url: first.location.url,
      pageName: first.location.pageName,
      templateFamily: first.location.templateFamily,
      domHash: historyByPage.get(pageId)?.dom_hash ?? '',
      dsRegistryVersion: first.identity.dsRegistryVersion,
      policyVersion: first.identity.policyVersion,
      findings,
      compliance: scoreCompliance(findings),
      coverage: {
        sectionsAnalyzed: 0,
        componentsDetected: findings.filter((f) => !isAbsentThisRun(f)).length,
        excludedPersonalized: 0,
        excludedOffDomain: 0,
        sampledListings: [],
        unexpandedStates: [],
        droppedRefs: [],
        truncation: [{ what: 'coverage detail', detail: 'restored from the database after a restart — per-page coverage detail was not persisted' }],
      },
      capture: { settled: true, httpStatus: 200, consoleSummary: 'restored from database', criticalFailures: 0 },
    };
  });
}

export function recordAuditHistory(db: Database.Database, input: { pageId: string; runId: string; domHash: string; dsRegistryVersion: string }): void {
  db.prepare(
    `INSERT OR REPLACE INTO audit_history (page_id, run_id, dom_hash, ds_registry_version, completed_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(input.pageId, input.runId, input.domHash, input.dsRegistryVersion, Date.now());
}

/**
 * §4.4 memoization: a page is skippable only if BOTH its DOM hash and the DS
 * registry version are unchanged — a DS change invalidates every cached page,
 * which is exactly why D6 must be a content hash and not the frozen semver.
 */
export function isCacheable(db: Database.Database, pageId: string, domHash: string, dsRegistryVersion: string): boolean {
  const row = db
    .prepare(`SELECT dom_hash, ds_registry_version FROM audit_history WHERE page_id = ? ORDER BY completed_at DESC LIMIT 1`)
    .get(pageId) as { dom_hash: string; ds_registry_version: string } | undefined;
  return row?.dom_hash === domHash && row?.ds_registry_version === dsRegistryVersion;
}
