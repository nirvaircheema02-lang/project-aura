import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AuditProperty } from '../../src/audit-link/finding-schema.ts';
import {
  buildDsTokenIndex,
  classifyProperty,
  propertyInfo,
  resolveTokenInScope,
  scopeForSurface,
  type ClassifyContext,
  type PropertyCategory,
} from '../../src/resolution/ds-evidence.ts';

const DARK = '[data-variant="cinematic-dark"]';
const LIGHT = '[data-variant="editorial-light"]';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeDs(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ds-evidence-'));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** A DS whose only CSS is `tokens/build/tokens.css`. */
function indexOf(css: string) {
  return buildDsTokenIndex(makeDs({ 'tokens/build/tokens.css': css }));
}

// ── fixture mirroring the real layout ────────────────────────────────────────────────────────

const TOKENS_CSS = `/**
 * Do not edit directly, this file was auto-generated.
 */

:root {
  --color-foundation-black: #000000; /** Foundation black — 92% usage surface */
  --color-foundation-white: #ffffff;
  --variant-cinematic-text-secondary: rgba(250, 250, 250, 0.65); /** Secondary text on dark */
  --semantic-ink-on-dark-muted: rgba(255, 255, 255, 0.62);
  --semantic-section-bg-accent: #f5f2f1; /** Accent section background */
  --spacing-2: 0.5rem;
  --typography-font-display: 'Noto Serif', Georgia, serif;
}
`;

const BASE_CSS = `@import "./layers.css";
@import "tailwindcss";

@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
}

:root {
  --section-bg-accent: #f5f2f1;     /* warm-300 */
  --section-py: 3rem;
  --shadow-card:
    0 1px 2px rgba(0, 0, 0, 0.10),
    0 2px 6px rgba(0, 0, 0, 0.12);
  --icon-check: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'></svg>");
  --ghost-url: url(data:image/png;base64,iVBORw0KGgo=);
}

@media (min-width: 768px) {
  :root { --section-py: 5rem; }
}
`;

const CINEMATIC_DARK_CSS = `/* CINEMATIC-DARK VARIANT OVERLAY — opt-in via [data-variant="cinematic-dark"] */
@layer tokens {
  [data-variant="cinematic-dark"] {
    --surface-text-muted: var(--variant-cinematic-text-secondary, rgba(250, 250, 250, 0.65));
    --section-bg-accent: #1a1a1e;
    --dark-only: 7px;
  }

  [data-variant="cinematic-dark"] [data-variant-section="cinematic"],
  [data-variant="cinematic-dark"] [data-section="hero"] {
    --section-bg-current: var(--section-bg-mesh);
  }
}
`;

const EDITORIAL_LIGHT_CSS = `@layer tokens {
  :root,
  [data-variant="editorial-light"] {
    --surface-bg: var(--color-foundation-white, #ffffff);
    --section-bg-accent: var(--semantic-section-bg-accent, #f5f2f1);
  }

  [data-variant="editorial-light"] {
    --surface-text-muted: rgba(0, 0, 0, 0.80);
    --light-only: 3px;
  }

  [data-variant="editorial-light"] [data-variant-section="cinematic"] {
    --surface-text-muted: var(--semantic-ink-on-dark-muted, rgba(255, 255, 255, 0.62));
  }
}
`;

const LAYERS_CSS = '@layer reset, base, tokens, composition, atoms, components, recipe-overrides;\n';

function mirrorDs(): string {
  return makeDs({
    'tokens/build/tokens.css': TOKENS_CSS,
    'core-v2/src/styles/base.css': BASE_CSS,
    'core-v2/src/styles/cinematic-dark.css': CINEMATIC_DARK_CSS,
    'core-v2/src/styles/editorial-light.css': EDITORIAL_LIGHT_CSS,
    'core-v2/src/styles/layers.css': LAYERS_CSS,
  });
}

// ── buildDsTokenIndex: parsing ───────────────────────────────────────────────────────────────

describe('buildDsTokenIndex — parsing', () => {
  it('throws a clear error when the DS path does not exist, or is a file', () => {
    expect(() => buildDsTokenIndex(join(tmpdir(), 'ds-evidence-definitely-missing'))).toThrow(/does not exist.*ds-evidence-definitely-missing/);
    const root = makeDs({ 'a-file.txt': 'x' });
    expect(() => buildDsTokenIndex(join(root, 'a-file.txt'))).toThrow(/not a directory/);
  });

  it('yields an empty index for a DS folder with none of the expected files', () => {
    const index = buildDsTokenIndex(makeDs({ 'README.md': '# nothing' }));
    expect(index.all()).toEqual([]);
    expect(index.lookup('--x')).toEqual([]);
    expect(index.resolve('--x', null)).toMatchObject({ value: null, scope: null, file: null });
  });

  it('skips missing files silently and reads only what exists', () => {
    const index = buildDsTokenIndex(makeDs({ 'core-v2/src/styles/base.css': ':root { --only-base: 1px; }' }));
    expect(index.all()).toEqual([{ token: '--only-base', value: '1px', scope: null, file: 'core-v2/src/styles/base.css' }]);
  });

  it('records unscoped :root tokens with their file relative to the DS root and drops the trailing /** … */ docs', () => {
    const index = buildDsTokenIndex(mirrorDs());
    expect(index.lookup('--color-foundation-black')).toEqual([{ token: '--color-foundation-black', value: '#000000', scope: null, file: 'tokens/build/tokens.css' }]);
    expect(index.lookup('--semantic-section-bg-accent')[0]?.value).toBe('#f5f2f1');
  });

  it('is comment-aware: commented-out declarations and braces never define anything', () => {
    const index = indexOf(`
      /* --ghost: nope; */
      :root { /* --also-ghost: 1; } :root { */ --real: 1px; /** docs */ }
      /* unterminated at the end is ignored: --late-ghost: 1; `);
    expect(index.all().map((d) => d.token)).toEqual(['--real']);
  });

  it('is string-aware: comment markers, semicolons and braces inside strings stay in the value', () => {
    const index = indexOf(`:root {
      --label: "/* not a comment */";
      --semi: "a;b";
      --brace: "}";
      --single: 'it\\'s; fine';
      --after: 2px;
    }`);
    const values = Object.fromEntries(index.all().map((d) => [d.token, d.value]));
    expect(values).toEqual({
      '--label': '"/* not a comment */"',
      '--semi': '"a;b"',
      '--brace': '"}"',
      '--single': "'it\\'s; fine'",
      '--after': '2px',
    });
  });

  it('handles ";" inside url() (quoted and unquoted) and inside var() fallbacks', () => {
    const index = indexOf(`:root {
      --quoted: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'></svg>");
      --unquoted: url(data:image/png;base64,AAAA);
      --fallback: var(--nope, "a;b");
      --next: 1px;
    }`);
    const values = Object.fromEntries(index.all().map((d) => [d.token, d.value]));
    expect(values['--quoted']).toBe(`url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'></svg>")`);
    expect(values['--unquoted']).toBe('url(data:image/png;base64,AAAA)');
    expect(values['--fallback']).toBe('var(--nope, "a;b")');
    expect(values['--next']).toBe('1px');
  });

  it('collapses multi-line values, strips !important, keeps whitespace inside strings, and accepts a last declaration without ";"', () => {
    const index = indexOf(`:root {
      --shadow:
        0 1px 2px red,
        0 2px 4px blue !important;
      --font: "Foo  Bar", serif;
      --last: 9px
    }`);
    const values = Object.fromEntries(index.all().map((d) => [d.token, d.value]));
    expect(values['--shadow']).toBe('0 1px 2px red, 0 2px 4px blue');
    expect(values['--font']).toBe('"Foo  Bar", serif');
    expect(values['--last']).toBe('9px');
  });

  it('keeps a "{ … }" custom-property value and continues with the next declaration', () => {
    const index = indexOf(':root { --blob: { a: b }; --after-blob: 4px; }');
    expect(Object.fromEntries(index.all().map((d) => [d.token, d.value]))).toEqual({ '--blob': '{ a: b }', '--after-blob': '4px' });
  });

  it('skips empty values and ordinary (non custom-property) declarations', () => {
    const index = indexOf(':root { --empty: ; color: red; background: blue; --ok: 1; }');
    expect(index.all().map((d) => d.token)).toEqual(['--ok']);
  });

  it('flattens @layer / @media / @supports / @theme, ignores bodiless at-rules and @keyframes / @font-face / @property', () => {
    const index = indexOf(`
      @charset "utf-8";
      @import url("x.css");
      @layer a, b;
      @font-face { font-family: X; src: url(x.woff2); --font-face-ghost: 1; }
      @property --registered { syntax: '<length>'; inherits: false; initial-value: 0px; }
      @keyframes spin { from { --kf-ghost: 0; } to { --kf-ghost: 1; } }
      @layer tokens { :root { --in-layer: 1; } }
      @media (min-width: 40em) { :root { --in-media: 2; } }
      @supports (display: grid) { :root { --in-supports: 3; } }
      @theme { --color-tw: #123456; }
      :root { --plain: 4; }
    `);
    expect(index.all().map((d) => [d.token, d.scope])).toEqual([
      ['--in-layer', null],
      ['--in-media', null],
      ['--in-supports', null],
      ['--color-tw', null],
      ['--plain', null],
    ]);
  });

  it('keeps source order inside a file, and lists duplicates in that order', () => {
    const index = indexOf(':root { --d: 1px; --e: 5px; } :root { --d: 2px; }');
    expect(index.lookup('--d').map((d) => d.value)).toEqual(['1px', '2px']);
    expect(index.all().map((d) => `${d.token}=${d.value}`)).toEqual(['--d=1px', '--e=5px', '--d=2px']);
  });

  it('reads tokens.css first, then core-v2/src/styles/*.css alphabetically; ignores everything else', () => {
    const root = makeDs({
      'tokens/build/tokens.css': ':root { --t: 1; }',
      'core-v2/src/styles/b.css': ':root { --t: 2; }',
      'core-v2/src/styles/a.css': ':root { --t: 3; }',
      'core-v2/src/styles/_z.css': ':root { --t: 4; }',
      'core-v2/src/styles/base.css.bak': ':root { --ghost-bak: 1; }',
      'core-v2/src/styles/notes.scss': ':root { --ghost-scss: 1; }',
      'core-v2/src/styles/sub/c.css': ':root { --ghost-sub: 1; }',
      'core-v2/src/other.css': ':root { --ghost-other: 1; }',
      'tokens/build/other.css': ':root { --ghost-build: 1; }',
      'tokens/build/tokens.scss': ':root { --ghost-tokens-scss: 1; }',
    });
    const index = buildDsTokenIndex(root);
    expect(index.lookup('--t').map((d) => d.file)).toEqual([
      'tokens/build/tokens.css',
      'core-v2/src/styles/_z.css',
      'core-v2/src/styles/a.css',
      'core-v2/src/styles/b.css',
    ]);
    expect(index.all().every((d) => d.token === '--t')).toBe(true);
  });

  it('does not throw on a directory named *.css or an unreadable entry', () => {
    const root = makeDs({ 'core-v2/src/styles/ok.css': ':root { --ok: 1px; }' });
    mkdirSync(join(root, 'core-v2/src/styles/dir.css'));
    expect(buildDsTokenIndex(root).all().map((d) => d.token)).toEqual(['--ok']);
  });

  it('hands out copies: mutating a result never changes the index', () => {
    const index = indexOf(':root { --x: 1px; }');
    const first = index.lookup('--x');
    first[0]!.value = 'tampered';
    index.all()[0]!.value = 'tampered';
    expect(index.lookup('--x')[0]?.value).toBe('1px');
    expect(index.resolve('--x', null).value).toBe('1px');
  });

  describe('selector → scope', () => {
    it.each([
      [':root', null],
      ['html', null],
      ['*', null],
      [':host', null],
      ['body', null],
      [':root, [data-variant="editorial-light"]', null],
      ['[data-variant="cinematic-dark"], html', null],
      ['*, *::before, *::after', null],
      ['[data-variant="cinematic-dark"]', '[data-variant="cinematic-dark"]'],
      ['[data-variant="editorial-light"] [data-variant-section="cinematic"]', '[data-variant="editorial-light"] [data-variant-section="cinematic"]'],
      ["[data-variant='cinematic-dark']", '[data-variant="cinematic-dark"]'],
      ['[data-variant="cinematic-dark"]   [data-section="hero"]', '[data-variant="cinematic-dark"] [data-section="hero"]'],
      ['.dark\n      > .x', '.dark > .x'],
      ['[data-variant="a"],\n  [data-variant="b"]', '[data-variant="a"], [data-variant="b"]'],
      ['[data-note="a,b"]', '[data-note="a,b"]'],
      [':root[data-theme="dark"]', ':root[data-theme="dark"]'],
    ])('%j → %j', (selector, scope) => {
      const index = indexOf(`${selector} { --probe: 1; }`);
      expect(index.all()).toEqual([{ token: '--probe', value: '1', scope, file: 'tokens/build/tokens.css' }]);
    });

    it('scopes a mixed file correctly (the real cinematic-dark / editorial-light shapes)', () => {
      const index = buildDsTokenIndex(mirrorDs());
      expect(index.lookup('--surface-text-muted').map((d) => [d.scope, d.file])).toEqual([
        [DARK, 'core-v2/src/styles/cinematic-dark.css'],
        [LIGHT, 'core-v2/src/styles/editorial-light.css'],
        [`${LIGHT} [data-variant-section="cinematic"]`, 'core-v2/src/styles/editorial-light.css'],
      ]);
      // `:root, [data-variant="editorial-light"]` applies at the root: unscoped
      expect(index.lookup('--surface-bg')).toEqual([{ token: '--surface-bg', value: 'var(--color-foundation-white, #ffffff)', scope: null, file: 'core-v2/src/styles/editorial-light.css' }]);
      expect(index.lookup('--section-bg-current')[0]?.scope).toBe(`${DARK} [data-variant-section="cinematic"], ${DARK} [data-section="hero"]`);
    });

    it('composes nested rules (CSS nesting) with their parent selector', () => {
      const index = indexOf(`
        [data-variant="x"] {
          --outer: 1;
          & .child { --nested-amp: 2; }
          .plain { --nested-plain: 3; }
          @media (min-width: 40em) { --nested-media: 4; }
        }
        :root { &[data-theme="dark"] { --root-nested: 5; } }
      `);
      expect(Object.fromEntries(index.all().map((d) => [d.token, d.scope]))).toEqual({
        '--outer': '[data-variant="x"]',
        '--nested-amp': '[data-variant="x"] .child',
        '--nested-plain': '[data-variant="x"] .plain',
        '--nested-media': '[data-variant="x"]',
        '--root-nested': ':root[data-theme="dark"]',
      });
    });
  });
});

// ── DsTokenIndex.resolve ─────────────────────────────────────────────────────────────────────

describe('DsTokenIndex.resolve', () => {
  const chainIndex = indexOf(`:root {
    --a: var(--b);
    --b: var(--c, 1rem);
    --nested-fb: var(--m1, var(--m2, red));
    --composite: 0 0 0 1px var(--color-x);
    --color-x: #123;
    --calc: calc(var(--s) * 2);
    --s: 4px;
    --spaced: var( --s );
    --upper: VAR(--s);
    --font: var(--font-missing, 'A', serif);
    --nofb: var(--missing);
    --nofb-outer: var(--nofb);
    --rescued: var(--nofb, 9px);
    --not-a-var: my-var(--s);
    --quoted: "var(--s)";
  }`);

  it('follows var() chains, uses the fallback when the end of a chain is undefined, and reports the chain', () => {
    const r = chainIndex.resolve('--a', null);
    expect(r.value).toBe('1rem');
    expect(r.chain).toEqual(['--a = var(--b) [unscoped; tokens/build/tokens.css]', '--b = var(--c, 1rem) [unscoped; tokens/build/tokens.css]', '--c is not defined', '--c is not usable; using fallback 1rem']);
    expect(r).toMatchObject({ scope: null, file: 'tokens/build/tokens.css' });
  });

  it('resolves nested fallbacks, fallbacks with top-level commas, and var() inside composite values', () => {
    expect(chainIndex.resolve('--nested-fb', null).value).toBe('red');
    expect(chainIndex.resolve('--font', null).value).toBe("'A', serif");
    expect(chainIndex.resolve('--composite', null).value).toBe('0 0 0 1px #123');
    expect(chainIndex.resolve('--calc', null).value).toBe('calc(4px * 2)');
  });

  it('tolerates whitespace and case in var(), but not look-alikes or var() inside strings', () => {
    expect(chainIndex.resolve('--spaced', null).value).toBe('4px');
    expect(chainIndex.resolve('--upper', null).value).toBe('4px');
    expect(chainIndex.resolve('--not-a-var', null).value).toBe('my-var(--s)');
    expect(chainIndex.resolve('--quoted', null).value).toBe('"var(--s)"');
  });

  it('is null when a chain ends in an undefined token with no fallback — unless an outer var() has its own fallback', () => {
    const broken = chainIndex.resolve('--nofb-outer', null);
    expect(broken.value).toBeNull();
    expect(broken.chain.at(-1)).toBe('--missing is not defined');
    expect(chainIndex.resolve('--rescued', null).value).toBe('9px');
  });

  it('is null (with a chain naming the token) for an undefined token, and trims the token name', () => {
    expect(chainIndex.resolve('--nope', null)).toEqual({ value: null, chain: ['--nope is not defined'], scope: null, file: null });
    expect(chainIndex.resolve('  --s  ', null).value).toBe('4px');
  });

  it('resolves a scoped definition over the unscoped one, falls back to unscoped, and keeps var() lookups in the same scope', () => {
    const index = indexOf(`
      :root { --q: base-q; --r: base-r; --only-base: base-only; }
      [data-variant="x"] { --p: var(--q); --q: scoped-q; --uses-base: var(--r); }
    `);
    expect(index.resolve('--q', '[data-variant="x"]')).toMatchObject({ value: 'scoped-q', scope: '[data-variant="x"]' });
    expect(index.resolve('--q', null)).toMatchObject({ value: 'base-q', scope: null });
    expect(index.resolve('--p', '[data-variant="x"]').value).toBe('scoped-q');
    expect(index.resolve('--uses-base', '[data-variant="x"]').value).toBe('base-r');
    expect(index.resolve('--only-base', '[data-variant="x"]')).toMatchObject({ value: 'base-only', scope: null });
    expect(index.resolve('--q', '[data-variant="other"]')).toMatchObject({ value: 'base-q', scope: null });
  });

  it('resolves a token defined only under OTHER scopes to null with an explanatory chain', () => {
    const index = buildDsTokenIndex(mirrorDs());
    const r = index.resolve('--surface-text-muted', null);
    expect(r.value).toBeNull();
    expect(r).toMatchObject({ scope: null, file: null });
    expect(r.chain).toHaveLength(1);
    expect(r.chain[0]).toContain('defined only under other scopes');
    expect(r.chain[0]).toContain(DARK);
    expect(r.chain[0]).toContain(LIGHT);
    expect(r.chain[0]).toContain('not visible from unscoped');
    expect(index.resolve('--dark-only', LIGHT).value).toBeNull();
    expect(index.resolve('--dark-only', DARK).value).toBe('7px');
  });

  it('resolves the real dark shape: the scoped var(--token, fallback) goes through tokens.css', () => {
    const r = buildDsTokenIndex(mirrorDs()).resolve('--surface-text-muted', DARK);
    expect(r.value).toBe('rgba(250, 250, 250, 0.65)');
    expect(r).toMatchObject({ scope: DARK, file: 'core-v2/src/styles/cinematic-dark.css' });
    expect(r.chain).toEqual([
      `--surface-text-muted = var(--variant-cinematic-text-secondary, rgba(250, 250, 250, 0.65)) [${DARK}; core-v2/src/styles/cinematic-dark.css]`,
      '--variant-cinematic-text-secondary = rgba(250, 250, 250, 0.65) [unscoped; tokens/build/tokens.css]',
    ]);
  });

  it('prefers the last unconditional definition; an @media override only wins when nothing else defines the token', () => {
    const index = buildDsTokenIndex(mirrorDs());
    expect(index.lookup('--section-py').map((d) => d.value)).toEqual(['3rem', '5rem']);
    expect(index.resolve('--section-py', null).value).toBe('3rem');
    const onlyMedia = indexOf('@media (min-width: 40em) { :root { --mq: 2rem; } }');
    expect(onlyMedia.resolve('--mq', null).value).toBe('2rem');
  });

  it('lets a later definition in the same scope override an earlier one', () => {
    const index = indexOf(':root { --d: 1px; } :root { --d: 2px; }');
    expect(index.resolve('--d', null).value).toBe('2px');
  });

  describe('cycles', () => {
    const cyc = indexOf(`:root {
      --c1: var(--c2);
      --c2: var(--c1);
      --c3: var(--c1, blue);
      --c4: var(--c5, red);
      --c5: var(--c4);
      --self: var(--self);
      --self-fb: var(--self-fb, green);
    }`);

    it('never loops: a cycle resolves to null and says so', () => {
      for (const token of ['--c1', '--c2', '--self']) {
        const r = cyc.resolve(token, null);
        expect(r.value).toBeNull();
        expect(r.chain.some((line) => line.startsWith('cycle '))).toBe(true);
      }
      expect(cyc.resolve('--c1', null).chain).toContain('cycle --c1 -> --c2 -> --c1');
    });

    it('treats every token IN a cycle as invalid even with a fallback, but lets a token OUTSIDE it use its fallback', () => {
      expect(cyc.resolve('--c3', null).value).toBe('blue');
      expect(cyc.resolve('--c4', null).value).toBeNull();
      expect(cyc.resolve('--c5', null).value).toBeNull();
      expect(cyc.resolve('--self-fb', null).value).toBeNull();
    });
  });

  describe('depth limit', () => {
    const lines = ['--d0: 1px;'];
    for (let i = 1; i <= 10; i++) lines.push(`--d${i}: var(--d${i - 1});`);
    lines.push('--deep-fb: var(--d9, 2px);');
    const deep = indexOf(`:root { ${lines.join(' ')} }`);

    it('follows at most 8 var() hops', () => {
      expect(deep.resolve('--d8', null).value).toBe('1px'); // 8 hops down to --d0
      const tooDeep = deep.resolve('--d9', null);
      expect(tooDeep.value).toBeNull(); // 9 hops
      expect(tooDeep.chain.at(-1)).toContain('deeper than 8');
    });

    it('does not hide an over-deep chain behind a fallback', () => {
      expect(deep.resolve('--deep-fb', null).value).toBeNull();
    });
  });
});

// ── scopeForSurface ──────────────────────────────────────────────────────────────────────────

describe('scopeForSurface', () => {
  it('maps surfaces to the DS variant scopes', () => {
    expect(scopeForSurface('dark')).toBe('[data-variant="cinematic-dark"]');
    expect(scopeForSurface('light')).toBe('[data-variant="editorial-light"]');
    expect(scopeForSurface('unknown')).toBeNull();
  });
});

// ── propertyInfo ─────────────────────────────────────────────────────────────────────────────

describe('propertyInfo', () => {
  const categories: Array<[string, PropertyCategory]> = [
    ['width', 'dimension'], ['height', 'dimension'], ['min-width', 'dimension'], ['max-height', 'dimension'], ['inline-size', 'dimension'], ['aspect-ratio', 'dimension'],
    ['display', 'layout'], ['position', 'layout'], ['top', 'layout'], ['inset', 'layout'], ['inset-inline', 'layout'], ['float', 'layout'], ['order', 'layout'], ['z-index', 'layout'],
    ['flex', 'layout'], ['flex-direction', 'layout'], ['grid-template-columns', 'layout'], ['align-items', 'layout'], ['justify-content', 'layout'], ['place-items', 'layout'],
    ['overflow', 'layout'], ['overflow-x', 'layout'], ['text-align', 'layout'], ['transform', 'layout'], ['transform-origin', 'layout'], ['translate', 'layout'],
    ['gap', 'spacing'], ['row-gap', 'spacing'], ['column-gap', 'spacing'], ['grid-gap', 'spacing'], ['padding', 'spacing'], ['padding-inline', 'spacing'], ['margin', 'spacing'], ['margin-top', 'spacing'],
    ['font-family', 'typography'], ['font-size', 'typography'], ['font-weight', 'typography'], ['line-height', 'typography'], ['letter-spacing', 'typography'],
    ['text-transform', 'typography'], ['text-decoration', 'typography'], ['white-space', 'typography'],
    ['color', 'color'], ['background-color', 'color'], ['background', 'color'], ['border-color', 'color'], ['border-top-color', 'color'], ['outline-color', 'color'],
    ['text-decoration-color', 'color'], ['fill', 'color'], ['stroke', 'color'],
    ['border', 'shape'], ['border-width', 'shape'], ['border-radius', 'shape'], ['border-top-left-radius', 'shape'], ['outline', 'shape'],
    ['box-shadow', 'effect'], ['text-shadow', 'effect'], ['opacity', 'effect'], ['filter', 'effect'], ['transition', 'effect'], ['animation-duration', 'effect'],
    ['cursor', 'other'], ['visibility', 'other'], ['list-style-type', 'other'], ['pointer-events', 'other'], ['--brand', 'other'],
  ];
  it.each(categories)('%s → category %s', (property, category) => {
    expect(propertyInfo(property).category).toBe(category);
  });

  const protectedProperties = [
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'inline-size', 'block-size', 'aspect-ratio',
    'display', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'inset-inline-start', 'float', 'clear', 'order', 'z-index',
    'flex', 'flex-direction', 'flex-wrap', 'flex-basis', 'grid', 'grid-template-columns', 'grid-area', 'align-items', 'align-self', 'align-content',
    'justify-content', 'justify-items', 'place-items', 'place-content', 'overflow', 'overflow-x', 'overflow-y', 'text-align', 'transform', 'transform-origin', 'translate',
    'margin', 'margin-top', 'margin-inline-start',
  ];
  it.each(protectedProperties)('%s is layout-protected', (property) => {
    expect(propertyInfo(property).layoutProtected).toBe(true);
  });

  const unprotected = [
    'gap', 'row-gap', 'column-gap', 'grid-gap', 'grid-row-gap', 'grid-column-gap', 'padding', 'padding-left', 'padding-inline',
    'color', 'background-color', 'font-size', 'font-family', 'font-weight', 'line-height', 'letter-spacing', 'border-radius', 'border-color', 'box-shadow', 'opacity', 'cursor', '--margin-x',
  ];
  it.each(unprotected)('%s is not layout-protected', (property) => {
    expect(propertyInfo(property).layoutProtected).toBe(false);
  });

  const inheritable = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'text-indent',
    'white-space', 'color', 'cursor', 'visibility', 'direction', 'list-style', 'list-style-type', 'quotes', '--any-custom-property',
  ];
  it.each(inheritable)('%s is inheritable', (property) => {
    expect(propertyInfo(property).inheritable).toBe(true);
  });

  const notInheritable = ['width', 'height', 'background-color', 'border-color', 'padding', 'margin', 'gap', 'row-gap', 'display', 'box-shadow', 'opacity', 'border-radius', 'text-decoration'];
  it.each(notInheritable)('%s is not inheritable', (property) => {
    expect(propertyInfo(property).inheritable).toBe(false);
  });

  it('normalises case, whitespace and vendor prefixes', () => {
    expect(propertyInfo('  Font-Size ')).toEqual({ category: 'typography', layoutProtected: false, inheritable: true });
    expect(propertyInfo('-webkit-box-shadow').category).toBe('effect');
    expect(propertyInfo('-webkit-line-clamp').category).toBe('typography');
    expect(propertyInfo('WIDTH').layoutProtected).toBe(true);
    expect(propertyInfo('totally-unknown')).toEqual({ category: 'other', layoutProtected: false, inheritable: false });
  });

  it('width and height are dimension AND protected, but not inheritable', () => {
    for (const property of ['width', 'height']) expect(propertyInfo(property)).toEqual({ category: 'dimension', layoutProtected: true, inheritable: false });
  });
});

// ── classifyProperty ─────────────────────────────────────────────────────────────────────────

const NOTE_NO_REQUIREMENT = 'Observed value; no verified DS requirement for this property/part.';
const NOTE_LAYOUT = 'length not comparable without layout context (actual "normal", expected "0.5rem")';
const NOTE_TOKEN = 'expected token --surface-text-muted is not defined in the Design System';

function prop(overrides: Partial<AuditProperty>): AuditProperty {
  return { property: 'color', actual: 'rgb(0, 0, 0)', expected: null, expectedToken: null, source: null, status: 'UNRESOLVED', note: null, ...overrides };
}

function ctxOf(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return { findingClassification: 'DEVIATION', dsComponent: 'Button', dsVariant: 'brand', surface: 'light', ...overrides };
}

describe('classifyProperty', () => {
  describe('MATCH / DIFFERENT', () => {
    it('MATCH is audit-expected-present and not changeable', () => {
      const c = classifyProperty(prop({ property: 'font-size', status: 'MATCH', actual: '16px', expected: '16px' }), ctxOf());
      expect(c).toMatchObject({ reason: 'audit-expected-present', changeable: false, expectedFromNote: null, tokenFromNote: null });
      expect(c.rationale).toContain('already matches');
    });

    it('DIFFERENT with an expected value is changeable — the audit measured it', () => {
      const c = classifyProperty(prop({ property: 'border-radius', status: 'DIFFERENT', actual: '4px', expected: '8px', expectedToken: '--radius-md', source: 'atoms/Card.tsx' }), ctxOf());
      expect(c).toMatchObject({ reason: 'audit-expected-present', changeable: true, layoutProtected: false });
      expect(c.rationale).toContain('"8px"');
      expect(c.rationale).toContain('--radius-md');
    });

    it('DIFFERENT on a layout-protected property is still changeable, and says that it is protected', () => {
      const c = classifyProperty(prop({ property: 'width', status: 'DIFFERENT', actual: '300px', expected: '320px' }), ctxOf());
      expect(c).toMatchObject({ reason: 'audit-expected-present', changeable: true, layoutProtected: true });
      expect(c.rationale).toContain('layout-protected');
    });

    it('DIFFERENT without an expected value is classified from its note instead', () => {
      expect(classifyProperty(prop({ status: 'DIFFERENT', expected: null, note: NOTE_TOKEN }), ctxOf()).reason).toBe('variant-or-theme-context');
      expect(classifyProperty(prop({ status: 'DIFFERENT', expected: null, note: 'something odd' }), ctxOf()).reason).toBe('capture-capability-gap');
    });
  });

  describe('real note shape 1 — "no verified DS requirement"', () => {
    it.each(['font-family', 'width', 'height', 'line-height', 'font-size', 'letter-spacing', 'color', 'font-weight'])('%s → no-ds-requirement, nothing to change', (property) => {
      const c = classifyProperty(prop({ property, note: NOTE_NO_REQUIREMENT }), ctxOf());
      const info = propertyInfo(property);
      expect(c).toMatchObject({ reason: 'no-ds-requirement', changeable: false, expectedFromNote: null, tokenFromNote: null, layoutProtected: info.layoutProtected, inheritable: info.inheritable });
      expect(c.rationale).toContain('no verified DS requirement');
    });

    it('width/height are layout-protected and never become changeable from the absence of an expected value', () => {
      for (const property of ['width', 'height']) {
        const c = classifyProperty(prop({ property, actual: '240px', note: NOTE_NO_REQUIREMENT }), ctxOf({ inheritedFromParent: true }));
        expect(c).toMatchObject({ reason: 'no-ds-requirement', changeable: false, layoutProtected: true, inheritable: false });
      }
    });

    it.each(['font-family', 'line-height', 'font-size', 'letter-spacing', 'color', 'font-weight'])('%s equal to its parent → inherited-context', (property) => {
      const c = classifyProperty(prop({ property, note: NOTE_NO_REQUIREMENT }), ctxOf({ inheritedFromParent: true }));
      expect(c).toMatchObject({ reason: 'inherited-context', changeable: false, inheritable: true });
    });

    it.each([false, null, undefined])('inheritedFromParent %s → still no-ds-requirement', (inheritedFromParent) => {
      const ctx = inheritedFromParent === undefined ? ctxOf() : ctxOf({ inheritedFromParent });
      expect(classifyProperty(prop({ property: 'color', note: NOTE_NO_REQUIREMENT }), ctx).reason).toBe('no-ds-requirement');
    });

    it('names the DS component when the caller knows it', () => {
      expect(classifyProperty(prop({ note: NOTE_NO_REQUIREMENT }), ctxOf({ dsComponent: 'Button', dsVariant: 'brand' })).rationale).toContain('Button (brand)');
      expect(classifyProperty(prop({ note: NOTE_NO_REQUIREMENT }), ctxOf({ dsComponent: null, dsVariant: null })).rationale).not.toContain('DS component');
    });

    it('matches the note case-insensitively', () => {
      expect(classifyProperty(prop({ note: 'NO VERIFIED DS REQUIREMENT here' }), ctxOf()).reason).toBe('no-ds-requirement');
    });
  });

  describe('real note shape 2 — "length not comparable without layout context"', () => {
    it.each(['row-gap', 'column-gap'])('%s with a DS source → layout-measurement-required and changeable', (property) => {
      const c = classifyProperty(prop({ property, actual: 'normal', expected: null, source: 'atoms/Button.tsx', note: NOTE_LAYOUT }), ctxOf());
      expect(c).toMatchObject({
        reason: 'layout-measurement-required',
        changeable: true,
        expectedFromNote: '0.5rem',
        actualKeyword: 'normal',
        tokenFromNote: null,
        layoutProtected: false,
        inheritable: false,
      });
      expect(c.rationale).toContain('atoms/Button.tsx');
      expect(c.rationale).toContain('0.5rem');
    });

    it('the same note with source: null is not changeable — the expectation is not backed by a DS file', () => {
      const c = classifyProperty(prop({ property: 'row-gap', actual: 'normal', source: null, note: NOTE_LAYOUT }), ctxOf());
      expect(c).toMatchObject({ reason: 'layout-measurement-required', changeable: false, expectedFromNote: '0.5rem', actualKeyword: 'normal' });
      expect(c.rationale).toContain('source is null');
    });

    it('an empty expected in the note is not changeable even with a source', () => {
      const c = classifyProperty(prop({ property: 'row-gap', source: 'atoms/Button.tsx', note: 'length not comparable without layout context (actual "normal", expected "")' }), ctxOf());
      expect(c).toMatchObject({ reason: 'layout-measurement-required', changeable: false, expectedFromNote: null });
      expect(c.rationale).toContain('no expected value');
    });

    it('recognises the keyword family and leaves actualKeyword null for a real length', () => {
      const keyword = (actual: string) => classifyProperty(prop({ property: 'height', source: 'atoms/Button.tsx', note: `length not comparable without layout context (actual "${actual}", expected "40px")` }), ctxOf()).actualKeyword;
      for (const k of ['normal', 'auto', 'none', 'inherit', 'initial', 'unset', 'fit-content', 'min-content', 'max-content']) expect(keyword(k)).toBe(k);
      expect(keyword('AUTO')).toBe('auto');
      expect(keyword('12px')).toBeNull();
      expect(keyword('calc(100% - 4px)')).toBeNull();
    });

    it('height with a DS source is changeable but reported as layout-protected', () => {
      const c = classifyProperty(prop({ property: 'height', actual: 'auto', source: 'atoms/Button.tsx', note: 'length not comparable without layout context (actual "auto", expected "2.5rem")' }), ctxOf());
      expect(c).toMatchObject({ reason: 'layout-measurement-required', changeable: true, layoutProtected: true, expectedFromNote: '2.5rem', actualKeyword: 'auto' });
    });

    it('mentions the rendered display when the caller measured it', () => {
      const c = classifyProperty(prop({ property: 'row-gap', source: 'atoms/Button.tsx', note: NOTE_LAYOUT }), ctxOf({ display: 'inline-flex' }));
      expect(c.rationale).toContain('computed display: inline-flex');
    });

    it('is not shadowed by a state/responsive word elsewhere in the context', () => {
      expect(classifyProperty(prop({ property: 'row-gap', source: 'atoms/Button.tsx', note: NOTE_LAYOUT }), ctxOf({ surface: 'dark' })).reason).toBe('layout-measurement-required');
    });
  });

  describe('real note shape 3 — "expected token … is not defined in the Design System"', () => {
    it('→ variant-or-theme-context, changeable, token extracted', () => {
      const c = classifyProperty(prop({ property: 'color', actual: 'rgb(255, 255, 255)', expectedToken: '--surface-text-muted', note: NOTE_TOKEN }), ctxOf({ surface: 'dark' }));
      expect(c).toMatchObject({ reason: 'variant-or-theme-context', changeable: true, tokenFromNote: '--surface-text-muted', expectedFromNote: null, inheritable: true, layoutProtected: false });
      expect(c.rationale).toContain('--surface-text-muted');
      expect(c.rationale).toContain('dark');
    });

    it('extracts token names with digits, underscores and dashes', () => {
      const c = classifyProperty(prop({ note: 'expected token --semantic-ink-2_on-dark is not defined in the Design System' }), ctxOf());
      expect(c.tokenFromNote).toBe('--semantic-ink-2_on-dark');
    });
  });

  describe('state / responsive / unknown notes', () => {
    it.each([
      'the hover treatment was not captured',
      'depends on the focus ring',
      'differs when the control is disabled',
      'interactive state not captured',
      'only visible while active',
    ])('state: %j', (note) => {
      const c = classifyProperty(prop({ note }), ctxOf());
      expect(c).toMatchObject({ reason: 'state-context', changeable: false });
      expect(c.rationale).toContain(note);
    });

    it.each([
      'differs below the mobile breakpoint',
      'depends on the viewport width',
      'responsive rule not captured',
      'defined in a media query',
    ])('responsive: %j', (note) => {
      const c = classifyProperty(prop({ note }), ctxOf());
      expect(c).toMatchObject({ reason: 'responsive-context', changeable: false });
      expect(c.rationale).toContain(note);
    });

    it('state wins over responsive when a note names both', () => {
      expect(classifyProperty(prop({ note: 'hover state differs per viewport' }), ctxOf()).reason).toBe('state-context');
    });

    it('an unrecognised note → capture-capability-gap, quoting the note verbatim and never guessing', () => {
      const note = 'Something the tool never emitted before: weird "quoted" thing';
      const c = classifyProperty(prop({ property: 'width', note }), ctxOf());
      expect(c).toMatchObject({ reason: 'capture-capability-gap', changeable: false, layoutProtected: true });
      expect(c.rationale).toContain(`"${note}"`);
    });

    it('no note at all → capture-capability-gap with an honest rationale', () => {
      const c = classifyProperty(prop({ note: null }), ctxOf());
      expect(c).toMatchObject({ reason: 'capture-capability-gap', changeable: false });
      expect(c.rationale).toContain('no note');
    });
  });

  it('fills actualKeyword from `actual` when the note does not carry one', () => {
    expect(classifyProperty(prop({ property: 'line-height', actual: 'normal', note: NOTE_NO_REQUIREMENT }), ctxOf()).actualKeyword).toBe('normal');
    expect(classifyProperty(prop({ property: 'line-height', actual: '24px', note: NOTE_NO_REQUIREMENT }), ctxOf()).actualKeyword).toBeNull();
    expect(classifyProperty(prop({ property: 'line-height', actual: null, note: NOTE_NO_REQUIREMENT }), ctxOf()).actualKeyword).toBeNull();
  });

  it('is deterministic and does not mutate its input', () => {
    const input = Object.freeze(prop({ property: 'row-gap', actual: 'normal', source: 'atoms/Button.tsx', note: NOTE_LAYOUT }));
    const ctx = Object.freeze(ctxOf());
    expect(classifyProperty(input, ctx)).toEqual(classifyProperty(input, ctx));
  });

  it('only returns reasons that the resolution schema knows', async () => {
    const { UNRESOLVED_REASONS } = await import('../../src/resolution/schema.ts');
    const notes = [null, NOTE_NO_REQUIREMENT, NOTE_LAYOUT, NOTE_TOKEN, 'hover', 'viewport', 'unknown'];
    for (const note of notes) {
      for (const status of ['DIFFERENT', 'MATCH', 'UNRESOLVED'] as const) {
        const reason = classifyProperty(prop({ status, note, source: 'atoms/Button.tsx', expected: status === 'DIFFERENT' ? '1px' : null }), ctxOf()).reason;
        expect(UNRESOLVED_REASONS).toContain(reason);
      }
    }
  });
});

// ── resolveTokenInScope ──────────────────────────────────────────────────────────────────────

describe('resolveTokenInScope', () => {
  const index = buildDsTokenIndex(mirrorDs());

  it('dark surface → the cinematic-dark value, with the chain as evidence', () => {
    const r = resolveTokenInScope(index, '--surface-text-muted', 'dark');
    expect(r).toMatchObject({
      outcome: 'resolved-target',
      value: 'rgba(250, 250, 250, 0.65)',
      token: '--surface-text-muted',
      scope: DARK,
      file: 'core-v2/src/styles/cinematic-dark.css',
    });
    expect(r.evidence).toHaveLength(2);
    expect(r.evidence.join('\n')).toContain('--variant-cinematic-text-secondary');
    expect(r.reason).toContain('rgba(250, 250, 250, 0.65)');
  });

  it('light surface → the editorial-light scoped value', () => {
    const r = resolveTokenInScope(index, '--surface-text-muted', 'light');
    expect(r).toMatchObject({ outcome: 'resolved-target', value: 'rgba(0, 0, 0, 0.80)', scope: LIGHT, file: 'core-v2/src/styles/editorial-light.css' });
  });

  it('a token defined unscoped and in the dark scope: dark → scoped, light → unscoped (resolved through var())', () => {
    const dark = resolveTokenInScope(index, '--section-bg-accent', 'dark');
    expect(dark).toMatchObject({ outcome: 'resolved-target', value: '#1a1a1e', scope: DARK });
    const light = resolveTokenInScope(index, '--section-bg-accent', 'light');
    expect(light).toMatchObject({ outcome: 'resolved-target', value: '#f5f2f1', scope: null, file: 'core-v2/src/styles/editorial-light.css' });
    expect(light.evidence.join('\n')).toContain('--semantic-section-bg-accent');
  });

  it('a purely unscoped token resolves the same on every surface', () => {
    for (const surface of ['light', 'dark', 'unknown'] as const) {
      expect(resolveTokenInScope(index, '--spacing-2', surface)).toMatchObject({ outcome: 'resolved-target', value: '0.5rem', scope: null, file: 'tokens/build/tokens.css' });
    }
  });

  it('unknown surface, defined only under several variant scopes → unresolved, naming the scopes, never a guess', () => {
    const r = resolveTokenInScope(index, '--surface-text-muted', 'unknown');
    expect(r).toMatchObject({ outcome: 'unresolved', value: null, scope: null, file: null, token: '--surface-text-muted' });
    expect(r.reason).toContain(DARK);
    expect(r.reason).toContain(LIGHT);
    expect(r.reason).toContain('not guessed');
    expect(r.evidence.length).toBeGreaterThanOrEqual(3);
  });

  it('unknown surface, defined unscoped AND under variants → the unscoped value, with the variant values as evidence', () => {
    const r = resolveTokenInScope(index, '--section-bg-accent', 'unknown');
    expect(r).toMatchObject({ outcome: 'resolved-target', value: '#f5f2f1', scope: null });
    expect(r.evidence.join('\n')).toContain(`also #1a1a1e under ${DARK}`);
  });

  it('unknown surface with exactly one defining scope → that scope (there is nothing to guess between)', () => {
    expect(resolveTokenInScope(index, '--dark-only', 'unknown')).toMatchObject({ outcome: 'resolved-target', value: '7px', scope: DARK });
  });

  it('a token defined only under a variant that does not apply to the surface → unresolved', () => {
    const r = resolveTokenInScope(index, '--dark-only', 'light');
    expect(r).toMatchObject({ outcome: 'unresolved', value: null });
    expect(r.reason).toContain(DARK);
    expect(r.reason).toContain('light surface');
    expect(resolveTokenInScope(index, '--light-only', 'dark').outcome).toBe('unresolved');
  });

  it('an undefined token → unresolved, "token not defined anywhere in the DS"', () => {
    const r = resolveTokenInScope(index, '--does-not-exist', 'dark');
    expect(r).toMatchObject({ outcome: 'unresolved', value: null, token: '--does-not-exist', scope: null, file: null, reason: 'token not defined anywhere in the DS' });
    expect(r.evidence).toHaveLength(1);
  });

  it('a defined token whose chain cannot be resolved → unresolved with the chain as evidence', () => {
    const broken = indexOf(':root { --broken: var(--missing); --loop-a: var(--loop-b); --loop-b: var(--loop-a); }');
    const r = resolveTokenInScope(broken, '--broken', 'light');
    expect(r).toMatchObject({ outcome: 'unresolved', value: null });
    expect(r.reason).toContain('--missing is not defined');
    expect(r.evidence).toEqual(['--broken = var(--missing) [unscoped; tokens/build/tokens.css]', '--missing is not defined']);
    expect(resolveTokenInScope(broken, '--loop-a', 'dark').outcome).toBe('unresolved');
  });

  it('works with any DsTokenIndex implementation (it only needs lookup + resolve)', () => {
    const fake = {
      all: () => [],
      lookup: (token: string) => (token === '--x' ? [{ token: '--x', value: '1px', scope: null, file: 'fake.css' }] : []),
      resolve: (token: string, scope: string | null) => (token === '--x' ? { value: '1px', chain: ['--x = 1px'], scope, file: 'fake.css' } : { value: null, chain: [], scope: null, file: null }),
    };
    expect(resolveTokenInScope(fake, '--x', 'dark')).toMatchObject({ outcome: 'resolved-target', value: '1px', file: 'fake.css' });
  });
});

// ── the real Design System (read-only) ───────────────────────────────────────────────────────

const REAL_DS = '/Users/sachin/Project-aura/project_aura1-main/design-system';

describe.skipIf(!existsSync(REAL_DS))('the real Design System', () => {
  const index = buildDsTokenIndex(REAL_DS);

  it('indexes the DS CSS with scopes', () => {
    const all = index.all();
    expect(all.length).toBeGreaterThan(500);
    expect(all.some((d) => d.scope === DARK && d.file === 'core-v2/src/styles/cinematic-dark.css')).toBe(true);
    expect(all.every((d) => d.file === 'tokens/build/tokens.css' || d.file.startsWith('core-v2/src/styles/'))).toBe(true);
  });

  it('--surface-text-muted resolves for a dark surface to the cinematic-dark value', () => {
    const r = resolveTokenInScope(index, '--surface-text-muted', 'dark');
    expect(r).toMatchObject({ outcome: 'resolved-target', value: 'rgba(250, 250, 250, 0.65)', scope: DARK, file: 'core-v2/src/styles/cinematic-dark.css' });
  });

  it('--surface-text-muted is defined nowhere in the generated token file; unscoped it exists only as the default editorial-light variant', () => {
    const defs = index.lookup('--surface-text-muted');
    expect(defs.some((d) => d.file === 'tokens/build/tokens.css')).toBe(false);
    // editorial-light.css declares it under `:root, [data-variant="editorial-light"]` — i.e. at the root, the default variant
    const unscoped = defs.filter((d) => d.scope === null);
    expect(unscoped.map((d) => d.file)).toEqual(['core-v2/src/styles/editorial-light.css']);
    expect(index.resolve('--surface-text-muted', null).value).toBe('rgba(0, 0, 0, 0.80)');
  });

  it('--section-bg-accent differs between the dark scope and the unscoped base', () => {
    const dark = index.resolve('--section-bg-accent', DARK).value;
    const base = index.resolve('--section-bg-accent', null).value;
    expect(dark).toBe('#1a1a1e');
    expect(base).toBe('#f5f2f1');
    expect(dark).not.toBe(base);
  });
});
