// Vendored verbatim from audit-agent src/ds/d4-components/index.ts (2026-09-18) — see docs/ARCHITECTURE.md Decision Log #3. Only import paths changed.
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { relative } from 'node:path';
import type { DSRawContent } from '../d1-reader/index.ts';
import { finding, type DSFinding } from '../findings.ts';

/**
 * D4 Components/Variants — IMPLEMENTATION-PLAN.md §4: Ken's components do
 * NOT use one uniform variant model, so this is 4 separate extraction
 * passes over core-v2/src/**\/*.tsx, not one. Read-only: a ts-morph Project
 * over the real files, no writes, no codegen.
 */

export interface StringUnionVariant {
  file: string;
  typeName: string;
  values: string[];
}

export interface VariantLookupMap {
  file: string;
  constName: string;
  keyedBy: string; // the Record<X, ...> key type, e.g. "BadgeTheme"
}

export interface IifeVariantLogic {
  file: string;
  functionOrConstName: string;
  /** True when this logic is visibly un-extractable from any stylesheet (e.g. driven by React state). */
  runtimeOnly: boolean;
  note?: string;
}

export interface CvaConfig {
  file: string;
  variantGroups: string[];
}

export interface D4Result {
  totalTsxFiles: number;
  /** Every component file, relative to core-v2/src — the name catalog B3 matches production components against. */
  componentFiles: string[];
  stringUnionVariants: StringUnionVariant[];
  lookupMaps: VariantLookupMap[];
  iifeLogic: IifeVariantLogic[];
  cvaConfigs: CvaConfig[];
  dataComponentCoverage: {
    withAttribute: number;
    total: number;
    byCategory: Record<string, { withAttribute: number; total: number }>;
  };
  findings: DSFinding[];
}

const VARIANT_TYPE_NAME_RE = /^\w*(Variant|Size|Theme|Background)$/;

function categoryOf(relPath: string): string {
  // core-v2/src/<category>/... — first path segment under src/.
  const parts = relPath.split('/');
  return parts[0] ?? 'unknown';
}

function extractStringUnionVariants(sf: SourceFile, relPath: string): StringUnionVariant[] {
  const out: StringUnionVariant[] = [];
  for (const alias of sf.getTypeAliases()) {
    if (!alias.isExported()) continue;
    const name = alias.getName();
    if (!VARIANT_TYPE_NAME_RE.test(name)) continue;
    const typeNode = alias.getTypeNode();
    if (!typeNode || typeNode.getKind() !== SyntaxKind.UnionType) continue;
    const literals = typeNode
      .asKindOrThrow(SyntaxKind.UnionType)
      .getTypeNodes()
      .filter((t) => t.getKind() === SyntaxKind.LiteralType)
      .map((t) => t.getText().replace(/^['"]|['"]$/g, ''));
    if (literals.length > 0) out.push({ file: relPath, typeName: name, values: literals });
  }
  return out;
}

function extractLookupMaps(sf: SourceFile, relPath: string): VariantLookupMap[] {
  const out: VariantLookupMap[] = [];
  // getDescendantsOfKind, not getVariableDeclarations(): the latter only sees
  // top-level module declarations — verified bug, real fix: Badge's/Button's
  // are declared inside the component FUNCTION BODY and were being missed entirely.
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const typeNode = decl.getTypeNode();
    if (!typeNode) continue;
    const text = typeNode.getText();
    const match = text.match(/^Record<\s*(\w+)\s*,/);
    if (match) {
      out.push({ file: relPath, constName: decl.getName(), keyedBy: match[1] as string });
    }
  }
  return out;
}

function extractIifeLogic(sf: SourceFile, relPath: string): IifeVariantLogic[] {
  const out: IifeVariantLogic[] = [];
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = decl.getName();
    if (!/variant/i.test(name)) continue;
    const initializer = decl.getInitializer();
    if (!initializer || initializer.getKind() !== SyntaxKind.CallExpression) continue;
    const call = initializer.asKindOrThrow(SyntaxKind.CallExpression);
    const expr = call.getExpression();
    const isIife = expr.getKind() === SyntaxKind.ParenthesizedExpression || expr.getKind() === SyntaxKind.ArrowFunction;
    if (!isIife) continue;

    // Verified pattern (IMPLEMENTATION-PLAN.md §4, Button.tsx): hover state applied via
    // React `useState` into an inline `style` object is un-extractable from any stylesheet.
    const usesHoverState =
      /variantInlineStyle/i.test(name) &&
      sf.getFullText().includes('isHovering') &&
      sf.getFullText().includes('useState');

    out.push({
      file: relPath,
      functionOrConstName: name,
      runtimeOnly: usesHoverState,
      ...(usesHoverState
        ? { note: 'Depends on React state (useState) set by onMouseEnter/onMouseLeave — only observable by actually hovering the element in a real browser, never by reading a stylesheet.' }
        : {}),
    });
  }
  return out;
}

function extractCvaConfigs(sf: SourceFile, relPath: string): CvaConfig[] {
  const out: CvaConfig[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'cva') continue;
    const args = call.getArguments();
    const configArg = args[1];
    const variantGroups: string[] = [];
    if (configArg && configArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
      const variantsProp = configArg
        .asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
        .getProperty('variants');
      if (variantsProp && variantsProp.getKind() === SyntaxKind.PropertyAssignment) {
        const init = variantsProp.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
        if (init && init.getKind() === SyntaxKind.ObjectLiteralExpression) {
          for (const p of init.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperties()) {
            if (p.getKind() === SyntaxKind.PropertyAssignment) {
              variantGroups.push(p.asKindOrThrow(SyntaxKind.PropertyAssignment).getName());
            }
          }
        }
      }
    }
    out.push({ file: relPath, variantGroups });
  }
  return out;
}

export function buildD4(raw: DSRawContent): D4Result {
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(raw.tsxFiles);

  const findings: DSFinding[] = [];
  const stringUnionVariants: StringUnionVariant[] = [];
  const lookupMaps: VariantLookupMap[] = [];
  const iifeLogic: IifeVariantLogic[] = [];
  const cvaConfigs: CvaConfig[] = [];

  const coreV2SrcRoot = raw.tsxFiles.length > 0 ? findCoreV2SrcRoot(raw.designSystemPath) : raw.designSystemPath;
  const byCategory: Record<string, { withAttribute: number; total: number }> = {};
  let withAttribute = 0;

  for (const absPath of raw.tsxFiles) {
    const sf = project.getSourceFileOrThrow(absPath);
    const relPath = relative(coreV2SrcRoot, absPath);
    const category = categoryOf(relPath);
    byCategory[category] ??= { withAttribute: 0, total: 0 };
    byCategory[category].total++;

    const text = sf.getFullText();
    if (/data-component=/.test(text)) {
      withAttribute++;
      byCategory[category].withAttribute++;
    }

    stringUnionVariants.push(...extractStringUnionVariants(sf, relPath));
    lookupMaps.push(...extractLookupMaps(sf, relPath));
    iifeLogic.push(...extractIifeLogic(sf, relPath));
    cvaConfigs.push(...extractCvaConfigs(sf, relPath));
  }

  if (cvaConfigs.length > 0) {
    const nonUiCva = cvaConfigs.filter((c) => !c.file.startsWith('ui/'));
    findings.push(
      finding({
        module: 'D4',
        severity: 'info',
        summary: `cva() variant configs found in ${cvaConfigs.length} file(s)${nonUiCva.length === 0 ? ', all under ui/ (shadcn primitives)' : ''}`,
        detail: `Ken's own atoms/molecules/organisms do not use cva() — confirmed by this pass. Files: ${cvaConfigs.map((c) => c.file).join(', ')}.`,
        sources: cvaConfigs.map((c) => c.file),
      }),
    );
    for (const cva of cvaConfigs) {
      const referencesThemeVar = /bg-primary|bg-destructive|text-primary-foreground/.test(
        project.getSourceFileOrThrow(raw.tsxFiles.find((p) => p.endsWith(cva.file))!).getFullText(),
      );
      if (referencesThemeVar) {
        const definesRootVar = (css: string) => /^\s*--primary(-foreground)?:/m.test(css);
        const definedAnywhere =
          definesRootVar(raw.baseCssRaw.content) ||
          definesRootVar(raw.editorialLightCssRaw.content) ||
          definesRootVar(raw.cinematicDarkCssRaw.content);
        if (!definedAnywhere) {
          findings.push(
            finding({
              module: 'D4',
              severity: 'warning',
              summary: `${cva.file} references shadcn theme vars (e.g. bg-primary) that are not defined anywhere in core-v2/src/styles`,
              detail:
                `Verified: no --primary / --primary-foreground custom property exists in base.css, editorial-light.css, ` +
                `or cinematic-dark.css. This shadcn ui/ primitive is unthemed in this Design System today — recorded as ` +
                `a fact for B4 to know about, not treated as a bug to silently work around.`,
              sources: [cva.file],
            }),
          );
        }
      }
    }
  }

  const runtimeOnlyLogic = iifeLogic.filter((l) => l.runtimeOnly);
  for (const l of runtimeOnlyLogic) {
    findings.push(
      finding({
        module: 'D4',
        severity: 'warning',
        summary: `${l.file}: "${l.functionOrConstName}" is runtime-only, un-extractable from any stylesheet`,
        detail: l.note ?? '',
        sources: [l.file],
      }),
    );
  }

  findings.push(
    finding({
      module: 'D4',
      severity: 'info',
      summary: `data-component coverage: ${withAttribute}/${raw.tsxFiles.length} files (${Object.entries(byCategory)
        .map(([cat, c]) => `${cat} ${c.withAttribute}/${c.total}`)
        .join(', ')})`,
      detail:
        'Variants are essentially invisible in the DOM outside this attribute. Whether the audited PRODUCTION site ' +
        '(not this DS repo) retains data-component in its build is unverified by D4 — it can only confirm DS-repo ' +
        'authoring intent, not production output. B2/B3 must treat this as a secondary signal only, per ARCHITECTURE.md §5.2.',
      sources: ['core-v2/src/**/*.tsx'],
    }),
  );

  return {
    totalTsxFiles: raw.tsxFiles.length,
    componentFiles: raw.tsxFiles.map((p) => relative(coreV2SrcRoot, p)).sort(),
    stringUnionVariants,
    lookupMaps,
    iifeLogic,
    cvaConfigs,
    dataComponentCoverage: { withAttribute, total: raw.tsxFiles.length, byCategory },
    findings,
  };
}

function findCoreV2SrcRoot(designSystemPath: string): string {
  return `${designSystemPath}/core-v2/src`;
}
