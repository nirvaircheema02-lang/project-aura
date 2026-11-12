import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { extractSections } from '../../src/preview/extract.ts';
import { generatePreviewApp, sourceHashOf } from '../../src/preview/scaffold.ts';
import type { ExtractionResult } from '../../src/preview/types.ts';

/**
 * The generated React app, written to disk without installing or building anything (no network):
 * its structure is what the pipeline then builds, serves and verifies.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ORIGINAL = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<style>
body{margin:0;font-family:Arial}
.hero{background:#111;color:#fff;padding:40px;background-image:url(data:image/png;base64,${PNG})}
.hero h1{font-size:40px;margin:0}
.cta{display:inline-flex;padding:8px 16px;color:#fff;background:#222;text-decoration:none}
.faq{padding:30px}
.pricing{padding:30px}
</style></head><body>
<header data-fra-section="header" data-fra-scope="excluded">Site header navigation</header>
<main>
<section data-fra-section="hero" class="hero"><h1>Big headline here</h1><a class="cta" href="/go" data-fra-element="e1" data-fra-findings="fid1">Talk to us</a><img alt="x" src="data:image/png;base64,${PNG}"></section>
<section data-fra-section="pricing" data-fra-scope="unselected" class="pricing"><h2>Pricing plans</h2></section>
<section data-fra-section="faq" class="faq"><h2>Questions</h2><p>Answer text here</p></section>
</main>
<footer data-fra-section="footer" data-fra-scope="excluded">Footer links</footer>
</body></html>`;

let browser: Browser;
let extraction: ExtractionResult;
let dirs: string[] = [];
beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  extraction = await extractSections(ctx, ORIGINAL, { sectionIds: ['hero', 'faq'], fullPage: false, names: { hero: 'Hero', faq: 'FAQ' }, edits: [] });
  await ctx.close();
});
afterAll(async () => { await browser?.close(); });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fra-scaffold-')); dirs.push(d); return d; };

// a stand-in for the Design System checkout: only its path is written into the generated config
const fakeDs = () => { const d = tmp(); mkdirSync(join(d, 'core-v2', 'src'), { recursive: true }); mkdirSync(join(d, 'tokens'), { recursive: true }); return d; };
const DS = fakeDs();
const base = (previewDir: string) => ({ runDir: tmp(), previewDir, runId: 'run-1', mode: 'selected-sections' as const, designSystemPath: DS, port: 4411, title: 'Fixture — React preview', extraction, islands: [], decisions: null, overridesDir: null, simulated: ['Forms do not submit.'], fetchImpl: (async () => { throw new Error('the generator must not touch the network here'); }) as unknown as typeof fetch });

describe('generatePreviewApp', () => {
  it('writes a runnable app containing exactly the extracted sections, in order, and nothing else', async () => {
    const dir = join(tmp(), 'preview-app');
    const g = await generatePreviewApp(base(dir));
    expect(g.sectionIds).toEqual(['hero', 'faq']);
    expect(g.generatedSections).toEqual(['hero', 'faq']);
    expect(g.overriddenSections).toEqual([]);
    const app = readFileSync(join(dir, 'src', 'App.tsx'), 'utf8');
    expect(app.indexOf('<SectionHero />')).toBeGreaterThan(-1);
    expect(app.indexOf('<SectionHero />')).toBeLessThan(app.indexOf('<SectionFaq />'));
    expect(app).not.toMatch(/Pricing|Header|Footer/i);
    for (const f of ['package.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'src/main.tsx', 'src/index.css', 'src/runtime/OriginalSection.tsx', 'src/generated/scoped.css', 'public/pv-status.json']) expect(existsSync(join(dir, f)), f).toBe(true);
    const sections = readdirSync(join(dir, 'src', 'generated', 'sections')).sort();
    expect(sections).toEqual(['SectionFaq.tsx', 'SectionHero.tsx']);
    expect(readFileSync(join(dir, 'src', 'generated', 'sections', 'SectionHero.tsx'), 'utf8')).toContain('Big headline here');
    expect(readFileSync(join(dir, 'src', 'generated', 'sections', 'SectionFaq.tsx'), 'utf8')).not.toContain('Pricing plans');
  }, 60_000);

  it('substitutes the run\'s own values into the template and binds the DS font variables', async () => {
    const dir = join(tmp(), 'preview-app');
    await generatePreviewApp(base(dir));
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.preview).toContain('--port 4411');
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('Fixture — React preview');
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain(DS);
    expect(readFileSync(join(dir, 'src', 'index.css'), 'utf8')).toMatch(/--font-dm-sans: 'DM Sans'/);
    expect(JSON.parse(readFileSync(join(dir, 'public', 'pv-status.json'), 'utf8'))).toMatchObject({ runId: 'run-1', mode: 'selected-sections', sections: ['hero', 'faq'] });
    // no template placeholder is left behind
    for (const f of ['package.json', 'index.html', 'vite.config.ts']) expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/\{\{[A-Z_]+\}\}/);
  }, 60_000);

  it('ships the status reader, writes a pending pv-status.json, and the chrome shows the overall verification status and its gaps', async () => {
    const dir = join(tmp(), 'preview-app');
    await generatePreviewApp(base(dir));
    // before verification runs there is no verdict, and no claim: the UI reads this as "pending"
    expect(JSON.parse(readFileSync(join(dir, 'public', 'pv-status.json'), 'utf8'))).toMatchObject({ verdict: null, failedRequired: 0, unverifiedRequired: 0, gaps: [], disclosed: [] });
    expect(existsSync(join(dir, 'src', 'runtime', 'status.ts'))).toBe(true);
    const chrome = readFileSync(join(dir, 'src', 'runtime', 'PreviewChrome.tsx'), 'utf8');
    expect(chrome).toContain("from './status'");
    expect(chrome).toMatch(/statusLine\(s\)/);
    expect(chrome).toMatch(/s\.gaps\.map/);
    expect(chrome).toMatch(/s\.disclosed/);
  }, 60_000);

  it('turns every data: URI into a local file, so the running preview needs nothing from anywhere else', async () => {
    const dir = join(tmp(), 'preview-app');
    const g = await generatePreviewApp(base(dir));
    expect(g.assets.written).toBeGreaterThan(0);
    expect(g.assets.remoteLeft).toEqual([]);
    const generated = readFileSync(join(dir, 'src', 'generated', 'sections', 'SectionHero.tsx'), 'utf8') + readFileSync(join(dir, 'src', 'generated', 'scoped.css'), 'utf8');
    expect(generated).not.toMatch(/data:image/);
    expect(generated).toMatch(/\/assets\/[0-9a-f]{12}\.png/);
    expect(readdirSync(join(dir, 'public', 'assets')).length).toBeGreaterThan(0);
  }, 60_000);

  it('wires a hand-authored override in place of the generated section, and refuses a decision that points at a missing module', async () => {
    const dir = join(tmp(), 'preview-app');
    const overrides = tmp();
    writeFileSync(join(overrides, 'Faq.tsx'), 'export default function Faq() { return <section data-pv-section="faq">override</section>; }\n');
    const g = await generatePreviewApp({ ...base(dir), overridesDir: overrides, decisions: { schemaVersion: 1, findings: {}, overrides: { faq: 'preview-overrides/Faq.tsx' } } });
    expect(g.overriddenSections).toEqual(['faq']);
    expect(g.generatedSections).toEqual(['hero']);
    const app = readFileSync(join(dir, 'src', 'App.tsx'), 'utf8');
    expect(app).toContain("import SectionFaq from './overrides/Faq';");
    expect(existsSync(join(dir, 'src', 'overrides', 'Faq.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'generated', 'sections', 'SectionFaq.tsx'))).toBe(false);
    mkdirSync(join(tmp(), 'x'));
    await expect(generatePreviewApp({ ...base(join(tmp(), 'preview-app2')), overridesDir: overrides, decisions: { schemaVersion: 1, findings: {}, overrides: { faq: 'preview-overrides/Missing.tsx' } } })).rejects.toThrow(/not in the run's preview-overrides/);
  }, 60_000);

  it('the source hash changes when the generated source changes, so an earlier G2 approval is invalidated', async () => {
    const dir = join(tmp(), 'preview-app');
    await generatePreviewApp(base(dir));
    const before = await sourceHashOf(dir);
    expect(await sourceHashOf(dir)).toBe(before);
    writeFileSync(join(dir, 'src', 'App.tsx'), readFileSync(join(dir, 'src', 'App.tsx'), 'utf8') + '\n// edited\n');
    expect(await sourceHashOf(dir)).not.toBe(before);
  }, 60_000);

  it('regenerating writes the same app (deterministic)', async () => {
    const a = join(tmp(), 'a');
    const b = join(tmp(), 'b');
    await generatePreviewApp(base(a));
    await generatePreviewApp({ ...base(b), runDir: base(b).runDir });
    expect(await sourceHashOf(a)).toBe(await sourceHashOf(b));
  }, 60_000);
});
