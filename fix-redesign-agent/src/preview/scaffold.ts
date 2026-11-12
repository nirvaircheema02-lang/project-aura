import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createAssetWriter, downloadRemoteAssets, rewriteCssUrls } from './assets.ts';
import { definedCustomProperties, makeVarRenamer } from './css.ts';
import { emitIsland, emitSectionSource, islandPaddingCss, islandWrapperStyle, islandWidthCss, type EmitContext } from './jsx.ts';
import type { IslandPlan } from './plan.ts';
import { applyEyebrowRule, EYEBROW_CSS, indicatorCss, markIndicatorBars } from './structural.ts';
import { applyIslandAlignment, applyUserStyleRules, type AppliedUserRule, type UserStyleRulesFile } from './user-style-rules.ts';
import type { DesignDecisionsFile, ExtractionResult } from './types.ts';
import type { DesignMode } from '../session/types.ts';

const TEMPLATE_DIR = join(import.meta.dirname, '..', '..', 'templates', 'react-preview');

export interface GeneratePreviewArgs {
  runDir: string;
  previewDir: string;
  runId: string;
  mode: DesignMode;
  designSystemPath: string;
  port: number;
  title: string;
  extraction: ExtractionResult;
  islands: IslandPlan[];
  decisions: DesignDecisionsFile | null;
  /** Hand-authored React for behaviour the generator cannot derive (Design Review Resolver output). */
  overridesDir: string | null;
  simulated: string[];
  /** DS-first structural rules (structural.ts): eyebrow icon + label style. Arrow links are planned as islands by planIslands. */
  structuralRules?: boolean;
  /** The project's user style rules (user-style-rules.ts); null when it has none. */
  userStyleRules?: UserStyleRulesFile | null;
  /** Scroll-linked movement of the original (translateY by scroll offset), replayed at runtime. */
  scrollEffects?: Array<{ className: string; tag: string; index: number; samples: Array<[number, number]> }>;
  /** Overridable for tests (no network). */
  fetchImpl?: typeof fetch;
}

export interface GeneratedPreview {
  sectionIds: string[];
  generatedSections: string[];
  overriddenSections: string[];
  sourceHash: string;
  assets: { written: number; downloaded: number; failed: Array<{ url: string; reason: string }>; remoteLeft: string[] };
  islandsMounted: number;
  /** Eyebrow labels whose decorative icon was dropped (structural rule). */
  eyebrows?: Array<{ sectionId: string; label: string }>;
  /** Arrow links mounted as CTALink with no finding mapped (structural rule). */
  arrowLinks?: number;
  /** Pill chips mounted as the DS Badge with no finding mapped (structural rule). */
  badges?: number;
  /** Carousel indicator groups given DS colours (structural rule). */
  indicatorGroups?: number;
  /** Each user style rule and how many elements it matched (0 = it matched nothing and is reported as such). */
  userRules?: AppliedUserRule[];
}

const subst = (text: string, vars: Record<string, string>) => text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => vars[k] ?? m);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function sourceHashOf(previewDir: string): Promise<string> {
  const files = (await walk(join(previewDir, 'src'))).sort();
  const h = createHash('sha256');
  for (const f of files) { h.update(relative(previewDir, f)); h.update(await readFile(f)); }
  const pub = join(previewDir, 'public');
  if (existsSync(pub)) for (const f of (await walk(pub)).sort()) { h.update(relative(previewDir, f)); h.update((await stat(f)).size.toString()); }
  return h.digest('hex');
}

const toIdent = (id: string) => 'Section' + id.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, _s, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');

export async function generatePreviewApp(args: GeneratePreviewArgs): Promise<GeneratedPreview> {
  const { previewDir, extraction } = args;
  const dsSrc = join(args.designSystemPath, 'core-v2', 'src');
  const dsTokens = join(args.designSystemPath, 'tokens');
  if (!existsSync(dsSrc)) throw new Error(`Design System source not found at ${dsSrc} (designSystemPath in config) — the React preview imports the real DS components.`);

  // 1. template → preview-app (generated folders are rebuilt from scratch; node_modules and dist are kept)
  await mkdir(previewDir, { recursive: true });
  await rm(join(previewDir, 'src'), { recursive: true, force: true });
  await rm(join(previewDir, 'public'), { recursive: true, force: true });
  const vars = { PACKAGE_NAME: `fra-react-preview-${args.runId.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 60)}`, PORT: String(args.port), TITLE: args.title, DS_SRC: dsSrc, DS_TOKENS: dsTokens };
  for (const f of await walk(TEMPLATE_DIR)) {
    const rel = relative(TEMPLATE_DIR, f);
    await write(join(previewDir, rel), subst(await readFile(f, 'utf8'), vars));
  }

  // 2. config files that depend on this machine's Design System location
  await write(join(previewDir, 'vite.config.ts'), `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The real Ken Design System source is imported by path; nothing is copied or modified.
// \`dedupe\` keeps a single React instance: DS files live next to their own node_modules.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@kenresearch/design-system', replacement: ${JSON.stringify(dsSrc)} },
      { find: '@kenresearch/tokens', replacement: ${JSON.stringify(dsTokens)} },
    ],
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  server: { fs: { strict: false } },
});
`);
  await write(join(previewDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', useDefineForClassFields: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', skipLibCheck: true, moduleResolution: 'bundler', allowImportingTsExtensions: true,
      isolatedModules: true, moduleDetection: 'force', noEmit: true, jsx: 'react-jsx', strict: true, baseUrl: '.', resolveJsonModule: true,
      paths: { '@kenresearch/design-system/*': [`${dsSrc}/*`], '@kenresearch/tokens/*': [`${dsTokens}/*`] },
      types: ['vite/client'],
    },
    include: ['src'],
  }, null, 2));
  await write(join(previewDir, 'src', 'index.css'), `@import "@kenresearch/design-system/styles/base.css";
@import "@kenresearch/design-system/styles/cinematic-dark.css";
@import "./generated/global.css";
@source ${JSON.stringify(dsSrc)};
/* the DS expects its consumer to bind the font variables it references (see the DS base.css): a design-system value such as var(--font-dm-sans) must resolve here */
:root { --font-dm-sans: 'DM Sans'; --font-noto-serif: 'Noto Serif'; }
/* Consumer theme. The DS atoms use the utilities font-display / font-body (rule R1.4: serif for headings, sans for body/UI); the DS ships no @theme, so without these
   a DS heading renders in the browser's default sans. The ui/* components (Select, Popover, Command, Dialog, Input) are shadcn-derived and use token names the DS never
   declares (bg-popover, border-input, ring-ring, text-muted-foreground …): unbound they paint no panel and fall back to currentcolor rings. Bound here to the DS's own tokens. */
@theme {
  --font-display: 'Noto Serif', Georgia, 'Times New Roman', serif;
  --font-body: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --color-popover: var(--color-foundation-white);
  --color-popover-foreground: var(--semantic-ink-strong);
  --color-accent: var(--black-100);
  --color-accent-foreground: var(--semantic-ink-strong);
  --color-muted-foreground: var(--semantic-ink-muted);
  --color-input: var(--border-input);
  --color-input-background: transparent;
  --color-border: var(--border-card);
  --color-ring: var(--color-foundation-black);
}
html { scroll-behavior: smooth; }
body { margin: 0; background: #fff; }
`);

  // 3. assets: download what the snapshot could not inline, then externalize every data: URI
  const publicDir = join(previewDir, 'public');
  await mkdir(publicDir, { recursive: true });
  const downloads = await downloadRemoteAssets(extraction.remoteAssets, publicDir, args.fetchImpl ? { fetchImpl: args.fetchImpl } : {});
  const assets = createAssetWriter(publicDir, downloads.map);

  // 4. sections
  const islandsBySection = new Map<string, IslandPlan[]>();
  for (const i of args.islands) islandsBySection.set(i.sectionId, [...(islandsBySection.get(i.sectionId) ?? []), i]);
  // the page's own custom properties live in their own namespace (see makeVarRenamer)
  const treeVars = new Set<string>();
  const walkStyles = (n: import('./types.ts').PreviewNode) => { if (n.t === 'el') { for (const k of Object.keys(n.style ?? {})) if (k.startsWith('--')) treeVars.add(k); n.children.forEach(walkStyles); } };
  extraction.sections.forEach((sec) => walkStyles(sec.tree));
  const renameVars = makeVarRenamer(new Set([...definedCustomProperties(extraction.scopedCss), ...definedCustomProperties(extraction.globalCss), ...treeVars]));
  const overrides = args.decisions?.overrides ?? {};
  const generatedSections: string[] = [];
  const overriddenSections: string[] = [];
  const importLines: string[] = [];
  const renderLines: string[] = [];
  const sectionExtraCss: string[] = [];
  let islandsMounted = 0;

  if (args.overridesDir && existsSync(args.overridesDir) && Object.keys(overrides).length) {
    await cp(args.overridesDir, join(previewDir, 'src', 'overrides'), { recursive: true });
  }

  // structural rules and user style rules act on the captured trees BEFORE they are emitted
  const eyebrows = args.structuralRules ? applyEyebrowRule(extraction.sections) : [];
  const user = applyUserStyleRules(args.userStyleRules ?? null, extraction.sections);
  const arrowLinks = args.islands.filter((p) => p.basis === 'structural' && p.spec.component === 'CTALink').length;
  const badges = args.islands.filter((p) => p.basis === 'structural' && p.spec.component === 'Badge').length;
  const indicators = indicatorCss(extraction.sections);
  if (args.structuralRules) markIndicatorBars(extraction.sections);

  for (const section of extraction.sections) {
    const ident = toIdent(section.id);
    const overridePath = overrides[section.id];
    if (overridePath) {
      const file = overridePath.replace(/^preview-overrides\//, '').replace(/\.tsx?$/, '');
      if (!existsSync(join(previewDir, 'src', 'overrides', `${file}.tsx`)) && !existsSync(join(previewDir, 'src', 'overrides', `${file}.ts`))) throw new Error(`Design decision overrides section "${section.id}" with ${overridePath}, but that module is not in the run's preview-overrides/ folder.`);
      importLines.push(`import ${ident} from './overrides/${file}';`);
      renderLines.push(`        <${ident} />`);
      overriddenSections.push(section.id);
      continue;
    }
    const plans = islandsBySection.get(section.id) ?? [];
    const ctx: EmitContext = { assetUrl: assets.urlFor, islands: new Map(plans.map((p) => [p.stamp, { slot: p.slot }])), extraRules: [], importantCounter: { n: 0 }, renameVars };
    const src = emitSectionSource(section, ctx, plans.map((p) => ({ slot: p.slot, jsx: emitIsland(p.spec, p.label, p.answer ? { nodes: p.answer, ctx } : undefined), component: p.spec.component, findingIds: p.findingIds.join(' '), wrapperStyle: applyIslandAlignment(islandWrapperStyle(p.layout), user.islandStyles.get(p.stamp)) })));
    await write(join(previewDir, 'src', 'generated', 'sections', `${src.componentName}.tsx`), src.code);
    if (src.extraCss) sectionExtraCss.push(src.extraCss);
    importLines.push(`import ${src.componentName} from './generated/sections/${src.componentName}';`);
    renderLines.push(`        <${src.componentName} />`);
    generatedSections.push(section.id);
    islandsMounted += plans.length;
  }

  // 5. CSS (scoped to the shadow roots) and document-level CSS (fonts, @property)
  await write(join(previewDir, 'src', 'generated', 'scoped.css'), [renameVars(rewriteCssUrls(extraction.scopedCss, assets.urlFor)), ...sectionExtraCss, ...(eyebrows.length ? [EYEBROW_CSS] : []), ...(args.structuralRules && indicators ? [indicators] : []), ...(user.css ? [user.css] : [])].join('\n'));
  const islandWidths = args.islands.map((p) => islandWidthCss(p.sectionId, p.slot, p.layout) + (p.spec.component === 'SectionHeading' ? '\n' + islandPaddingCss(p.sectionId, p.slot, p.layout) : '')).join('\n');
  // the spacing the original's section containers gave each section (display:contents mirrors lose it): desktop, and phone width below Tailwind's md
  const spacingCss = extraction.sections.filter((sec) => sec.outerSpacing).flatMap((sec) => {
    const sp = sec.outerSpacing!;
    const rule = (v: { top: number; bottom: number }) => `[data-pv-section=${JSON.stringify(sec.id)}] { padding-top: ${v.top}px; padding-bottom: ${v.bottom}px; }`;
    return [rule(sp.desktop), ...(sp.mobile.top !== sp.desktop.top || sp.mobile.bottom !== sp.desktop.bottom ? [`@media (max-width: 767px) { ${rule(sp.mobile)} }`] : [])];
  }).join('\n');
  await write(join(previewDir, 'src', 'generated', 'global.css'), renameVars(rewriteCssUrls([extraction.globalCss, islandWidths, spacingCss].join('\n'), assets.urlFor)));
  const keepAttrs = (a: Record<string, string>) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'style'));
  await write(join(previewDir, 'src', 'generated', 'page.ts'), `export const htmlAttrs: Record<string, string> = ${JSON.stringify(keepAttrs(extraction.htmlAttrs))};\nexport const bodyAttrs: Record<string, string> = ${JSON.stringify(keepAttrs(extraction.bodyAttrs))};\n`);
  await write(join(previewDir, 'src', 'generated', 'scrollEffects.ts'), `import type { ScrollEffect } from '../runtime/scrollEffects';\nexport const scrollEffects: ScrollEffect[] = ${JSON.stringify(args.scrollEffects ?? [])};\n`);
  await assets.flush();

  // 6. App + status
  await write(join(previewDir, 'src', 'App.tsx'), `import { PreviewBar, PreviewNotes } from './runtime/PreviewChrome';
import { ScrollEffects } from './runtime/ScrollEffectsHost';
${importLines.join('\n')}

export default function App() {
  return (
    <>
      <PreviewBar />
      <ScrollEffects />
      <main>
${renderLines.join('\n')}
      </main>
      <PreviewNotes />
    </>
  );
}
`);
  await write(join(previewDir, 'public', 'pv-status.json'), JSON.stringify({ runId: args.runId, mode: args.mode, sections: extraction.sections.map((s) => s.id), simulated: args.simulated, unavailable: [], verdict: null, failedRequired: 0, unverifiedRequired: 0, gaps: [], gapsTruncated: 0, disclosed: [], disclosedTruncated: 0 }, null, 2)); // verdict null = verification has not run yet; verify.ts rewrites it with the real status
  await write(join(previewDir, 'README.md'), `# React preview — ${args.runId}

Generated by fix-redesign-agent (pipeline node R8). Recreates the ${extraction.sections.length} ${args.mode === 'full-page' ? 'page' : 'selected'} section(s) for visual review. It is **not** production source.

\`\`\`bash
npm install
npm run dev      # http://127.0.0.1:${args.port}/
npm run build
\`\`\`

- \`src/generated/\` is regenerated by \`pnpm run agent preview ${args.runId}\`; do not edit it by hand.
- Behaviour the generator cannot derive (JavaScript-driven widgets) is reported as unavailable at G2. To add it, author a React module under the run's \`preview-overrides/\`, register it in \`context/design-decisions.json\` (\`overrides\`), and regenerate.
- Design-system components are imported by path from the Design System repo; nothing there is modified.
`);

  const sourceHash = await sourceHashOf(previewDir);
  return {
    sectionIds: extraction.sections.map((s) => s.id),
    generatedSections,
    overriddenSections,
    sourceHash,
    assets: { written: assets.written(), downloaded: downloads.downloaded.length, failed: downloads.failed, remoteLeft: [...new Set(assets.remoteMissing)] },
    islandsMounted,
    eyebrows,
    arrowLinks,
    badges,
    indicatorGroups: extraction.sections.reduce((n, sec) => n + (sec.indicators?.length ?? 0), 0),
    userRules: user.applied,
  };
}
