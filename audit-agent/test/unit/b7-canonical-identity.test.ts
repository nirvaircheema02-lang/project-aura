import { describe, expect, it } from 'vitest';
import { mergeFindingPair, reconcileDuplicates, sameElement } from '../../src/agents/b7-coverage-qa/identity.ts';
import { linkTwins } from '../../src/agents/b7-coverage-qa/reconcile.ts';
import type { RawManifestItem } from '../../src/agents/b7-coverage-qa/manifest.ts';
import type { Finding } from '../../src/skills/s0-result-contract.ts';
import type { B4Output, DetectedComponent } from '../../src/agents/types.ts';

/**
 * ONE PHYSICAL ELEMENT, ONE FINDING. A finding id hashes the fingerprint (path, role, name, text) with the box left
 * out, so an element the audit already held and B7's recovery captured again read as a fingerprint COLLISION and got a
 * numbered second id — "How We Capture Dealer Needs" twice in one section. Identity is decided from combined evidence
 * (DOM path + role + words + section, with geometry and liveness to tell genuine look-alikes apart).
 */

type Box = { x: number; y: number; width: number; height: number };
const HEADING_BOX: Box = { x: 100, y: 1200, width: 600, height: 40 };

function comp(over: { elId: string; findingId: string; path?: string; text?: string; sectionId?: string; tag?: string; box?: Box; componentType?: string }): DetectedComponent {
  const box = over.box ?? HEADING_BOX;
  const text = over.text ?? 'How We Capture Dealer Needs';
  return {
    elId: over.elId, ref: `ref-${over.elId}`, findingId: over.findingId, sectionId: over.sectionId ?? 's-method', sectionName: 'Method', componentType: over.componentType ?? 'section-heading', label: text,
    fingerprint: { structuralPath: over.path ?? 'main > section:nth-of-type(3) > h2', role: over.tag ?? 'h2', accessibleName: '', textPrefix: text, box },
    domFacts: null,
  } as unknown as DetectedComponent;
}

const finding = (findingId: string, classification: Finding['classification'], extra: Partial<Finding> & Record<string, unknown> = {}): Finding => ({
  identity: { findingId, auditId: 'a', runId: 'r', timestamp: 't', dsRegistryVersion: 'v', policyVersion: 'p' },
  location: { url: 'u', pageId: 'p', pageName: 'n', templateFamily: null, section: 'Method', sectionId: 's-method', captureState: 'default' },
  component: { productionType: 'section-heading', productionLabel: 'How We Capture Dealer Needs', dsComponent: null, dsVariant: null, signature: `sig-${findingId}` },
  classification,
  comparison: { properties: [], mismatches: [], ruleViolations: [] },
  quality: { severity: 'LOW', confidence: 0.6, confidenceBand: 'MEDIUM', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' },
  action: { recommendation: '', rootCauseRef: null, dsCandidateNote: null, registryUpdateRef: null },
  history: { previousStatus: null, currentStatus: classification, delta: null, previousRunId: null },
  ...extra,
}) as unknown as Finding;

const b4 = (components: DetectedComponent[], findings: Finding[]): B4Output => ({
  components, findings, matches: new Map(components.map((c) => [c.ref, {} as never])), matched: components, unmatched: [], sections: [], ariaElements: [], decisions: {},
} as unknown as B4Output);

const live = (...ids: string[]) => new Set(ids);

describe('the same element is never written twice', () => {
  it('the same heading recovered twice (a stamp lost, captured again) → ONE component and ONE finding, the earlier id', () => {
    const first = comp({ elId: 's-method-recovered-b7-3', findingId: 'f-first' });
    const second = comp({ elId: 's-method-recovered-b7-9', findingId: 'f-second' });
    const out = reconcileDuplicates(b4([first, second], [finding('f-first', 'MATCH'), finding('f-second', 'MATCH')]), { requireSameSection: true, liveElIds: live('s-method-recovered-b7-9') });
    expect(out.state.findings.map((f) => f.identity.findingId)).toEqual(['f-first']);
    expect(out.state.components.map((c) => c.elId)).toEqual(['s-method-recovered-b7-3']);
    expect(out.merged).toEqual([{ kept: { elId: 's-method-recovered-b7-3', findingId: 'f-first' }, dropped: { elId: 's-method-recovered-b7-9', findingId: 'f-second' }, label: 'How We Capture Dealer Needs' }]);
    expect([...out.state.matches.keys()]).toEqual(['ref-s-method-recovered-b7-3']); // the dropped capture's B3 answer goes with it
  });

  it('the same control found in the FIRST PASS and again by B7 after the page re-rendered it and shifted it 300px → one finding, the first pass\'s', () => {
    const original = comp({ elId: 's-method-4', findingId: 'f-orig', path: 'header > nav > a:nth-of-type(2)', text: 'Reports', tag: 'a', componentType: 'nav-link' });
    const rediscovered = comp({ elId: 's-method-recovered-b7-0', findingId: 'f-again', path: 'header > nav > a:nth-of-type(2)', text: 'Reports', tag: 'a', componentType: 'nav-link', box: { ...HEADING_BOX, y: HEADING_BOX.y + 300 } });
    // the original's audit stamp is gone from the page (re-rendered) — only the re-discovery's is live
    const out = reconcileDuplicates(b4([original, rediscovered], [finding('f-orig', 'DEVIATION'), finding('f-again', 'DEVIATION')]), { requireSameSection: false, liveElIds: live('s-method-recovered-b7-0') });
    expect(out.state.findings.map((f) => f.identity.findingId)).toEqual(['f-orig']);
    expect(out.state.components.map((c) => c.elId)).toEqual(['s-method-4']);
  });

  it('the same element whose status CHANGES after recovery is UPDATED, not duplicated: NEEDS_REVIEW → INCORRECT keeps the first finding id and takes the measured result', () => {
    const first = comp({ elId: 's-method-5', findingId: 'f-1' });
    const again = comp({ elId: 's-method-recovered-b7-2', findingId: 'f-2' });
    const review = finding('f-1', 'NEEDS_REVIEW', { review: { status: 'NEEDS_REVIEW', reason: 'resembles two components', node: 'B3', signals: [], possibleMatches: [], observed: [] } });
    const measured = finding('f-2', 'INCORRECT', { quality: { severity: 'HIGH', confidence: 0.7, confidenceBand: 'MEDIUM', escalationStatus: 'NONE', escalationReasons: [], evidence: [], visualVerdict: 'NOT_CHECKED' }, comparison: { properties: [{ property: 'font-size', actual: '32px', expected: '31.25px', expectedToken: null, source: null, status: 'DIFFERENT', note: null }], mismatches: [], ruleViolations: [] } });
    const out = reconcileDuplicates(b4([first, again], [review, measured]), { requireSameSection: true, liveElIds: live('s-method-recovered-b7-2') });
    expect(out.state.findings).toHaveLength(1);
    const [f] = out.state.findings as [Finding];
    expect(f.identity.findingId).toBe('f-1'); // one id for the element, for good — history continues
    expect(f.classification).toBe('INCORRECT');
    expect(f.comparison.properties?.map((p) => p.property)).toEqual(['font-size']);
  });

  it('…and MATCH → DEVIATION likewise; a later MATCH never erases an earlier measured breach, but the evidence of both is kept', () => {
    const a = finding('f-a', 'INCORRECT', { comparison: { properties: [{ property: 'color', actual: 'red', expected: 'black', expectedToken: null, source: null, status: 'DIFFERENT', note: null }], mismatches: [{ property: 'color', actual: 'red', expected: 'black', expectedToken: null, comparison: 'exact', delta: null }], ruleViolations: [{ ruleId: 'R1.2', title: 't', why: 'w' }] } });
    const b = finding('f-b', 'MATCH', { comparison: { properties: [{ property: 'font-size', actual: '16px', expected: '16px', expectedToken: null, source: null, status: 'MATCH', note: null }], mismatches: [], ruleViolations: [] } });
    const merged = mergeFindingPair(a, b);
    expect(merged.classification).toBe('INCORRECT');
    expect(merged.identity.findingId).toBe('f-a');
    expect(merged.comparison.properties?.map((p) => p.property).sort()).toEqual(['color', 'font-size']);
    expect(merged.comparison.ruleViolations.map((v) => v.ruleId)).toEqual(['R1.2']);
    const up = mergeFindingPair(finding('f-c', 'MATCH'), finding('f-d', 'DEVIATION'));
    expect(up).toMatchObject({ classification: 'DEVIATION', identity: { findingId: 'f-c' } });
  });
});

describe('different elements stay different', () => {
  it('identical wording in DIFFERENT sections remains two findings — even when path, role and words all agree', () => {
    const a = comp({ elId: 's-one-1', findingId: 'f-a', sectionId: 's-one' });
    const b = comp({ elId: 's-two-1', findingId: 'f-b', sectionId: 's-two' });
    const out = reconcileDuplicates(b4([a, b], [finding('f-a', 'MATCH'), finding('f-b', 'MATCH')]), { requireSameSection: true, liveElIds: live('s-one-1', 's-two-1') });
    expect(out.merged).toHaveLength(0);
    expect(out.state.findings).toHaveLength(2);
    // and the same wording on genuinely different DOM nodes (different path) is never one element either
    const c = comp({ elId: 's-three-1', findingId: 'f-c', path: 'main > section:nth-of-type(7) > h2', sectionId: 's-one' });
    expect(sameElement(a, c, { requireSameSection: false })).toBe(false);
  });

  it('repeated list items that are genuinely different DOM elements (same text, nth-of-type 1..4) all remain', () => {
    const items = [1, 2, 3, 4].map((n) => comp({ elId: `s-list-${n}`, findingId: `f-${n}`, path: `main > ul > li:nth-of-type(${n}) > a`, text: 'Learn more', tag: 'a', sectionId: 's-list', componentType: 'link', box: { x: 100, y: 400 + n * 40, width: 90, height: 24 } }));
    const out = reconcileDuplicates(b4(items, items.map((c) => finding(c.findingId, 'DEVIATION'))), { requireSameSection: true, liveElIds: live(...items.map((c) => c.elId)) });
    expect(out.merged).toHaveLength(0);
    expect(out.state.findings.map((f) => f.identity.findingId)).toEqual(['f-1', 'f-2', 'f-3', 'f-4']);
  });

  it('look-alikes that share a path (shadow roots) and are BOTH on the page, apart, stay separate — a later capture of one is not a rediscovery of the other', () => {
    const shadowA = comp({ elId: 's-method-8', findingId: 'f-a', path: 'my-widget > button', text: 'Open', tag: 'button', componentType: 'button' });
    const shadowB = comp({ elId: 's-method-recovered-b7-4', findingId: 'f-b', path: 'my-widget > button', text: 'Open', tag: 'button', componentType: 'button', box: { ...HEADING_BOX, y: HEADING_BOX.y + 500 } });
    // the earlier audit's element is STILL live (its stamp is on the page): the later capture is a different element
    const out = reconcileDuplicates(b4([shadowA, shadowB], [finding('f-a', 'MATCH'), finding('f-b', 'MATCH')]), { requireSameSection: true, liveElIds: live('s-method-8', 's-method-recovered-b7-4') });
    expect(out.merged).toHaveLength(0);
    // …and with no liveness information the reading stays conservative: far apart means two elements
    expect(reconcileDuplicates(b4([shadowA, shadowB], [finding('f-a', 'MATCH'), finding('f-b', 'MATCH')]), { requireSameSection: true }).merged).toHaveLength(0);
  });

  it('two FIRST-PASS components are never merged by the "original is gone" rule — only a recovery can be a rediscovery', () => {
    const a = comp({ elId: 's-method-1', findingId: 'f-a', box: HEADING_BOX });
    const b = comp({ elId: 's-method-2', findingId: 'f-b', box: { ...HEADING_BOX, y: HEADING_BOX.y + 400 } });
    expect(sameElement(a, b, { requireSameSection: true, liveElIds: live() })).toBe(false);
  });
});

describe('a finding-less capture adds nothing to merge; the survivor is untouched', () => {
  it('a duplicate component that never produced a finding is dropped, the survivor\'s finding is exactly what it was', () => {
    const first = comp({ elId: 's-method-1', findingId: 'f-1' });
    const orphan = comp({ elId: 's-method-recovered-b7-1', findingId: 'f-orphan' });
    const before = finding('f-1', 'DEVIATION');
    const out = reconcileDuplicates(b4([first, orphan], [before]), { requireSameSection: false, liveElIds: live('s-method-recovered-b7-1') });
    expect(out.state.findings).toEqual([before]);
    expect(out.state.components).toHaveLength(1);
  });
});

describe('B7 finds an element the page MOVED by its canonical identity — it is not "missing", so it is never captured again', () => {
  const rawItem = (over: Partial<RawManifestItem> & { id: string; text: string; path: string }): RawManifestItem => ({
    kind: 'heading', role: 'heading', tag: 'h2', box: HEADING_BOX,
    facts: { tag: 'h2', classes: [], roleAttr: null, cursor: 'auto', text: over.text, hasSvg: false, hasImg: false, ownText: true, childElementCount: 0, style: {} as never, box: HEADING_BOX },
    visibility: 'visible', where: [], reveal: { kind: null, hostSelector: null, controlSelector: null },
    place: { inNavigation: false, inFooter: false, insideOwner: false, ownerText: null }, stamps: { self: [], inner: [], owner: [] }, source: 'dom', ...over,
  });

  it('stamp erased AND the layout shifted 300px (past the box test) → still linked, by DOM path + role + words', () => {
    const audited = comp({ elId: 's-method-4', findingId: 'f-1' });
    const moved = rawItem({ id: 'b7-9', text: 'How We Capture Dealer Needs', path: 'main > section:nth-of-type(3) > h2', box: { ...HEADING_BOX, y: HEADING_BOX.y + 300 } });
    expect(linkTwins([moved], [audited]).get('b7-9')?.elId).toBe('s-method-4');
  });

  it('a different node with the same words (another path) is NOT linked to it; an element another item already owns by its stamp is never offered', () => {
    const audited = comp({ elId: 's-method-4', findingId: 'f-1' });
    const other = rawItem({ id: 'b7-8', text: 'How We Capture Dealer Needs', path: 'main > section:nth-of-type(5) > h2', box: { ...HEADING_BOX, y: HEADING_BOX.y + 300 } });
    expect(linkTwins([other], [audited]).size).toBe(0);
    const owner = rawItem({ id: 'b7-1', text: 'How We Capture Dealer Needs', path: 'main > section:nth-of-type(3) > h2', stamps: { self: ['s-method-4'], inner: [], owner: [] } });
    const second = rawItem({ id: 'b7-2', text: 'How We Capture Dealer Needs', path: 'main > section:nth-of-type(3) > h2', box: { ...HEADING_BOX, y: HEADING_BOX.y + 300 } });
    const linked = linkTwins([owner, second], [audited]);
    expect(linked.has('b7-2')).toBe(false); // the audited element is the stamped item's — the look-alike is a separate element
  });

  it('look-alikes sharing a path are told apart by position — each item takes the closest one-to-one', () => {
    const a = comp({ elId: 's-w-1', findingId: 'f-a', path: 'my-widget > button', text: 'Open', tag: 'button', box: { x: 100, y: 100, width: 80, height: 30 } });
    const b = comp({ elId: 's-w-2', findingId: 'f-b', path: 'my-widget > button', text: 'Open', tag: 'button', box: { x: 100, y: 600, width: 80, height: 30 } });
    const mk = (id: string, y: number) => rawItem({ id, text: 'Open', path: 'my-widget > button', tag: 'button', kind: 'control', role: 'button', box: { x: 100, y, width: 80, height: 30 } });
    const moved = linkTwins([mk('b7-1', 640), mk('b7-2', 140)], [a, b]);
    expect(moved.get('b7-2')?.elId).toBe('s-w-1');
    expect(moved.get('b7-1')?.elId).toBe('s-w-2');
  });
});
