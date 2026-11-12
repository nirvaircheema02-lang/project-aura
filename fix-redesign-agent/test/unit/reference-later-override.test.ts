import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyPattern } from '../../src/reference/patterns.ts';
import type { ApprovedRegistry, PatternQuery, PatternVerification } from '../../src/reference/types.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';

/**
 * Reference lane round 3 (minor): the conditioned reading caught only CONDITIONAL overrides of a related property. An UNCONDITIONAL later declaration of a
 * related property in the same rule list, or a related `!important` one, also changes the value in force - the pattern verified as "used as found and fully
 * DS-grounded" while the reference's rendered colour was another. Now it is refused with the override named; a later declaration of an UNRELATED property, an
 * EARLIER related one that the declared property resets, and a related one the declared property out-ranks with !important are not.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { cleanupDsFixtures(); for (const c of cleanups.splice(0)) await c(); });

const CSS = `
.later { border: 1px solid rgba(0,0,0,.08); }
.later { border-color: rgba(255,0,0,.9); }
.imp { border: 1px solid rgba(0,0,0,.08); border-color: rgba(255,0,0,.9) !important; }
.impfirst { border-color: rgba(255,0,0,.9) !important; }
.impfirst { border: 1px solid rgba(0,0,0,.08); }
.later2 { border-top-color: rgba(0,0,0,.08); }
.later2 { border: 1px solid rgba(255,0,0,.9); }
.sameblock { border-top-color: rgba(0,0,0,.08); border-width: 1px; border-style: solid; }
.harmless { border: 1px solid rgba(0,0,0,.08); }
.harmless { padding: 4px; border-radius: 10px; }
.harmless { border-width: 1px; }
.early { border-color: rgba(255,0,0,.9); }
.early { border: 1px solid rgba(0,0,0,.08); }
.usedimp { border: 1px solid rgba(0,0,0,.08) !important; }
.usedimp { border-color: rgba(255,0,0,.9); }
.otherrule { border: 1px solid rgba(0,0,0,.08); }
.somewhere-else { border-color: rgba(255,0,0,.9); }
.v1 { border: 1px solid rgba(0,0,0,.08); }
.v1 { border-top: 1px solid rgba(255,0,0,.9); }
.v2 { border: 1px solid rgba(0,0,0,.08); }
.v2 { border-block: 1px solid rgba(255,0,0,.9); }
.v3 { border: 1px solid rgba(0,0,0,.08); }
.v3 { all: unset; }
.v4 { border: 1px solid rgba(0,0,0,.08); }
.v4 { border-inline-start: 1px solid rgba(255,0,0,.9); }
.v5 { border-top-color: rgba(0,0,0,.08); }
.v5 { border-block-start: 1px solid rgba(255,0,0,.9); }
.v6 { border: 1px solid rgba(0,0,0,.08); }
.v6 { padding-block: 4px; margin-inline: 8px; border-radius: 6px; }
.v7 { border-color: rgba(255,0,0,.9); }
.v7 { border-block: 1px solid rgba(0,0,0,.08); border: 1px solid rgba(0,0,0,.08); }
`;
const DECL: Record<string, Record<string, string>> = {
  later: { border: '1px solid rgba(0,0,0,.08)' },
  imp: { border: '1px solid rgba(0,0,0,.08)' },
  impfirst: { border: '1px solid rgba(0,0,0,.08)' },
  later2: { 'border-top-color': 'rgba(0,0,0,.08)' },
  sameblock: { 'border-top-color': 'rgba(0,0,0,.08)' },
  harmless: { border: '1px solid rgba(0,0,0,.08)' },
  early: { border: '1px solid rgba(0,0,0,.08)' },
  usedimp: { border: '1px solid rgba(0,0,0,.08) !important' },
  otherrule: { border: '1px solid rgba(0,0,0,.08)' },
  v1: { border: '1px solid rgba(0,0,0,.08)' },
  v2: { border: '1px solid rgba(0,0,0,.08)' },
  v3: { border: '1px solid rgba(0,0,0,.08)' },
  v4: { border: '1px solid rgba(0,0,0,.08)' },
  v5: { 'border-top-color': 'rgba(0,0,0,.08)' },
  v6: { border: '1px solid rgba(0,0,0,.08)' },
  v7: { border: '1px solid rgba(0,0,0,.08)' },
};

async function world(): Promise<ApprovedRegistry> {
  const base = await mkdtemp(join(tmpdir(), 'ref-later-'));
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
const verify = async (id: string, query: PatternQuery = q()): Promise<PatternVerification> => verifyPattern({ registry: await world(), projectName: 'competition-benchmarking-v2-react', patternId: id, query, dsTokens: miniDsIndex() });
const detail = (v: PatternVerification) => v.checks.find((c) => c.id === 'declarations-present')!.detail;

describe('a later related declaration changes the value in force', () => {
  it.each([
    ['later', /border-color/, /later/],
    ['imp', /border-color/, /!important/],
    ['impfirst', /border-color/, /!important/],
    ['later2', /border\b(?!-)/, /later/],
    // round 4: the intermediate side shorthands, the logical aliases and `all` override the used `border` just as `border-color` does
    ['v1', /border-top/, /later/],
    ['v2', /border-block/, /later/],
    ['v3', /\ball\b/, /later/],
    ['v5', /border-block-start/, /later/],
  ])('%s is refused, with the override named', async (id, property, how) => {
    const v = await verify(id);
    expect(v.ok, v.reasons.join(' | ')).toBe(false);
    expect(detail(v)).toMatch(property);
    expect(detail(v)).toMatch(how);
    expect(v.applied).toEqual({});
  });

  it('a LOGICAL alias overrides the physical side it is: border-inline-start is the left border (ltr), so it matters for a left-border need and not for a top one', async () => {
    const left = await verify('v4', q({ colour: { property: 'border-left-color' } }));
    expect(left.ok, left.reasons.join(' | ')).toBe(false);
    expect(detail(left)).toMatch(/border-inline-start/);
    expect(detail(left)).toMatch(/later/);
    const top = await verify('v4');
    expect(top.ok, top.reasons.join(' | ')).toBe(true);
  });

  it('the same without a named colour need (the whole declared property list is checked)', async () => {
    const v = await verify('later', q({ colour: {} }));
    expect(v.ok, v.reasons.join(' | ')).toBe(false);
    expect(detail(v)).toMatch(/border-color/);
  });
});

describe('what does NOT change the value in force stays accepted', () => {
  // v6: padding / margin / radius are not borders; v7: the later declarations here are the used `border`, which resets the earlier border-block and border-color
  it.each(['sameblock', 'harmless', 'early', 'usedimp', 'otherrule', 'v6', 'v7'])('%s', async (id) => {
    const v = await verify(id);
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.classification).toBe('approved-project-pattern');
    expect(Object.keys(v.applied).length).toBeGreaterThan(0);
  });
});
