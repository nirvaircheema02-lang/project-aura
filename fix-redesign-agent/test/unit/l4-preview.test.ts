import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runL4 } from '../../src/agents/l4-preview/index.ts';
import { ensureLibraryDirs, redesignPaths, type RedesignPaths } from '../../src/output/redesign-store.ts';
import type { AcceptanceResult, ComponentSpec } from '../../src/library/types.ts';

/** Real filesystem writes, no browser — same tier as `r1-resolve-load.test.ts`. */

let root: string;
let paths: RedesignPaths;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fra-l4-'));
  paths = redesignPaths(root, 'proj', 'run-1');
  await ensureLibraryDirs(paths); // creates previewsDir (and in-context's parent dir) — the real dirs runL4 writes into
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function componentSpec(overrides: Partial<ComponentSpec> = {}): ComponentSpec {
  return {
    schemaVersion: 1,
    componentId: 'card-abcd1234',
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
    statesToDesign: ['hover', 'focus'],
    postFixPrerequisite: null,
    writeSet: ['core-v2/src/molecules/Card.tsx'],
    declaredSharedChanges: { barrelEntries: [], tokenAdditions: [] },
    dependsOn: { findings: [], components: [] },
    constraints: [],
    ...overrides,
  };
}

const acceptance: AcceptanceResult[] = [
  { area: 'accessibility', check: 'text contrast ≥ 4.5:1', evidenceClass: 'observed', passed: true, detail: '7.00:1' },
  { area: 'responsive', check: 'renders at 375×800 with no overflow/clipping/overlap', evidenceClass: 'proposed', passed: false, detail: 'element not found at this viewport' },
];

describe('runL4 — per-component preview', () => {
  it('writes a preview HTML file at componentPreviewHtmlPath, with the acceptance table and evidence classes; copies the reference crop alongside it', async () => {
    const cropPath = join(root, 'reference-crop.png');
    writeFileSync(cropPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // a few real PNG-signature bytes are enough — L4 only copies the file, never decodes it
    const spec = componentSpec({ reference: { source: 'live-capture', priorRunId: null, elementStamp: 'e1', cropPath } });

    const result = await runL4(paths, spec, acceptance);

    expect(existsSync(result.previewHtmlPath)).toBe(true);
    const html = readFileSync(result.previewHtmlPath, 'utf-8');
    expect(html).toContain('Card');
    expect(html).toContain('card-abcd1234');
    expect(html).toContain('text contrast'); // an acceptance check's own text
    expect(html).toContain('class="proposed"'); // the proposed row is flagged in the table
    expect(html).toContain('renders at 375×800');
    expect(html).toContain('hover'); // statesToDesign is listed
    expect(html).not.toContain('(no reference crop)'); // a crop WAS given

    expect(result.previewPngPaths).toHaveLength(1);
    const pngPath = result.previewPngPaths[0]!;
    expect(pngPath).toBe(result.previewHtmlPath.replace(/\.html$/, '-reference.png'));
    expect(readFileSync(pngPath)).toEqual(readFileSync(cropPath)); // copied byte-for-byte

    expect(result.inContextRendered).toBe(false); // no redesign-content.html exists in this run yet
    expect(existsSync(paths.inContextHtml)).toBe(false);
  });

  it('with no reference crop, says so in the preview and reports zero preview PNGs', async () => {
    const spec = componentSpec(); // reference.cropPath is null by default
    const result = await runL4(paths, spec, []);
    const html = readFileSync(result.previewHtmlPath, 'utf-8');
    expect(html).toContain('(no reference crop)');
    expect(result.previewPngPaths).toEqual([]);
  });

  it("reuses Workflow A's own redesign-content.html as the in-context preview when it exists", async () => {
    writeFileSync(paths.redesignContentHtml, '<html><body>the corrected page, with R4\'s component swaps already applied</body></html>');
    const spec = componentSpec();

    const result = await runL4(paths, spec, []);

    expect(result.inContextRendered).toBe(true);
    expect(existsSync(paths.inContextHtml)).toBe(true);
    expect(readFileSync(paths.inContextHtml, 'utf-8')).toBe(readFileSync(paths.redesignContentHtml, 'utf-8'));
  });

  it('escapes HTML-significant characters in spec fields so a component name can never break out of the preview markup', async () => {
    const spec = componentSpec({ name: '<script>evil</script>' });
    const result = await runL4(paths, spec, []);
    const html = readFileSync(result.previewHtmlPath, 'utf-8');
    expect(html).not.toContain('<script>evil</script>');
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;');
  });
});
