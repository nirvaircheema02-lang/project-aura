import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toReferenceProvenance, verifyPattern } from '../../src/reference/patterns.ts';
import type { ApprovedRegistry, DsTokenLookup, PatternQuery, PatternVerification } from '../../src/reference/types.ts';
import { buildDsTokenIndex } from '../../src/resolution/ds-evidence.ts';
import { cleanupDsFixtures, makeDsDir, MINI_DS_DARK, MINI_DS_TOKENS, miniDsIndex } from '../helpers/ds-colour-fixture.ts';

/**
 * Colour-lane review: what `verifyPattern` does with the reference CSS it reads. A reference colour is a colour wherever it is written, a project token is
 * judged by VALUE even when it aliases a DS token of the same name, a conditional block applies only to the surface/viewport it is for, a state pair is judged
 * through the same grounding as the mapped value, and a var() fallback never carries a raw colour into `applied`.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  cleanupDsFixtures();
  for (const c of cleanups.splice(0)) await c();
});

interface P {
  id: string;
  declarations: Record<string, string>;
  surfaces?: Array<'light' | 'dark'>;
  kind?: 'css-rule' | 'css-tokens';
  locator?: string;
}

async function world(css: string, patterns: P[]): Promise<ApprovedRegistry> {
  const base = await mkdtemp(join(tmpdir(), 'ref-colours-review-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'projects');
  const file = join(root, 'competition-benchmarking-v2-react', 'src', 'globals.css');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, css);
  return {
    schemaVersion: 1, version: 'test.1', approvedBy: 'test', approvedOn: '2026-10-09', referenceProjectsRoot: root,
    projects: [{
      name: 'competition-benchmarking-v2-react', relativeDir: 'competition-benchmarking-v2-react', kind: 'react-vite', inspectionUrl: null, role: 'fixture', preferredFor: ['subtle-border'], notes: [],
      patterns: patterns.map((p) => ({
        id: p.id, category: 'subtle-border' as const, purpose: 'subtle hairline border for a card', description: 'a card with a soft hairline border',
        source: { file: 'src/globals.css', kind: p.kind ?? ('css-rule' as const), locator: p.locator ?? `.${p.id}` }, declarations: p.declarations,
        appliesTo: { surfaces: p.surfaces ?? ['light'], viewports: ['any' as const], elementKinds: ['card', 'panel'] }, whenNotToUse: 'fixture',
      })),
    }],
  };
}

const baseQuery: PatternQuery = { category: 'subtle-border', purpose: 'subtle hairline border for a card', surface: 'light', viewport: 'any', elementKinds: ['card'], properties: [] };
const verify = (registry: ApprovedRegistry, id: string, over: Partial<PatternQuery> = {}, ds: DsTokenLookup = miniDsIndex()): Promise<PatternVerification> =>
  verifyPattern({ registry, projectName: 'competition-benchmarking-v2-react', patternId: id, query: { ...baseQuery, ...over }, dsTokens: ds });
const check = (v: PatternVerification, id: string) => v.checks.find((c) => c.id === id);
const RAW = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:red|blue|white|black)\b|canvastext/i;

describe('defect 1: a colour in a property that is not a "colour property" is refused, never taken raw', () => {
  const CSS = `
.stop { stop-color: red; }
.flood { flood-color: blue; }
.scroll { scrollbar-color: red blue; }
.drop { filter: drop-shadow(0 0 2px red); }
.sys { border: 1px solid CanvasText; }
.sysout { outline: 2px solid Highlight; }
.tap { -webkit-tap-highlight-color: red; }
.emph { text-emphasis: filled red; }
.cur { border: 1px solid currentColor; }
.up { border: 1px solid RGBA(0,0,0,.08); }
.upsoft { border: 1px solid HSL(0 0% 0% / 8%); }
.low { border: 1px solid rgba(0,0,0,.08); }
`;
  const pats: P[] = [
    { id: 'stop', declarations: { 'stop-color': 'red' } },
    { id: 'flood', declarations: { 'flood-color': 'blue' } },
    { id: 'scroll', declarations: { 'scrollbar-color': 'red blue' } },
    { id: 'drop', declarations: { filter: 'drop-shadow(0 0 2px red)' } },
    { id: 'sys', declarations: { border: '1px solid CanvasText' } },
    { id: 'sysout', declarations: { outline: '2px solid Highlight' } },
    { id: 'tap', declarations: { '-webkit-tap-highlight-color': 'red' } },
    { id: 'emph', declarations: { 'text-emphasis': 'filled red' } },
    { id: 'cur', declarations: { border: '1px solid currentColor' } },
    { id: 'up', declarations: { border: '1px solid RGBA(0,0,0,.08)' } },
    { id: 'upsoft', declarations: { border: '1px solid HSL(0 0% 0% / 8%)' } },
    { id: 'low', declarations: { border: '1px solid rgba(0,0,0,.08)' } },
  ];

  it.each(['stop', 'flood', 'scroll', 'drop', 'sys', 'sysout', 'tap', 'emph'])('%s: refused, nothing applied, never an approved project pattern', async (id) => {
    const v = await verify(await world(CSS, pats), id);
    expect(v.ok, `${id}: ${JSON.stringify(v.applied)}`).toBe(false);
    expect(v.applied).toEqual({});
    expect(v.classification).toBeNull();
    expect(check(v, 'colours-mapped')?.ok).toBe(false);
  });

  it('currentcolor is a permitted keyword: kept as written, no colour mapping involved', async () => {
    const v = await verify(await world(CSS, pats), 'cur');
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toMatch(/currentcolor/i);
    expect(v.colours).toEqual([]);
    expect(v.classification).toBe('approved-project-pattern');
  });

  it('uppercase function names (RGBA, HSL) are read exactly like their lowercase forms (defect 11)', async () => {
    const w = await world(CSS, pats);
    const low = await verify(w, 'low');
    expect(low.ok, low.reasons.join(' | ')).toBe(true);
    for (const id of ['up', 'upsoft']) {
      const v = await verify(w, id);
      expect(v.ok, `${id}: ${v.reasons.join(' | ')}`).toBe(true);
      expect(v.applied.border).toBe(low.applied.border);
    }
  });
});

describe('defect 5: a project token that aliases a DS token of the same name is judged by VALUE', () => {
  const CSS = `
:root {
  --border-soft: var(--border-strong);
  --border-default: var(--bd2);
  --bd2: var(--border-section);
  --semantic-hairline-soft: var(--border-card);
}
.alias { border: 1px solid var(--border-soft); }
.chain { border: 1px solid var(--border-default); }
.same { border: 1px solid var(--semantic-hairline-soft); }
`;
  const pats: P[] = [
    { id: 'alias', declarations: { border: '1px solid var(--border-soft)' } },
    { id: 'chain', declarations: { border: '1px solid var(--border-default)' } },
    { id: 'same', declarations: { border: '1px solid var(--semantic-hairline-soft)' } },
  ];

  it('the project says --border-soft is the DS --border-strong colour: the DS --border-soft (a different colour) is NOT applied by name', async () => {
    const v = await verify(await world(CSS, pats), 'alias');
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).not.toContain('var(--border-soft)');
    const c = v.colours.find((m) => m.property === 'border')!;
    expect(c.nameCollision).not.toBeNull();
    expect(c.nameCollision!.dsValue).toBe('rgba(0, 0, 0, 0.08)');
    expect(c.referenceRgba.alpha).toBeCloseTo(0.18, 2); // the colour the reference really renders
    expect(c.dsValue).toBe('rgba(0, 0, 0, 0.18)');
    expect(c.sameName).toBe(false);
  });

  it('an alias reached through a project-only token is followed to its value too: a different colour is a collision', async () => {
    const v = await verify(await world(CSS, pats), 'chain');
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).not.toContain('var(--border-default)');
    expect(v.colours[0]?.nameCollision ?? null).not.toBeNull();
    expect(v.colours[0]!.referenceRgba.alpha).toBeCloseTo(0.1, 2);
  });

  it('an alias that really equals the DS definition keeps the name, and the mapping records that it is the same colour', async () => {
    const v = await verify(await world(CSS, pats), 'same');
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toBe('1px solid var(--semantic-hairline-soft)');
    expect(v.colours[0]).toMatchObject({ outcome: 'exact', sameName: true, nameCollision: null });
  });
});

describe('defect 6: conditional at-rules apply only to the surface / viewport they are for', () => {
  const CSS = `
:root { --edge: rgba(0,0,0,.08); }
@media (prefers-color-scheme: dark) { :root { --edge: rgba(255,255,255,.12); } }
.theme { border: 1px solid var(--edge); }
.resp { border: 1px solid rgba(0,0,0,.08); }
@media (max-width: 600px) { .resp { border: 1px solid rgba(255,0,170,.5); } }
.wide { border: 1px solid rgba(0,0,0,.08); }
@media (min-width: 900px) { .wide { border: 1px solid rgba(0,0,0,.12); } }
.sup { border: 1px solid rgba(0,0,0,.08); }
@supports (color: color-mix(in srgb, red, blue)) { .sup { border: 1px solid rgba(255,0,170,.5); } }
.layered { border: 1px solid rgba(0,0,0,.08); }
@layer base { .layered { border: 1px solid rgba(0,0,0,.12); } }
`;
  const both: Array<'light' | 'dark'> = ['light', 'dark'];
  const pats: P[] = [
    { id: 'theme', declarations: { border: '1px solid var(--edge)' }, surfaces: both },
    { id: 'resp', declarations: { border: '1px solid rgba(0,0,0,.08)' } },
    { id: 'wide', declarations: { border: '1px solid rgba(0,0,0,.08)' } },
    { id: 'sup', declarations: { border: '1px solid rgba(0,0,0,.08)' } },
    { id: 'layered', declarations: { border: '1px solid rgba(0,0,0,.12)' } },
  ];

  it('a prefers-color-scheme: dark override is NOT read for a light surface; the base value is, and the property is marked conditioned', async () => {
    const v = await verify(await world(CSS, pats), 'theme', { surface: 'light' });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.colours[0]!.referenceRgba).toMatchObject({ r: 0, g: 0, b: 0 });
    expect(v.colours[0]!.referenceRgba.alpha).toBeCloseTo(0.08, 2);
    expect(v.conditioned.join(' ')).toMatch(/--edge/);
    expect(v.conditioned.join(' ')).toMatch(/prefers-color-scheme/);
  });

  it('the same override IS read for a dark surface', async () => {
    const v = await verify(await world(CSS, pats), 'theme', { surface: 'dark' });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.colours[0]!.referenceRgba).toMatchObject({ r: 255, g: 255, b: 255 });
    expect(v.colours[0]!.referenceRgba.alpha).toBeCloseTo(0.12, 2);
  });

  it('a max-width override does not turn the base declaration into drift, is not read for a desktop need, and IS read for a mobile one', async () => {
    const w = await world(CSS, pats);
    const desktop = await verify(w, 'resp', { viewport: 'desktop' });
    expect(desktop.ok, desktop.reasons.join(' | ')).toBe(true);
    expect(desktop.colours[0]!.referenceRgba.alpha).toBeCloseTo(0.08, 2);
    const any = await verify(w, 'resp', { viewport: 'any' });
    expect(any.ok, any.reasons.join(' | ')).toBe(true);
    expect(any.conditioned.join(' ')).toMatch(/max-width: 600px/);
    const mobile = await verify(w, 'resp', { viewport: 'mobile' });
    expect(mobile.ok).toBe(false); // the mobile value is the magenta one: no DS colour is near it
    expect(check(mobile, 'colours-mapped')?.detail).toMatch(/255,\s*0,\s*170/);
  });

  it('a min-width override applies to desktop, not to mobile or to an unspecified viewport', async () => {
    const w = await world(CSS, pats);
    const desktop = await verify(w, 'wide', { viewport: 'desktop' });
    expect(desktop.colours[0]!.referenceRgba.alpha).toBeCloseTo(0.12, 2);
    const mobile = await verify(w, 'wide', { viewport: 'mobile' });
    expect(mobile.colours[0]!.referenceRgba.alpha).toBeCloseTo(0.08, 2);
  });

  it('an @supports block is never "the default": the base rule is read and the property is marked', async () => {
    const v = await verify(await world(CSS, pats), 'sup');
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.colours[0]!.referenceRgba.alpha).toBeCloseTo(0.08, 2);
    expect(v.conditioned.join(' ')).toMatch(/@supports/);
  });

  it('@layer is not a condition: its rules apply (and win by order), nothing is marked', async () => {
    const v = await verify(await world(CSS, pats), 'layered');
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.conditioned).toEqual([]);
  });

  it('the conditioned properties reach the provenance of an accepted pattern', async () => {
    const v = await verify(await world(CSS, pats), 'sup');
    const prov = toReferenceProvenance(v);
    expect(prov?.conditioned?.join(' ')).toMatch(/@supports/);
    expect(prov?.note ?? '').toMatch(/conditioned|@supports/);
  });
});

describe('defect 8 + 14: a hover pair is judged through the same grounding as the mapped value', () => {
  const CSS = `
:root { --a: rgba(0,0,0,.07); --b: rgba(0,0,0,.09); --c: rgba(0,0,0,.08); --d: rgba(0,0,0,.15); }
.hvcollapse { border: 1px solid var(--a); }
.hvcollapse:hover { border-color: var(--b); }
.hvok { border: 1px solid var(--c); }
.hvok:hover { border-color: var(--d); }
.hvliteral { border: 1px solid rgba(0,0,0,.07); }
.hvliteral:hover { border-color: rgba(0,0,0,.09); }
.hvlone { border-width: 1px; }
.hvlone:hover { border-color: rgba(0,0,0,.15); }
`;
  const pats: P[] = [
    { id: 'hvcollapse', declarations: { border: '1px solid var(--a)' } },
    { id: 'hvok', declarations: { border: '1px solid var(--c)' } },
    { id: 'hvliteral', declarations: { border: '1px solid rgba(0,0,0,.07)' } },
    { id: 'hvlone', declarations: { 'border-width': '1px' } },
  ];
  const hover: Partial<PatternQuery> = { colour: { state: 'hover', property: 'border-top-color' } };

  it('a default colour that comes through a project var() is read like a literal one: the same pair is judged the same way', async () => {
    const w = await world(CSS, pats);
    const literal = await verify(w, 'hvliteral', hover);
    const viaVar = await verify(w, 'hvcollapse', hover);
    expect(literal.ok).toBe(false); // the reference's .07 -> .09 collapses onto indistinguishable DS colours
    expect(check(literal, 'colours-mapped')?.detail).toMatch(/collapse/);
    expect(viaVar.ok, viaVar.reasons.join(' | ')).toBe(false);
    expect(check(viaVar, 'colours-mapped')?.detail).toMatch(/collapse/);
  });

  it('a pair that stays distinguishable passes and records the reference pair\'s delta', async () => {
    const v = await verify(await world(CSS, pats), 'hvok', hover);
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    const m = v.colours.find((c) => c.state === 'hover')!;
    expect(m.verification.designTime.stateDistinct).toBe(true);
    expect(m.verification.designTime.stateDelta).not.toBeNull();
  });

  it('a hover colour with no default colour to pair it with has no recorded pair: the check is left to be unverified, not a flat number', async () => {
    const v = await verify(await world(CSS, pats), 'hvlone', hover);
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    const m = v.colours.find((c) => c.state === 'hover')!;
    expect(m.verification.designTime.stateDistinct).toBeNull();
    expect(m.verification.designTime.stateDelta).toBeNull();
  });
});

describe('defect 10: var(--ds-token, <raw>) never carries the raw fallback', () => {
  const CSS = '.fb { border: 1px solid var(--dark-only, #ff00aa); } .fb2 { border: 1px solid var(--border-card, #ff00aa); }';
  const dsWithDarkOnly = () =>
    buildDsTokenIndex(makeDsDir({ 'tokens/build/tokens.css': MINI_DS_TOKENS, 'core-v2/src/styles/cinematic-dark.css': `${MINI_DS_DARK}\n@layer tokens { [data-variant="cinematic-dark"] { --dark-only: #123456; } }` }));
  const pats: P[] = [{ id: 'fb', declarations: { border: '1px solid var(--dark-only, #ff00aa)' }, surfaces: ['light', 'dark'] }, { id: 'fb2', declarations: { border: '1px solid var(--border-card, #ff00aa)' }, surfaces: ['light', 'dark'] }];

  it('a token the DS defines only in the dark scope does not resolve on a light surface: refused instead of falling back to the raw colour', async () => {
    const v = await verify(await world(CSS, pats), 'fb', { surface: 'light' }, dsWithDarkOnly());
    expect(v.ok, JSON.stringify(v.applied)).toBe(false);
    expect(JSON.stringify(v)).not.toMatch(/applied.*ff00aa/);
    expect(check(v, 'tokens-exist')?.detail).toMatch(/--dark-only/);
  });

  it('on the dark surface the token resolves and is applied by name, without its fallback', async () => {
    const v = await verify(await world(CSS, pats), 'fb', { surface: 'dark' }, dsWithDarkOnly());
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toBe('1px solid var(--dark-only)');
    expect(RAW.test(v.applied.border!.replace(/var\([^)]*\)/g, ''))).toBe(false);
  });

  it('a DS token that resolves keeps no fallback in `applied` either', async () => {
    const v = await verify(await world(CSS, pats), 'fb2', {}, dsWithDarkOnly());
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toBe('1px solid var(--border-card)');
  });
});

describe('defect 12: a declaration supplies only the properties it sets', () => {
  const CSS = '.rad { border: 1px solid #ff00aa; border-radius: 10px; }';
  const pats: P[] = [{ id: 'rad', declarations: { border: '1px solid #ff00aa', 'border-radius': '10px' } }];

  it('an unmappable border colour does not refuse a pattern that is only asked for its radius', async () => {
    const v = await verify(await world(CSS, pats), 'rad', { colour: { property: 'border-top-left-radius' } });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toBeUndefined();
    expect(v.applied['border-radius']).toBe('10px');
    expect(v.reasons.join(' ')).toMatch(/border is not applied/);
  });

  it('the same colour still refuses a pattern that is asked for the border colour', async () => {
    const v = await verify(await world(CSS, pats), 'rad', { colour: { property: 'border-top-color' } });
    expect(v.ok).toBe(false);
  });
});
