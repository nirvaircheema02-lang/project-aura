import { describe, expect, it } from 'vitest';
import { renderComponentReviewHtml } from '../../src/manifest/review-html.ts';
import type { ComponentManifest, ManifestComponent } from '../../src/manifest/schema.ts';

/**
 * `component-review.html` (§10a, G3) — regression coverage for the `data-scope` bug fixed
 * earlier this session: a card must be stamped `data-scope="global"` for an excluded
 * (header/footer) pattern and `data-scope="content"` otherwise, because the export script's
 * OWN routing (global candidates vs. page-local selections) reads exactly that attribute
 * back off the DOM at export time — the two must never drift apart.
 */

function component(overrides: Partial<ManifestComponent>): ManifestComponent {
  return {
    findingId: 'a'.repeat(32),
    signature: 'sig-1',
    instanceIndex: null,
    instanceCount: 1,
    relatedFindingIds: [],
    sectionId: 'hero',
    sectionName: 'Hero',
    scope: 'content',
    productionType: 'button',
    productionLabel: 'Sign up',
    auditClassification: 'INCORRECT',
    severity: 'HIGH',
    ds: { dsComponent: 'Button', dsVariant: 'primary', dsFile: 'core-v2/src/atoms/Button.tsx', possibleMatches: [], registryUpdateRef: null, dsCandidateNote: null },
    mismatchProperties: [],
    mismatchClass: 'cosmetic',
    tokens: [],
    fixPlan: { decision: 'fix', note: null },
    redesign: { requested: true, planned: true, applied: true, verified: true, swappedTo: null, unaddressedReason: null },
    location: { located: true, method: 'objective', stamp: 'e1', tagName: 'button', auditBox: null, liveBox: null },
    crops: { before: null, after: null },
    auditEvidence: [],
    states: { captured: ['default'], missing: [] },
    crossRun: { sightings: [], reuse: 'single' },
    suggestion: { bucket: 'page-fix-only', rule: 'R3', confidence: 'high', reason: 'x' },
    ...overrides,
  };
}

function manifest(components: ManifestComponent[]): ComponentManifest {
  return {
    schemaVersion: 1,
    redesignRunId: 'run-1',
    createdAt: '2026-09-18T10:00:00.000Z',
    pageId: 'p1',
    auditAiMode: null,
    auditDsRegistryVersion: 'e'.repeat(64),
    designSystem: { path: '/ds', dsRegistryVersion: 'f'.repeat(64), changedSinceAudit: false },
    viewport: { width: 1440, height: 900 },
    scope: { contentSectionIds: ['hero'], excludedSectionIds: ['global-header'] },
    sections: [],
    components,
    counts: { findings: components.length, located: components.length, unlocated: 0, excluded: 0, fixRequested: 0, fixApplied: 0, fixVerified: 0, byBucket: {}, otherPageFindings: 0 },
  };
}

const contentA = component({ findingId: 'a'.repeat(32), signature: 'btn-sig', scope: 'content', sectionName: 'Hero' });
const contentB = component({ findingId: 'b'.repeat(32), signature: 'btn-sig', scope: 'content', sectionName: 'Hero' });
const global = component({
  findingId: 'c'.repeat(32),
  signature: 'nav-sig',
  scope: 'excluded',
  productionType: 'nav',
  productionLabel: 'Primary nav',
  sectionName: 'Header',
  crossRun: { sightings: [{ runId: 'other-run', displayName: 'other-run', url: 'https://example.com/other', findingIds: ['c'.repeat(32)], basis: 'label', score: 0.7 }], reuse: 'multi-page' },
});

function cardFor(html: string, patternId: string): string {
  const cards = html.split('<article class="pattern-card"').slice(1);
  const card = cards.find((c) => c.startsWith(` data-pattern-id="${patternId}"`));
  if (!card) throw new Error(`no card found for pattern ${patternId}`);
  return `<article class="pattern-card"${card}`;
}

describe('renderComponentReviewHtml', () => {
  const html = renderComponentReviewHtml(manifest([contentA, contentB, global]));

  it('stamps a content-scope pattern data-scope="content" and groups its two instances under one card', () => {
    const card = cardFor(html, 'btn-sig');
    expect(card).toContain('data-scope="content"');
    expect(card).toContain(`data-finding-ids="${'a'.repeat(32)} ${'b'.repeat(32)}"`);
    expect(card).toContain('2 instance(s)');
  });

  it('stamps an excluded (global header/footer) pattern data-scope="global"', () => {
    const card = cardFor(html, 'nav-sig');
    expect(card).toContain('data-scope="global"');
  });

  it('places content cards under "Content components" and excluded cards under "Global candidates"', () => {
    const contentHeading = html.indexOf('<h2>Content components</h2>');
    const globalHeading = html.indexOf('<h2>Global candidates');
    const btnCardIdx = html.indexOf('data-pattern-id="btn-sig"');
    const navCardIdx = html.indexOf('data-pattern-id="nav-sig"');
    expect(contentHeading).toBeGreaterThan(-1);
    expect(globalHeading).toBeGreaterThan(contentHeading);
    expect(btnCardIdx).toBeGreaterThan(contentHeading);
    expect(btnCardIdx).toBeLessThan(globalHeading);
    expect(navCardIdx).toBeGreaterThan(globalHeading);
  });

  it('shows cross-run evidence only for the pattern that has sightings; the other states none explicitly', () => {
    const btnCard = cardFor(html, 'btn-sig');
    const navCard = cardFor(html, 'nav-sig');
    expect(btnCard).toContain('No cross-run evidence — reuse status rests on this page alone.');
    expect(navCard).toContain('Evidence from other pages');
    expect(navCard).toContain('other-run');
    expect(navCard).toContain('label');
  });

  it('shows the suggestion with its rule id and confidence — the checklist must show its reasoning (Decision Log #24)', () => {
    const card = cardFor(html, 'btn-sig');
    expect(card).toContain('Suggestion: <strong>page-fix-only</strong> (rule R3, high confidence) — x');
    expect(card).toContain('data-rule="R3"');
  });

  it('the export script routes a card to globalCandidates vs. selections by reading the SAME data-scope attribute the card is stamped with', () => {
    // this is the exact regression: selection export must never re-derive scope by any other means.
    expect(html).toContain("(card.dataset.scope === 'global' ? globalCandidates : selections).push(entry);");
  });

  it('§regression: the SAME signature recurring both inside and outside the excluded header/footer produces TWO separate cards, each with only its own members — never merged into one card routed by whichever instance came first', () => {
    const sameSigContent = component({ findingId: 'd'.repeat(32), signature: 'shared-sig', scope: 'content', sectionName: 'Hero' });
    const sameSigGlobal = component({ findingId: 'e'.repeat(32), signature: 'shared-sig', scope: 'excluded', sectionName: 'Header' });
    // Global instance listed FIRST in `components` — under the old signature-only grouping this
    // would have made the WHOLE group (including the content instance) render as one global card.
    const splitHtml = renderComponentReviewHtml(manifest([sameSigGlobal, sameSigContent]));

    const cards = splitHtml.split('<article class="pattern-card"').slice(1).filter((c) => c.startsWith(' data-pattern-id="shared-sig"'));
    expect(cards).toHaveLength(2);

    const scopes = cards.map((c) => c.match(/data-scope="([^"]+)"/)?.[1]).sort();
    expect(scopes).toEqual(['content', 'global']);

    const contentCard = cards.find((c) => c.includes('data-scope="content"'))!;
    const globalCard = cards.find((c) => c.includes('data-scope="global"'))!;
    expect(contentCard).toContain(`data-finding-ids="${'d'.repeat(32)}"`); // only its own member
    expect(globalCard).toContain(`data-finding-ids="${'e'.repeat(32)}"`); // only its own member

    // Each card lands under the correct heading — the content card before "Global candidates", the global one after.
    const contentHeadingIdx = splitHtml.indexOf('<h2>Content components');
    const globalHeadingIdx = splitHtml.indexOf('<h2>Global candidates');
    const contentCardIdx = splitHtml.indexOf(contentCard);
    const globalCardIdx = splitHtml.indexOf(globalCard);
    expect(contentCardIdx).toBeGreaterThan(contentHeadingIdx);
    expect(contentCardIdx).toBeLessThan(globalHeadingIdx);
    expect(globalCardIdx).toBeGreaterThan(globalHeadingIdx);
  });

  it('the pattern count in the summary bar counts (signature, scope) groups, not raw signatures', () => {
    const sameSigContent = component({ findingId: 'd'.repeat(32), signature: 'shared-sig', scope: 'content' });
    const sameSigGlobal = component({ findingId: 'e'.repeat(32), signature: 'shared-sig', scope: 'excluded' });
    const splitHtml = renderComponentReviewHtml(manifest([sameSigContent, sameSigGlobal]));
    expect(splitHtml).toContain('2 component(s), 2 pattern(s)');
  });
});
