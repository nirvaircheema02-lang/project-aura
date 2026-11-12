import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { componentStyleModelFromSource, type ComponentStyleModel } from './component-styles.ts';
import { effectiveTokenMap } from './catalog.ts';
import type { DsRegistry } from './d2-registry/index.ts';

/** Extract a supported compound slot from actual DS JSX; no duplicated colour constants.
 * Unknown source shapes fail closed. A link slot must never be compared to its nav root.
 */
export async function breadcrumbSlotModels(registry: DsRegistry): Promise<Map<string, ComponentStyleModel>> {
  const out = new Map<string, ComponentStyleModel>();
  const file = 'molecules/Breadcrumb.tsx';
  const source = await readFile(join(registry.designSystemPath, 'core-v2/src', file), 'utf8').catch(() => null);
  if (!source) return out;
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile('Breadcrumb.tsx', source);
  const openings = sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
  for (const [slot, tag, signal] of [['link', 'a', 'isLast'], ['trigger', 'button', 'isOpen']] as const) {
    const node = openings.find(n => n.getTagNameNode().getText() === tag && (n.getAttribute('className')?.getText().includes(signal)));
    if (!node) continue;
    const attrs = ['className', 'style'].map(a => node.getAttribute(a)?.getText() ?? '').join(' ');
    const model = componentStyleModelFromSource('BreadcrumbSlot.tsx', `
      function BreadcrumbSlot({ colorScheme = 'dark', current = false, expanded = false }: { colorScheme?: 'dark' | 'light'; current?: boolean; expanded?: boolean }) {
        const isDark = colorScheme === 'dark'; const isLast = current; const isOpen = expanded;
        return <${tag} ${attrs} />;
      }`, effectiveTokenMap(registry, 'editorial-light'));
    if (model) out.set(slot, model);
  }
  return out;
}

/** Reuse the DS's own declarations and JSX for each heading level/subtitle, not the wrapper. */
export async function headingSlotModels(registry: DsRegistry): Promise<Map<string, ComponentStyleModel>> {
  const out = new Map<string, ComponentStyleModel>();
  const source = await readFile(join(registry.designSystemPath, 'core-v2/src/atoms/SectionHeading.tsx'), 'utf8').catch(() => null);
  if (!source) return out;
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile('SectionHeading.tsx', source);
  const declarations = ['sizeClass', 'fontClass'].map(name => sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find(d => d.getName() === name)?.getText()).filter(Boolean);
  const openings = sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
  for (const slot of ['h1', 'h2', 'h3', 'subtitle']) {
    const node = openings.find(n => slot === 'subtitle'
      ? n.getTagNameNode().getText() === 'p' && n.getParent().getText().includes('{subtitle}')
      : n.getTagNameNode().getText() === slot);
    if (!node) continue;
    const tag = slot === 'subtitle' ? 'p' : slot;
    const attrs = ['className','style'].map(a => node.getAttribute(a)?.getText() ?? '').join(' ');
    const model = componentStyleModelFromSource('HeadingSlot.tsx', `function HeadingSlot() { ${declarations.map(d => `const ${d};`).join('\n')} return <${tag} ${attrs} />; }`, effectiveTokenMap(registry,'editorial-light'));
    if (model) out.set(slot,model);
  }
  return out;
}

