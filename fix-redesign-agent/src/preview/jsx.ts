import type { ElementLayout, IslandSpec, PreviewNode } from './types.ts';

/** Turns a captured DOM tree into JSX source. Pure; no I/O. */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const HTML_PROP: Record<string, string> = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength', colspan: 'colSpan', rowspan: 'rowSpan',
  autocomplete: 'autoComplete', autofocus: 'autoFocus', autoplay: 'autoPlay', srcset: 'srcSet', fetchpriority: 'fetchPriority', crossorigin: 'crossOrigin', enterkeyhint: 'enterKeyHint',
  inputmode: 'inputMode', contenteditable: 'contentEditable', spellcheck: 'spellCheck', datetime: 'dateTime', usemap: 'useMap', frameborder: 'frameBorder', allowfullscreen: 'allowFullScreen',
  playsinline: 'playsInline', novalidate: 'noValidate', formaction: 'formAction', formmethod: 'formMethod', formtarget: 'formTarget', formnovalidate: 'formNoValidate', accesskey: 'accessKey',
  charset: 'charSet', 'accept-charset': 'acceptCharset', 'http-equiv': 'httpEquiv', cellpadding: 'cellPadding', cellspacing: 'cellSpacing', hreflang: 'hrefLang', srclang: 'srcLang',
  controlslist: 'controlsList', referrerpolicy: 'referrerPolicy', itemprop: 'itemProp', itemscope: 'itemScope', itemtype: 'itemType', itemid: 'itemID', rel: 'rel', value: 'defaultValue', checked: 'defaultChecked',
  imagesizes: 'imageSizes', imagesrcset: 'imageSrcSet', nomodule: 'noModule', disablepictureinpicture: 'disablePictureInPicture', disableremoteplayback: 'disableRemotePlayback',
};

const BOOLEAN_ATTRS = new Set(['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected']);

const SVG_SPECIAL: Record<string, string> = { 'xlink:href': 'xlinkHref', 'xlink:title': 'xlinkTitle', 'xml:space': 'xmlSpace', 'xml:lang': 'xmlLang', 'xmlns:xlink': 'xmlnsXlink', class: 'className' };

const kebabToCamel = (s: string) => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

export function propName(attr: string, svg: boolean, tag: string): string | null {
  const lower = attr.toLowerCase();
  if (attr.startsWith('aria-') || attr.startsWith('data-')) return attr;
  if (svg) {
    if (SVG_SPECIAL[attr]) return SVG_SPECIAL[attr]!;
    if (attr === 'xmlns') return null; // React sets the namespace itself
    return attr.includes('-') ? kebabToCamel(attr) : attr;
  }
  if (tag === 'option' && lower === 'selected') return null; // select-level defaultValue carries it
  if ((lower === 'value' || lower === 'checked') && !['input', 'textarea', 'select'].includes(tag)) return lower; // <li value>, <button value>, <progress value>
  if (HTML_PROP[lower]) return HTML_PROP[lower]!;
  if (/^on[a-z]/i.test(lower)) return null;
  if (!/^[a-z][a-z0-9]*$/i.test(attr)) return null; // an attribute React cannot represent safely
  return attr;
}

export function cssPropName(prop: string): string {
  if (prop.startsWith('--')) return prop;
  if (prop.startsWith('-ms-')) return 'ms' + kebabToCamel(prop.slice(3)).replace(/^./, (c) => c.toUpperCase());
  if (prop.startsWith('-')) return kebabToCamel(prop).replace(/^./, (c) => c.toUpperCase());
  return kebabToCamel(prop);
}

const q = (s: string) => JSON.stringify(s);
/** A JSX attribute value: plain literal when it has nothing JSX would misread, otherwise a JS string expression (JSX string attributes do not process escapes). */
const attrValue = (s: string) => (/^[\w .,:;#%()/@!?&=+*'-]*$/.test(s) && !/\\/.test(s) ? q(s) : `{${q(s)}}`);

export interface EmitContext {
  /** Resolves data:/remote URLs to public paths. */
  assetUrl: (value: string) => string;
  /** elementStamp → island that replaces that element. */
  islands: ReadonlyMap<string, { slot: string }>;
  /** Appended CSS for inline styles that carry !important (React style objects cannot). */
  extraRules: string[];
  importantCounter: { n: number };
  /** Renames the page's custom properties into the preview's own namespace (see makeVarRenamer). */
  renameVars?: (text: string) => string;
}

function emitStyle(style: Record<string, string>, ctx: EmitContext): { obj: string | null; importantId: string | null } {
  const plain: string[] = [];
  const important: Array<[string, string]> = [];
  const rn = ctx.renameVars ?? ((t: string) => t);
  for (const [rawProp, rawValue] of Object.entries(style)) {
    const prop = rn(rawProp);
    let value = rn(rawValue);
    const imp = /\s*!important\s*$/.test(value);
    if (imp) value = value.replace(/\s*!important\s*$/, '');
    if (/url\(/.test(value)) value = value.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (_w, _qq, v: string) => `url("${ctx.assetUrl(v)}")`);
    if (imp) important.push([prop, value]);
    else plain.push(`${q(cssPropName(prop))}: ${q(value)}`);
  }
  let importantId: string | null = null;
  if (important.length) {
    importantId = String(++ctx.importantCounter.n);
    ctx.extraRules.push(`[data-pv-i="${importantId}"] { ${important.map(([p, v]) => `${p}: ${v} !important;`).join(' ')} }`);
  }
  return { obj: plain.length ? `{{ ${plain.join(', ')} }}` : null, importantId };
}

function srcsetValue(v: string, ctx: EmitContext): string {
  return v.split(',').map((part) => { const bits = part.trim().split(/\s+/); if (bits[0]) bits[0] = ctx.assetUrl(bits[0]); return bits.join(' '); }).join(', ');
}

function collectSelectValue(node: PreviewNode & { t: 'el' }): string | null {
  const find = (n: PreviewNode): string | null => {
    if (n.t !== 'el') return null;
    if (n.tag === 'option' && 'selected' in n.attrs) return n.attrs['value'] ?? textOf(n);
    for (const c of n.children) { const r = find(c); if (r !== null) return r; }
    return null;
  };
  return find(node);
}
function textOf(n: PreviewNode): string { return n.t === 'text' ? n.v : n.children.map(textOf).join(''); }

export function emitNode(node: PreviewNode, ctx: EmitContext, depth: number): string {
  const pad = '  '.repeat(depth);
  if (node.t === 'text') return `${pad}{${q(node.v)}}`;
  if (node.elementStamp) {
    const island = ctx.islands.get(node.elementStamp);
    if (island) return `${pad}<Slot name=${q(island.slot)} />`;
  }
  const svg = node.ns === 'svg';
  const tag = node.tag;
  const props: string[] = [];
  const attrs = { ...node.attrs };
  let selectDefault: string | null = null;
  if (tag === 'select') selectDefault = collectSelectValue(node);

  for (const [name, value] of Object.entries(attrs)) {
    if (tag === 'select' && name === 'value') continue;
    const prop = propName(name, svg, tag);
    if (!prop) continue;
    const lower = name.toLowerCase();
    if (!svg && BOOLEAN_ATTRS.has(lower) && (value === '' || value.toLowerCase() === lower)) {
      if (lower === 'checked' && ['input'].includes(tag)) props.push('defaultChecked');
      else props.push(prop);
      continue;
    }
    // The preview is a local static recreation, so lazy loading buys nothing, and inside a section's shadow root on a phone viewport the browser can leave a
    // lazy image un-requested (a blank hero where the phone image belongs). Every image is requested.
    if (tag === 'img' && lower === 'loading' && value.toLowerCase() === 'lazy') continue;
    let v = value;
    if (['src', 'poster', 'data-src'].includes(lower) && tag !== 'script') v = ctx.assetUrl(v);
    if (lower === 'srcset' || lower === 'imagesrcset') v = srcsetValue(v, ctx);
    if (svg && (lower === 'href' || lower === 'xlink:href') && /^data:/.test(v)) v = ctx.assetUrl(v);
    props.push(`${prop}=${attrValue(v)}`);
  }
  if (selectDefault !== null) props.push(`defaultValue=${attrValue(selectDefault)}`);
  if (node.findingIds?.length) {
    props.push(`data-finding-ids=${attrValue(node.findingIds.join(' '))}`);
    if (node.findingIds.length === 1) props.push(`data-finding-id=${attrValue(node.findingIds[0]!)}`);
  }
  if (node.style) {
    const { obj, importantId } = emitStyle(node.style, ctx);
    if (obj) props.push(`style=${obj}`);
    if (importantId) props.push(`data-pv-i=${q(importantId)}`);
  }
  const open = `${pad}<${tag}${props.length ? ' ' + props.join(' ') : ''}`;
  if (VOID.has(tag) && !svg) return `${open} />`;
  const kids = node.children;
  if (kids.length === 0) return `${open} />`;
  const body = kids.map((c) => emitNode(c, ctx, depth + 1)).join('\n');
  return `${open}>\n${body}\n${pad}</${tag}>`;
}

export interface IslandEmit { slot: string; jsx: string }

/** Where each supported design-system component lives under `core-v2/src` (the import path is `@kenresearch/design-system/<dir>/<name>`). */
export const ISLAND_DIR: Record<IslandSpec['component'], string> = { Button: 'atoms', SectionHeading: 'atoms', AccordionItem: 'molecules', CTALink: 'atoms', CarouselArrow: '', Badge: 'atoms' };

/**
 * The JSX for a design-system island. Only components the generator knows how to derive deterministically are supported.
 * AccordionItem carries the ORIGINAL answer content: its nodes are emitted as the component's `answer` (the question is the label).
 */
export function emitIsland(spec: IslandSpec, label: string, answer?: { nodes: PreviewNode[]; ctx: EmitContext }): string {
  const props = Object.entries(spec.props)
    .map(([k, v]) => (typeof v === 'string' ? `${k}=${attrValue(v)}` : v === true ? k : `${k}={${JSON.stringify(v)}}`))
    .join(' ');
  if (spec.component === 'AccordionItem') {
    const body = (answer?.nodes ?? []).map((n) => emitNode(n, answer!.ctx, 4)).join('\n');
    return `<AccordionItem${props ? ' ' + props : ''} question={${q(label)}} answer={<>\n${body}\n      </>} />`;
  }
  if (spec.component === 'Badge') {
    // `overlay`: a badge over an image / dark surface — the DS Badge's own `style` prop exists for exactly this (backdrop blur + on-dark tokens), values are DS tokens
    const { overlay, ...rest } = spec.props;
    const badgeProps = Object.entries(rest).map(([k, v]) => (typeof v === 'string' ? `${k}=${attrValue(v)}` : v === true ? k : `${k}={${JSON.stringify(v)}}`)).join(' ');
    const style = overlay ? ' style={{ backgroundColor: "var(--border-on-dark-card)", color: "var(--semantic-ink-on-dark-strong)", backdropFilter: "blur(8px)" }}' : '';
    return `<Badge${badgeProps ? ' ' + badgeProps : ''}${style}>{${q(label)}}</Badge>`;
  }
  if (spec.component === 'CarouselArrow') return `<CarouselArrow${props ? ' ' + props : ''} />`;
  return `<${spec.component}${props ? ' ' + props : ''}>{${q(label)}}</${spec.component}>`;
}

export interface SectionSource {
  componentName: string;
  code: string;
  extraCss: string;
  islandComponents: Set<string>;
}

const identOf = (id: string) => 'Section' + id.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, _s, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');

export function emitSectionSource(section: { id: string; name: string; tree: PreviewNode; ancestors: Array<{ tag: string; attrs: Record<string, string> }> }, ctx: EmitContext, islands: Array<{ slot: string; jsx: string; component: string; findingIds: string; wrapperStyle: Record<string, string> }>): SectionSource {
  const componentName = identOf(section.id);
  const body = emitNode(section.tree, ctx, 3);
  const imports = [...new Set(islands.map((i) => i.component))];
  const importLines = imports.map((c) => (ISLAND_DIR[c as IslandSpec['component']] === '' ? `import { ${c} } from '../../runtime/${c}';` : `import { ${c} } from '@kenresearch/design-system/${ISLAND_DIR[c as IslandSpec['component']] ?? 'atoms'}/${c}';`));
  const islandProp = islands.length ? `\n      islands={{ ${islands.map((i) => `${q(i.slot)}: { node: ${i.jsx}, findingIds: ${q(i.findingIds)}, component: ${q(i.component)}, style: ${JSON.stringify(i.wrapperStyle)} }`).join(', ')} }}` : '';
  const code = `// GENERATED by fix-redesign-agent (React Preview, node R8) from this run's captured evidence. Do not edit by hand:
// regenerate with \`pnpm run agent preview <redesignRunId>\`. Hand-authored behaviour belongs in preview-overrides/.
import { OriginalSection, Slot } from '../../runtime/OriginalSection';
${importLines.join('\n')}

const ANCESTORS = ${JSON.stringify(section.ancestors)};

export default function ${componentName}() {
  return (
    <OriginalSection id=${q(section.id)} name=${q(section.name)} ancestors={ANCESTORS}${islandProp}>
${body}
    </OriginalSection>
  );
}
`;
  return { componentName, code, extraCss: ctx.extraRules.join('\n'), islandComponents: new Set(imports) };
}

/**
 * The wrapper style that keeps a replaced element's place in its parent: its display, margins, alignment and growth.
 * A control centred by AUTO margins (equal, large used margins on a block-level box that does not span its parent) keeps `margin: auto`
 * with a shrink-wrapped width instead of the one-viewport pixel values, so it stays centred at every width.
 */
export function islandWrapperStyle(layout: ElementLayout): Record<string, string> {
  const style: Record<string, string> = { display: layout.display === 'contents' || layout.display === 'none' ? 'block' : layout.display };
  const [t, r, b, l] = layout.margin;
  const px = (v: string) => (/^-?[\d.]+px$/.test(v) ? parseFloat(v) : NaN);
  const autoCentred = !layout.fullWidth && /^(block|flex|grid|table)$/.test(layout.display) && px(r) > 8 && Math.abs(px(r) - px(l)) < 2;
  const rightAuto = !layout.fullWidth && /^(block|flex|grid|table)$/.test(layout.display) && px(l) > 8 && px(r) < 2; // a right-aligned control: auto margin on the left
  if (rightAuto) {
    style["margin"] = `${t} 0px ${b} auto`;
    style['width'] = 'max-content';
    style['maxWidth'] = '100%';
  } else if (autoCentred) {
    style['margin'] = `${t} auto ${b} auto`;
    style['width'] = 'max-content';
    style['maxWidth'] = '100%';
  } else if ([t, r, b, l].some((m) => m !== '0px')) style['margin'] = `${t} ${r} ${b} ${l}`;
  if (layout.alignSelf && layout.alignSelf !== 'auto' && layout.alignSelf !== 'normal') style['alignSelf'] = layout.alignSelf;
  if (layout.flexGrow && layout.flexGrow !== '0') style['flexGrow'] = layout.flexGrow;
  // a flex element that aligns its own content (a right-aligned "Read More ↗") and pads it: the replacement's slot keeps both
  if (/flex$/.test(layout.display) && layout.justifyContent && /^(flex-end|end|right|center)$/.test(layout.justifyContent)) style['justifyContent'] = layout.justifyContent === 'center' ? 'center' : 'flex-end';
  if (layout.padding && layout.padding.some((v) => v !== '0px') && /flex$/.test(layout.display)) style['padding'] = layout.padding.join(' ');
  if (layout.fullWidth) style['width'] = '100%';
  // Authored rules own these dimensions at each breakpoint; an inline fallback would defeat them.
  for (const rule of layout.widthRules ?? []) {
    for (const match of rule.body.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)) delete style[cssPropName(match[1]!)];
  }
  return style;
}

/**
 * The original's responsive horizontal padding (`max-sm:px-4`) for the slot of a design-system HEADING that replaced it: the DS heading has no such padding,
 * so at the breakpoint the title touched the screen edge while the text below stayed 16px in. Same selector/media/layer handling as the width rules.
 */
export function islandPaddingCss(sectionId: string, slot: string, layout: ElementLayout): string {
  const target = `[data-pv-section=${q(sectionId)}] > [slot=${q(slot)}]`;
  return (layout.paddingRules ?? []).map((rule) => {
    let css = `:where(${target}):is(${rule.selector}, :where(*)) { ${rule.body} }`;
    for (const group of [...rule.groups].reverse()) css = `${group} { ${css} }`;
    return css;
  }).join('\n');
}

/** Match only this light-DOM island, retaining the source selectors' specificity and media/layer order. */
export function islandWidthCss(sectionId: string, slot: string, layout: ElementLayout): string {
  const target = `[data-pv-section=${q(sectionId)}] > [slot=${q(slot)}]`;
  return (layout.widthRules ?? []).map((rule) => {
    // :where(*) makes the selector match the replacement; :is keeps the original specificity.
    const selector = rule.selector ? `:where(${target}):is(${rule.selector}, :where(*))` : `${target}:not(#pv-inline-width#pv-inline-width)`;
    let css = `${selector} { ${rule.body} }`;
    for (const group of [...rule.groups].reverse()) css = `${group} { ${css} }`;
    return css;
  }).join('\n');
}
