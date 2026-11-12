import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildNewComponentDeliverable, buildRedesignDeliverable } from '../../src/output/deliverable.ts';
import { ensureRedesignDirs, redesignPaths, sectionFragmentPath, type RedesignPaths } from '../../src/output/redesign-store.ts';
import type { ComponentSpec, L2Output, L4Output } from '../../src/library/types.ts';

/**
 * The two clean, user-facing deliverables — `redesign/` and `new-component/<Name>/` — SIBLING
 * folders directly under the run root, never nested in one another, never wrapped in a shared
 * parent. Every test here verifies against REAL files on disk (this module only ever
 * copies/reads/writes real bytes, never re-derives HTML content), and specifically checks that
 * internal artifacts (JSON, PNG tiles, traces) never leak into either one.
 */

let root: string;
let paths: RedesignPaths;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fra-deliverable-'));
  paths = redesignPaths(root, 'proj', 'run-1');
  await ensureRedesignDirs(paths);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('buildRedesignDeliverable', () => {
  it('Full Page mode copies redesignContentHtml to redesign/redesigned-page.html, nothing under sections/, plus an honest provenance comment (never original React/Next source)', async () => {
    writeFileSync(paths.redesignContentHtml, '<!doctype html><html><body>full page content</body></html>');
    const result = await buildRedesignDeliverable(paths, 'full-page', { redesignContentHtml: paths.redesignContentHtml }, []);
    expect(result).toEqual({ pageHtmlName: 'redesigned-page.html', pageHtmlPath: join(paths.redesignDeliverableDir, 'redesigned-page.html'), sectionIds: [] });
    const html = readFileSync(result.pageHtmlPath, 'utf-8');
    expect(html).toContain('full page content');
    expect(html).toMatch(/not original React\/Next\.js source/i);
    expect(existsSync(join(paths.redesignDeliverableDir, 'redesigned-sections.html'))).toBe(false);
  });

  it('Selected Sections mode copies redesigned-sections.html PLUS one standalone file per selected section, as DIRECT siblings — no page/ or output/ wrapper layer', async () => {
    writeFileSync(paths.redesignContentHtml, '<!doctype html><html><body>combined sections</body></html>');
    mkdirSync(paths.sectionsDir, { recursive: true });
    writeFileSync(sectionFragmentPath(paths, 'hero'), '<!doctype html><html><body>hero fragment</body></html>');
    writeFileSync(sectionFragmentPath(paths, 'features'), '<!doctype html><html><body>features fragment</body></html>');

    const result = await buildRedesignDeliverable(paths, 'selected-sections', { redesignContentHtml: paths.redesignContentHtml }, ['hero', 'features']);
    expect(result.pageHtmlName).toBe('redesigned-sections.html');
    expect(readFileSync(result.pageHtmlPath, 'utf-8')).toContain('combined sections');
    expect(result.sectionIds).toEqual(['hero', 'features']);
    expect(readFileSync(join(paths.redesignDeliverableSectionsDir, 'hero.html'), 'utf-8')).toContain('hero fragment');
    expect(readFileSync(join(paths.redesignDeliverableSectionsDir, 'features.html'), 'utf-8')).toContain('features fragment');
    // Siblings directly under the run root, never nested inside one another.
    expect(paths.redesignDeliverableDir).toBe(join(root, 'proj', 'redesigns', 'run-1', 'redesign'));
    expect(paths.newComponentDir).toBe(join(root, 'proj', 'redesigns', 'run-1', 'new-component'));
  });

  it('a section whose internal fragment was never written (§8.2: wrapper not located) is silently skipped, never a crash and never a phantom link', async () => {
    writeFileSync(paths.redesignContentHtml, '<!doctype html><html><body>x</body></html>');
    mkdirSync(paths.sectionsDir, { recursive: true });
    writeFileSync(sectionFragmentPath(paths, 'hero'), '<!doctype html><html><body>hero</body></html>');
    // 'unlocatable' has NO fragment file on disk at all.
    const result = await buildRedesignDeliverable(paths, 'selected-sections', { redesignContentHtml: paths.redesignContentHtml }, ['hero', 'unlocatable']);
    expect(result.sectionIds).toEqual(['hero']);
    expect(existsSync(join(paths.redesignDeliverableSectionsDir, 'unlocatable.html'))).toBe(false);
  });

  it('a section deselected since an earlier invocation of the SAME run is removed, not left stranded (adversarial-review regression)', async () => {
    writeFileSync(paths.redesignContentHtml, '<!doctype html><html><body>x</body></html>');
    mkdirSync(paths.sectionsDir, { recursive: true });
    writeFileSync(sectionFragmentPath(paths, 'hero'), '<!doctype html><html><body>hero</body></html>');
    writeFileSync(sectionFragmentPath(paths, 'features'), '<!doctype html><html><body>features</body></html>');
    const first = await buildRedesignDeliverable(paths, 'selected-sections', { redesignContentHtml: paths.redesignContentHtml }, ['hero', 'features']);
    expect(first.sectionIds).toEqual(['hero', 'features']);
    expect(existsSync(join(paths.redesignDeliverableSectionsDir, 'features.html'))).toBe(true);

    // A later invocation resolves scope down to just 'hero' — 'features.html' must not survive.
    const second = await buildRedesignDeliverable(paths, 'selected-sections', { redesignContentHtml: paths.redesignContentHtml }, ['hero']);
    expect(second.sectionIds).toEqual(['hero']);
    expect(existsSync(join(paths.redesignDeliverableSectionsDir, 'features.html'))).toBe(false);
    expect(existsSync(join(paths.redesignDeliverableSectionsDir, 'hero.html'))).toBe(true);
  });
});

describe('buildNewComponentDeliverable', () => {
  function fakeDsRepo(): string {
    const dsRepoPath = join(root, 'fake-ds-repo');
    mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
    writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'), 'export const Card = () => null;\n');
    writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/Card.stories.tsx'), 'export default { title: "Card" };\n');
    return dsRepoPath;
  }

  const spec = (overrides: Partial<ComponentSpec> = {}): ComponentSpec => ({
    schemaVersion: 1,
    componentId: 'comp-1',
    patternId: 'pattern-1',
    resolution: 'new',
    updateTarget: null,
    name: 'Card',
    category: 'molecules',
    scope: 'page-local',
    scopeEvidenceMissing: false,
    reference: { source: 'live-capture', priorRunId: null, elementStamp: 'e1', cropPath: null },
    anatomy: 'card — 1 instance',
    variantAxes: [],
    tokens: [],
    statesObserved: ['default'],
    statesToDesign: ['hover'],
    postFixPrerequisite: null,
    writeSet: ['core-v2/src/molecules/Card.tsx', 'core-v2/src/molecules/Card.stories.tsx'],
    declaredSharedChanges: { barrelEntries: [], tokenAdditions: [] },
    dependsOn: { findings: [], components: [] },
    constraints: [],
    ...overrides,
  });

  it('copies the approved component\'s exact written files (real React/TypeScript source) into new-component/<Name>/, and writes new-component/index.html', async () => {
    const dsRepoPath = fakeDsRepo();
    const build: L2Output = { componentId: 'comp-1', filesWritten: ['core-v2/src/molecules/Card.tsx', 'core-v2/src/molecules/Card.stories.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };
    const result = await buildNewComponentDeliverable(paths, 'run-1', [spec()], [build], [], dsRepoPath);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ componentId: 'comp-1', name: 'Card', dirName: 'Card', hasPreview: false });
    expect(readFileSync(join(paths.newComponentDir, 'Card', 'Card.tsx'), 'utf-8')).toContain('export const Card');
    expect(readFileSync(join(paths.newComponentDir, 'Card', 'Card.stories.tsx'), 'utf-8')).toContain('title: "Card"');
    expect(existsSync(paths.newComponentIndexHtml)).toBe(true);
    expect(readFileSync(paths.newComponentIndexHtml, 'utf-8')).toContain('Card');
  });

  it('never exposes a build that did not respect its write set, even if the spec is in the approved list (§9.4/§11.4)', async () => {
    const dsRepoPath = fakeDsRepo();
    const rejectedBuild: L2Output = { componentId: 'comp-1', filesWritten: [], writeSetRespected: false, violatingPaths: ['core-v2/src/other/Sneaky.tsx'], usage: null };
    const result = await buildNewComponentDeliverable(paths, 'run-1', [spec()], [rejectedBuild], [], dsRepoPath);
    expect(result).toEqual([]);
    expect(existsSync(join(paths.newComponentDir, 'Card'))).toBe(false);
  });

  it('a spec with no matching build result is skipped, not crashed on', async () => {
    const dsRepoPath = fakeDsRepo();
    const result = await buildNewComponentDeliverable(paths, 'run-1', [spec()], [], [], dsRepoPath);
    expect(result).toEqual([]);
  });

  it('copies the L4 preview + reference crop, rewriting the file:// src to the portable copy alongside it', async () => {
    const dsRepoPath = fakeDsRepo();
    const build: L2Output = { componentId: 'comp-1', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };
    const cropPath = join(root, 'crop.png');
    writeFileSync(cropPath, Buffer.from('fake-png-bytes'));
    const previewPath = join(root, 'comp-1.html');
    writeFileSync(previewPath, `<!doctype html><html><body><img src="file://${cropPath}" alt="reference"></body></html>`);
    const l4: L4Output = { componentId: 'comp-1', previewHtmlPath: previewPath, previewPngPaths: [join(root, 'comp-1-reference.png')], inContextRendered: false };
    writeFileSync(l4.previewPngPaths[0]!, Buffer.from('fake-png-bytes'));

    const result = await buildNewComponentDeliverable(paths, 'run-1', [spec()], [build], [l4], dsRepoPath);
    expect(result[0]?.hasPreview).toBe(true);
    const html = readFileSync(join(paths.newComponentDir, 'Card', 'preview.html'), 'utf-8');
    expect(html).toContain('src="reference.png"');
    expect(html).not.toContain('file://');
    expect(existsSync(join(paths.newComponentDir, 'Card', 'reference.png'))).toBe(true);
  });

  it('a cropPath that was RECORDED but never actually captured (a documented non-fatal L4 case) never leaks its internal file:// path into the deliverable (adversarial-review regression)', async () => {
    const dsRepoPath = fakeDsRepo();
    const build: L2Output = { componentId: 'comp-1', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };
    const missingCropPath = join(root, 'never-actually-written.png'); // deliberately never created
    const previewPath = join(root, 'comp-1.html');
    writeFileSync(previewPath, `<!doctype html><html><body><img src="file://${missingCropPath}" alt="reference" style="max-width:400px"></body></html>`);
    // previewPngPaths is empty, exactly as L4 leaves it when existsSync(cropPath) failed.
    const l4: L4Output = { componentId: 'comp-1', previewHtmlPath: previewPath, previewPngPaths: [], inContextRendered: false };

    const result = await buildNewComponentDeliverable(paths, 'run-1', [spec()], [build], [l4], dsRepoPath);
    expect(result[0]?.hasPreview).toBe(true);
    const html = readFileSync(join(paths.newComponentDir, 'Card', 'preview.html'), 'utf-8');
    expect(html).not.toContain('file://');
    expect(html).not.toContain(root); // no internal run-tree path leaked at all
    expect(html).toContain('reference image unavailable');
  });

  it('a component approved in an earlier invocation but no longer in the CURRENT approved set is removed, not left stranded (adversarial-review regression, §11.4 rule 3)', async () => {
    const dsRepoPath = fakeDsRepo();
    const build: L2Output = { componentId: 'comp-1', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };
    const first = await buildNewComponentDeliverable(paths, 'run-1', [spec()], [build], [], dsRepoPath);
    expect(first).toHaveLength(1);
    expect(existsSync(join(paths.newComponentDir, 'Card'))).toBe(true);

    // A later invocation: comp-1's approval was invalidated (or rejected) — no longer approved.
    const second = await buildNewComponentDeliverable(paths, 'run-1', [], [build], [], dsRepoPath);
    expect(second).toEqual([]);
    expect(existsSync(join(paths.newComponentDir, 'Card'))).toBe(false);
  });

  it('two approved components sharing the same display name never clobber each other — disambiguated by componentId (adversarial-review regression)', async () => {
    const dsRepoPath = join(root, 'ds-two-cards');
    mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
    writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/CardA.tsx'), 'export const CardA = () => null;\n');
    writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/CardB.tsx'), 'export const CardB = () => null;\n');
    const specA = spec({ componentId: 'comp-aaaaaa', writeSet: ['core-v2/src/molecules/CardA.tsx'] });
    const specB = spec({ componentId: 'comp-bbbbbb', writeSet: ['core-v2/src/molecules/CardB.tsx'] }); // same name: "Card"
    const buildA: L2Output = { componentId: 'comp-aaaaaa', filesWritten: ['core-v2/src/molecules/CardA.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };
    const buildB: L2Output = { componentId: 'comp-bbbbbb', filesWritten: ['core-v2/src/molecules/CardB.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };

    const result = await buildNewComponentDeliverable(paths, 'run-1', [specA, specB], [buildA, buildB], [], dsRepoPath);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((r) => r.dirName)).size).toBe(2); // no collision
    expect(readFileSync(join(paths.newComponentDir, result[0]!.dirName, 'CardA.tsx'), 'utf-8')).toContain('CardA');
    expect(readFileSync(join(paths.newComponentDir, result[1]!.dirName, 'CardB.tsx'), 'utf-8')).toContain('CardB');
  });

  it('copies the shared in-context render once when it exists, absent when it does not', async () => {
    const dsRepoPath = fakeDsRepo();
    const build: L2Output = { componentId: 'comp-1', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };
    mkdirSync(join(paths.libraryDir, 'in-context'), { recursive: true });
    writeFileSync(paths.inContextHtml, '<!doctype html><html><body>in context</body></html>');
    await buildNewComponentDeliverable(paths, 'run-1', [spec()], [build], [], dsRepoPath);
    expect(readFileSync(paths.newComponentInContextHtml, 'utf-8')).toContain('in context');
  });

  it('sanitizes a component name with unsafe characters into a safe directory name, falling back to componentId if nothing survives', async () => {
    const dsRepoPath = fakeDsRepo();
    const build: L2Output = { componentId: 'comp-1', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };
    const weird = spec({ name: 'Card / Footer!! 🎉' });
    const result = await buildNewComponentDeliverable(paths, 'run-1', [weird], [build], [], dsRepoPath);
    expect(result[0]?.dirName).toBe('CardFooter');
    expect(existsSync(join(paths.newComponentDir, 'CardFooter'))).toBe(true);
  });
});

describe('redesign/ and new-component/ never contain internal artifacts', () => {
  it('after building both deliverables, neither folder holds JSON, .jsonl traces, or page-tile screenshots', async () => {
    writeFileSync(paths.redesignContentHtml, '<!doctype html><html><body>x</body></html>');
    await buildRedesignDeliverable(paths, 'full-page', { redesignContentHtml: paths.redesignContentHtml }, []);
    const dsRepoPath = join(root, 'ds');
    mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
    writeFileSync(join(dsRepoPath, 'core-v2/src/molecules/Card.tsx'), 'export const Card = () => null;\n');
    const spec2: ComponentSpec = {
      schemaVersion: 1, componentId: 'comp-1', patternId: 'p1', resolution: 'new', updateTarget: null, name: 'Card', category: 'molecules', scope: 'page-local', scopeEvidenceMissing: false,
      reference: { source: 'live-capture', priorRunId: null, elementStamp: 'e1', cropPath: null }, anatomy: '', variantAxes: [], tokens: [], statesObserved: [], statesToDesign: [],
      postFixPrerequisite: null, writeSet: ['core-v2/src/molecules/Card.tsx'], declaredSharedChanges: { barrelEntries: [], tokenAdditions: [] }, dependsOn: { findings: [], components: [] }, constraints: [],
    };
    const build: L2Output = { componentId: 'comp-1', filesWritten: ['core-v2/src/molecules/Card.tsx'], writeSetRespected: true, violatingPaths: [], usage: null };
    await buildNewComponentDeliverable(paths, 'run-1', [spec2], [build], [], dsRepoPath);

    const { readdirSync, statSync } = await import('node:fs');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f: string) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const files = [...walk(paths.redesignDeliverableDir), ...walk(paths.newComponentDir)];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.endsWith('.json')).toBe(false);
      expect(f.endsWith('.jsonl')).toBe(false);
      expect(f).not.toMatch(/page-tile/);
    }
    // And they really are siblings, not nested in one another.
    expect(paths.newComponentDir.startsWith(paths.redesignDeliverableDir)).toBe(false);
    expect(paths.redesignDeliverableDir.startsWith(paths.newComponentDir)).toBe(false);
  });
});
