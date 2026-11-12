import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildReferenceHooks } from '../../src/reference/hooks.ts';
import { loadApprovedRegistry } from '../../src/reference/registry.ts';
import type { PatternQuery } from '../../src/reference/types.ts';
import { buildDsTokenIndex } from '../../src/resolution/ds-evidence.ts';
import { resolveTargets } from '../../src/resolution/resolve.ts';
import { cleanupDsFixtures, miniDsIndex, REAL_DS } from '../helpers/ds-colour-fixture.ts';
import { entryFor, now, residual, RUN } from '../helpers/resolver-stub.ts';

/**
 * Round 2, defect 6: what `hooks.find` OFFERS is what `hooks.verify` can ACCEPT. The Resolver hands the judge the first six candidates; one the verifier is certain to
 * refuse on `purpose-matches` ("no meaningful word in common between the need and the pattern purpose") wastes a slot and the judge's one attempt.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { cleanupDsFixtures(); for (const c of cleanups.splice(0)) await c(); });

const PURPOSES = [
  'tinted fill behind a quiet notice box',
  'hairline separation of a sidebar block',
  'accordion row divider with a faint rule',
  'light separation of a card from its section',
  'pricing table header underline',
  'stat strip thin top border',
  'footer link list divider',
  'subtle border for a card grid',
];

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'hooks-purpose-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'projects');
  const css = join(root, 'competition-benchmarking-v2-react', 'src', 'globals.css');
  await mkdir(dirname(css), { recursive: true });
  await writeFile(css, PURPOSES.map((_, i) => `.p${i} { border: 1px solid var(--border-soft); }`).join('\n'));
  const registryPath = join(base, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    schemaVersion: 1, version: 'test.1', approvedBy: 'test', approvedOn: '2026-10-09', referenceProjectsRoot: root,
    projects: [{ name: 'competition-benchmarking-v2-react', relativeDir: 'competition-benchmarking-v2-react', kind: 'react-vite', inspectionUrl: null, role: 'fixture', preferredFor: ['subtle-border'], notes: [],
      patterns: PURPOSES.map((purpose, i) => ({
        id: `p${i}`, category: 'subtle-border', purpose, description: 'a bordered block', source: { file: 'src/globals.css', kind: 'css-rule', locator: `.p${i}` },
        declarations: { border: '1px solid var(--border-soft)' }, appliesTo: { surfaces: ['light'], viewports: ['any'], elementKinds: ['card', 'panel'] }, whenNotToUse: 'fixture',
      })) }],
  }));
  return registryPath;
}

const query = (purpose: string, over: Partial<PatternQuery> = {}): PatternQuery => ({ category: 'subtle-border', purpose, surface: 'light', viewport: 'any', elementKinds: ['card'], properties: ['border-top-color'], ...over });

describe('hooks.find offers only what the purpose check of verification would accept', () => {
  it('a candidate with no meaningful word in common with the need is not offered; one that shares a word is', async () => {
    const hooks = (await buildReferenceHooks({ registryPath: await fixture(), dsTokens: miniDsIndex() }))!;
    const offered = hooks.find(query('a card that needs a subtle border')).map((c) => c.pattern);
    expect(offered.sort()).toEqual(['p3', 'p5', 'p7']); // "card" (p3, p7), "subtle" (p7), "border" (p5, p7)
    const none = hooks.find(query('a carousel with an autoplay toggle'));
    expect(none).toEqual([]);
  });

  it('EVERY offered candidate passes the purpose check when verified (no candidate that is certain to be refused)', async () => {
    const hooks = (await buildReferenceHooks({ registryPath: await fixture(), dsTokens: miniDsIndex() }))!;
    for (const purpose of ['a card that needs a subtle border', 'panel sidebar block hairline', 'accordion row', 'footer', 'zzz', 'notice box tinted']) {
      for (const c of hooks.find(query(purpose))) {
        const v = await hooks.verify({ project: c.project, pattern: c.pattern, query: query(purpose) });
        expect(v.reasons.join(' | '), `${purpose} / ${c.pattern}`).not.toMatch(/purpose-matches/);
      }
    }
  });

  it('the filter comes BEFORE the six-slot cap: the Resolver\'s candidates are the matching ones, not the first six offered', async () => {
    const hooks = (await buildReferenceHooks({ registryPath: await fixture(), dsTokens: miniDsIndex() }))!;
    // eight patterns of the same category and kinds: all eight used to be offered in registry order, the cap kept p0..p5, so p7 - the best match - never reached the judge
    const out = await resolveTargets({ page: null, dsIndex: miniDsIndex(), dsRegistryVersion: 'v1', decisions: null, reference: hooks, now }, { run: RUN, findings: [residual('f-card', 'card')], entries: [entryFor('eCard', 'f-card')] });
    expect(out.residuals[0]!.candidatePatterns.map((c) => c.pattern)).toEqual(['p3', 'p5', 'p7']);
  });
});

describe('the shipped registry', () => {
  it('every candidate offered for any (kind, surface, purpose) is accepted by the purpose check of verification', async () => {
    const hooks = (await buildReferenceHooks({ dsTokens: miniDsIndex() }))!;
    const purposes = [
      'panel too little evidence to call it a DS component classified as panel',
      'card a card that needs a subtle border classified as card',
      'accordion faq row classified as accordion',
      'section classified as section tinted band',
      'x', '',
    ];
    let checked = 0;
    for (const purpose of purposes) for (const kind of ['card', 'panel', 'accordion', 'section', 'row']) for (const surface of ['light', 'dark'] as const) {
      const q = query(purpose, { elementKinds: [kind], surface });
      for (const c of hooks.find(q)) {
        const v = await hooks.verify({ project: c.project, pattern: c.pattern, query: q });
        expect(v.reasons.join(' | '), `${purpose} / ${kind} / ${surface} / ${c.pattern}`).not.toMatch(/purpose-matches/);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(REAL_DS))('on the real DS: a panel is offered only patterns the verifier can claim on purpose (reviewer repro: three of four were refused)', async () => {
    const hooks = (await buildReferenceHooks({ dsTokens: buildDsTokenIndex(REAL_DS) }))!;
    const q = query('panel too little evidence to call it a DS component classified as panel', { elementKinds: ['panel'], properties: ['border-top-color'] });
    const offered = hooks.find(q);
    for (const c of offered) {
      const v = await hooks.verify({ project: c.project, pattern: c.pattern, query: q });
      expect(v.reasons.join(' | '), c.pattern).not.toMatch(/purpose-matches/);
    }
    expect((await loadApprovedRegistry()).registry.projects.length).toBeGreaterThan(0);
  }, 120_000);
});
