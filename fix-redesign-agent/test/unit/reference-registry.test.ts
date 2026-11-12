import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findPatterns, readDeclarations, toReferenceProvenance, verifyPattern } from '../../src/reference/patterns.ts';
import { hashProjectSource } from '../../src/reference/project-hash.ts';
import { defaultRegistryPath, loadApprovedRegistry, ReferenceRejectedError, requireApprovedProject, resolveProject } from '../../src/reference/registry.ts';
import type { ApprovedPattern, ApprovedProject, ApprovedRegistry, DsTokenLookup, PatternQuery } from '../../src/reference/types.ts';
import { buildDsTokenIndex, type DsTokenIndex } from '../../src/resolution/ds-evidence.ts';
import { ReferenceProvenanceSchema } from '../../src/resolution/schema.ts';
import { cleanupDsFixtures, makeDsDir, miniDsIndex, REAL_DS } from '../helpers/ds-colour-fixture.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  cleanupDsFixtures();
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function put(base: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

const COMPETITION_CSS = `
:root {
  --white: #ffffff;
  --border-soft: rgba(0,0,0,.08);
  --border-default: rgba(0,0,0,.12);
  --radius-sm: 10px;
  --chain-a: var(--chain-b);
  --chain-b: 1px solid var(--chain-a);
}
.v1-card { background: var(--white); border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }
.rule-strip { border-top: 1px solid var(--border-soft); }
.lit-card { border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.fb-card { background: var(--only-fallback, rgba(255, 255, 255, 0.9)); }
.dangling { color: var(--nowhere); }
.cycle { border: var(--chain-a); }
.plain-colour { color: #333; border: 1px solid; margin: 0; }
`;

const SURVEY_CSS = `
:root {
  --pdp-card-radius: 10px;
  --pdp-card-border-rest: 1px solid rgba(0, 0, 0, 0.06);
  --pdp-card-shadow-rest: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02);
}
.pdp-card { border-radius: var(--pdp-card-radius); border: var(--pdp-card-border-rest); box-shadow: var(--pdp-card-shadow-rest); transition: all .4s; }
@media (max-width: 600px) { .pdp-card { transition: none; } }
.plain { border-radius: var(--radius-sm); border: 1px solid var(--border-soft); }
`;

function pattern(over: Partial<ApprovedPattern> & Pick<ApprovedPattern, 'id' | 'declarations' | 'source'>): ApprovedPattern {
  return {
    category: 'card-separation',
    purpose: 'light separation of a card from its section',
    description: 'a flat card with a soft hairline border',
    appliesTo: { surfaces: ['light'], viewports: ['any'], elementKinds: ['card', 'panel'] },
    whenNotToUse: 'fixture',
    ...over,
  };
}

const cssRule = (locator: string, file = 'src/globals.css') => ({ file, kind: 'css-rule' as const, locator });

function project(over: Partial<ApprovedProject> & Pick<ApprovedProject, 'name'>): ApprovedProject {
  return { relativeDir: over.name, kind: 'react-vite', inspectionUrl: null, role: 'fixture', preferredFor: [], notes: [], patterns: [], ...over };
}

interface World {
  base: string;
  root: string;
  registry: ApprovedRegistry;
  competitionDir: string;
  css: string;
}

async function makeWorld(): Promise<World> {
  const base = await tempDir('ref-world');
  const root = join(base, 'projects');
  await put(root, {
    'competition-benchmarking-v2-react/package.json': '{"name":"c"}',
    'competition-benchmarking-v2-react/src/globals.css': COMPETITION_CSS,
    'competition-benchmarking-v2-react/src/App.tsx': 'export const App = () => null;\n',
    'survey-product-detail-page/src/app/globals.css': SURVEY_CSS,
    'report-store-legacy/src/main.tsx': 'export {};\n',
    // decoys: similarly named folders next to the approved ones, and a same-named copy elsewhere
    'competition-benchmarking-v2/src/globals.css': COMPETITION_CSS,
    'report-store-legacy-copy/src/main.tsx': 'export {};\n',
    'ken-auth-redesign-v2/PROJECT.md': '# decoy\n',
    'ken-auth-redesign-copy/PROJECT.md': '# decoy\n',
  });
  await put(base, { 'elsewhere/report-store-legacy/src/main.tsx': 'export {};\n', 'elsewhere/unapproved/src/main.tsx': 'export {};\n' });

  const registry: ApprovedRegistry = {
    schemaVersion: 1,
    version: 'test.1',
    approvedBy: 'test',
    approvedOn: '2026-10-09',
    referenceProjectsRoot: root,
    projects: [
      project({
        name: 'survey-product-detail-page',
        kind: 'next',
        patterns: [
          pattern({
            id: 'survey-card',
            source: cssRule('.pdp-card', 'src/app/globals.css'),
            declarations: { 'border-radius': 'var(--pdp-card-radius)', border: 'var(--pdp-card-border-rest)', 'box-shadow': 'var(--pdp-card-shadow-rest)' },
          }),
          pattern({ id: 'survey-plain', source: cssRule('.plain', 'src/app/globals.css'), declarations: { 'border-radius': 'var(--radius-sm)', border: '1px solid var(--border-soft)' } }),
        ],
      }),
      project({ name: 'report-store-legacy', kind: 'legacy-readonly' }),
      project({ name: 'ken-auth-redesign', kind: 'docs-and-specs' }),
      project({
        name: 'competition-benchmarking-v2-react',
        preferredFor: ['card-separation', 'subtle-border'],
        patterns: [
          pattern({
            id: 'flat-card',
            source: cssRule('.v1-card'),
            declarations: { background: 'var(--white)', border: '1px solid var(--border-soft)', 'border-radius': 'var(--radius-sm)' },
          }),
          pattern({
            id: 'rule-strip',
            category: 'subtle-border',
            purpose: 'separate a row of figures with a soft hairline rule',
            description: 'top rule only',
            source: cssRule('.rule-strip'),
            declarations: { 'border-top': '1px solid var(--border-soft)' },
            appliesTo: { surfaces: ['light'], viewports: ['desktop'], elementKinds: ['row', 'section'] },
          }),
          pattern({
            id: 'border-scale',
            category: 'subtle-border',
            purpose: 'hairline border colour ladder',
            description: 'black-alpha border colours',
            source: { file: 'src/globals.css', kind: 'css-tokens', locator: ':root' },
            declarations: { '--border-soft': 'rgba(0,0,0,.08)', '--border-default': 'rgba(0,0,0,.12)' },
          }),
          pattern({ id: 'literal-card', source: cssRule('.lit-card'), declarations: { 'border-radius': '10px', 'box-shadow': '0 1px 3px rgba(0,0,0,.08)' } }),
          pattern({ id: 'fallback-card', source: cssRule('.fb-card'), declarations: { background: 'var(--only-fallback, rgba(255, 255, 255, 0.9))' } }),
          pattern({ id: 'dangling-card', source: cssRule('.dangling'), declarations: { color: 'var(--nowhere)' } }),
          pattern({ id: 'cycle-card', source: cssRule('.cycle'), declarations: { border: 'var(--chain-a)' } }),
          pattern({ id: 'plain-colour', source: cssRule('.plain-colour'), declarations: { color: '#333', border: '1px solid', margin: '0' } }),
        ],
      }),
    ],
  };
  return { base, root, registry, competitionDir: join(root, 'competition-benchmarking-v2-react'), css: join(root, 'competition-benchmarking-v2-react', 'src', 'globals.css') };
}

function fakeDs(tokens: Record<string, string | null>): DsTokenLookup {
  return {
    lookup(token) {
      if (!Object.hasOwn(tokens, token)) return [];
      return [{ token, value: 'ds', scope: tokens[token] ?? null, file: 'tokens.css' }];
    },
  };
}
const allDsTokens: DsTokenLookup = { lookup: (token) => [{ token, value: 'ds', scope: null, file: 'tokens.css' }] };

/** A DS token index with exactly these declarations in its base `:root` (and optionally a scoped block): colours are mapped by VALUE, so the tests need real values. */
const dsOf = (root: string, scoped = ''): DsTokenIndex => buildDsTokenIndex(makeDsDir({ 'tokens/build/tokens.css': `:root { ${root} }`, ...(scoped ? { 'core-v2/src/styles/cinematic-dark.css': scoped } : {}) }));

const baseQuery: PatternQuery = {
  category: 'card-separation',
  purpose: 'subtle separation between a section and its cards',
  surface: 'light',
  viewport: 'any',
  elementKinds: ['card'],
  properties: ['border', 'border-radius'],
};

const check = (v: { checks: Array<{ id: string; ok: boolean; detail: string }> }, id: string) => {
  const found = v.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

function withUrl(registry: ApprovedRegistry, name: string, inspectionUrl: string | null): ApprovedRegistry {
  return { ...registry, projects: registry.projects.map((p) => (p.name === name ? { ...p, inspectionUrl } : p)) };
}

// ── project hash ─────────────────────────────────────────────────────────────────────────────

describe('hashProjectSource', () => {
  const baseFiles = { 'src/a.ts': 'export const a = 1;\n', 'src/b.css': '.b { color: red }\n', 'README.md': '# hi\n', 'package.json': '{}' };

  it('is stable across calls and counts the hashed files', async () => {
    const dir = await tempDir('hash');
    await put(dir, baseFiles);
    const first = await hashProjectSource(dir);
    const second = await hashProjectSource(dir);
    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.fileCount).toBe(4);
  });

  it('does not depend on where the tree lives', async () => {
    const a = await tempDir('hash-a');
    const b = await tempDir('hash-b');
    await put(a, baseFiles);
    await put(b, baseFiles);
    expect((await hashProjectSource(a)).hash).toBe((await hashProjectSource(b)).hash);
  });

  it('changes when a source file changes, is added, or is renamed', async () => {
    const dir = await tempDir('hash');
    await put(dir, baseFiles);
    const before = (await hashProjectSource(dir)).hash;
    await writeFile(join(dir, 'src/a.ts'), 'export const a = 2;\n');
    const edited = (await hashProjectSource(dir)).hash;
    expect(edited).not.toBe(before);
    await writeFile(join(dir, 'src/c.tsx'), 'export {};\n');
    const added = await hashProjectSource(dir);
    expect(added.hash).not.toBe(edited);
    expect(added.fileCount).toBe(5);
    await rm(join(dir, 'src/c.tsx'));
    await writeFile(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    expect((await hashProjectSource(dir)).hash).toBe(before);
    await rm(join(dir, 'src/a.ts'));
    await writeFile(join(dir, 'src/a2.ts'), 'export const a = 1;\n');
    expect((await hashProjectSource(dir)).hash).not.toBe(before);
  });

  it('ignores node_modules, .git, dist, build, .next, lockfiles, tsbuildinfo, .DS_Store and non-source files', async () => {
    const dir = await tempDir('hash');
    await put(dir, baseFiles);
    const before = await hashProjectSource(dir);
    await put(dir, {
      'node_modules/pkg/index.js': 'x',
      'nested/node_modules/pkg/index.ts': 'x',
      '.git/config': 'x',
      '.git/hooks/pre-commit.json': '{}',
      'dist/app.js': 'x',
      'build/app.css': 'x',
      '.next/server.js': 'x',
      '.turbo/log.json': '{}',
      'coverage/index.html': '<html>',
      'package-lock.json': '{"v":1}',
      'pnpm-lock.yaml': 'lock: 1',
      'yarn.lock': 'lock',
      'tsconfig.tsbuildinfo': '{}',
      '.DS_Store': 'bin',
      'src/logo.png': 'bin',
      'notes.txt': 'plain text',
    });
    expect(await hashProjectSource(dir)).toEqual(before);
    await writeFile(join(dir, 'node_modules/pkg/index.js'), 'changed');
    await writeFile(join(dir, 'package-lock.json'), '{"v":2}');
    expect(await hashProjectSource(dir)).toEqual(before);
  });

  it('includes .ts .tsx .js .jsx .mjs .css .scss .html .json .md', async () => {
    const dir = await tempDir('hash');
    await put(dir, { 'a.ts': '1', 'a.tsx': '1', 'a.js': '1', 'a.jsx': '1', 'a.mjs': '1', 'a.css': '1', 'a.scss': '1', 'a.html': '1', 'a.json': '1', 'a.md': '1', 'a.cjs': '1' });
    expect((await hashProjectSource(dir)).fileCount).toBe(10);
  });

  it('does not follow a symlink that leaves the project, and still counts one that stays inside', async () => {
    const outside = await tempDir('hash-outside');
    await writeFile(join(outside, 'secret.json'), '{"s":1}');
    const dir = await tempDir('hash');
    await put(dir, baseFiles);
    const before = await hashProjectSource(dir);
    await symlink(join(outside, 'secret.json'), join(dir, 'link-out.json'));
    await symlink(outside, join(dir, 'link-dir'));
    expect(await hashProjectSource(dir)).toEqual(before);
    await symlink(join(dir, 'src/a.ts'), join(dir, 'link-in.ts'));
    const withInside = await hashProjectSource(dir);
    expect(withInside.fileCount).toBe(before.fileCount + 1);
    expect(withInside.hash).not.toBe(before.hash);
  });

  it('refuses to truncate when the file cap is exceeded', async () => {
    const dir = await tempDir('hash');
    await put(dir, { '1.ts': '1', '2.ts': '2', '3.ts': '3', '4.ts': '4', '5.ts': '5' });
    await expect(hashProjectSource(dir, { maxFiles: 3 })).rejects.toThrow(/more than 3 source files/);
    expect((await hashProjectSource(dir, { maxFiles: 5 })).fileCount).toBe(5);
  });

  it('an empty project hashes to a stable value with fileCount 0', async () => {
    const dir = await tempDir('hash');
    expect(await hashProjectSource(dir)).toEqual({ hash: createHash('sha256').update('').digest('hex'), fileCount: 0 });
  });
});

// ── registry loading ─────────────────────────────────────────────────────────────────────────

describe('loadApprovedRegistry', () => {
  async function writeRegistry(mutate: (r: ApprovedRegistry) => unknown): Promise<string> {
    const w = await makeWorld();
    const file = join(w.base, 'registry.json');
    await writeFile(file, JSON.stringify(mutate(structuredClone(w.registry))));
    return file;
  }

  it('loads a valid registry and reports the sha256 of the file bytes', async () => {
    const file = await writeRegistry((r) => r);
    const { registry, sha256 } = await loadApprovedRegistry(file);
    expect(registry.projects.map((p) => p.name)).toContain('competition-benchmarking-v2-react');
    expect(sha256).toBe(createHash('sha256').update(await readFile(file)).digest('hex'));
  });

  it('names the failing field for a schema error', async () => {
    const file = await writeRegistry((r) => {
      (r.projects[0] as unknown as { kind: string }).kind = 'wordpress';
      return r;
    });
    await expect(loadApprovedRegistry(file)).rejects.toThrow(/projects\.0\.kind/);
    const missing = await writeRegistry((r) => ({ ...r, version: undefined }));
    await expect(loadApprovedRegistry(missing)).rejects.toThrow(/version/);
  });

  it('rejects a tag or ARIA role as a pattern element kind (a pattern fits component categories) and canonicalises aliases', async () => {
    for (const raw of ['div', 'a', 'span', 'generic', 'made-up']) {
      const file = await writeRegistry((r) => {
        r.projects[3]!.patterns[0]!.appliesTo.elementKinds = ['card', raw] as never;
        return r;
      });
      await expect(loadApprovedRegistry(file), raw).rejects.toThrow(/appliesTo\.elementKinds\.1.*"[^"]*" is not a component category/);
    }
    const aliased = await writeRegistry((r) => {
      r.projects[3]!.patterns[0]!.appliesTo.elementKinds = ['Cards', 'faq-row', 'Panel'] as never;
      return r;
    });
    expect((await loadApprovedRegistry(aliased)).registry.projects[3]!.patterns[0]!.appliesTo.elementKinds).toEqual(['card', 'accordion', 'panel']);
  });

  it('rejects invalid JSON', async () => {
    const w = await makeWorld();
    const file = join(w.base, 'bad.json');
    await writeFile(file, '{ not json');
    await expect(loadApprovedRegistry(file)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects duplicate project names', async () => {
    const file = await writeRegistry((r) => ({ ...r, projects: [...r.projects, r.projects[0]] }));
    await expect(loadApprovedRegistry(file)).rejects.toThrow(/"survey-product-detail-page" is listed more than once/);
  });

  it('rejects a relativeDir whose basename is not the project name', async () => {
    const file = await writeRegistry((r) => {
      (r.projects[1] as ApprovedProject).relativeDir = 'report-store-legacy-copy';
      return r;
    });
    await expect(loadApprovedRegistry(file)).rejects.toThrow(/relativeDir "report-store-legacy-copy" must end in the project name "report-store-legacy"/);
  });

  it('rejects a relativeDir that climbs out of the root or is absolute', async () => {
    for (const bad of ['../report-store-legacy', '/abs/report-store-legacy', 'a/../../report-store-legacy']) {
      const file = await writeRegistry((r) => {
        (r.projects[1] as ApprovedProject).relativeDir = bad;
        return r;
      });
      await expect(loadApprovedRegistry(file)).rejects.toThrow(/relativeDir/);
    }
  });

  it('rejects a relative referenceProjectsRoot, a non-localhost inspectionUrl, duplicate pattern ids and an escaping pattern file', async () => {
    await expect(loadApprovedRegistry(await writeRegistry((r) => ({ ...r, referenceProjectsRoot: 'projects' })))).rejects.toThrow(/referenceProjectsRoot/);
    await expect(
      loadApprovedRegistry(
        await writeRegistry((r) => {
          (r.projects[1] as ApprovedProject).inspectionUrl = 'https://kenresearch.com';
          return r;
        }),
      ),
    ).rejects.toThrow(/inspectionUrl/);
    await expect(
      loadApprovedRegistry(
        await writeRegistry((r) => {
          const p = r.projects[0] as ApprovedProject;
          p.patterns = [p.patterns[0] as ApprovedPattern, p.patterns[0] as ApprovedPattern];
          return r;
        }),
      ),
    ).rejects.toThrow(/"survey-card" is used twice/);
    await expect(
      loadApprovedRegistry(
        await writeRegistry((r) => {
          ((r.projects[0] as ApprovedProject).patterns[0] as ApprovedPattern).source.file = '../outside.css';
          return r;
        }),
      ),
    ).rejects.toThrow(/source\.file/);
  });

  it('defaultRegistryPath points at references/approved-projects.json in this repo', () => {
    const p = defaultRegistryPath();
    expect(p.endsWith(join('references', 'approved-projects.json'))).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});

// ── resolving projects ───────────────────────────────────────────────────────────────────────

describe('resolveProject', () => {
  it('resolves an exact approved name to its realpath with hash and file count', async () => {
    const w = await makeWorld();
    const r = await resolveProject(w.registry, 'competition-benchmarking-v2-react');
    expect(r.status).toBe('approved-available');
    expect(r.sourcePath).toBe(await realpath(w.competitionDir));
    const expected = await hashProjectSource(w.competitionDir);
    expect(r.projectHash).toBe(expected.hash);
    expect(r.fileCount).toBe(expected.fileCount);
    expect(r.fileCount).toBe(3);
    expect(r.kind).toBe('react-vite');
    expect(r.serverStatus).toBe('not-checked');
    expect(r.name).toBe('competition-benchmarking-v2-react');
  });

  it('rejects an unapproved name and lists the approved projects in the reason', async () => {
    const w = await makeWorld();
    const r = await resolveProject(w.registry, 'some-other-project');
    expect(r.status).toBe('rejected');
    expect(r.sourcePath).toBeNull();
    expect(r.projectHash).toBeNull();
    for (const p of w.registry.projects) expect(r.reason).toContain(p.name);
  });

  it('rejects similarly named references: prefix, suffix, case, whitespace — even when such a folder exists', async () => {
    const w = await makeWorld();
    for (const name of ['competition-benchmarking-v2', 'report-store-legacy-copy', 'Report-Store-Legacy', 'Competition-Benchmarking-V2-React', 'competition-benchmarking-v2-react ', ' report-store-legacy', 'survey', 'ken-auth-redesign-v2', '']) {
      const r = await resolveProject(w.registry, name);
      expect(r.status, `"${name}"`).toBe('rejected');
      expect(r.sourcePath).toBeNull();
    }
  });

  it('accepts the approved folder by path (absolute, relative, un-normalised) and rejects an unapproved copy of an approved name', async () => {
    const w = await makeWorld();
    const approvedDir = join(w.root, 'report-store-legacy');
    const real = await realpath(approvedDir);
    expect((await resolveProject(w.registry, approvedDir)).sourcePath).toBe(real);
    expect((await resolveProject(w.registry, relative(process.cwd(), approvedDir))).sourcePath).toBe(real);
    expect((await resolveProject(w.registry, `${approvedDir}/`)).sourcePath).toBe(real);
    expect((await resolveProject(w.registry, join(w.root, 'nowhere', '..', 'report-store-legacy'))).status).toBe('approved-available');

    const copy = join(w.base, 'elsewhere', 'report-store-legacy');
    const rejected = await resolveProject(w.registry, copy);
    expect(rejected.status).toBe('rejected');
    expect(rejected.sourcePath).toBeNull();
    expect(rejected.reason).toContain('report-store-legacy');
    for (const p of w.registry.projects) expect(rejected.reason).toContain(p.name);

    expect((await resolveProject(w.registry, join(w.root, 'report-store-legacy-copy'))).status).toBe('rejected');
    expect((await resolveProject(w.registry, join(w.root, 'competition-benchmarking-v2'))).status).toBe('rejected');
    expect((await resolveProject(w.registry, join(approvedDir, 'src'))).status).toBe('rejected');
    expect((await resolveProject(w.registry, w.root)).status).toBe('rejected');
    expect((await resolveProject(w.registry, '.')).status).toBe('rejected');
  });

  it('judges a path by its realpath: a symlink to an unapproved dir is rejected, a symlink to the approved folder is the approved folder', async () => {
    const w = await makeWorld();
    const toUnapproved = join(w.base, 'link-to-unapproved');
    await symlink(join(w.base, 'elsewhere', 'report-store-legacy'), toUnapproved);
    expect((await resolveProject(w.registry, toUnapproved)).status).toBe('rejected');
    // a link NAMED like an approved project but living elsewhere and pointing elsewhere
    await mkdir(join(w.base, 'links'), { recursive: true });
    const namedLink = join(w.base, 'links', 'competition-benchmarking-v2-react');
    await symlink(join(w.base, 'elsewhere', 'unapproved'), namedLink);
    expect((await resolveProject(w.registry, namedLink)).status).toBe('rejected');

    const toApproved = join(w.base, 'link-to-approved');
    await symlink(w.competitionDir, toApproved);
    const r = await resolveProject(w.registry, toApproved);
    expect(r.status).toBe('approved-available');
    expect(r.sourcePath).toBe(await realpath(w.competitionDir));
  });

  it('does not use an approved folder that has been replaced by a symlink to somewhere else', async () => {
    const w = await makeWorld();
    const approvedDir = join(w.root, 'ken-auth-redesign');
    await symlink(join(w.base, 'elsewhere', 'unapproved'), approvedDir);
    for (const ref of ['ken-auth-redesign', approvedDir]) {
      const r = await resolveProject(w.registry, ref);
      expect(r.status, ref).toBe('approved-source-missing');
      expect(r.sourcePath).toBeNull();
      expect(r.projectHash).toBeNull();
      expect(r.name).toBe('ken-auth-redesign');
    }
  });

  it('reports an approved but missing folder as approved-source-missing and never substitutes a similar folder', async () => {
    const w = await makeWorld();
    const r = await resolveProject(w.registry, 'ken-auth-redesign');
    expect(r.status).toBe('approved-source-missing');
    expect(r.sourcePath).toBeNull();
    expect(r.projectHash).toBeNull();
    expect(r.fileCount).toBe(0);
    expect(r.kind).toBe('docs-and-specs');
    expect(r.reason).toContain('ken-auth-redesign');
    expect(r.reason).toContain('nothing is substituted');
    // the same by path
    expect((await resolveProject(w.registry, join(w.root, 'ken-auth-redesign'))).status).toBe('approved-source-missing');
    // and the decoys stay rejected
    expect((await resolveProject(w.registry, join(w.root, 'ken-auth-redesign-v2'))).status).toBe('rejected');
  });

  it('honours the root override', async () => {
    const w = await makeWorld();
    const other = await tempDir('other-root');
    await put(other, { 'report-store-legacy/src/main.tsx': 'export const other = 1;\n' });
    const r = await resolveProject(w.registry, 'report-store-legacy', { root: other });
    expect(r.sourcePath).toBe(await realpath(join(other, 'report-store-legacy')));
    // the registry's own folder is then not the approved one
    expect((await resolveProject(w.registry, join(w.root, 'report-store-legacy'), { root: other })).status).toBe('rejected');
  });

  it('requireApprovedProject returns an available project and throws ReferenceRejectedError otherwise', async () => {
    const w = await makeWorld();
    const ok = await requireApprovedProject(w.registry, 'competition-benchmarking-v2-react');
    expect(ok.status).toBe('approved-available');
    expect(ok.projectHash).toMatch(/^[0-9a-f]{64}$/);
    const rejected = requireApprovedProject(w.registry, 'competition-benchmarking-v2');
    await expect(rejected).rejects.toBeInstanceOf(ReferenceRejectedError);
    await expect(rejected).rejects.toMatchObject({ resolution: { status: 'rejected' } });
    await expect(requireApprovedProject(w.registry, 'ken-auth-redesign')).rejects.toMatchObject({ name: 'ReferenceRejectedError', resolution: { status: 'approved-source-missing' } });
  });
});

describe('resolveProject: localhost inspection server', () => {
  it('is not checked unless asked, and the fetch implementation is then never called', async () => {
    const w = await makeWorld();
    const registry = withUrl(w.registry, 'competition-benchmarking-v2-react', 'http://127.0.0.1:1');
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const r = await resolveProject(registry, 'competition-benchmarking-v2-react', { fetchImpl });
    expect(r.serverStatus).toBe('not-checked');
    expect(calls).toBe(0);
  });

  it('a server that is down leaves the project approved-available, with serverStatus unreachable', async () => {
    const w = await makeWorld();
    const { url, server } = await startServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    const registry = withUrl(w.registry, 'competition-benchmarking-v2-react', url); // the port is now closed
    const r = await resolveProject(registry, 'competition-benchmarking-v2-react', { checkServer: true, serverTimeoutMs: 1000 });
    expect(r.status).toBe('approved-available');
    expect(r.serverStatus).toBe('unreachable');
    expect(r.projectHash).not.toBeNull();
  });

  it('a 2xx server is reachable; a redirect is reachable without being followed', async () => {
    const w = await makeWorld();
    const ok = await startServer((_req, res) => res.end('ok'));
    const redirect = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/never');
      res.end();
    });
    expect((await resolveProject(withUrl(w.registry, 'competition-benchmarking-v2-react', ok.url), 'competition-benchmarking-v2-react', { checkServer: true })).serverStatus).toBe('reachable');
    expect((await resolveProject(withUrl(w.registry, 'competition-benchmarking-v2-react', redirect.url), 'competition-benchmarking-v2-react', { checkServer: true })).serverStatus).toBe('reachable');
  });

  it('falls back to GET when HEAD is refused, and treats 5xx as unreachable without changing status', async () => {
    const w = await makeWorld();
    const noHead = await startServer((req, res) => {
      res.statusCode = req.method === 'HEAD' ? 405 : 200;
      res.end('ok');
    });
    const broken = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    expect((await resolveProject(withUrl(w.registry, 'competition-benchmarking-v2-react', noHead.url), 'competition-benchmarking-v2-react', { checkServer: true })).serverStatus).toBe('reachable');
    const r = await resolveProject(withUrl(w.registry, 'competition-benchmarking-v2-react', broken.url), 'competition-benchmarking-v2-react', { checkServer: true });
    expect(r.serverStatus).toBe('unreachable');
    expect(r.status).toBe('approved-available');
  });

  it('a hanging server times out as unreachable', async () => {
    const w = await makeWorld();
    const hang = await startServer(() => undefined);
    const r = await resolveProject(withUrl(w.registry, 'competition-benchmarking-v2-react', hang.url), 'competition-benchmarking-v2-react', { checkServer: true, serverTimeoutMs: 150 });
    expect(r.serverStatus).toBe('unreachable');
    expect(r.status).toBe('approved-available');
  });

  it('never contacts a non-localhost URL, and a thrown fetch is just unreachable', async () => {
    const w = await makeWorld();
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const remote = await resolveProject(withUrl(w.registry, 'competition-benchmarking-v2-react', 'https://kenresearch.com'), 'competition-benchmarking-v2-react', { checkServer: true, fetchImpl: counting });
    expect(remote.serverStatus).toBe('not-checked');
    expect(calls).toBe(0);
    const throwing = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const local = await resolveProject(withUrl(w.registry, 'competition-benchmarking-v2-react', 'http://localhost:3095'), 'competition-benchmarking-v2-react', { checkServer: true, fetchImpl: throwing });
    expect(local.serverStatus).toBe('unreachable');
    expect(local.status).toBe('approved-available');
  });

  it('is not probed for a project without a URL, nor for a missing source', async () => {
    const w = await makeWorld();
    const noUrl = await resolveProject(w.registry, 'competition-benchmarking-v2-react', { checkServer: true });
    expect(noUrl.serverStatus).toBe('not-checked');
    const missing = await resolveProject(withUrl(w.registry, 'ken-auth-redesign', 'http://localhost:3091'), 'ken-auth-redesign', { checkServer: true });
    expect(missing.status).toBe('approved-source-missing');
    expect(missing.serverStatus).toBe('not-checked');
  });
});

// ── reading declarations ─────────────────────────────────────────────────────────────────────

describe('readDeclarations', () => {
  it('reads @layer always, and @media/@supports only when their condition holds for the env; the last matching rule wins per property', () => {
    const css = `
      @layer base, components;
      .a { color: red; padding: 1px }
      @layer base { .a { margin: 0 } }
      @media (min-width: 640px) { .a { color: blue } @media (min-width: 1px) { .a { gap: 2px } } }
      @supports (display: grid) { .a { display: grid } }
      .a { padding: 2px }
      @keyframes spin { from { color: red } to { color: blue } }
      @font-face { font-family: X; src: url("a;b.woff") }
      @import url("x.css") layer(base);
    `;
    // the base reading: an @media/@supports override is not "the" value (it used to win only because it came later in the file)
    expect(readDeclarations(css, 'css-rule', '.a')).toEqual({ color: 'red', padding: '2px', margin: '0' });
    // a desktop need satisfies the width queries; @supports is about the browser, not the need, and never holds
    expect(readDeclarations(css, 'css-rule', '.a', { surface: 'light', viewportWidth: 1440 })).toEqual({ color: 'blue', padding: '2px', margin: '0', gap: '2px' });
    expect(readDeclarations(css, 'css-rule', 'from')).toBeNull();
    expect(readDeclarations(css, 'css-rule', 'to')).toBeNull();
  });

  it('matches the locator against each member of a selector list after whitespace normalisation', () => {
    const css = `
      .x,
      .y   >   .z ,   .w
         .v { gap: 4px }
      .only { color: red }
    `;
    expect(readDeclarations(css, 'css-rule', '.x')).toEqual({ gap: '4px' });
    expect(readDeclarations(css, 'css-rule', '.y > .z')).toEqual({ gap: '4px' });
    expect(readDeclarations(css, 'css-rule', '.y>.z')).toEqual({ gap: '4px' });
    expect(readDeclarations(css, 'css-rule', '.w .v')).toEqual({ gap: '4px' });
    expect(readDeclarations(css, 'css-rule', '.y')).toBeNull();
    expect(readDeclarations(css, 'css-rule', '.x, .only')).toBeNull();
    expect(readDeclarations(css, 'css-rule', '.missing')).toBeNull();
    expect(readDeclarations('.es-kpi + .es-kpi { border-left: 1px solid red }', 'css-rule', '.es-kpi+.es-kpi')).toEqual({ 'border-left': '1px solid red' });
    expect(readDeclarations('.a:nth-child(2n+1), .b[data-x~="y z"] { top: 0 }', 'css-rule', '.b[data-x~="y z"]')).toEqual({ top: '0' });
  });

  it('ignores comments, but not comment markers inside strings', () => {
    const css = `
      /* .a { color: red } */
      .a { /* c1 */ color /* c2 */ : /* c3 */ green; content: "/* keep */"; /* trailing */ }
    `;
    expect(readDeclarations(css, 'css-rule', '.a')).toEqual({ color: 'green', content: '"/* keep */"' });
  });

  it('is aware of strings and parentheses when splitting declarations and rules', () => {
    const css = `.s { content: "}"; background: url("a;b.png"); mask: url(data:image/svg+xml;utf8,<svg xmlns='x'/>); color: red }`;
    expect(readDeclarations(css, 'css-rule', '.s')).toEqual({
      content: '"}"',
      background: 'url("a;b.png")',
      mask: "url(data:image/svg+xml;utf8,<svg xmlns='x'/>)",
      color: 'red',
    });
  });

  it('collapses whitespace in values, keeps !important, lowercases property names but not custom properties', () => {
    const css = `.m { box-shadow: 0 1px 2px red,
        0 2px 4px   blue !important; COLOR: Red; --Foo: Bar }`;
    expect(readDeclarations(css, 'css-rule', '.m')).toEqual({ 'box-shadow': '0 1px 2px red, 0 2px 4px blue !important', color: 'Red', '--Foo': 'Bar' });
  });

  it('skips nested rules without losing the declarations around them', () => {
    expect(readDeclarations('.a { color: red; &:hover { color: blue } padding: 4px }', 'css-rule', '.a')).toEqual({ color: 'red', padding: '4px' });
  });

  it('css-tokens reads only custom properties from every :root block', () => {
    const css = `
      :root { --a: 1; color: red; --b: var(--a) }
      html, :root { --c: 3 }
      .x { --not-root: 1 }
      @media (min-width: 1px) { :root { --a: 2 } }
    `;
    expect(readDeclarations(css, 'css-tokens', ':root')).toEqual({ '--a': '1', '--b': 'var(--a)', '--c': '3' });
    expect(readDeclarations(css, 'css-tokens', ':root', { surface: 'light', viewportWidth: 1440 })).toEqual({ '--a': '2', '--b': 'var(--a)', '--c': '3' });
    expect(readDeclarations(css, 'css-rule', ':root')).toMatchObject({ color: 'red', '--a': '1' });
    expect(readDeclarations('.a { color: red }', 'css-tokens', ':root')).toBeNull();
    expect(readDeclarations(css, 'css-tokens', '.x')).toEqual({ '--not-root': '1' });
  });

  it('never throws on malformed CSS', () => {
    const hostile = [
      '',
      '{',
      '}',
      '}}}{{{;;;:::(((',
      '.a',
      '.a {',
      '.a { color: red',
      '.a { color: red; } } } .b { x: y }',
      '/* unterminated .a { color: red }',
      '.a { content: "unterminated; color: red }\n.b { x: y }',
      '@media',
      '@media {',
      '@media (x) { .a { color: red }',
      '.a { color: url( }',
      '.a { background: var(--x, }',
      'a:b',
      '\\',
      '.a { \\',
      '@media{'.repeat(5000),
      '{'.repeat(20000),
    ];
    for (const css of hostile) {
      expect(() => readDeclarations(css, 'css-rule', '.a')).not.toThrow();
      expect(() => readDeclarations(css, 'css-tokens', ':root')).not.toThrow();
    }
    expect(readDeclarations('.a { color: red', 'css-rule', '.a')).toEqual({ color: 'red' });
    expect(readDeclarations('.a { color: red; } } } .b { x: y }', 'css-rule', '.b')).toEqual({ x: 'y' });
    expect(readDeclarations('/* unterminated .a { color: red }', 'css-rule', '.a')).toBeNull();
  });
});

// ── finding patterns ─────────────────────────────────────────────────────────────────────────

describe('findPatterns', () => {
  it('requires the category and every requested property, and puts the preferred project first', async () => {
    const w = await makeWorld();
    const found = findPatterns(w.registry, { ...baseQuery, properties: ['border'] });
    // survey is first in the registry, competition is the preferred project for this category
    expect(found.map((f) => `${f.project}/${f.pattern.id}`)).toEqual([
      'competition-benchmarking-v2-react/cycle-card',
      'competition-benchmarking-v2-react/flat-card',
      'competition-benchmarking-v2-react/plain-colour',
      'survey-product-detail-page/survey-card',
      'survey-product-detail-page/survey-plain',
    ]);
    expect(found.slice(0, 3).every((f) => f.preferred)).toBe(true);
    expect(found.slice(3).every((f) => !f.preferred)).toBe(true);
  });

  it('a pattern missing any requested property is not a candidate', async () => {
    const w = await makeWorld();
    const ids = (props: string[]) => findPatterns(w.registry, { ...baseQuery, properties: props }).map((f) => f.pattern.id);
    expect(ids(['border', 'box-shadow'])).toEqual(['survey-card']);
    expect(ids(['border', 'border-radius', 'background'])).toEqual(['flat-card']);
    expect(ids(['border', 'margin'])).toEqual(['plain-colour']);
    expect(ids(['outline'])).toEqual([]);
  });

  it('matches property names case-insensitively, other categories separately, and everything in a category when no property is named', async () => {
    const w = await makeWorld();
    expect(findPatterns(w.registry, { ...baseQuery, properties: ['BORDER-Radius'] }).map((f) => f.pattern.id)).toContain('flat-card');
    expect(findPatterns(w.registry, { ...baseQuery, category: 'subtle-border', elementKinds: ['row'], viewport: 'desktop', properties: ['border-top'] }).map((f) => f.pattern.id)).toEqual(['rule-strip']);
    expect(findPatterns(w.registry, { ...baseQuery, category: 'subtle-border', properties: ['--border-soft'] }).map((f) => f.pattern.id)).toEqual(['border-scale']);
    expect(findPatterns(w.registry, { ...baseQuery, category: 'tabs', properties: [] })).toEqual([]);
    expect(findPatterns(w.registry, { ...baseQuery, properties: [] })).toHaveLength(8);
  });

  it('keeps registry order between preferred projects and orders by pattern id inside a project', async () => {
    const w = await makeWorld();
    const registry: ApprovedRegistry = { ...w.registry, projects: w.registry.projects.map((p) => (p.name === 'survey-product-detail-page' ? { ...p, preferredFor: ['card-separation' as const] } : p)) };
    const found = findPatterns(registry, { ...baseQuery, properties: ['border'] });
    expect(found.map((f) => `${f.project}/${f.pattern.id}`)).toEqual([
      'survey-product-detail-page/survey-card',
      'survey-product-detail-page/survey-plain',
      'competition-benchmarking-v2-react/cycle-card',
      'competition-benchmarking-v2-react/flat-card',
      'competition-benchmarking-v2-react/plain-colour',
    ]);
    expect(found.every((f) => f.preferred)).toBe(true);
  });

  it('selects by SEMANTIC kind: a card need does not get a row/section strip, a row need does, and no kind gets nothing', async () => {
    const w = await makeWorld();
    const ids = (elementKinds: string[], over: Partial<PatternQuery> = {}) => findPatterns(w.registry, { ...baseQuery, category: 'subtle-border', purpose: 'x', elementKinds, properties: [], ...over }).map((f) => f.pattern.id);
    expect(ids(['card'])).toEqual(['border-scale']);
    expect(ids(['row'], { viewport: 'desktop' })).toEqual(['rule-strip']); // rule-strip is desktop-only
    expect(ids(['row'], { viewport: 'any' })).toEqual([]); // a need for every viewport is not met by a desktop-only strip
    expect(ids([])).toEqual([]);
    expect(ids(['div'])).toEqual([]);
    expect(ids(['accordion-trigger'])).toEqual([]);
    expect(findPatterns(w.registry, { ...baseQuery, elementKinds: [], properties: [] })).toEqual([]);
  });

  it('offers only patterns that fit the surface and viewport, the same predicates the verifier applies', async () => {
    const w = await makeWorld();
    const dark = findPatterns(w.registry, { ...baseQuery, surface: 'dark', properties: [] });
    expect(dark).toEqual([]); // every fixture pattern is light-only
    const mobile = findPatterns(w.registry, { ...baseQuery, category: 'subtle-border', elementKinds: ['row'], viewport: 'mobile', properties: [] });
    expect(mobile).toEqual([]);
  });

  it('SELECTION EQUALS VERIFICATION: a pattern is offered exactly when its surface, viewport and element-kind checks would pass', async () => {
    const w = await makeWorld();
    const real = (await loadApprovedRegistry()).registry;
    const worlds = [
      { name: 'fixture', registry: w.registry, root: w.root, kindSets: [[], ['card'], ['row'], ['section'], ['input'], ['card', 'link'], ['div']], viewports: ['any', 'desktop', 'mobile'] as const },
      { name: 'shipped', registry: real, root: undefined, kindSets: [[], ['card'], ['panel'], ['accordion'], ['input'], ['div']], viewports: ['any'] as const },
    ];
    let compared = 0;
    for (const { name, registry, root, kindSets, viewports } of worlds) {
      for (const project of registry.projects) {
        for (const p of project.patterns) {
          for (const elementKinds of kindSets) {
            for (const surface of ['light', 'dark'] as const) {
              for (const viewport of viewports) {
                const query: PatternQuery = { category: p.category, purpose: p.purpose, surface, viewport, elementKinds, properties: [] };
                const offered = findPatterns(registry, query).some((f) => f.project === project.name && f.pattern.id === p.id);
                const v = await verifyPattern({ registry, projectName: project.name, patternId: p.id, query, dsTokens: allDsTokens, ...(root ? { root } : {}) });
                const applicable = ['surface-compatible', 'viewport-applicable', 'element-kind-compatible'].every((id) => check(v, id).ok);
                expect(offered, `${name} ${project.name}/${p.id} kinds=${elementKinds.join('+') || '-'} ${surface} ${viewport}`).toBe(applicable);
                compared++;
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(300);
    // ~400 verifications, each reading the source: seconds alone, tens of seconds when the suites run in parallel (the 5 s default timed out under that load)
  }, 180_000);
});

// ── verifying patterns ───────────────────────────────────────────────────────────────────────

describe('verifyPattern', () => {
  // the DS carries the values the reference's tokens have (--white, --border-soft, --radius-sm) and the rest of the real hairline/tint/shadow families
  const dsFull = miniDsIndex();

  async function run(w: World, projectName: string, patternId: string, query: Partial<PatternQuery>, ds: DsTokenLookup) {
    return verifyPattern({ registry: w.registry, projectName, patternId, query: { ...baseQuery, ...query }, dsTokens: ds });
  }

  it('passes every check and is an approved-project-pattern when every token exists in the DS', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, dsFull);
    expect(v.checks.map((c) => c.id)).toEqual([
      'project-approved',
      'source-available',
      'declarations-present',
      'purpose-matches',
      'surface-compatible',
      'viewport-applicable',
      'element-kind-compatible',
      'ds-grounded',
      'tokens-exist',
      'colours-mapped',
    ]);
    expect(v.checks.every((c) => c.ok), JSON.stringify(v.checks)).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.classification).toBe('approved-project-pattern');
    expect(v.applied).toEqual({ border: '1px solid var(--border-soft)', 'border-radius': 'var(--radius-sm)' });
    expect(v.hardcoded).toEqual([]);
    expect(v.tokens).toEqual([
      { token: '--border-soft', existsInDs: true, dsScope: null },
      { token: '--radius-sm', existsInDs: true, dsScope: null },
    ]);
    expect(v.project.status).toBe('approved-available');
    expect(v.pattern?.id).toBe('flat-card');
    const css = await readFile(w.css);
    expect(v.fileSha256).toBe(createHash('sha256').update(css).digest('hex'));
    expect(v.declarationsFound).toEqual({ border: '1px solid var(--border-soft)', 'border-radius': 'var(--radius-sm)', background: 'var(--white)' });
  });

  it('applies the whole pattern when no property is named', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { properties: [] }, dsFull);
    expect(v.classification).toBe('approved-project-pattern');
    expect(Object.keys(v.applied).sort()).toEqual(['background', 'border', 'border-radius']);
  });

  it('records the DS scope a token was found under', async () => {
    const w = await makeWorld();
    // the DS defines --border-soft only under the editorial-light scope; the card is on a light surface, so that scope is the one it is read in
    const scoped = buildDsTokenIndex(makeDsDir({ 'core-v2/src/styles/editorial-light.css': '@layer tokens { [data-variant="editorial-light"] { --border-soft: rgba(0, 0, 0, 0.08); } }', 'tokens/build/tokens.css': ':root { --radius-sm: 10px; }' }));
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, scoped);
    expect(v.tokens).toContainEqual({ token: '--border-soft', existsInDs: true, dsScope: '[data-variant="editorial-light"]' });
    expect(v.classification).toBe('approved-project-pattern');
    expect(v.colours[0]).toMatchObject({ dsToken: '--border-soft', dsScope: '[data-variant="editorial-light"]', outcome: 'exact' });
  });

  it('a DS token defined only in the OTHER scope is not a candidate on this surface: the colour is mapped by value instead, or refused', async () => {
    const w = await makeWorld();
    const darkOnly = dsOf('--radius-sm: 10px;', '@layer tokens { [data-variant="cinematic-dark"] { --border-soft: rgba(255, 255, 255, 0.10); } }');
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, darkOnly);
    expect(v.ok).toBe(false); // light surface, no light border token anywhere: nothing suitable exists
    expect(check(v, 'colours-mapped').detail).toMatch(/no DS border token|no DS border/i);
  });

  it('a project-only COLOUR token is not used by name: its value is mapped to the DS token that has it', async () => {
    const w = await makeWorld();
    const ds = dsOf('--radius-sm: 10px; --border-card: rgba(0, 0, 0, 0.08);'); // --border-soft exists only in the reference project
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, ds);
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.applied).toEqual({ border: '1px solid var(--border-card)', 'border-radius': 'var(--radius-sm)' });
    expect(v.classification).toBe('approved-project-pattern'); // an EXACT equivalent: nothing was invented
    expect(v.tokens).toContainEqual({ token: '--border-soft', existsInDs: false, dsScope: null });
    expect(v.hardcoded).toEqual([]);
    expect(check(v, 'ds-grounded').ok).toBe(true);
    expect(check(v, 'tokens-exist').ok).toBe(true);
  });

  it('a project-only LENGTH token is inlined, flagged as not DS guidance and makes the result a proposed-local-variant', async () => {
    const w = await makeWorld();
    const ds = dsOf('--border-card: rgba(0, 0, 0, 0.08); --border-soft: rgba(0, 0, 0, 0.08);'); // --radius-sm exists only in the reference project
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, ds);
    expect(v.ok).toBe(true);
    expect(v.classification).toBe('proposed-local-variant');
    expect(v.tokens).toContainEqual({ token: '--radius-sm', existsInDs: false, dsScope: null });
    expect(v.applied).toEqual({ border: '1px solid var(--border-soft)', 'border-radius': '10px' });
    expect(v.hardcoded).toHaveLength(1);
    expect(v.hardcoded[0]).toContain('--radius-sm');
    expect(v.hardcoded[0]).toContain('10px');
    expect(check(v, 'ds-grounded').ok).toBe(false);
    expect(check(v, 'ds-grounded').detail).toContain('--radius-sm');
    expect(check(v, 'tokens-exist').ok).toBe(true);
    expect(v.reasons.join(' ')).toContain('proposed local variant');
  });

  it('resolves a chain of project tokens: the colours and the shadow are mapped to DS tokens, the radius stays a flagged length', async () => {
    const w = await makeWorld();
    const v = await run(w, 'survey-product-detail-page', 'survey-card', { properties: ['border', 'box-shadow', 'border-radius'] }, dsFull);
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.classification).toBe('proposed-local-variant'); // 6% has no exact token: the nearest suitable one; the 10px radius is hardcoded
    expect(v.applied).toEqual({
      border: '1px solid var(--semantic-hairline-faint)',
      'box-shadow': 'var(--shadow-card-rest)',
      'border-radius': '10px',
    });
    expect(v.tokens.map((t) => t.token)).toEqual(['--pdp-card-border-rest', '--pdp-card-shadow-rest', '--pdp-card-radius']);
    expect(v.tokens.every((t) => !t.existsInDs)).toBe(true);
    expect(v.hardcoded).toHaveLength(1);
    expect(v.hardcoded[0]).toContain('--pdp-card-radius');
    expect(v.colours.map((c) => `${c.property}:${c.outcome}:${c.dsToken}`)).toEqual(['border:nearest:--semantic-hairline-faint', 'box-shadow:nearest:--shadow-card-rest']);
  });

  it('maps a literal colour (here a whole shadow) to a DS token and still flags a literal length as hardcoded', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'literal-card', { properties: ['border-radius', 'box-shadow'] }, dsFull);
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.classification).toBe('proposed-local-variant');
    expect(v.hardcoded).toEqual(['border-radius: 10px']);
    expect(v.applied).toEqual({ 'border-radius': '10px', 'box-shadow': 'var(--shadow-sm)' }); // 0 1px 3px rgba(0,0,0,.08) IS the DS --shadow-sm
    expect(v.colours[0]).toMatchObject({ role: 'shadow', outcome: 'exact', dsToken: '--shadow-sm' });
    expect(v.tokens).toEqual([]);
    expect(check(v, 'ds-grounded').ok).toBe(false);
    expect(check(v, 'tokens-exist').ok).toBe(true);
  });

  it('treats 0, a 1px hairline border width and keyword values as not hardcoded; a literal hex colour with no DS token is refused, not accepted as hardcoded', async () => {
    const w = await makeWorld();
    const onlyMargin = await run(w, 'competition-benchmarking-v2-react', 'plain-colour', { properties: ['margin', 'border'] }, dsFull);
    expect(onlyMargin.hardcoded).toEqual([]);
    expect(onlyMargin.classification).toBe('approved-project-pattern');
    const withColour = await run(w, 'competition-benchmarking-v2-react', 'plain-colour', { properties: ['color'] }, dsFull);
    expect(withColour.ok).toBe(false); // #333 is no DS ink colour
    expect(withColour.applied).toEqual({});
    expect(check(withColour, 'colours-mapped').detail).toContain('#333');
    expect(withColour.hardcoded).toEqual([]);
  });

  it('a var() fallback literal colour is mapped like any other colour (here: refused, no DS token is that translucent white)', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'fallback-card', { properties: ['background'] }, dsFull);
    expect(v.ok).toBe(false);
    expect(v.applied).toEqual({});
    expect(v.tokens).toEqual([{ token: '--only-fallback', existsInDs: false, dsScope: null }]);
    expect(check(v, 'colours-mapped').detail).toContain('rgba(255, 255, 255, 0.9)');
    expect(check(v, 'tokens-exist').ok).toBe(true);
    // once the DS has the token the fallback never applies
    const inDs = await run(w, 'competition-benchmarking-v2-react', 'fallback-card', { properties: ['background'] }, dsOf('--only-fallback: #123456;'));
    expect(inDs.classification).toBe('approved-project-pattern');
    // ... and then it is applied by name WITHOUT the fallback: a raw colour never rides along in `applied`
    expect(inDs.applied).toEqual({ background: 'var(--only-fallback)' });
  });

  it('a token that exists nowhere (DS, project, fallback) fails tokens-exist and the whole verification', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'dangling-card', { properties: ['color'] }, dsFull);
    expect(v.tokens).toEqual([{ token: '--nowhere', existsInDs: false, dsScope: null }]);
    expect(check(v, 'tokens-exist').ok).toBe(false);
    expect(check(v, 'tokens-exist').detail).toContain('--nowhere');
    expect(check(v, 'ds-grounded').ok).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.classification).toBeNull();
    expect(v.applied).toEqual({});
  });

  it('a cycle between project tokens is reported as unresolvable instead of looping', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'cycle-card', { properties: ['border'] }, fakeDs({}));
    expect(check(v, 'tokens-exist').ok).toBe(false);
    expect(check(v, 'tokens-exist').detail).toMatch(/cyclic/);
    expect(v.ok).toBe(false);
  });

  it('fails surface-compatible for a dark surface (and the black hairline is invisible there)', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { surface: 'dark' }, dsFull);
    expect(check(v, 'surface-compatible').ok).toBe(false);
    expect(check(v, 'surface-compatible').detail).toContain('dark');
    // a black 8% hairline also disappears on a dark surface: the colour check says so on its own
    expect(v.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['surface-compatible', 'colours-mapped']);
    expect(check(v, 'colours-mapped').detail).toMatch(/not visible on this surface/);
    expect(v.ok).toBe(false);
    expect(v.classification).toBeNull();
    expect(v.applied).toEqual({});
    expect(v.reasons.some((r) => r.startsWith('surface-compatible'))).toBe(true);
  });

  it('fails viewport-applicable for a desktop-only pattern on a mobile need, but any satisfies everything', async () => {
    const w = await makeWorld();
    const subtle: Partial<PatternQuery> = { category: 'subtle-border', purpose: 'hairline rule separating a row of figures', elementKinds: ['row'], properties: ['border-top'] };
    const mobile = await run(w, 'competition-benchmarking-v2-react', 'rule-strip', { ...subtle, viewport: 'mobile' }, dsFull);
    expect(mobile.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['viewport-applicable']);
    expect(mobile.ok).toBe(false);
    const desktop = await run(w, 'competition-benchmarking-v2-react', 'rule-strip', { ...subtle, viewport: 'desktop' }, dsFull);
    expect(desktop.ok).toBe(true);
    const wantsAll = await run(w, 'competition-benchmarking-v2-react', 'rule-strip', { ...subtle, viewport: 'any' }, dsFull);
    expect(check(wantsAll, 'viewport-applicable').ok).toBe(false);
    for (const viewport of ['any', 'desktop', 'mobile'] as const) {
      expect(check(await run(w, 'competition-benchmarking-v2-react', 'flat-card', { viewport }, dsFull), 'viewport-applicable').ok).toBe(true);
    }
  });

  it('fails purpose-matches when the words or the category differ', async () => {
    const w = await makeWorld();
    const words = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { purpose: 'keyboard navigation dropdown menu' }, dsFull);
    expect(check(words, 'purpose-matches').ok).toBe(false);
    expect(words.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['purpose-matches']);
    expect(words.ok).toBe(false);
    const category = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { category: 'tabs' }, dsFull);
    expect(check(category, 'purpose-matches').ok).toBe(false);
    expect(check(category, 'purpose-matches').detail).toContain('tabs');
    const plural = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { purpose: 'Cards, SECTIONS!' }, dsFull);
    expect(check(plural, 'purpose-matches').ok).toBe(true);
    expect(check(plural, 'purpose-matches').detail).toBe('shared terms: card, section');
  });

  it('fails element-kind-compatible for an element kind the pattern does not fit, and says what the element was classified as', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { elementKinds: ['input'], elementEvidence: { tag: 'input', role: null, productionType: 'input', summary: '<input> classified as input (high: audit type input; native input)' } }, dsFull);
    expect(v.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['element-kind-compatible']);
    expect(v.ok).toBe(false);
    expect(check(v, 'element-kind-compatible').detail).toMatch(/classified as input.*the pattern fits card, panel/);
    expect(check(await run(w, 'competition-benchmarking-v2-react', 'flat-card', { elementKinds: ['Panel'] }, dsFull), 'element-kind-compatible').ok).toBe(true);
    expect(check(await run(w, 'competition-benchmarking-v2-react', 'flat-card', { elementKinds: ['cards'] }, dsFull), 'element-kind-compatible').ok).toBe(true);
  });

  it('a tag or an ARIA role is not a component category: no kind, or a raw "div", fails closed with the reason', async () => {
    const w = await makeWorld();
    for (const elementKinds of [[], ['div'], ['a', 'generic']]) {
      const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { elementKinds }, dsFull);
      expect(v.checks.filter((c) => !c.ok).map((c) => c.id), JSON.stringify(elementKinds)).toEqual(['element-kind-compatible']);
      expect(check(v, 'element-kind-compatible').detail).toMatch(/a tag or ARIA role alone does not name a component category/);
      expect(check(v, 'element-kind-compatible').detail).toMatch(/the pattern fits card, panel/);
      expect(v.ok).toBe(false);
      expect(v.applied).toEqual({});
    }
  });

  it('records the kinds that matched in the provenance, so the run artifact shows why the pattern fit', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { elementKinds: ['card', 'link'], elementEvidence: { tag: 'a', role: null, productionType: 'card', summary: '<a> classified as card, link' } }, dsFull);
    expect(v.ok).toBe(true);
    const prov = toReferenceProvenance(v)!;
    expect(prov.elementKinds).toEqual({ matched: ['card'], inferred: ['card', 'link'], evidence: '<a> classified as card, link' });
    expect(ReferenceProvenanceSchema.parse(prov)).toEqual(prov);
  });

  it('reports declaration drift precisely when the source has changed since the registry was written', async () => {
    const w = await makeWorld();
    const before = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, dsFull);
    expect(before.ok).toBe(true);
    await writeFile(w.css, COMPETITION_CSS.replace('border: 1px solid var(--border-soft); border-radius', 'border: 2px solid var(--border-strong); border-radius'));
    const after = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, dsFull);
    const present = check(after, 'declarations-present');
    expect(present.ok).toBe(false);
    expect(present.detail).toContain('border: registry has "1px solid var(--border-soft)", source now has "2px solid var(--border-strong)"');
    expect(present.detail).not.toContain('border-radius:');
    expect(after.declarationsFound.border).toBe('2px solid var(--border-strong)');
    expect(after.fileSha256).not.toBe(before.fileSha256);
    expect(after.project.projectHash).not.toBe(before.project.projectHash);
    expect(after.ok).toBe(false);
    expect(after.classification).toBeNull();
    expect(after.applied).toEqual({});
  });

  it('fails declarations-present when the rule or one declaration has disappeared', async () => {
    const w = await makeWorld();
    await writeFile(w.css, COMPETITION_CSS.replace('border-radius: var(--radius-sm); }\n.rule-strip', '}\n.rule-strip'));
    const dropped = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, dsFull);
    expect(check(dropped, 'declarations-present').detail).toContain('border-radius: no longer declared');
    expect(dropped.ok).toBe(false);
    await writeFile(w.css, COMPETITION_CSS.replace('.v1-card {', '.v2-card {'));
    const renamed = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, dsFull);
    expect(check(renamed, 'declarations-present').detail).toContain('no rule ".v1-card"');
    expect(renamed.declarationsFound).toEqual({});
    expect(renamed.ok).toBe(false);
  });

  it('is not bothered by reformatting that does not change the declarations', async () => {
    const w = await makeWorld();
    await writeFile(w.css, COMPETITION_CSS.replace(/\.v1-card \{[^}]*\}/, '.v1-card {\n  background:var(--white);\n  border:   1px   solid var(--border-soft) ;\n  /* c */ border-radius : var(--radius-sm)\n}'));
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', {}, dsFull);
    expect(check(v, 'declarations-present').ok).toBe(true);
    expect(v.ok).toBe(true);
  });

  it('fails declarations-present when a requested property is not declared by the pattern', async () => {
    const w = await makeWorld();
    const v = await run(w, 'competition-benchmarking-v2-react', 'flat-card', { properties: ['border', 'margin'] }, dsFull);
    expect(check(v, 'declarations-present').ok).toBe(false);
    expect(check(v, 'declarations-present').detail).toContain('margin');
    expect(v.ok).toBe(false);
  });

  it('rejects an unknown project or pattern at project-approved without touching the filesystem', async () => {
    const w = await makeWorld();
    const unknownProject = await run(w, 'competition-benchmarking-v2', 'flat-card', {}, dsFull);
    expect(check(unknownProject, 'project-approved').ok).toBe(false);
    expect(unknownProject.project.status).toBe('rejected');
    expect(unknownProject.pattern).toBeNull();
    expect(unknownProject.ok).toBe(false);
    expect(unknownProject.checks).toHaveLength(10);
    // a path is not a project name here
    const asPath = await run(w, join(w.root, 'report-store-legacy'), 'flat-card', {}, dsFull);
    expect(asPath.project.status).toBe('rejected');
    const unknownPattern = await run(w, 'competition-benchmarking-v2-react', 'no-such-pattern', {}, dsFull);
    expect(check(unknownPattern, 'project-approved').ok).toBe(false);
    expect(check(unknownPattern, 'project-approved').detail).toContain('flat-card');
    expect(unknownPattern.project.status).toBe('approved-available');
    expect(unknownPattern.pattern).toBeNull();
  });

  it('fails source-available when the approved source is missing, or the pattern file is missing or escapes the project', async () => {
    const w = await makeWorld();
    const registry: ApprovedRegistry = {
      ...w.registry,
      projects: w.registry.projects.map((p) =>
        p.name === 'ken-auth-redesign'
          ? { ...p, patterns: [pattern({ id: 'x', source: cssRule('.a'), declarations: { color: 'red' } })] }
          : p.name === 'competition-benchmarking-v2-react'
            ? {
                ...p,
                patterns: [
                  pattern({ id: 'gone', source: cssRule('.a', 'src/nope.css'), declarations: { color: 'red' } }),
                  pattern({ id: 'escape', source: cssRule('.a', '../competition-benchmarking-v2/src/globals.css'), declarations: { color: 'red' } }),
                  pattern({ id: 'absolute', source: cssRule('.a', join(w.root, 'competition-benchmarking-v2/src/globals.css')), declarations: { color: 'red' } }),
                  pattern({ id: 'tsx', source: { file: 'src/App.tsx', kind: 'tsx-classes', locator: 'App' }, declarations: { color: 'red' } }),
                ],
              }
            : p,
      ),
    };
    const go = (projectName: string, patternId: string) => verifyPattern({ registry, projectName, patternId, query: { ...baseQuery, properties: ['color'] }, dsTokens: dsFull });
    const missing = await go('ken-auth-redesign', 'x');
    expect(missing.project.status).toBe('approved-source-missing');
    expect(check(missing, 'source-available').ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(check(await go('competition-benchmarking-v2-react', 'gone'), 'source-available').detail).toContain('does not exist');
    expect(check(await go('competition-benchmarking-v2-react', 'escape'), 'source-available').ok).toBe(false);
    expect(check(await go('competition-benchmarking-v2-react', 'absolute'), 'source-available').ok).toBe(false);
    const tsx = await go('competition-benchmarking-v2-react', 'tsx');
    expect(check(tsx, 'source-available').ok).toBe(true);
    expect(check(tsx, 'declarations-present').ok).toBe(false);
    expect(check(tsx, 'declarations-present').detail).toContain('tsx-classes');
  });

  it('verifies css-tokens patterns: each literal colour is mapped by value (token ladders are evidence for choosing a DS token), and a drifted value is reported', async () => {
    const w = await makeWorld();
    const q: Partial<PatternQuery> = { category: 'subtle-border', purpose: 'hairline border colour', elementKinds: ['card'], properties: ['--border-soft'] };
    const v = await run(w, 'competition-benchmarking-v2-react', 'border-scale', q, dsFull);
    expect(check(v, 'declarations-present').ok).toBe(true);
    expect(v.ok, v.reasons.join(' | ')).toBe(true);
    expect(v.classification).toBe('approved-project-pattern'); // --border-soft is the DS's --border-soft, same value
    expect(v.applied).toEqual({ '--border-soft': 'var(--border-soft)' });
    expect(v.hardcoded).toEqual([]);
    expect(v.colours[0]).toMatchObject({ property: '--border-soft', outcome: 'exact', dsToken: '--border-soft', sameName: true });
    await writeFile(w.css, COMPETITION_CSS.replace('--border-soft: rgba(0,0,0,.08);', '--border-soft: rgba(0,0,0,.05);'));
    const drifted = await run(w, 'competition-benchmarking-v2-react', 'border-scale', q, dsFull);
    expect(check(drifted, 'declarations-present').detail).toContain('registry has "rgba(0,0,0,.08)", source now has "rgba(0,0,0,.05)"');
    expect(drifted.ok).toBe(false);
  });

  it('records server reachability only when asked, and never lets it change the verdict', async () => {
    const w = await makeWorld();
    const { url } = await startServer((_req, res) => res.end('ok'));
    const registry = withUrl(w.registry, 'competition-benchmarking-v2-react', url);
    const checked = await verifyPattern({ registry, projectName: 'competition-benchmarking-v2-react', patternId: 'flat-card', query: baseQuery, dsTokens: dsFull, checkServer: true });
    expect(checked.project.serverStatus).toBe('reachable');
    expect(checked.ok).toBe(true);
    const unchecked = await verifyPattern({ registry, projectName: 'competition-benchmarking-v2-react', patternId: 'flat-card', query: baseQuery, dsTokens: dsFull });
    expect(unchecked.project.serverStatus).toBe('not-checked');
    expect(unchecked.ok).toBe(true);
  });
});

describe('toReferenceProvenance', () => {
  it('maps a verified pattern to the ReferenceProvenance schema', async () => {
    const w = await makeWorld();
    const dsFull = miniDsIndex();
    const v = await verifyPattern({ registry: w.registry, projectName: 'competition-benchmarking-v2-react', patternId: 'flat-card', query: baseQuery, dsTokens: dsFull });
    const prov = toReferenceProvenance(v);
    expect(prov).not.toBeNull();
    expect(ReferenceProvenanceSchema.parse(prov)).toEqual(prov);
    expect(prov).toMatchObject({
      project: 'competition-benchmarking-v2-react',
      pattern: 'flat-card',
      sourcePath: await realpath(w.competitionDir),
      file: 'src/globals.css',
      fileSha256: v.fileSha256,
      projectHash: v.project.projectHash,
      classification: 'approved-project-pattern',
      dsGrounded: true,
      renderingEvidence: 'source-only',
      note: null,
    });
    expect(prov?.tokens).toEqual(v.tokens);
    expect(prov?.colours).toEqual(v.colours);
    expect(prov?.colours[0]).toMatchObject({ property: 'border', outcome: 'exact', dsToken: '--border-soft' });
  });

  it('carries the proposed-local-variant classification, the DS-grounding flag, and server evidence', async () => {
    const w = await makeWorld();
    const { url } = await startServer((_req, res) => res.end('ok'));
    const registry = withUrl(w.registry, 'competition-benchmarking-v2-react', url);
    const v = await verifyPattern({ registry, projectName: 'competition-benchmarking-v2-react', patternId: 'flat-card', query: baseQuery, dsTokens: dsOf('--border-soft: rgba(0, 0, 0, 0.08); --white: #ffffff;'), checkServer: true }); // --radius-sm: reference only
    const prov = toReferenceProvenance(v);
    expect(prov?.classification).toBe('proposed-local-variant');
    expect(prov?.dsGrounded).toBe(false);
    expect(prov?.renderingEvidence).toBe('server-reachable');
    expect(prov?.note).toContain('--radius-sm');
    expect(prov?.tokens).toContainEqual({ token: '--radius-sm', existsInDs: false, dsScope: null });
  });

  it('is null for a verification that did not pass', async () => {
    const w = await makeWorld();
    const v = await verifyPattern({ registry: w.registry, projectName: 'competition-benchmarking-v2-react', patternId: 'flat-card', query: { ...baseQuery, surface: 'dark' }, dsTokens: miniDsIndex() });
    expect(v.ok).toBe(false);
    expect(toReferenceProvenance(v)).toBeNull();
  });
});

// ── the real registry ────────────────────────────────────────────────────────────────────────

const REAL_ROOT = '/Users/sachin/Project-aura/project_aura1-main/projects';
const APPROVED = ['survey-product-detail-page', 'case-study-v2', 'ken-auth-redesign', 'expert-interview-page', 'report-store-legacy', 'competition-benchmarking-v2-react'];

describe.skipIf(!existsSync(REAL_ROOT))('the real approved-projects registry', () => {
  it('lists exactly the six approved projects, with the user preference on competition-benchmarking-v2-react', async () => {
    const { registry, sha256 } = await loadApprovedRegistry();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.referenceProjectsRoot).toBe(REAL_ROOT);
    expect(registry.projects.map((p) => p.name).sort()).toEqual([...APPROVED].sort());
    const competition = registry.projects.find((p) => p.name === 'competition-benchmarking-v2-react');
    expect(competition?.preferredFor).toEqual(expect.arrayContaining(['card-separation', 'subtle-border']));
    expect(registry.projects.filter((p) => p.preferredFor.length > 0).map((p) => p.name)).toEqual(['competition-benchmarking-v2-react']);
    expect(registry.projects.find((p) => p.name === 'report-store-legacy')?.kind).toBe('legacy-readonly');
    const urls = Object.fromEntries(registry.projects.map((p) => [p.name, p.inspectionUrl]));
    expect(urls).toMatchObject({
      'survey-product-detail-page': 'http://localhost:3050',
      'case-study-v2': 'http://localhost:3060',
      'ken-auth-redesign': 'http://localhost:3091',
      'expert-interview-page': 'http://localhost:4177',
      'report-store-legacy': 'http://localhost:5183',
      'competition-benchmarking-v2-react': 'http://localhost:3095',
    });
  });

  it('resolves all six real projects as approved-available without a server check', { timeout: 60_000 }, async () => {
    const { registry } = await loadApprovedRegistry();
    for (const name of APPROVED) {
      const r = await resolveProject(registry, name);
      expect(r.status, `${name}: ${r.reason}`).toBe('approved-available');
      expect(r.sourcePath).toBe(await realpath(join(REAL_ROOT, name)));
      expect(r.projectHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.fileCount).toBeGreaterThan(0);
      expect(r.serverStatus).toBe('not-checked');
    }
  });

  it('rejects the same-named report-store-legacy under design-system-audit', async () => {
    const { registry } = await loadApprovedRegistry();
    const copy = join(REAL_ROOT, '..', 'design-system-audit', 'worked-examples', 'report-store-legacy');
    const r = await resolveProject(registry, copy);
    expect(r.status).toBe('rejected');
    expect(r.sourcePath).toBeNull();
    for (const name of APPROVED) expect(r.reason).toContain(name);
    expect((await resolveProject(registry, join(REAL_ROOT, 'report-store-legacy'))).status).toBe('approved-available');
  });

  it.skipIf(!existsSync(REAL_DS))('every curated pattern still holds in the real source, and every colour maps to a DS token of the real Design System', { timeout: 120_000 }, async () => {
    const { registry } = await loadApprovedRegistry();
    const realDs = buildDsTokenIndex(REAL_DS);
    let curated = 0;
    for (const project of registry.projects) {
      for (const p of project.patterns) {
        curated++;
        expect(['css-rule', 'css-tokens']).toContain(p.source.kind);
        expect(Object.keys(p.declarations).length).toBeGreaterThan(0);
        const v = await verifyPattern({
          registry,
          projectName: project.name,
          patternId: p.id,
          query: {
            category: p.category,
            purpose: p.purpose,
            surface: p.appliesTo.surfaces[0] ?? 'light',
            viewport: 'any',
            elementKinds: p.appliesTo.elementKinds,
            properties: Object.keys(p.declarations),
          },
          dsTokens: realDs,
        });
        const label = `${project.name}/${p.id}`;
        expect(check(v, 'project-approved').ok, label).toBe(true);
        expect(check(v, 'source-available').ok, `${label}: ${check(v, 'source-available').detail}`).toBe(true);
        expect(check(v, 'declarations-present').ok, `${label}: ${check(v, 'declarations-present').detail}`).toBe(true);
        expect(v.ok, `${label}: ${v.reasons.join(' | ')}`).toBe(true);
        for (const [prop, value] of Object.entries(p.declarations)) expect(v.declarationsFound[prop], `${label} ${prop}`).toBe(value);
        expect(toReferenceProvenance(v), label).not.toBeNull();
      }
    }
    expect(curated).toBeGreaterThan(0);
  });

  it('finds the preferred project first for card separation and subtle borders', async () => {
    const { registry } = await loadApprovedRegistry();
    const card = findPatterns(registry, { category: 'card-separation', purpose: 'light separation of cards', surface: 'light', viewport: 'any', elementKinds: ['card'], properties: ['border', 'border-radius'] });
    expect(card.length).toBeGreaterThan(1);
    expect(card[0]).toMatchObject({ project: 'competition-benchmarking-v2-react', preferred: true });
    expect(card.some((c) => !c.preferred)).toBe(true);
    const rules = findPatterns(registry, { category: 'subtle-border', purpose: 'hairline rules', surface: 'light', viewport: 'any', elementKinds: ['row'], properties: ['border-top'] });
    expect(rules[0]).toMatchObject({ project: 'competition-benchmarking-v2-react', preferred: true });
  });

  it('the registry values match the real competition-benchmarking tokens verbatim', async () => {
    const { registry } = await loadApprovedRegistry();
    const css = await readFile(join(REAL_ROOT, 'competition-benchmarking-v2-react', 'src', 'globals.css'), 'utf8');
    const tokens = readDeclarations(css, 'css-tokens', ':root');
    expect(tokens).toMatchObject({ '--border-soft': 'rgba(0,0,0,.08)', '--border-default': 'rgba(0,0,0,.12)', '--border-strong': 'rgba(0,0,0,.15)', '--border-active': 'rgba(0,0,0,.20)', '--border-on-dark': 'rgba(255,255,255,.14)' });
    const scale = registry.projects.find((p) => p.name === 'competition-benchmarking-v2-react')?.patterns.find((p) => p.id === 'hairline-border-scale');
    expect(scale?.declarations).toEqual({ '--border-soft': 'rgba(0,0,0,.08)', '--border-default': 'rgba(0,0,0,.12)', '--border-strong': 'rgba(0,0,0,.15)', '--border-active': 'rgba(0,0,0,.20)' });
  });
});
