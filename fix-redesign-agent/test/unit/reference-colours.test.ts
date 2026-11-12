import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toReferenceProvenance, verifyPattern } from '../../src/reference/patterns.ts';
import type { ApprovedPattern, ApprovedRegistry, DsTokenLookup, PatternQuery } from '../../src/reference/types.ts';
import { ReferenceProvenanceSchema } from '../../src/resolution/schema.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';

/**
 * Finding 3 — an approved reference's COLOUR is never used raw. It is read (alpha, state, theme), mapped to the exact or the nearest SUITABLE
 * DS token for its role and surface, and recorded with provenance; when nothing suitable exists the pattern is refused with the specific gap.
 * Everything here goes through `verifyPattern`, the single place a reference declaration becomes an applied value.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  cleanupDsFixtures();
  for (const c of cleanups.splice(0)) await c();
});

const CSS = `
:root {
  --soft-edge: rgba(0,0,0,.08);
  --odd: rgba(255,0,170,.5);
  --border-strong: rgba(0,0,0,.15);
  --border-soft: rgba(0,0,0,.08);
  --on-dark-edge: rgba(255,255,255,.14);
  --faint-black: rgba(0,0,0,.08);
  --faq-border: #f5f5f5;
  --hair6: rgba(0,0,0,.06);
  --opaque-grey: #efefef;
  --ref-shadow: 0 1px 3px rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.02);
  --chain-a: var(--chain-b);
  --chain-b: var(--chain-a);
  --alias: var(--soft-edge);
}
.exact { border: 1px solid var(--soft-edge); }
.sameval { border: 1px solid var(--border-soft); }
.collide { border: 1px solid var(--border-strong); }
.primitive { border: 1px solid var(--faq-border); }
.nearest { border: 1px solid var(--hair6); }
.ondark { border: 1px solid var(--on-dark-edge); }
.blackdark { border: 1px solid var(--faint-black); }
.opaque { border: 1px solid var(--opaque-grey); }
.transparent { border: 1px solid transparent; }
.odd { border: 1px solid var(--odd); }
.lit { border: 1px solid #cccccc; }
.named { border: 1px solid red; }
.multi { border: 1px solid var(--soft-edge); box-shadow: 0 4px 11px rgba(0,0,0,.2); }
.mixed { border: 1px solid color-mix(in srgb, red 50%, blue); }
.grad { background: linear-gradient(90deg, #fff, #000); }
.shadow { box-shadow: var(--ref-shadow); }
.shadowodd { box-shadow: 0 4px 11px rgba(0,0,0,.2); }
.cycle { border: 1px solid var(--chain-a); }
.chain { border: 1px solid var(--alias); }
.hov { border: 1px solid var(--soft-edge); }
.hov:hover { border-color: var(--border-strong); }
.hovsame { border: 1px solid var(--soft-edge); }
.hovsame:hover { border-color: var(--soft-edge); }
.hovcollapse { border: 1px solid rgba(0,0,0,.075); }
.hovcollapse:hover { border-color: rgba(0,0,0,.08); }
`;

const rules = ['exact', 'sameval', 'collide', 'primitive', 'nearest', 'ondark', 'blackdark', 'opaque', 'transparent', 'odd', 'lit', 'named', 'multi', 'mixed', 'grad', 'shadow', 'shadowodd', 'cycle', 'chain', 'hov', 'hovsame', 'hovcollapse'];
const declsOf: Record<string, Record<string, string>> = {
  grad: { background: 'linear-gradient(90deg, #fff, #000)' },
  shadow: { 'box-shadow': 'var(--ref-shadow)' },
  shadowodd: { 'box-shadow': '0 4px 11px rgba(0,0,0,.2)' },
  multi: { border: '1px solid var(--soft-edge)', 'box-shadow': '0 4px 11px rgba(0,0,0,.2)' },
};
const declsFor = (id: string): Record<string, string> => declsOf[id] ?? { border: CSS.split(`.${id} {`)[1]!.split('border:')[1]!.split(';')[0]!.trim() };

interface World {
  registry: ApprovedRegistry;
}

async function makeWorld(): Promise<World> {
  const base = await mkdtemp(join(tmpdir(), 'ref-colours-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'projects');
  const css = join(root, 'competition-benchmarking-v2-react', 'src', 'globals.css');
  await mkdir(dirname(css), { recursive: true });
  await writeFile(css, CSS);
  const pattern = (id: string, surfaces: Array<'light' | 'dark'> = ['light']): ApprovedPattern => ({
    id,
    category: 'subtle-border',
    purpose: 'subtle hairline border for a card',
    description: 'a card with a soft hairline border',
    source: { file: 'src/globals.css', kind: 'css-rule', locator: `.${id}` },
    declarations: declsFor(id),
    appliesTo: { surfaces, viewports: ['any'], elementKinds: ['card', 'panel'] },
    whenNotToUse: 'fixture',
  });
  const dark = new Set(['ondark', 'blackdark']);
  return {
    registry: {
      schemaVersion: 1,
      version: 'test.1',
      approvedBy: 'test',
      approvedOn: '2026-10-09',
      referenceProjectsRoot: root,
      projects: [
        { name: 'competition-benchmarking-v2-react', relativeDir: 'competition-benchmarking-v2-react', kind: 'react-vite', inspectionUrl: null, role: 'fixture', preferredFor: ['subtle-border'], notes: [], patterns: rules.map((id) => pattern(id, dark.has(id) ? ['dark'] : ['light'])) },
      ],
    },
  };
}

const baseQuery: PatternQuery = { category: 'subtle-border', purpose: 'subtle hairline border for a card', surface: 'light', viewport: 'any', elementKinds: ['card'], properties: [] };

async function verify(w: World, id: string, over: Partial<PatternQuery> = {}, ds: DsTokenLookup = miniDsIndex()) {
  return verifyPattern({ registry: w.registry, projectName: 'competition-benchmarking-v2-react', patternId: id, query: { ...baseQuery, ...over }, dsTokens: ds });
}

const check = (v: { checks: Array<{ id: string; ok: boolean; detail: string }> }, id: string) => v.checks.find((c) => c.id === id);
const RAW_COLOUR_RE = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:red|white|black|blue)\b/i;
/** A raw colour literal (a DS token NAME such as --color-ramp-black-100 is not one). */
const RAW_COLOUR = { test: (v: string) => RAW_COLOUR_RE.test(v.replace(/var\([^)]*\)/g, '')) };
const colours = (v: { colours?: unknown[] }) => (v.colours ?? []) as Array<Record<string, any>>;

describe('exact equivalent under a different token name', () => {
  it('maps the reference colour to the DS token that has the SAME value, whatever the reference called it', async () => {
    const v = await verify(await makeWorld(), 'exact', { properties: ['border'] });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toMatch(/^1px solid var\(--[a-z0-9-]+\)$/);
    expect(RAW_COLOUR.test(v.applied.border!)).toBe(false);
    expect(v.applied.border).toBe('1px solid var(--border-card)'); // a card: the DS's own card border, not a lookalike
    expect(v.classification).toBe('approved-project-pattern');
    expect(check(v, 'colours-mapped')?.ok).toBe(true);
    const c = colours(v)[0]!;
    expect(c).toMatchObject({ outcome: 'exact', dsToken: '--border-card', referenceToken: '--soft-edge', role: 'border', theme: 'light', property: 'border' });
    expect(c.referenceResolved).toMatch(/rgba\(0,\s*0,\s*0,\s*\.08\)|rgba\(0, 0, 0, 0\.08\)/);
    expect(c.distance.deltaE).toBe(0);
    expect(c.dsValue).toBe('rgba(0, 0, 0, 0.08)');
    expect(c.reason).toMatch(/exact/i);
    expect(c.verification.designTime).toMatchObject({ polarityOk: true, strengthOk: true });
    expect(c.verification.rendered.status).toBe('not-run');
  });

  it('follows the reference project\'s own var() chain to the actual colour first (alias -> alias -> rgba)', async () => {
    const v = await verify(await makeWorld(), 'chain', { properties: ['border'] });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toBe('1px solid var(--border-card)');
    expect(colours(v)[0]!.referenceChain).toEqual(expect.arrayContaining(['--alias', '--soft-edge']));
  });

  it('an exact PRIMITIVE beats a nearest semantic token (the user: "if an exact equivalent exists, use it"), recorded as exact + primitive', async () => {
    const v = await verify(await makeWorld(), 'primitive', { properties: ['border'] });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    const c = colours(v)[0]!;
    expect(c).toMatchObject({ outcome: 'exact', tier: 'primitive', referenceToken: '--faq-border' });
    expect(['--color-ramp-black-100', '--color-ramp-white-800']).toContain(c.dsToken);
    expect(v.applied.border).toBe(`1px solid var(${c.dsToken})`);
    expect(RAW_COLOUR.test(v.applied.border!)).toBe(false);
  });
});

describe('the token NAME never decides equivalence', () => {
  it('a reference token that shares a DS name but not its value is mapped by VALUE, with the collision recorded', async () => {
    const v = await verify(await makeWorld(), 'collide', { properties: ['border'] });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).not.toContain('var(--border-strong)'); // the DS's --border-strong is .18, not the reference's .15
    expect(v.applied.border).toBe('1px solid var(--border-input)');
    expect(colours(v)[0]).toMatchObject({ outcome: 'exact', dsToken: '--border-input', sameName: false, nameCollision: { referenceValue: 'rgba(0,0,0,.15)', dsValue: 'rgba(0, 0, 0, 0.18)' } });
  });

  it('the same name AND the same value keeps the DS token by name', async () => {
    const v = await verify(await makeWorld(), 'sameval', { properties: ['border'] });
    expect(v.applied.border).toBe('1px solid var(--border-soft)');
    expect(colours(v)[0]).toMatchObject({ outcome: 'exact', dsToken: '--border-soft', sameName: true, nameCollision: null });
    expect(v.classification).toBe('approved-project-pattern');
  });
});

describe('nearest suitable DS token when no exact match exists', () => {
  it('chooses by role, polarity, strength and visibility - not by distance alone - and records why', async () => {
    const v = await verify(await makeWorld(), 'nearest', { properties: ['border'] });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    // black 6% has no exact token; .05 and .07 are equally close, the not-weaker .07 keeps the separation visible
    expect(v.applied.border).toBe('1px solid var(--semantic-hairline-faint)');
    expect(v.classification).toBe('proposed-local-variant'); // a nearest match is a proposal, never "used as found"
    const c = colours(v)[0]!;
    expect(c).toMatchObject({ outcome: 'nearest', dsToken: '--semantic-hairline-faint', tier: 'semantic' });
    expect(c.distance.deltaE).toBeGreaterThan(0);
    expect(c.distance.deltaE).toBeLessThanOrEqual(2);
    expect(c.rejected.map((r: { token: string }) => r.token)).toContain('--border-hairline');
    expect(c.reason).toMatch(/nearest/i);
    expect(v.reasons.join(' ')).toMatch(/proposed local variant/);
  });

  it('never picks a component token (table / status / glass) or a heavier border to satisfy a generic card border', async () => {
    const v = await verify(await makeWorld(), 'nearest', { properties: ['border'] });
    const tried = colours(v)[0]!.rejected.map((r: { token: string }) => r.token).concat(colours(v)[0]!.dsToken);
    for (const t of tried) expect(t).not.toMatch(/^--(?:table|glass|semantic-status)/);
  });
});

describe('dark surface and alpha handling', () => {
  it('white 14% on a dark surface maps to an on-dark token (never a black-alpha one)', async () => {
    const v = await verify(await makeWorld(), 'ondark', { surface: 'dark', properties: ['border'] });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    const c = colours(v)[0]!;
    expect(c).toMatchObject({ outcome: 'nearest', theme: 'dark', role: 'border' });
    expect(c.dsValue).toMatch(/rgba\(255, 255, 255,/);
    expect(v.applied.border).toMatch(/^1px solid var\(--[a-z0-9-]+\)$/);
    expect(c.backdrops.length).toBeGreaterThan(0);
  });

  it('a black 8% hairline on a dark surface is invisible there: refused, with the reason and no applied value', async () => {
    const v = await verify(await makeWorld(), 'blackdark', { surface: 'dark', properties: ['border'] });
    expect(v.ok).toBe(false);
    expect(v.applied).toEqual({});
    expect(check(v, 'colours-mapped')?.ok).toBe(false);
    expect(check(v, 'colours-mapped')?.detail).toMatch(/not visible on this surface/);
    expect(colours(v)[0]).toMatchObject({ outcome: 'unmapped', dsToken: null });
  });

  it('an alpha colour is never mapped to an opaque token', async () => {
    const v = await verify(await makeWorld(), 'exact', { properties: ['border'] });
    expect(colours(v)[0]!.dsValue).toMatch(/rgba/);
  });

  it('an OPAQUE reference may take an alpha token only on a MEASURED solid backdrop (and within 1 delta-E)', async () => {
    const w = await makeWorld();
    const measured = await verify(w, 'opaque', { properties: ['border'], colour: { backdrops: ['rgb(255, 255, 255)'], backdropSource: 'measured' } });
    expect(measured.ok, measured.reasons.join(' | ')).toBe(true);
    expect(measured.applied.border).toBe('1px solid var(--semantic-hairline-faint)');
    expect(colours(measured)[0]).toMatchObject({ outcome: 'nearest', backdropSource: 'measured' });
    const unmeasured = await verify(w, 'opaque', { properties: ['border'] });
    expect(unmeasured.ok).toBe(false);
    expect(check(unmeasured, 'colours-mapped')?.detail).toMatch(/opaque|alpha|measured/i);
  });

  it('alpha 0 is the keyword transparent: no token is needed', async () => {
    const v = await verify(await makeWorld(), 'transparent', { properties: ['border'] });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied.border).toBe('1px solid transparent');
  });
});

describe('no safe match stays unresolved', () => {
  it('a colour no DS token approximates is refused with the closest rejected token and the constraint that failed', async () => {
    const v = await verify(await makeWorld(), 'odd', { properties: ['border'] });
    expect(v.ok).toBe(false);
    expect(v.classification).toBeNull();
    expect(v.applied).toEqual({});
    expect(check(v, 'colours-mapped')?.ok).toBe(false);
    const detail = check(v, 'colours-mapped')!.detail;
    expect(detail).toMatch(/255,\s*0,\s*170/);
    expect(detail).toMatch(/no DS border token/i);
    expect(detail).toMatch(/closest/i);
    expect(colours(v)[0]).toMatchObject({ outcome: 'unmapped', dsToken: null, dsValue: null });
    expect(colours(v)[0]!.rejected.length).toBeGreaterThan(0);
    expect(toReferenceProvenance(v)).toBeNull();
  });

  it('is unresolved when the DS carries no colour values at all (a lookup-only double): never a silent pass', async () => {
    const lookupOnly: DsTokenLookup = { lookup: (token) => [{ token, value: 'ds', scope: null, file: 'tokens.css' }] };
    const v = await verify(await makeWorld(), 'exact', { properties: ['border'] }, lookupOnly);
    expect(v.ok).toBe(false);
    expect(check(v, 'colours-mapped')?.detail).toMatch(/DS colour values/i);
    expect(v.applied).toEqual({});
  });
});

describe('a raw reference colour cannot bypass the mapping', () => {
  it.each(['lit', 'named', 'odd', 'mixed', 'grad', 'blackdark'])('%s: refused, or applied with no raw colour literal at all', async (id) => {
    const w = await makeWorld();
    const v = await verify(w, id, { surface: id === 'blackdark' ? 'dark' : 'light' });
    if (v.ok) for (const value of Object.values(v.applied)) expect(RAW_COLOUR.test(value), `${id}: ${value}`).toBe(false);
    else expect(v.applied).toEqual({});
    expect(v.hardcoded.join(' ')).not.toMatch(/proposed local variant: .*#cccccc/);
  });

  it('a hardcoded hex that has no DS token is not "accepted as a proposed local variant"', async () => {
    const v = await verify(await makeWorld(), 'lit', { properties: ['border'] });
    expect(v.ok).toBe(false);
    expect(v.classification).toBeNull();
    expect(check(v, 'colours-mapped')?.detail).toMatch(/#cccccc/i);
  });

  it('every colour in every applied value of every fixture pattern is a DS var(), a keyword or absent', async () => {
    const w = await makeWorld();
    for (const id of rules) {
      for (const surface of ['light', 'dark'] as const) {
        const v = await verify(w, id, { surface });
        if (!v.ok) continue;
        for (const value of Object.values(v.applied)) expect(value, `${id}/${surface}`).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
      }
    }
  });
});

describe('all-or-nothing per declaration; unsupported expressions are never passed through', () => {
  it('one unmappable colour refuses the pattern when the need includes it; nothing is applied partially', async () => {
    const v = await verify(await makeWorld(), 'multi');
    expect(v.ok).toBe(false);
    expect(v.applied).toEqual({});
    expect(check(v, 'colours-mapped')?.detail).toMatch(/box-shadow/);
  });

  it('a declaration that cannot supply the needed property is dropped, never applied raw, and does not fail the pattern', async () => {
    const v = await verify(await makeWorld(), 'multi', { colour: { property: 'border-top-color' } });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied).toEqual({ border: '1px solid var(--border-card)' });
    expect(v.reasons.join(' ')).toMatch(/box-shadow.*not applied/);
    expect(colours(v).every((c) => c.outcome !== 'unmapped' || c.property === 'box-shadow')).toBe(true);
  });

  it('color-mix() and gradients are an unsupported colour expression', async () => {
    const mixed = await verify(await makeWorld(), 'mixed', { properties: ['border'] });
    expect(mixed.ok).toBe(false);
    expect(check(mixed, 'colours-mapped')?.detail).toMatch(/unsupported colour expression/i);
    const grad = await verify(await makeWorld(), 'grad', { properties: ['background'] });
    expect(grad.ok).toBe(false);
    expect(check(grad, 'colours-mapped')?.detail).toMatch(/unsupported colour expression/i);
  });

  it('a cyclic project token is reported, not looped over', async () => {
    const v = await verify(await makeWorld(), 'cycle', { properties: ['border'] });
    expect(v.ok).toBe(false);
    expect(v.applied).toEqual({});
  });
});

describe('box-shadow maps WHOLE layers to a DS shadow token', () => {
  it('two reference layers collapse onto --shadow-card-rest, and the dropped faint layer is flagged', async () => {
    const v = await verify(await makeWorld(), 'shadow', { properties: ['box-shadow'] });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied['box-shadow']).toBe('var(--shadow-card-rest)');
    expect(colours(v)[0]).toMatchObject({ role: 'shadow', outcome: 'nearest', dsToken: '--shadow-card-rest' });
    expect(colours(v)[0]!.reason).toMatch(/dropped|layer/i);
  });

  it('a shadow no DS shadow approximates is unmapped (the colour is never swapped inside a hand-made geometry)', async () => {
    const v = await verify(await makeWorld(), 'shadowodd', { properties: ['box-shadow'] });
    expect(v.ok).toBe(false);
    expect(check(v, 'colours-mapped')?.detail).toMatch(/box-shadow/);
    expect(v.applied).toEqual({});
  });
});

describe('state: only a state the reference actually declares is mapped, and the mapped pair stays distinguishable', () => {
  it('maps the :hover declaration of the same rule and records the state', async () => {
    const v = await verify(await makeWorld(), 'hov', { colour: { state: 'hover', property: 'border-top-color' } });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied['border-color'] ?? v.applied['border']).toBeDefined();
    expect(colours(v).some((c) => c.state === 'hover' && c.outcome === 'exact' && c.dsToken === '--border-input')).toBe(true);
  });

  it('a hover target for a rule with no :hover declaration stays unresolved: the default colour is NOT reused as a hover treatment', async () => {
    const v = await verify(await makeWorld(), 'exact', { colour: { state: 'hover', property: 'border-top-color' } });
    expect(v.ok).toBe(false);
    expect(check(v, 'colours-mapped')?.detail).toMatch(/hover/);
  });

  it('two reference states that the mapping would collapse onto one DS colour are refused', async () => {
    const v = await verify(await makeWorld(), 'hovcollapse', { colour: { state: 'hover', property: 'border-top-color' } });
    expect(v.ok).toBe(false);
    expect(check(v, 'colours-mapped')?.detail).toMatch(/collapse|indistinguishable/);
  });

  it('a reference whose hover equals its default has no state change to preserve: the pair stays as (in)distinguishable as the reference\'s', async () => {
    const v = await verify(await makeWorld(), 'hovsame', { colour: { state: 'hover', property: 'border-top-color' } });
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
  });
});

describe('provenance', () => {
  it('carries reference project/file/pattern, original colour, selected DS token, match kind, reason and verification, and parses against the schema', async () => {
    const v = await verify(await makeWorld(), 'nearest', { properties: ['border'] });
    const prov = toReferenceProvenance(v);
    expect(prov).not.toBeNull();
    expect(ReferenceProvenanceSchema.parse(JSON.parse(JSON.stringify(prov)))).toEqual(prov);
    expect(prov).toMatchObject({ project: 'competition-benchmarking-v2-react', pattern: 'nearest', file: 'src/globals.css' });
    const c = prov!.colours[0]!;
    expect(c).toMatchObject({ outcome: 'nearest', dsToken: '--semantic-hairline-faint', property: 'border', referenceToken: '--hair6' });
    expect(c.referenceValue).toBe('var(--hair6)');
    expect(c.reason.length).toBeGreaterThan(10);
    expect(c.verification.designTime.strengthOk).toBe(true);
    expect(c.verification.rendered.status).toBe('not-run');
  });

  it('an old file without the colours field still parses (defaults to none)', () => {
    const old = { project: 'p', pattern: 'x', sourcePath: '/p', file: 'a.css', fileSha256: 'a', projectHash: 'b', classification: 'approved-project-pattern', dsGrounded: true, tokens: [], renderingEvidence: 'source-only', note: null };
    expect(ReferenceProvenanceSchema.parse(old).colours).toEqual([]);
  });
});
