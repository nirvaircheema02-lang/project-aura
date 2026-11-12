import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toReferenceProvenance, verifyPattern } from '../../src/reference/patterns.ts';
import type { ApprovedRegistry, PatternQuery, PatternVerification } from '../../src/reference/types.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';

/**
 * Round 2, defect 5: a conditional at-rule that overrides a RELATED longhand (or shorthand) of a declared property. `border` is declared, a desktop `@media` sets
 * `border-color` on the same selector: the declared value is not the one in force for a desktop need, and the old report listed nothing. Now the related
 * property is listed as conditioned (suppliesProperty, both directions), and one whose condition holds for the need - so the value read is NOT the value in force -
 * refuses the pattern, with the override named.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { cleanupDsFixtures(); for (const c of cleanups.splice(0)) await c(); });

const CSS = `
.nested { border: 1px solid rgba(0,0,0,.08); }
@media (min-width: 700px) { .nested { border-color: rgba(255,0,0,.9); } }
.small { border: 1px solid rgba(0,0,0,.08); }
@media (max-width: 600px) { .small { border-color: rgba(255,0,0,.9); } }
.longhand { border-top-color: rgba(0,0,0,.08); }
@media (min-width: 700px) { .longhand { border: 1px solid rgba(255,0,0,.9); } }
.radius { border: 1px solid rgba(0,0,0,.08); border-radius: 10px; }
@media (min-width: 700px) { .radius { border-color: rgba(255,0,0,.9); } }
.direct { border-color: rgba(0,0,0,.08); }
@media (min-width: 700px) { .direct { border-color: rgba(0,0,0,.12); } }
.dark { border: 1px solid rgba(0,0,0,.08); }
@media (prefers-color-scheme: dark) { .dark { border-top-color: rgba(255,255,255,.12); } }
`;
const DECL: Record<string, Record<string, string>> = {
  nested: { border: '1px solid rgba(0,0,0,.08)' },
  small: { border: '1px solid rgba(0,0,0,.08)' },
  longhand: { 'border-top-color': 'rgba(0,0,0,.08)' },
  radius: { border: '1px solid rgba(0,0,0,.08)', 'border-radius': '10px' },
  direct: { 'border-color': 'rgba(0,0,0,.08)' },
  dark: { border: '1px solid rgba(0,0,0,.08)' },
};

async function world(): Promise<ApprovedRegistry> {
  const base = await mkdtemp(join(tmpdir(), 'ref-conditioned-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'projects');
  const file = join(root, 'competition-benchmarking-v2-react', 'src', 'globals.css');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, CSS);
  return {
    schemaVersion: 1, version: 'test.1', approvedBy: 'test', approvedOn: '2026-10-09', referenceProjectsRoot: root,
    projects: [{
      name: 'competition-benchmarking-v2-react', relativeDir: 'competition-benchmarking-v2-react', kind: 'react-vite', inspectionUrl: null, role: 'fixture', preferredFor: ['subtle-border'], notes: [],
      patterns: Object.entries(DECL).map(([id, declarations]) => ({
        id, category: 'subtle-border' as const, purpose: 'subtle hairline border for a card', description: 'a card with a soft hairline border',
        source: { file: 'src/globals.css', kind: 'css-rule' as const, locator: `.${id}` }, declarations,
        appliesTo: { surfaces: ['light' as const, 'dark' as const], viewports: ['any' as const], elementKinds: ['card'] }, whenNotToUse: 'fixture',
      })),
    }],
  };
}

const q = (over: Partial<PatternQuery> = {}): PatternQuery => ({ category: 'subtle-border', purpose: 'subtle hairline border for a card', surface: 'light', viewport: 'any', elementKinds: ['card'], properties: [], colour: { property: 'border-top-color' }, ...over });
const verify = async (id: string, query: PatternQuery): Promise<PatternVerification> => verifyPattern({ registry: await world(), projectName: 'competition-benchmarking-v2-react', patternId: id, query, dsTokens: miniDsIndex() });
const detail = (v: PatternVerification) => v.checks.find((c) => c.id === 'declarations-present')!.detail;

describe('a conditional override of a related property', () => {
  it('desktop (the override applies): the pattern is refused and the override is named - the declared `border` is not what is in force', async () => {
    const v = await verify('nested', q({ viewport: 'desktop' }));
    expect(v.ok, v.reasons.join(' | ')).toBe(false);
    expect(detail(v)).toMatch(/border-color/);
    expect(detail(v)).toMatch(/min-width: 700px/);
    expect(v.applied).toEqual({});
    expect(toReferenceProvenance(v)).toBeNull();
  });

  it('mobile (it does not apply): the base is read, and the override is LISTED as conditioned (it used to be silent)', async () => {
    const v = await verify('nested', q({ viewport: 'mobile' }));
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toMatch(/^1px solid/);
    expect(v.conditioned.join(' ')).toMatch(/border-color: @media \(min-width: 700px\) does not apply to this need; the base rule was read/);
    expect(toReferenceProvenance(v)?.conditioned?.join(' ')).toMatch(/border-color/);
  });

  it('any viewport (the Resolver\'s query): the base is read and the override is listed', async () => {
    const v = await verify('nested', q({ viewport: 'any' }));
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.conditioned.join(' ')).toMatch(/border-color: @media \(min-width: 700px\)/);
  });

  it('a max-width override applies on mobile and is refused there, but is only listed on desktop', async () => {
    expect((await verify('small', q({ viewport: 'mobile' }))).ok).toBe(false);
    const desktop = await verify('small', q({ viewport: 'desktop' }));
    expect(desktop.ok).toBe(true);
    expect(desktop.conditioned.join(' ')).toMatch(/border-color: @media \(max-width: 600px\) does not apply/);
  });

  it('both directions: a declared LONGHAND overridden by a conditional SHORTHAND is the same case', async () => {
    const v = await verify('longhand', q({ viewport: 'desktop' }));
    expect(v.ok, v.reasons.join(' | ')).toBe(false);
    expect(detail(v)).toMatch(/border/);
    expect((await verify('longhand', q({ viewport: 'mobile' }))).conditioned.join(' ')).toMatch(/border: @media \(min-width: 700px\)/);
  });

  it('the dark scheme: an override for the dark surface refuses a dark need and is listed for a light one', async () => {
    expect((await verify('dark', q({ surface: 'dark' }))).ok).toBe(false);
    const light = await verify('dark', q({ surface: 'light' }));
    expect(light.ok).toBe(true);
    expect(light.conditioned.join(' ')).toMatch(/border-top-color: @media \(prefers-color-scheme: dark\)/);
  });

  it('a property the need does not depend on is not an obstacle (border-radius is not changed by a border-color override)', async () => {
    const v = await verify('radius', q({ viewport: 'desktop', colour: { property: 'border-radius' }, properties: ['border-radius'] }));
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.conditioned).toEqual([]);
    // ... but the same pattern asked for its border colour is refused
    expect((await verify('radius', q({ viewport: 'desktop' }))).ok).toBe(false);
  });

  it('with no particular need the whole declared pattern is held to it', async () => {
    expect((await verify('radius', q({ viewport: 'desktop', colour: {} }))).ok).toBe(false);
  });

  it('the property that IS declared and overridden is still read (not refused): the override value is the one used', async () => {
    const v = await verify('direct', q({ viewport: 'desktop', colour: { property: 'border-color' } }));
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.colours[0]!.referenceRgba.alpha).toBeCloseTo(0.12, 2);
  });
});
