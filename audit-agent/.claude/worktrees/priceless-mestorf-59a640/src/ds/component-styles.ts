import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type SourceFile,
  type TypeNode,
} from 'ts-morph';
import { EXTRACTED_PROPERTIES } from '../t-layer/computed-style.ts';
import { effectiveTokenMap } from './catalog.ts';
import type { DsRegistry } from './d2-registry/index.ts';
import { analyzeUtility, compareBreakpointOrder, cssPropertyDeclarations, parseClass, type UtilityContext } from './tailwind-utilities.ts';

/**
 * Component style models — a D-layer derived view (like catalog.ts) that
 * answers, straight from a DS component's source: what must its ROOT
 * element's rendered styles be, for each variant/size? Every rule traces to
 * a class string or style literal in the real file; nothing is invented.
 *
 * It is a small, conservative data-flow walk (ts-morph over the one file):
 * the props with a string-literal union or boolean type become dimensions,
 * the className/style expressions of the returned JSX root are walked
 * through cn()/clsx(), ternaries, lookup maps (`sizeClass[size]`), local
 * helpers and IIFEs, and every branch is filed under the dimension values
 * that select it. Where the source cannot be read deterministically — a
 * caller-provided className, a condition on a non-dimension prop, a React
 * state the component (or the capture's disclosure clicks) may have changed,
 * a class gated by an element state or position a real instance may be in
 * (disabled:, aria-*, data-*, last:), a box-shadow layer (ring-*), a
 * Tailwind class whose value is unknowable — the property is left without
 * an expectation and the reason is recorded in `notes`. A missing
 * expectation is safe; a wrong one would publish a false deviation.
 */

/**
 * One prop that selects styles. An optional union prop without a default
 * also takes UNSET_VALUE ("(unset)", its default): omitting it is a real
 * state of the component. `$root` (union, no default) is present only when
 * the component renders different root elements.
 */
export interface StyleDimension {
  name: string;
  values: string[];
  defaultValue: string | null;
  kind: 'union' | 'boolean';
}

/** Dimension name → value ('true'/'false' for booleans). */
export type Assignment = Record<string, string>;

export interface StyleRule {
  property: string;
  /**
   * `token` and `literal` are both null when this rule sets the property to a
   * value that cannot be determined statically (`w-full`, a theme shadow, a
   * branch under an unknown condition): it wins like any rule, and when it
   * wins, no expectation is produced for the property.
   */
  token: string | null;
  literal: string | null;
  /** The class token or style expression text. */
  source: string;
  /** Constraints: dim → allowed values (missing dim = any). */
  when: Record<string, string[]>;
  media: { minWidth?: number; maxWidth?: number } | null;
  /** Cascade order; the later rule wins (twMerge / breakpoint order / inline style beats class / !important beats both). */
  order: number;
  origin: 'class' | 'style';
  /**
   * React state taken at its rest value to reach this rule (`isHovering=false`):
   * the rule holds only while nobody is pointing at or focusing the element.
   */
  assumes: string[];
}

export interface ComponentStyleModel {
  /** Catalog file, e.g. "atoms/Button.tsx". */
  file: string;
  component: string;
  dimensions: StyleDimension[];
  /** Rest-state, root-element rules only. */
  rules: StyleRule[];
  /** Every class token that can reach the root className (all branches, state-prefixed ones included) — for class fingerprinting by B3. */
  classTokens: string[];
  /** What could not be resolved, stated. */
  notes: string[];
  /**
   * Present when the component renders different root elements (an `<a>`
   * when `href` is set, a `<button>` otherwise): the `$root` dimension picks
   * one, and each root is only reachable under its own constraints.
   */
  roots?: Array<{
    id: string;
    /** The FIRST tag discovered for this root group — kept for existing callers; prefer `tags`. */
    tag: string;
    /** Every native tag folded into this group (same rules, different tags — e.g. Button's `<a>`/`<button>`). */
    tags: string[];
    when: Array<Record<string, string[]>>;
  }>;
}

// ── Constraint algebra ─────────────────────────────────────────────────────
// A Constraint is a conjunction (dim ∈ allowed values, for every listed dim);
// a Dnf is a disjunction of those ([] = never, [{}] = always). A Tri keeps the
// region where a condition is SURELY true apart from where it MAY be true —
// an unknown condition is surely-nowhere / maybe-everywhere.

type Constraint = Record<string, string[]>;
type Dnf = Constraint[];
interface Tri {
  definite: Dnf;
  possible: Dnf;
  /** React state the condition read at its rest value (`isHovering=false`) — carried into the `why` of the rules it selects. */
  assumes?: string[] | undefined;
}

/** A Tri that also records the rest-state assumptions of `from` (deduplicated, in first-seen order). */
function withAssumes(tri: Tri, ...from: Array<readonly string[] | undefined>): Tri {
  const assumes = [...new Set([...(tri.assumes ?? []), ...from.flatMap((a) => a ?? [])])];
  return assumes.length > 0 ? { ...tri, assumes } : tri;
}

const DNF_CAP = 256;
const ALWAYS: Dnf = [{}];
const NEVER: Dnf = [];
const TRUE_TRI: Tri = { definite: ALWAYS, possible: ALWAYS };
const FALSE_TRI: Tri = { definite: NEVER, possible: NEVER };
const UNKNOWN_TRI: Tri = { definite: NEVER, possible: ALWAYS };

type Domains = ReadonlyMap<string, string[]>;

function constraintKey(c: Constraint): string {
  return JSON.stringify(Object.keys(c).sort().map((k) => [k, c[k]]));
}

/** Intersects two conjunctions; null when they cannot both hold. Dims whose allowed set is the whole domain are dropped. */
function andConstraint(a: Constraint, b: Constraint, domains: Domains): Constraint | null {
  const out: Constraint = {};
  const dims = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const dim of [...dims].sort()) {
    const left = a[dim];
    const right = b[dim];
    let allowed = left && right ? left.filter((v) => right.includes(v)) : (left ?? right ?? []);
    const domain = domains.get(dim);
    if (domain) allowed = domain.filter((v) => allowed.includes(v));
    if (allowed.length === 0) return null;
    if (domain && allowed.length === domain.length) continue;
    out[dim] = allowed;
  }
  return out;
}

function dedupe(dnf: Dnf): Dnf {
  if (dnf.some((c) => Object.keys(c).length === 0)) return ALWAYS;
  const seen = new Map<string, Constraint>();
  for (const c of dnf) seen.set(constraintKey(c), c);
  return [...seen.values()];
}

/** Null when the result would exceed DNF_CAP — callers degrade to "unknown". */
function dnfAnd(a: Dnf, b: Dnf, domains: Domains): Dnf | null {
  const out: Dnf = [];
  for (const x of a) {
    for (const y of b) {
      const c = andConstraint(x, y, domains);
      if (c) out.push(c);
      if (out.length > DNF_CAP) return null;
    }
  }
  return dedupe(out);
}

function dnfOr(a: Dnf, b: Dnf): Dnf | null {
  const out = dedupe([...a, ...b]);
  return out.length > DNF_CAP ? null : out;
}

function dnfNot(a: Dnf, domains: Domains): Dnf | null {
  let result: Dnf | null = ALWAYS;
  for (const conj of a) {
    // ¬(d1 ∈ S1 ∧ d2 ∈ S2) = (d1 ∉ S1) ∨ (d2 ∉ S2)
    const negated: Dnf = [];
    for (const [dim, allowed] of Object.entries(conj)) {
      const domain = domains.get(dim);
      if (!domain) return null;
      const rest = domain.filter((v) => !allowed.includes(v));
      if (rest.length > 0) negated.push({ [dim]: rest });
    }
    if (Object.keys(conj).length === 0) return NEVER;
    result = dnfAnd(result, negated, domains);
    if (result === null) return null;
  }
  return result;
}

function isNever(t: Tri): boolean {
  return t.possible.length === 0;
}

/** True when the condition is fully decided by the dimensions (no unknown part). */
function isExact(t: Tri): boolean {
  const keys = (dnf: Dnf) => dnf.map(constraintKey).sort().join('|');
  return keys(t.definite) === keys(t.possible);
}

// ── Source helpers ─────────────────────────────────────────────────────────

type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;
/** Parameter declaration (compiler node) → the argument it is bound to at the call being walked. */
type Env = ReadonlyMap<ts.Node, { node: Node; env: Env }>;
const EMPTY_ENV: Env = new Map();

type Binding =
  | { kind: 'dim'; dim: string }
  | { kind: 'param'; name: string }
  | { kind: 'expr'; node: Node; env: Env }
  | { kind: 'function'; fn: FunctionLike }
  /** React state; `rest` is its truthiness in the rest state (null: unknown), `restText` the value as written (`false`). */
  | { kind: 'state'; name: string; rest: boolean | null; restText: string }
  | { kind: 'undefined' }
  | { kind: 'unknown'; name: string };

/** 'rules' emits rules; 'indeterminate' emits value-less rules (the branch may or may not apply); 'tokens' only records class tokens. */
type Mode = 'rules' | 'indeterminate' | 'tokens';
interface Walk {
  when: Constraint;
  mode: Mode;
  env: Env;
  depth: number;
  /** Rest-state assumptions taken on the way here (see Tri.assumes). */
  assumed: string[];
}

const MAX_DEPTH = 24;
const CLASS_JOINERS = new Set(['cn', 'clsx', 'classNames', 'classnames', 'cx', 'twMerge', 'twJoin', 'clsxm']);
const COMPONENT_WRAPPERS = /^(React\.)?(forwardRef|memo)$/;
/** React state names the spec treats as interaction state (rest = the falsy branch). */
const STATE_NAME_RE = /hover|focus|active|pressed|open|expanded|loading|disabled|selected|checked|mounted|visible/i;
/** Only these are surely false at rest when their origin is a hook; `mounted`/`visible`/`open` from a hook may well be true. */
const INTERACTION_STATE_RE = /hover|focus|active|pressed/i;
/**
 * DOM handlers that fire only when someone points at, focuses or types into
 * the element — none of which the capture does to an element it is not
 * expanding. onClick/onChange are left out on purpose: the capture clicks
 * tabs, accordions and "Read more" open (t-layer/disclosure.ts). onLoad,
 * onScroll and onAnimation* fire with nobody touching the page.
 */
const INTERACTION_HANDLER_RE = /^on(Mouse(Enter|Leave|Over|Out|Move|Down|Up)|Pointer(Enter|Leave|Over|Out|Move|Down|Up|Cancel)|Focus|Blur|Key(Down|Up|Press)|Touch(Start|End|Move|Cancel)|HoverStart|HoverEnd)(Capture)?$/;
/** A hook whose callback argument is the function itself, not something it runs. */
const CALLBACK_HOOK_RE = /^(React\.)?useCallback$/;
/** React appends `px` to numbers on every extracted property except these. */
const UNITLESS_STYLE = new Set(['opacity', 'font-weight', 'line-height']);
const EXTRACTED_ORDER = new Map<string, number>(EXTRACTED_PROPERTIES.map((p, i) => [p, i]));

function unwrap(node: Node): Node {
  let n = node;
  for (;;) {
    if (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isNonNullExpression(n) || Node.isSatisfiesExpression(n) || Node.isTypeAssertion(n)) {
      n = n.getExpression();
    } else return n;
  }
}

function statementList(node: Node): Node[] {
  return Node.isBlock(node) ? node.getStatements() : [node];
}

/** The node with every wrapping parenthesis / `as` / `!` / `satisfies` around it — what its parent actually holds. */
function outermost(node: Node): Node {
  let n = node;
  for (;;) {
    const parent = n.getParent();
    const wraps = parent && (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isNonNullExpression(parent) || Node.isSatisfiesExpression(parent) || Node.isTypeAssertion(parent));
    if (!wraps) return n;
    n = parent;
  }
}

function sameNode(a: Node | undefined, b: Node): boolean {
  return a !== undefined && a.compilerNode === b.compilerNode;
}

/** A JSX element that renders a DOM element: `<div>`, `<motion.div>`. */
function isDomElement(element: Node | undefined): boolean {
  if (!element || !(Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element))) return false;
  return /^([a-z]|(motion|m)\.[a-z])/.test(element.getTagNameNode().getText());
}

function jsxElementOf(node: Node): Node | undefined {
  return node.getFirstAncestor((a) => Node.isJsxOpeningElement(a) || Node.isJsxSelfClosingElement(a));
}

/** `[deps]` — the dependency list of a hook call, which names values without calling them. */
function isHookDependencyList(array: Node): boolean {
  const call = array.getParent();
  if (!call || !Node.isCallExpression(call)) return false;
  const position = call.getArguments().findIndex((a) => a.compilerNode === array.compilerNode);
  return /^use[A-Z]/.test(call.getExpression().getText().split('.').pop() ?? '') && position > 0;
}

function shortText(node: Node): string {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

/** `backgroundColor` → `background-color`; `WebkitX` → `-webkit-x`; custom properties unchanged. */
function kebab(name: string): string {
  if (name.startsWith('--')) return name;
  const dashed = name.replace(/([A-Z])/g, '-$1').toLowerCase();
  return /^(webkit|moz|ms)-/.test(dashed) ? `-${dashed}` : dashed;
}

function propertyNameText(nameNode: Node): string | null {
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) return nameNode.getLiteralValue();
  if (Node.isNumericLiteral(nameNode)) return nameNode.getText();
  return null;
}

/** useState(x): true/false for a literal initial value, null when it depends on something else. */
function literalTruthiness(node: Node | undefined): boolean | null {
  if (!node) return false;
  const n = unwrap(node);
  if (Node.isTrueLiteral(n)) return true;
  if (Node.isFalseLiteral(n) || Node.isNullLiteral(n)) return false;
  if (Node.isIdentifier(n) && n.getText() === 'undefined') return false;
  if (Node.isNumericLiteral(n)) return Number(n.getLiteralValue()) !== 0;
  if (Node.isStringLiteral(n)) return n.getLiteralValue() !== '';
  return null;
}

interface FoundComponent {
  /** The declaration's own name (`AlertDialog` for ui/alert-dialog.tsx) — what the module exports. */
  name: string;
  fn: FunctionLike;
  /** The props type when it is not written on the parameter (forwardRef<El, Props>, React.FC<Props>). */
  propsType: TypeNode | undefined;
}

/** Unwraps forwardRef(…)/memo(…)/React.* wrappers down to the render function, keeping a props type argument when one is given. */
function unwrapComponent(name: string, node: Node, propsType: TypeNode | undefined): FoundComponent | null {
  const n = unwrap(node);
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n)) return { name, fn: n, propsType };
  if (Node.isCallExpression(n) && COMPONENT_WRAPPERS.test(n.getExpression().getText())) {
    const typeArgs = n.getTypeArguments();
    const wrapperName = n.getExpression().getText();
    const declaredProps = wrapperName.endsWith('forwardRef') ? typeArgs[1] : typeArgs[0];
    const first = n.getArguments()[0];
    return first ? unwrapComponent(name, first, propsType ?? declaredProps) : null;
  }
  return null;
}

/**
 * The render function named like the file (`Button`, `forwardRef(function
 * CTALink…)`, `memo(…)`). shadcn files are kebab/lower case (`ui/alert-dialog.tsx`
 * → `AlertDialog`), so the name is matched without case or dashes when there
 * is no exact match — and the model is named after the declaration that
 * matched, never the file.
 */
function findComponent(sf: SourceFile, fileBase: string): FoundComponent | null {
  const loose = (s: string) => s.replace(/[-_]/g, '').toLowerCase();
  const topLevelNames = [...sf.getFunctions().map((f) => f.getName() ?? ''), ...sf.getVariableDeclarations().map((v) => v.getName())].filter((n) => n !== '');
  const name = topLevelNames.find((n) => n === fileBase) ?? topLevelNames.find((n) => loose(n) === loose(fileBase));
  if (!name) return null;
  const fnDecl = sf.getFunction(name);
  if (fnDecl) return { name, fn: fnDecl, propsType: undefined };
  const varDecl = sf.getVariableDeclaration(name);
  const init = varDecl?.getInitializer();
  if (!varDecl || !init) return null;
  let declaredType: TypeNode | undefined;
  const annotation = varDecl.getTypeNode();
  if (annotation && Node.isTypeReference(annotation)) declaredType = annotation.getTypeArguments()[0];
  return unwrapComponent(name, init, declaredType);
}

// ── Props → dimensions ────────────────────────────────────────────────────

interface DimInfo {
  name: string;
  kind: 'union' | 'boolean';
  values: string[];
  defaultValue: string | null;
  order: number;
  /**
   * An optional boolean prop without a default: omitted, it is `undefined`,
   * which its 'false' value stands for too — so `prop === false` holds for
   * only part of that value (`undefined === false` is false at runtime).
   */
  mayBeUndefined: boolean;
}

type LiteralKind = { kind: 'union'; values: string[] } | { kind: 'boolean' } | null;

/**
 * The value a union dimension takes when an optional prop is omitted and has
 * no default: `undefined` at runtime, a real state of the component
 * (StatCard without `surface` renders no inline surface style).
 */
export const UNSET_VALUE = '(unset)';

interface PropMember {
  type: TypeNode;
  optional: boolean;
}

function addMember(out: Map<string, PropMember>, m: { getName(): string; getTypeNode(): TypeNode | undefined; hasQuestionToken(): boolean }): void {
  const type = m.getTypeNode();
  const key = m.getName().replace(/^['"]|['"]$/g, '');
  if (type && !out.has(key)) out.set(key, { type, optional: m.hasQuestionToken() || /\bundefined\b/.test(type.getText()) });
}

/** A props type's members by name (local interfaces, aliases, intersections, type literals). */
function propMembers(typeNode: TypeNode | undefined, sf: SourceFile, out: Map<string, PropMember>, seen: Set<string>): void {
  if (!typeNode) return;
  if (Node.isIntersectionTypeNode(typeNode)) {
    for (const t of typeNode.getTypeNodes()) propMembers(t, sf, out, seen);
    return;
  }
  if (Node.isParenthesizedTypeNode(typeNode)) {
    propMembers(typeNode.getTypeNode(), sf, out, seen);
    return;
  }
  if (Node.isTypeLiteral(typeNode)) {
    for (const m of typeNode.getProperties()) addMember(out, m);
    return;
  }
  if (Node.isTypeReference(typeNode)) {
    const name = typeNode.getTypeName().getText();
    if (sf.getInterface(name)) interfaceMembers(name, sf, out, seen);
    else if (!seen.has(name)) {
      seen.add(name);
      propMembers(sf.getTypeAlias(name)?.getTypeNode(), sf, out, seen);
    }
  }
}

/** A local interface's own members, then those of the local interfaces it extends (Omit<…> of library types is skipped). */
function interfaceMembers(name: string, sf: SourceFile, out: Map<string, PropMember>, seen: Set<string>): void {
  const iface = sf.getInterface(name);
  if (!iface || seen.has(name)) return;
  seen.add(name);
  for (const m of iface.getProperties()) addMember(out, m);
  for (const ext of iface.getExtends()) interfaceMembers(ext.getExpression().getText(), sf, out, seen);
}

/** A member type as a dimension domain: a string-literal union (through local aliases, Exclude/Extract) or boolean. */
function literalKind(typeNode: TypeNode | undefined, sf: SourceFile, seen: Set<string> = new Set()): LiteralKind {
  if (!typeNode) return null;
  if (Node.isParenthesizedTypeNode(typeNode)) return literalKind(typeNode.getTypeNode(), sf, seen);
  if (typeNode.getKind() === SyntaxKind.BooleanKeyword) return { kind: 'boolean' };
  if (Node.isLiteralTypeNode(typeNode)) {
    const lit = typeNode.getLiteral();
    if (Node.isStringLiteral(lit)) return { kind: 'union', values: [lit.getLiteralValue()] };
    if (Node.isTrueLiteral(lit) || Node.isFalseLiteral(lit)) return { kind: 'boolean' };
    return null;
  }
  if (Node.isUnionTypeNode(typeNode)) {
    const values: string[] = [];
    let booleans = false;
    for (const part of typeNode.getTypeNodes()) {
      if (part.getKind() === SyntaxKind.UndefinedKeyword) continue;
      if (Node.isLiteralTypeNode(part) && Node.isNullLiteral(part.getLiteral())) continue;
      const k = literalKind(part, sf, seen);
      if (!k) return null;
      if (k.kind === 'boolean') booleans = true;
      else values.push(...k.values.filter((v) => !values.includes(v)));
    }
    if (booleans && values.length > 0) return null; // `boolean | 'mixed'` is neither
    if (booleans) return { kind: 'boolean' };
    return values.length > 0 ? { kind: 'union', values } : null;
  }
  if (Node.isTypeReference(typeNode)) {
    const name = typeNode.getTypeName().getText();
    const args = typeNode.getTypeArguments();
    if ((name === 'Exclude' || name === 'Extract') && args.length === 2) {
      const base = literalKind(args[0], sf, seen);
      const cut = literalKind(args[1], sf, seen);
      if (!base || base.kind !== 'union' || !cut || cut.kind !== 'union') return null;
      const values = name === 'Exclude' ? base.values.filter((v) => !cut.values.includes(v)) : base.values.filter((v) => cut.values.includes(v));
      return { kind: 'union', values };
    }
    if (seen.has(name)) return null;
    seen.add(name);
    return literalKind(sf.getTypeAlias(name)?.getTypeNode(), sf, seen);
  }
  return null;
}

// ── The walk ──────────────────────────────────────────────────────────────

interface RawRule {
  property: string;
  token: string | null;
  literal: string | null;
  source: string;
  when: Constraint;
  media: { minWidth?: number; maxWidth?: number } | null;
  origin: 'class' | 'style';
  important: boolean;
  /** The class's variant prefixes — its breakpoints decide its place among breakpoint rules ([] for inline style). */
  variants: readonly string[];
  /**
   * A value-less class rule that, whenever it applies, decides the property
   * over every plain class whatever the class order: a class behind an
   * element-state/structural/unknown variant (extra specificity, or a later
   * place in the stylesheet), or a ring/shadow-color layer composed into
   * box-shadow. Ranked above all other class rules, below inline style.
   */
  overridesClasses: boolean;
  assumed: string[];
  seq: number;
}

interface NodeInEnv {
  node: Node;
  env: Env;
}

interface RootInfo {
  /** The DOM tag it renders (`div` for `<motion.div>`, the `as` default for a polymorphic root). */
  tag: string;
  /** The tag as written in the source. */
  label: string;
  className: NodeInEnv | null;
  style: NodeInEnv | null;
  /** framer-motion `initial` / `animate` / `whileInView` / `exit` / `variants` on a motion.* root. */
  motion: Array<{ name: string; value: NodeInEnv }>;
  reach: Tri;
  signature: string;
}

const MOTION_ATTRIBUTES = new Set(['initial', 'animate', 'whileInView', 'exit', 'variants']);

interface Flow {
  returns: Array<{ node: Node | undefined; reach: Tri }>;
  fallthrough: Tri;
  breaks: Tri;
}

type Scalar = { kind: 'dim'; dim: string } | { kind: 'literal'; value: string; type: 'string' | 'boolean' | 'number' } | { kind: 'undefined' } | { kind: 'unknown' };
type IndexKey = { kind: 'dim'; dim: string } | { kind: 'literal'; value: string };
/** One value a lookup (`map[size]`) can produce, with the constraints and rest-state assumptions that select it. */
interface Alternative {
  when: Constraint;
  node: Node;
  env: Env;
  assumed: string[];
}

class ModelBuilder {
  readonly file: string;
  readonly component: string;
  readonly sf: SourceFile;
  readonly ctx: UtilityContext;
  readonly dims = new Map<string, DimInfo>();
  readonly domains = new Map<string, string[]>();
  /** Destructured prop binding (compiler node) → the prop it reads and its dimension, if any. */
  readonly propBindings = new Map<ts.Node, { prop: string; dim: string | null }>();
  propsParam: ts.Node | null = null;
  readonly rules: RawRule[] = [];
  readonly classTokens = new Set<string>();
  readonly notes = new Set<string>();
  readonly localVars = new Set<string>();
  readonly resolving = new Set<ts.Node>();
  readonly calling = new Set<ts.Node>();
  /** The component's render function — a setter called while it runs is not reacting to anyone. */
  readonly componentFn: FunctionLike;
  identifiersByName: Map<string, Node[]> | null = null;
  /** useState pattern (compiler node) → whether its initial value is its rest value (see stateSettled). */
  readonly settledStates = new Map<ts.Node, boolean>();
  seq = 0;

  constructor(file: string, sf: SourceFile, ctx: UtilityContext, found: FoundComponent) {
    this.file = file;
    this.component = found.name;
    this.componentFn = found.fn;
    this.sf = sf;
    this.ctx = ctx;
  }

  note(text: string): void {
    this.notes.add(text);
  }

  // ── Tri helpers bound to this component's dimension domains ──

  and(a: Tri, b: Tri): Tri {
    const t = { definite: dnfAnd(a.definite, b.definite, this.domains) ?? NEVER, possible: dnfAnd(a.possible, b.possible, this.domains) ?? ALWAYS };
    return withAssumes(t, a.assumes, b.assumes);
  }

  or(a: Tri, b: Tri): Tri {
    const t = { definite: dnfOr(a.definite, b.definite) ?? NEVER, possible: dnfOr(a.possible, b.possible) ?? ALWAYS };
    return withAssumes(t, a.assumes, b.assumes);
  }

  not(a: Tri): Tri {
    const t = { definite: dnfNot(a.possible, this.domains) ?? NEVER, possible: dnfNot(a.definite, this.domains) ?? ALWAYS };
    return withAssumes(t, a.assumes);
  }

  /**
   * The walks a branch gets under condition `tri`: rules where it surely
   * holds, value-less rules where it only may hold, and — when it can never
   * hold at rest (a hover branch) — a tokens-only walk so B3 still sees its
   * classes. Rest-state assumptions the condition made travel with them.
   */
  branches(tri: Tri, w: Walk): Walk[] {
    const base: Dnf = [w.when];
    const doubtful: Mode = w.mode === 'tokens' ? 'tokens' : 'indeterminate';
    const assumed = tri.assumes ? [...new Set([...w.assumed, ...tri.assumes])] : w.assumed;
    const sure = dnfAnd(base, tri.definite, this.domains);
    const possible = dnfAnd(base, tri.possible, this.domains);
    const notSure = dnfNot(tri.definite, this.domains);
    const maybe = possible && notSure ? dnfAnd(possible, notSure, this.domains) : null;
    if (sure === null || maybe === null) return [{ ...w, mode: doubtful, assumed }];
    const out: Walk[] = [];
    for (const c of sure) out.push({ ...w, when: c, assumed });
    for (const c of maybe) out.push({ ...w, when: c, mode: doubtful, assumed });
    if (out.length === 0) out.push({ ...w, mode: 'tokens', assumed });
    return out;
  }

  // ── Dimensions ──

  collectDims(found: FoundComponent): void {
    const param = found.fn.getParameters()[0];
    if (!param) return;
    const members = new Map<string, PropMember>();
    propMembers(param.getTypeNode() ?? found.propsType, this.sf, members, new Set());

    const patterns: Node[] = [];
    const nameNode = param.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) patterns.push(nameNode);
    else if (Node.isIdentifier(nameNode)) {
      // function X(props) { const { variant = 'a' } = props; … }
      this.propsParam = param.compilerNode;
      const body = found.fn.getBody();
      if (body && Node.isBlock(body)) {
        for (const decl of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
          const init = decl.getInitializer();
          const pattern = decl.getNameNode();
          if (init && Node.isIdentifier(init) && init.getText() === nameNode.getText() && Node.isObjectBindingPattern(pattern)) patterns.push(pattern);
        }
      }
    }

    let order = 0;
    for (const pattern of patterns) {
      if (!Node.isObjectBindingPattern(pattern)) continue;
      for (const element of pattern.getElements()) {
        const local = element.getNameNode();
        if (!Node.isIdentifier(local)) continue;
        if (element.getDotDotDotToken()) {
          this.propBindings.set(element.compilerNode, { prop: `...${local.getText()}`, dim: null });
          continue;
        }
        const propNode = element.getPropertyNameNode();
        const prop = propNode ? (propertyNameText(propNode) ?? local.getText()) : local.getText();
        const member = members.get(prop);
        const kind = literalKind(member?.type, this.sf);
        const init = element.getInitializer();
        const initValue = init ? unwrap(init) : undefined;
        let dim: DimInfo | null = null;
        if (kind?.kind === 'union') {
          const def = initValue && (Node.isStringLiteral(initValue) || Node.isNoSubstitutionTemplateLiteral(initValue)) ? initValue.getLiteralValue() : null;
          if (def !== null && kind.values.includes(def)) dim = { name: prop, kind: 'union', values: kind.values, defaultValue: def, order: order++, mayBeUndefined: false };
          else if (!init && member?.optional) dim = { name: prop, kind: 'union', values: [...kind.values, UNSET_VALUE], defaultValue: UNSET_VALUE, order: order++, mayBeUndefined: false };
          else dim = { name: prop, kind: 'union', values: kind.values, defaultValue: null, order: order++, mayBeUndefined: false };
        } else if (kind?.kind === 'boolean' || (!kind && initValue && (Node.isTrueLiteral(initValue) || Node.isFalseLiteral(initValue)))) {
          const def = initValue && Node.isTrueLiteral(initValue) ? 'true' : 'false';
          const mayBeUndefined = !init && member?.optional === true;
          dim = { name: prop, kind: 'boolean', values: ['false', 'true'], defaultValue: def, order: order++, mayBeUndefined };
        }
        if (dim) {
          this.dims.set(dim.name, dim);
          this.domains.set(dim.name, dim.values);
        }
        this.propBindings.set(element.compilerNode, { prop, dim: dim ? dim.name : null });
      }
    }

    // With an un-destructured props object, any member can be read as `props.x` — each typed one is a dimension too.
    if (this.propsParam === null) return;
    for (const [prop, member] of members) {
      if (this.dims.has(prop)) continue;
      const kind = literalKind(member.type, this.sf);
      let dim: DimInfo | null = null;
      if (kind?.kind === 'union') {
        dim = member.optional
          ? { name: prop, kind: 'union', values: [...kind.values, UNSET_VALUE], defaultValue: UNSET_VALUE, order: order++, mayBeUndefined: false }
          : { name: prop, kind: 'union', values: kind.values, defaultValue: null, order: order++, mayBeUndefined: false };
      } else if (kind?.kind === 'boolean') {
        dim = { name: prop, kind: 'boolean', values: ['false', 'true'], defaultValue: 'false', order: order++, mayBeUndefined: member.optional };
      }
      if (!dim) continue;
      this.dims.set(dim.name, dim);
      this.domains.set(dim.name, dim.values);
    }
  }

  // ── Name resolution ──

  resolve(node: Node, env: Env): Binding {
    if (Node.isShorthandPropertyAssignment(node)) {
      const decl = node.getValueSymbol()?.getDeclarations()[0];
      return decl ? this.bindingOf(decl, node.getName(), env) : { kind: 'unknown', name: node.getName() };
    }
    const name = node.getText();
    if (name === 'undefined') return { kind: 'undefined' };
    if (!Node.isIdentifier(node)) return { kind: 'unknown', name };
    const decl = node.getSymbol()?.getDeclarations()[0];
    return decl ? this.bindingOf(decl, name, env) : { kind: 'unknown', name };
  }

  bindingOf(decl: Node, name: string, env: Env): Binding {
    const prop = this.propBindings.get(decl.compilerNode);
    if (prop) return prop.dim ? { kind: 'dim', dim: prop.dim } : { kind: 'param', name: prop.prop };
    if (Node.isParameterDeclaration(decl)) {
      const bound = env.get(decl.compilerNode);
      if (bound) return { kind: 'expr', node: bound.node, env: bound.env };
      return { kind: 'param', name };
    }
    if (Node.isBindingElement(decl)) {
      const pattern = decl.getParent();
      const varDecl = pattern.getParent();
      const init = Node.isVariableDeclaration(varDecl) ? varDecl.getInitializer() : undefined;
      const call = init ? unwrap(init) : undefined;
      if (call && Node.isCallExpression(call)) {
        const callee = call.getExpression().getText();
        if (Node.isArrayBindingPattern(pattern) && /(^|\.)useState$/.test(callee) && sameNode(pattern.getElements()[0], decl)) {
          const initial = call.getArguments()[0];
          const restText = initial ? shortText(initial) : 'undefined';
          let settled = this.settledStates.get(pattern.compilerNode);
          if (settled === undefined) {
            settled = this.stateSettled(name, pattern.getElements()[1]);
            this.settledStates.set(pattern.compilerNode, settled);
          }
          return { kind: 'state', name, rest: settled ? literalTruthiness(initial) : null, restText };
        }
        if (Node.isObjectBindingPattern(pattern) && /^use[A-Z]/.test(callee.split('.').pop() ?? '') && STATE_NAME_RE.test(name)) {
          return { kind: 'state', name, rest: INTERACTION_STATE_RE.test(name) ? false : null, restText: 'false' };
        }
      }
      return { kind: 'unknown', name };
    }
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (!init) return { kind: 'unknown', name };
      const inner = unwrap(init);
      if (Node.isArrowFunction(inner) || Node.isFunctionExpression(inner)) return { kind: 'function', fn: inner };
      return { kind: 'expr', node: init, env };
    }
    if (Node.isFunctionDeclaration(decl)) return { kind: 'function', fn: decl };
    return { kind: 'unknown', name };
  }

  // ── React state: is its initial value the rest value? ──

  /**
   * Whether a `useState` keeps its initial value in the rest state the audit
   * captures. Only when nothing else can change it: its setter is never used,
   * or it is an interaction state (hover/focus/active/pressed — the spec's
   * rest-at-falsy states) whose setter only runs from pointer, focus or
   * keyboard handlers on DOM elements. A state set from an effect, an onLoad,
   * a scroll listener or an observer (RevealImage's `loaded`, BackToTop's
   * `visible`) is past its initial value on a live page, whatever its name —
   * its branches are then unknown, never read at the initial value.
   */
  stateSettled(name: string, setterElement: Node | undefined): boolean {
    let uses: Node[];
    if (!setterElement || Node.isOmittedExpression(setterElement)) uses = [];
    else if (Node.isBindingElement(setterElement) && !setterElement.getDotDotDotToken() && Node.isIdentifier(setterElement.getNameNode())) {
      uses = this.usesOf(setterElement.getNameNode());
    } else return false; // the setter is handed on in a form this walk does not follow
    if (uses.length === 0) return true;
    return INTERACTION_STATE_RE.test(name) && uses.every((use) => this.interactiveUse(use, 0));
  }

  /**
   * Every identifier in the file that may refer to the same declaration as
   * `nameNode` (itself excluded). One that resolves to a different
   * declaration (a shadowing parameter, another object's property) is left
   * out; one that does not resolve, or a `{ setX }` shorthand handing it on,
   * is kept — so it can only make the answer more cautious.
   */
  usesOf(nameNode: Node): Node[] {
    if (!this.identifiersByName) {
      this.identifiersByName = new Map();
      for (const id of this.sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const list = this.identifiersByName.get(id.getText()) ?? [];
        list.push(id);
        this.identifiersByName.set(id.getText(), list);
      }
    }
    const declaration = nameNode.getSymbol()?.getDeclarations()[0];
    return (this.identifiersByName.get(nameNode.getText()) ?? []).filter((id) => {
      if (id.compilerNode === nameNode.compilerNode) return false;
      if (Node.isShorthandPropertyAssignment(id.getParent())) return true;
      const target = id.getSymbol()?.getDeclarations()[0];
      return target === undefined || declaration === undefined || target.compilerNode === declaration.compilerNode;
    });
  }

  /** One use of a setter or handler: a DOM interaction handler itself, a hook dependency, or a call made from an interaction handler. */
  interactiveUse(use: Node, depth: number): boolean {
    if (depth > 8) return false;
    if (this.inInteractionSlot(use)) return true;
    const outer = outermost(use);
    const parent = outer.getParent();
    if (!parent) return false;
    if (Node.isArrayLiteralExpression(parent) && isHookDependencyList(parent)) return true;
    if (Node.isCallExpression(parent) && sameNode(parent.getExpression(), outer)) {
      const fn = this.enclosingFunction(parent);
      return fn !== null && this.interactiveFunction(fn, depth + 1);
    }
    return false;
  }

  /** The function whose body contains `node`; null when that is the component's own render (a call during render). */
  enclosingFunction(node: Node): Node | null {
    const fn = node.getFirstAncestor((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a) || Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a));
    if (!fn || fn.compilerNode === this.componentFn.compilerNode) return null;
    return fn;
  }

  /** A function runs only on interaction when it IS an interaction handler, or is bound or handed only to code that is. */
  interactiveFunction(fn: Node, depth: number): boolean {
    if (depth > 8) return false;
    if (this.inInteractionSlot(fn)) return true;
    if (Node.isFunctionDeclaration(fn)) {
      const name = fn.getNameNode();
      return name !== undefined && this.usesOf(name).every((use) => this.interactiveUse(use, depth + 1));
    }
    if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return false;
    return this.interactiveValue(fn, depth + 1);
  }

  /**
   * A function value — or `useCallback(fn)` — runs when what it is bound or
   * handed to runs: a const bound to it, every use of which is interactive;
   * a callback given to a timer or listener inside an interactive function.
   * An effect, and any other hook, runs it with nobody touching the page.
   */
  interactiveValue(value: Node, depth: number): boolean {
    if (depth > 8) return false;
    if (this.inInteractionSlot(value)) return true;
    const outer = outermost(value);
    const parent = outer.getParent();
    if (!parent) return false;
    if (Node.isVariableDeclaration(parent) && sameNode(parent.getInitializer(), outer)) {
      const name = parent.getNameNode();
      return Node.isIdentifier(name) && this.usesOf(name).every((use) => this.interactiveUse(use, depth + 1));
    }
    if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && (parent.getArguments() as Node[]).some((arg) => sameNode(arg, outer))) {
      const callee = parent.getExpression().getText();
      if (CALLBACK_HOOK_RE.test(callee)) return this.interactiveValue(parent, depth + 1);
      if (/^use[A-Z]/.test(callee.split('.').pop() ?? '')) return false;
      const fn = this.enclosingFunction(parent);
      return fn !== null && this.interactiveFunction(fn, depth + 1);
    }
    return false;
  }

  /**
   * `onMouseEnter={…}` on a DOM element, or `{ onMouseEnter: … }` in a props
   * object spread only onto DOM elements (Button's `<a {...sharedProps}>`).
   */
  inInteractionSlot(node: Node): boolean {
    const outer = outermost(node);
    const parent = outer.getParent();
    if (!parent) return false;
    if (Node.isJsxExpression(parent)) {
      const attribute = parent.getParent();
      if (!attribute || !Node.isJsxAttribute(attribute)) return false;
      return INTERACTION_HANDLER_RE.test(attribute.getNameNode().getText()) && isDomElement(jsxElementOf(attribute));
    }
    if (Node.isPropertyAssignment(parent) && sameNode(parent.getInitializer(), outer)) {
      const key = propertyNameText(parent.getNameNode());
      const object = parent.getParent();
      return key !== null && INTERACTION_HANDLER_RE.test(key) && Node.isObjectLiteralExpression(object) && this.spreadOnlyOntoDom(object);
    }
    return false;
  }

  spreadOnlyOntoDom(object: Node): boolean {
    const outer = outermost(object);
    const parent = outer.getParent();
    const onDom = (spread: Node | undefined) => spread !== undefined && Node.isJsxSpreadAttribute(spread) && isDomElement(jsxElementOf(spread));
    if (onDom(parent)) return true;
    if (!parent || !Node.isVariableDeclaration(parent) || !sameNode(parent.getInitializer(), outer)) return false;
    const name = parent.getNameNode();
    if (!Node.isIdentifier(name)) return false;
    const uses = this.usesOf(name);
    return uses.length > 0 && uses.every((use) => onDom(outermost(use).getParent()));
  }

  /** `props.variant` when the component takes an un-destructured props object. */
  propsMember(node: Node, env: Env): Binding | null {
    if (!Node.isPropertyAccessExpression(node) || this.propsParam === null) return null;
    const target = unwrap(node.getExpression());
    if (!Node.isIdentifier(target)) return null;
    const decl = target.getSymbol()?.getDeclarations()[0];
    if (!decl || decl.compilerNode !== this.propsParam || env.has(decl.compilerNode)) return null;
    const dim = this.dims.get(node.getName());
    return dim ? { kind: 'dim', dim: dim.name } : { kind: 'param', name: `props.${node.getName()}` };
  }

  /** A resolution with a recursion guard on the declaration being followed. */
  follow<T>(node: Node, fallback: T, fn: () => T): T {
    const key = node.compilerNode;
    if (this.resolving.has(key)) return fallback;
    this.resolving.add(key);
    try {
      return fn();
    } finally {
      this.resolving.delete(key);
    }
  }

  // ── Conditions ──

  /** What a condition says about the dimensions, with React state taken at rest. */
  cond(node: Node, env: Env, depth = 0): Tri {
    if (depth > MAX_DEPTH) return UNKNOWN_TRI;
    const n = unwrap(node);
    if (Node.isTrueLiteral(n)) return TRUE_TRI;
    if (Node.isFalseLiteral(n) || Node.isNullLiteral(n)) return FALSE_TRI;
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralValue() ? TRUE_TRI : FALSE_TRI;
    if (Node.isNumericLiteral(n)) return Number(n.getLiteralValue()) !== 0 ? TRUE_TRI : FALSE_TRI;
    if (Node.isPrefixUnaryExpression(n) && n.getOperatorToken() === SyntaxKind.ExclamationToken) return this.not(this.cond(n.getOperand(), env, depth + 1));
    if (Node.isBinaryExpression(n)) {
      const op = n.getOperatorToken().getKind();
      if (op === SyntaxKind.AmpersandAmpersandToken) return this.and(this.cond(n.getLeft(), env, depth + 1), this.cond(n.getRight(), env, depth + 1));
      if (op === SyntaxKind.BarBarToken) return this.or(this.cond(n.getLeft(), env, depth + 1), this.cond(n.getRight(), env, depth + 1));
      if (op === SyntaxKind.EqualsEqualsEqualsToken || op === SyntaxKind.EqualsEqualsToken) return this.equality(n.getLeft(), n.getRight(), env);
      if (op === SyntaxKind.ExclamationEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsToken) return this.not(this.equality(n.getLeft(), n.getRight(), env));
      return UNKNOWN_TRI;
    }
    if (Node.isConditionalExpression(n)) {
      const test = this.cond(n.getCondition(), env, depth + 1);
      return this.or(this.and(test, this.cond(n.getWhenTrue(), env, depth + 1)), this.and(this.not(test), this.cond(n.getWhenFalse(), env, depth + 1)));
    }
    if (Node.isCallExpression(n) && n.getExpression().getText() === 'Boolean' && n.getArguments().length === 1) {
      return this.cond(n.getArguments()[0] as Node, env, depth + 1);
    }
    const binding = Node.isIdentifier(n) ? this.resolve(n, env) : this.propsMember(n, env);
    if (!binding) return UNKNOWN_TRI;
    switch (binding.kind) {
      case 'dim': {
        const dim = this.dims.get(binding.dim) as DimInfo;
        if (dim.kind === 'boolean') return { definite: [{ [dim.name]: ['true'] }], possible: [{ [dim.name]: ['true'] }] };
        // A union prop is truthy whenever it is set to a non-empty value; with a default (or required) it always is.
        const truthy = dim.values.filter((v) => v !== UNSET_VALUE && v !== '');
        if (truthy.length === dim.values.length) return TRUE_TRI;
        return { definite: [{ [dim.name]: truthy }], possible: [{ [dim.name]: truthy }] };
      }
      case 'state':
        if (binding.rest === null) return UNKNOWN_TRI;
        return withAssumes(binding.rest ? TRUE_TRI : FALSE_TRI, [`${binding.name}=${binding.restText}`]);
      case 'expr':
        return this.follow(binding.node, UNKNOWN_TRI, () => this.cond(binding.node, binding.env, depth + 1));
      case 'undefined':
        return FALSE_TRI;
      case 'function':
        return TRUE_TRI;
      case 'unknown':
        if (INTERACTION_STATE_RE.test(binding.name)) return withAssumes(FALSE_TRI, [`${binding.name}=false`]);
        return UNKNOWN_TRI;
      default:
        return UNKNOWN_TRI;
    }
  }

  scalar(node: Node, env: Env, depth = 0): Scalar {
    if (depth > MAX_DEPTH) return { kind: 'unknown' };
    const n = unwrap(node);
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return { kind: 'literal', value: n.getLiteralValue(), type: 'string' };
    if (Node.isTrueLiteral(n)) return { kind: 'literal', value: 'true', type: 'boolean' };
    if (Node.isFalseLiteral(n)) return { kind: 'literal', value: 'false', type: 'boolean' };
    if (Node.isNumericLiteral(n)) return { kind: 'literal', value: n.getText(), type: 'number' };
    const binding = Node.isIdentifier(n) ? this.resolve(n, env) : this.propsMember(n, env);
    if (!binding) return { kind: 'unknown' };
    if (binding.kind === 'dim') return { kind: 'dim', dim: binding.dim };
    if (binding.kind === 'undefined') return { kind: 'undefined' };
    if (binding.kind === 'expr') return this.follow(binding.node, { kind: 'unknown' } as Scalar, () => this.scalar(binding.node, binding.env, depth + 1));
    return { kind: 'unknown' };
  }

  /**
   * `dim === 'x'` (either side, through aliases) → dim ∈ {x}; two literals →
   * a constant; anything else is unknown. Strict equality never crosses
   * types: a boolean prop is never `'true'`, a union of strings never `1`.
   */
  equality(left: Node, right: Node, env: Env): Tri {
    const a = this.scalar(left, env);
    const b = this.scalar(right, env);
    const dimSide = a.kind === 'dim' ? a : b.kind === 'dim' ? b : null;
    const other = dimSide === a ? b : a;
    if (dimSide && dimSide.kind === 'dim') {
      const dim = this.dims.get(dimSide.dim) as DimInfo;
      // An omitted optional boolean is `undefined`, which its 'false' value also stands for: `=== false` and
      // `=== undefined` hold for only part of that value — possibly, never surely. `=== true` stays exact.
      const partOfFalse: Tri = { definite: NEVER, possible: [{ [dim.name]: ['false'] }] };
      if (other.kind === 'literal') {
        const valueType = dim.kind === 'boolean' ? 'boolean' : 'string';
        if (other.type !== valueType || !dim.values.includes(other.value)) return FALSE_TRI;
        if (dim.kind === 'boolean' && dim.mayBeUndefined && other.value === 'false') return partOfFalse;
        return { definite: [{ [dim.name]: [other.value] }], possible: [{ [dim.name]: [other.value] }] };
      }
      // Only an optional prop without a default is ever undefined — for a union that is its UNSET_VALUE.
      if (other.kind === 'undefined') {
        if (dim.values.includes(UNSET_VALUE)) return { definite: [{ [dim.name]: [UNSET_VALUE] }], possible: [{ [dim.name]: [UNSET_VALUE] }] };
        return dim.kind === 'boolean' && dim.mayBeUndefined ? partOfFalse : FALSE_TRI;
      }
      return UNKNOWN_TRI;
    }
    if (a.kind === 'literal' && b.kind === 'literal') return a.value === b.value && a.type === b.type ? TRUE_TRI : FALSE_TRI;
    return UNKNOWN_TRI;
  }

  // ── Control flow: which return statements are reached, under what ──

  flow(statements: Node[], reach: Tri, env: Env): Flow {
    const returns: Flow['returns'] = [];
    let breaks = FALSE_TRI;
    let current = reach;
    for (const s of statements) {
      if (isNever(current)) break;
      if (Node.isReturnStatement(s)) {
        returns.push({ node: s.getExpression(), reach: current });
        current = FALSE_TRI;
        break;
      }
      if (Node.isThrowStatement(s)) {
        current = FALSE_TRI;
        break;
      }
      if (Node.isBreakStatement(s) || s.getKind() === SyntaxKind.ContinueStatement) {
        breaks = this.or(breaks, current);
        current = FALSE_TRI;
        break;
      }
      if (Node.isBlock(s)) {
        const inner = this.flow(s.getStatements(), current, env);
        returns.push(...inner.returns);
        breaks = this.or(breaks, inner.breaks);
        current = inner.fallthrough;
        continue;
      }
      if (Node.isIfStatement(s)) {
        const test = this.cond(s.getExpression(), env);
        const thenFlow = this.flow(statementList(s.getThenStatement()), this.and(current, test), env);
        const elseStatement = s.getElseStatement();
        const elseReach = this.and(current, this.not(test));
        const elseFlow = elseStatement ? this.flow(statementList(elseStatement), elseReach, env) : { returns: [], fallthrough: elseReach, breaks: FALSE_TRI };
        returns.push(...thenFlow.returns, ...elseFlow.returns);
        breaks = this.or(breaks, this.or(thenFlow.breaks, elseFlow.breaks));
        current = this.or(thenFlow.fallthrough, elseFlow.fallthrough);
        continue;
      }
      if (Node.isSwitchStatement(s)) {
        const inner = this.switchFlow(s, current, env);
        returns.push(...inner.returns);
        current = inner.fallthrough;
        continue;
      }
      if (Node.isTryStatement(s)) {
        const inner = this.flow(s.getTryBlock().getStatements(), current, env);
        returns.push(...inner.returns);
        const catchBlock = s.getCatchClause()?.getBlock();
        if (catchBlock) returns.push(...this.flow(catchBlock.getStatements(), this.and(current, UNKNOWN_TRI), env).returns);
        current = catchBlock ? this.or(inner.fallthrough, this.and(current, UNKNOWN_TRI)) : inner.fallthrough;
        continue;
      }
      if (Node.isIterationStatement(s) || Node.isLabeledStatement(s)) {
        // A loop body may run any number of times: its returns are possible, never sure.
        const body = s.getStatement();
        returns.push(...this.flow(statementList(body), this.and(current, UNKNOWN_TRI), env).returns);
        continue;
      }
    }
    return { returns, fallthrough: current, breaks };
  }

  switchFlow(s: Node, reach: Tri, env: Env): Flow {
    if (!Node.isSwitchStatement(s)) return { returns: [], fallthrough: reach, breaks: FALSE_TRI };
    const discriminant = s.getExpression();
    const clauses = s.getCaseBlock().getClauses();
    const labels = clauses.map((clause) => (Node.isCaseClause(clause) ? this.equality(discriminant, clause.getExpression(), env) : null));
    let anyLabel = FALSE_TRI;
    for (const label of labels) if (label) anyLabel = this.or(anyLabel, label);
    const returns: Flow['returns'] = [];
    let fall = FALSE_TRI;
    let breaks = FALSE_TRI;
    let hasDefault = false;
    clauses.forEach((clause, i) => {
      const label = labels[i];
      const entry = label ? this.and(reach, label) : this.and(reach, this.not(anyLabel));
      if (!label) hasDefault = true;
      const inner = this.flow(clause.getStatements(), this.or(fall, entry), env);
      returns.push(...inner.returns);
      breaks = this.or(breaks, inner.breaks);
      fall = inner.fallthrough;
    });
    const after = this.or(this.or(breaks, fall), hasDefault ? FALSE_TRI : this.and(reach, this.not(anyLabel)));
    return { returns, fallthrough: after, breaks: FALSE_TRI };
  }

  // ── Roots ──

  roots(fn: FunctionLike): RootInfo[] {
    const found: Array<{ node: Node; reach: Tri }> = [];
    const body = fn.getBody();
    if (body && Node.isBlock(body)) {
      for (const r of this.flow(body.getStatements(), TRUE_TRI, EMPTY_ENV).returns) if (r.node) found.push({ node: r.node, reach: r.reach });
    } else if (body) found.push({ node: body, reach: TRUE_TRI });
    const out: RootInfo[] = [];
    for (const f of found) this.rootsFrom(f.node, f.reach, EMPTY_ENV, out, 0);
    return out;
  }

  rootsFrom(node: Node, reach: Tri, env: Env, out: RootInfo[], depth: number): void {
    if (depth > 8 || isNever(reach)) return;
    const n = unwrap(node);
    if (Node.isJsxElement(n)) {
      out.push(this.rootInfo(n.getOpeningElement(), reach, env));
    } else if (Node.isJsxSelfClosingElement(n)) {
      out.push(this.rootInfo(n, reach, env));
    } else if (Node.isJsxFragment(n)) {
      this.note(`${this.component} returns a Fragment: there is no single root element — its children are not modeled`);
    } else if (Node.isConditionalExpression(n)) {
      const test = this.cond(n.getCondition(), env);
      this.rootsFrom(n.getWhenTrue(), this.and(reach, test), env, out, depth + 1);
      this.rootsFrom(n.getWhenFalse(), this.and(reach, this.not(test)), env, out, depth + 1);
    } else if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
      this.rootsFrom(n.getRight(), this.and(reach, this.cond(n.getLeft(), env)), env, out, depth + 1);
    } else if (Node.isIdentifier(n)) {
      const binding = this.resolve(n, env);
      if (binding.kind === 'expr') this.follow(binding.node, undefined, () => this.rootsFrom(binding.node, reach, binding.env, out, depth + 1));
      else if (binding.kind !== 'undefined') this.note(`${this.component} returns \`${n.getText()}\`, which is not a JSX element in this file — not modeled`);
    } else if (!Node.isNullLiteral(n)) {
      this.note(`${this.component} returns a non-JSX expression (${shortText(n)}) — not modeled`);
    }
  }

  rootInfo(opening: JsxOpeningElement | JsxSelfClosingElement, reach: Tri, env: Env): RootInfo {
    const tagNode = opening.getTagNameNode();
    let tag = tagNode.getText();
    let isComponent = false;
    const isMotion = /^(motion|m)\.[a-z]/.test(tag);
    if (isMotion) {
      tag = tag.split('.')[1] as string;
    } else if (/^[a-z]/.test(tag)) {
      // a DOM element
    } else if (Node.isIdentifier(tagNode)) {
      // Polymorphic `as: Component = 'div'` renders a DOM element named by the prop.
      const binding = this.resolve(tagNode, env);
      const dim = binding.kind === 'dim' ? this.dims.get(binding.dim) : undefined;
      if (dim?.defaultValue && /^[a-z]/.test(dim.defaultValue)) tag = dim.defaultValue;
      else if (binding.kind === 'param' && /^[A-Z]/.test(tag) && this.propDefaultIsDomTag(tagNode)) tag = this.propDefaultIsDomTag(tagNode) as string;
      else isComponent = true;
    } else isComponent = true;
    if (isComponent) {
      this.note(`root <${tag}> is a component, not a DOM element — its className/style are assumed to reach the element it renders, which is not guaranteed`);
    }

    let className: NodeInEnv | null = null;
    let style: NodeInEnv | null = null;
    const motion: RootInfo['motion'] = [];
    for (const attr of opening.getAttributes()) {
      if (Node.isJsxAttribute(attr)) {
        const name = attr.getNameNode().getText();
        const isMotionProp = isMotion && MOTION_ATTRIBUTES.has(name);
        if (name !== 'className' && name !== 'style' && !isMotionProp) continue;
        const init = attr.getInitializer();
        let value: Node | undefined;
        if (init && Node.isStringLiteral(init)) value = init;
        else if (init && Node.isJsxExpression(init)) value = init.getExpression();
        if (!value) continue;
        if (isMotionProp) motion.push({ name, value: { node: value, env } });
        else if (name === 'className') className = { node: value, env };
        else style = { node: value, env };
      } else if (Node.isJsxSpreadAttribute(attr)) {
        const spread = this.spreadAttributes(attr.getExpression(), env, tag);
        if (spread.className) className = spread.className;
        if (spread.style) style = spread.style;
      }
    }
    // Roots that pass the same className/style (Button's `<a {...sharedProps}>` and `<button className={sharedClassName}>`)
    // render the same rules whatever their tag — they are one root for this model.
    const motionText = motion.map((m) => `${m.name}=${m.value.node.getText()}`).join(' ');
    const signature = `${className ? className.node.getText() : ''}|${style ? style.node.getText() : ''}|${motionText}`;
    return { tag, label: tagNode.getText(), className, style, motion, reach, signature };
  }

  /**
   * The CSS properties framer-motion writes inline on a motion.* root. At
   * audit time an entrance animation may be finished, running, or never
   * triggered (`whileInView` below the fold), so every animated property is
   * value-less — it overrides the classes, with an unknowable value. When
   * the targets cannot be read at all, every property is.
   */
  motionProperties(root: RootInfo): { properties: Set<string>; readable: boolean } {
    const properties = new Set<string>();
    const variants = root.motion.find((m) => m.name === 'variants');
    let readable = variants ? this.motionTargets(variants.value.node, variants.value.env, properties, 0) : true;
    for (const m of root.motion) {
      if (m.name === 'variants') continue;
      const value = unwrap(m.value.node);
      // A label (`initial="hidden"`), `false`, or an animation-controls object refers to the variants.
      const isLabel = Node.isStringLiteral(value) || Node.isFalseLiteral(value) || Node.isTrueLiteral(value) || Node.isArrayLiteralExpression(value);
      if (isLabel) continue;
      const targetsRead = this.motionTargets(value, m.value.env, properties, 0);
      if (!targetsRead && !variants) readable = false;
    }
    return { properties, readable };
  }

  isObjectValue(node: Node, env: Env): boolean {
    const n = unwrap(node);
    if (Node.isObjectLiteralExpression(n)) return true;
    if (!Node.isIdentifier(n)) return false;
    const binding = this.resolve(n, env);
    return binding.kind === 'expr' && Node.isObjectLiteralExpression(unwrap(binding.node));
  }

  motionTargets(node: Node, env: Env, out: Set<string>, depth: number): boolean {
    if (depth > 6) return false;
    const n = unwrap(node);
    if (Node.isObjectLiteralExpression(n)) {
      let readable = true;
      for (const prop of n.getProperties()) {
        if (Node.isPropertyAssignment(prop)) {
          const key = propertyNameText(prop.getNameNode());
          const init = prop.getInitializer();
          if (key === null || !init) {
            readable = false;
            continue;
          }
          if (key === 'transition') continue;
          // An object value is a variant (`hidden: { opacity: 0 }`) or `transitionEnd` — its keys are the styles.
          // Anything else (a number, a keyframe array, a MotionValue) is a target for the property `key`.
          if (this.isObjectValue(init, env)) readable = this.motionTargets(init, env, out, depth + 1) && readable;
          else out.add(kebab(key));
        } else if (Node.isShorthandPropertyAssignment(prop)) {
          out.add(kebab(prop.getName()));
        } else if (Node.isSpreadAssignment(prop)) {
          readable = this.motionTargets(prop.getExpression(), env, out, depth + 1) && readable;
        }
      }
      return readable;
    }
    if (Node.isConditionalExpression(n)) {
      const a = this.motionTargets(n.getWhenTrue(), env, out, depth + 1);
      const b = this.motionTargets(n.getWhenFalse(), env, out, depth + 1);
      return a && b;
    }
    if (Node.isFalseLiteral(n) || Node.isStringLiteral(n)) return true;
    if (Node.isIdentifier(n)) {
      const binding = this.resolve(n, env);
      if (binding.kind !== 'expr') return false;
      return this.follow(binding.node, false, () => this.motionTargets(binding.node, binding.env, out, depth + 1));
    }
    return false;
  }

  /** The default of a destructured prop used as a tag (`as: Tag = 'span'` with a non-union type), when it is a DOM tag name. */
  propDefaultIsDomTag(tagNode: Node): string | null {
    if (!Node.isIdentifier(tagNode)) return null;
    const decl = tagNode.getSymbol()?.getDeclarations()[0];
    if (!decl || !Node.isBindingElement(decl)) return null;
    const init = decl.getInitializer();
    const value = init ? unwrap(init) : undefined;
    return value && Node.isStringLiteral(value) && /^[a-z]/.test(value.getLiteralValue()) ? value.getLiteralValue() : null;
  }

  /** `{...sharedProps}` → its className/style when it is a local object literal; a caller spread is noted. */
  spreadAttributes(expression: Node, env: Env, tag: string): { className: NodeInEnv | null; style: NodeInEnv | null } {
    const result: { className: NodeInEnv | null; style: NodeInEnv | null } = { className: null, style: null };
    let target = unwrap(expression);
    let targetEnv = env;
    if (Node.isIdentifier(target)) {
      const binding = this.resolve(target, env);
      if (binding.kind === 'param') {
        this.note(`{...${target.getText()}} spreads caller props onto <${tag}> — any className/style a caller passes through it is not modeled`);
        return result;
      }
      if (binding.kind !== 'expr') {
        this.note(`{...${target.getText()}} on <${tag}> could not be resolved — not modeled`);
        return result;
      }
      target = unwrap(binding.node);
      targetEnv = binding.env;
    }
    if (!Node.isObjectLiteralExpression(target)) {
      this.note(`spread ${shortText(expression)} on <${tag}> is not an object literal — not modeled`);
      return result;
    }
    for (const prop of target.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        const name = propertyNameText(prop.getNameNode());
        const init = prop.getInitializer();
        if (!init) continue;
        if (name === 'className') result.className = { node: init, env: targetEnv };
        if (name === 'style') result.style = { node: init, env: targetEnv };
      } else if (Node.isShorthandPropertyAssignment(prop)) {
        if (prop.getName() === 'className') result.className = { node: prop, env: targetEnv };
        if (prop.getName() === 'style') result.style = { node: prop, env: targetEnv };
      }
    }
    return result;
  }

  // ── className ──

  walkClass(node: Node, w: Walk): void {
    if (w.depth > MAX_DEPTH) {
      this.note(`className expression nested too deeply to follow: ${shortText(node)}`);
      return;
    }
    const next: Walk = { ...w, depth: w.depth + 1 };
    const n = unwrap(node);
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) {
      this.emitClassText(n.getLiteralValue(), next, false, false);
      return;
    }
    if (Node.isTemplateExpression(n)) {
      const parts: Array<string | Node> = [n.getHead().getLiteralText()];
      for (const span of n.getTemplateSpans()) parts.push(span.getExpression(), span.getLiteral().getLiteralText());
      this.walkClassParts(parts, next);
      return;
    }
    if (Node.isBinaryExpression(n)) {
      const op = n.getOperatorToken().getKind();
      if (op === SyntaxKind.AmpersandAmpersandToken) {
        for (const b of this.branches(this.cond(n.getLeft(), w.env), next)) this.walkClass(n.getRight(), b);
        return;
      }
      if (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) {
        const test = op === SyntaxKind.BarBarToken ? this.cond(n.getLeft(), w.env) : UNKNOWN_TRI;
        for (const b of this.branches(test, next)) this.walkClass(n.getLeft(), b);
        for (const b of this.branches(this.not(test), next)) this.walkClass(n.getRight(), b);
        return;
      }
      if (op === SyntaxKind.PlusToken) {
        this.walkClassParts(this.concatParts(n), next);
        return;
      }
    }
    if (Node.isConditionalExpression(n)) {
      const test = this.cond(n.getCondition(), w.env);
      for (const b of this.branches(test, next)) this.walkClass(n.getWhenTrue(), b);
      for (const b of this.branches(this.not(test), next)) this.walkClass(n.getWhenFalse(), b);
      return;
    }
    if (Node.isArrayLiteralExpression(n)) {
      for (const el of n.getElements()) this.walkClass(el, next);
      return;
    }
    if (Node.isObjectLiteralExpression(n)) {
      // clsx object syntax: { 'font-bold': isBold }
      for (const prop of n.getProperties()) {
        if (Node.isPropertyAssignment(prop)) {
          const key = propertyNameText(prop.getNameNode());
          const init = prop.getInitializer();
          if (key === null || !init) {
            this.note(`computed clsx key ${shortText(prop)} — not modeled`);
            continue;
          }
          for (const b of this.branches(this.cond(init, w.env), next)) this.emitClassText(key, b, false, false);
        } else if (Node.isShorthandPropertyAssignment(prop)) {
          for (const b of this.branches(this.cond(prop.getNameNode(), w.env), next)) this.emitClassText(prop.getName(), b, false, false);
        }
      }
      return;
    }
    if (Node.isCallExpression(n)) {
      this.walkCall(n, next, 'class');
      return;
    }
    if (Node.isElementAccessExpression(n) || Node.isPropertyAccessExpression(n)) {
      const member = this.propsMember(n, w.env);
      if (member) {
        this.classFromBinding(member, n, next);
        return;
      }
      const alternatives = this.alternatives(n, next);
      if (!alternatives) {
        this.note(`className lookup ${shortText(n)} could not be resolved to local values — not modeled`);
        return;
      }
      for (const alt of alternatives) this.walkClass(alt.node, { ...next, when: alt.when, env: alt.env, assumed: alt.assumed });
      return;
    }
    if (Node.isIdentifier(n) || Node.isShorthandPropertyAssignment(n)) {
      this.classFromBinding(this.resolve(n, w.env), n, next);
      return;
    }
    if (Node.isNullLiteral(n) || Node.isTrueLiteral(n) || Node.isFalseLiteral(n) || Node.isNumericLiteral(n)) return;
    this.note(`className expression ${shortText(n)} is not statically readable — not modeled`);
  }

  classFromBinding(binding: Binding, node: Node, w: Walk): void {
    switch (binding.kind) {
      case 'expr':
        this.follow(binding.node, undefined, () => this.walkClass(binding.node, { ...w, env: binding.env }));
        return;
      case 'param':
        this.note(
          binding.name === 'className'
            ? 'className: caller-provided parameter "className" ignored — a caller may add or override classes'
            : `className: caller-provided value "${binding.name}" ignored`,
        );
        return;
      case 'undefined':
      case 'function':
        return;
      default:
        this.note(`className value \`${shortText(node)}\` (${binding.kind}) is not statically readable — not modeled`);
    }
  }

  /** `a + ' ' + b` flattened into literal text and expression parts. */
  concatParts(node: Node): Array<string | Node> {
    const n = unwrap(node);
    if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      return [...this.concatParts(n.getLeft()), ...this.concatParts(n.getRight())];
    }
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return [n.getLiteralValue()];
    return [n];
  }

  /**
   * Literal text and `${}` spans of a template (or concatenation). A class
   * glued to a span (`px-${n}`) is a fragment Tailwind never generated —
   * dropped, from rules and from classTokens; a span that stands alone
   * between spaces is walked as its own class expression.
   */
  walkClassParts(parts: Array<string | Node>, w: Walk): void {
    parts.forEach((part, i) => {
      const before = parts[i - 1];
      const after = parts[i + 1];
      if (typeof part === 'string') {
        if (!part) return;
        const gluedStart = before !== undefined && typeof before !== 'string' && !/^\s/.test(part);
        const gluedEnd = after !== undefined && typeof after !== 'string' && !/\s$/.test(part);
        const tokens = part.trim().split(/\s+/);
        if (gluedStart) this.note(`dynamic class fragment "…${tokens[0]}" glued to a \${} span — Tailwind cannot generate it; skipped`);
        if (gluedEnd) this.note(`dynamic class fragment "${tokens[tokens.length - 1]}…" glued to a \${} span — Tailwind cannot generate it; skipped`);
        this.emitClassText(part.trim(), w, gluedStart, gluedEnd);
        return;
      }
      const openBefore = before === undefined || (typeof before === 'string' && (i - 1 === 0 ? before === '' || /\s$/.test(before) : /\s$/.test(before)));
      const openAfter = after === undefined || (typeof after === 'string' && (i + 1 === parts.length - 1 ? after === '' || /^\s/.test(after) : /^\s/.test(after)));
      if (openBefore && openAfter) this.walkClass(part, w);
      else this.note(`dynamic class fragment \${${shortText(part)}} glued to literal text — Tailwind cannot generate it; skipped`);
    });
  }

  emitClassText(text: string, w: Walk, dropFirst: boolean, dropLast: boolean): void {
    const tokens = text.split(/\s+/);
    tokens.forEach((token, i) => {
      if (!token) return;
      if (dropFirst && i === 0) return;
      if (dropLast && i === tokens.length - 1) return;
      this.emitClassToken(token, w);
    });
  }

  emitClassToken(token: string, w: Walk): void {
    const parsed = parseClass(token);
    if (!parsed) return;
    this.classTokens.add(token);
    // hover:, focus:, before:, [&>svg]: … never style the root at rest — fingerprint only.
    if (w.mode === 'tokens' || parsed.atRest === 'never') return;
    const analysis = analyzeUtility(parsed.utility, this.ctx);
    if (analysis.reason && !parsed.stateGated) this.note(analysis.reason);
    const base = { source: token, when: w.when, media: parsed.media, origin: 'class' as const, important: parsed.important, variants: parsed.variants, assumed: w.assumed };
    const valueless = (property: string, overridesClasses: boolean) => this.push({ ...base, property, token: null, literal: null, overridesClasses });
    const set = [...(analysis.declarations ?? []).map((d) => d.property), ...analysis.touched];
    // Behind disabled:, aria-*, data-*, last:, @md: … the class may or may not apply to the instance on the page,
    // and where it does it beats every plain class whatever their order: its properties get no expectation.
    if (parsed.atRest === 'maybe') {
      for (const property of [...set, ...analysis.layered]) valueless(property, true);
      return;
    }
    // A ring or shadow-color layer joins the composite box-shadow whatever the class order.
    for (const property of analysis.layered) valueless(property, true);
    if (w.mode === 'indeterminate') {
      for (const property of set) valueless(property, false);
      return;
    }
    for (const d of analysis.declarations ?? []) this.push({ ...base, property: d.property, token: d.token, literal: d.literal, overridesClasses: false });
    for (const property of analysis.touched) valueless(property, false);
  }

  push(rule: Omit<RawRule, 'seq'>): void {
    this.rules.push({ ...rule, when: { ...rule.when }, seq: this.seq++ });
  }

  // ── Calls: cn()/clsx(), local helpers, IIFEs ──

  walkCall(call: Node, w: Walk, context: 'class' | 'style'): void {
    if (!Node.isCallExpression(call)) return;
    const callee = unwrap(call.getExpression());
    const calleeText = callee.getText();
    if (context === 'class' && CLASS_JOINERS.has(calleeText)) {
      for (const arg of call.getArguments()) this.walkClass(arg, w);
      return;
    }
    if (context === 'class' && Node.isPropertyAccessExpression(callee) && callee.getName() === 'join') {
      // ['a', cond && 'b'].filter(Boolean).join(' ')
      let target = unwrap(callee.getExpression());
      if (Node.isCallExpression(target)) {
        const filter = target.getExpression();
        if (Node.isPropertyAccessExpression(filter) && filter.getName() === 'filter') target = unwrap(filter.getExpression());
      }
      if (Node.isArrayLiteralExpression(target)) {
        this.walkClass(target, w);
        return;
      }
    }
    let fn: FunctionLike | null = null;
    if (Node.isArrowFunction(callee) || Node.isFunctionExpression(callee)) fn = callee;
    else if (Node.isIdentifier(callee)) {
      const binding = this.resolve(callee, w.env);
      if (binding.kind === 'function') fn = binding.fn;
      const builder = binding.kind === 'expr' ? unwrap(binding.node) : null;
      if (builder && Node.isCallExpression(builder) && builder.getExpression().getText() === 'cva') {
        this.note(`${calleeText}() is a cva() variant builder (shadcn primitive) — its classes are not modeled`);
        return;
      }
    }
    if (!fn) {
      this.note(`${context === 'class' ? 'className' : 'style'} call ${shortText(call)} is not a local function — not modeled`);
      return;
    }
    const key = fn.compilerNode;
    if (this.calling.has(key)) return;
    const env = new Map(w.env);
    fn.getParameters().forEach((param, i) => {
      const arg = call.getArguments()[i] ?? param.getInitializer();
      if (arg && Node.isIdentifier(param.getNameNode())) env.set(param.compilerNode, { node: arg, env: call.getArguments()[i] ? w.env : env });
    });
    this.calling.add(key);
    try {
      const body = fn.getBody();
      const inner: Walk = { ...w, env };
      if (body && Node.isBlock(body)) {
        for (const r of this.flow(body.getStatements(), TRUE_TRI, env).returns) {
          if (!r.node) continue;
          const returned = r.node;
          for (const b of this.branches(r.reach, inner)) {
            if (context === 'class') this.walkClass(returned, b);
            else this.walkStyle(returned, b);
          }
        }
      } else if (body) {
        if (context === 'class') this.walkClass(body, inner);
        else this.walkStyle(body, inner);
      }
    } finally {
      this.calling.delete(key);
    }
  }

  // ── Lookup maps ──

  /**
   * `map[dim]` / `colors.bg` over local object literals: each property value,
   * filed under dim ∈ {its key}. Null when anything along the way is not a
   * local literal (an imported map, a spread, a computed key).
   */
  alternatives(node: Node, w: Walk): Alternative[] | null {
    if (w.depth > MAX_DEPTH) return null;
    const n = unwrap(node);
    const next: Walk = { ...w, depth: w.depth + 1 };
    if (Node.isElementAccessExpression(n) || Node.isPropertyAccessExpression(n)) {
      const base = this.alternatives(n.getExpression(), next);
      if (!base) return null;
      let key: IndexKey | null;
      if (Node.isPropertyAccessExpression(n)) key = { kind: 'literal', value: n.getName() };
      else {
        const arg = n.getArgumentExpression();
        key = arg ? this.indexKey(arg, w.env) : null;
      }
      if (!key) return null;
      const out: Alternative[] = [];
      for (const alt of base) {
        const obj = unwrap(alt.node);
        if (!Node.isObjectLiteralExpression(obj)) return null;
        for (const prop of obj.getProperties()) {
          if (Node.isSpreadAssignment(prop)) return null;
          if (!Node.isPropertyAssignment(prop)) continue;
          const name = propertyNameText(prop.getNameNode());
          const init = prop.getInitializer();
          if (name === null || !init) return null;
          if (key.kind === 'literal') {
            if (name === key.value) out.push({ ...alt, node: init });
            continue;
          }
          const c = andConstraint(alt.when, { [key.dim]: [name] }, this.domains);
          if (c) out.push({ ...alt, when: c, node: init });
        }
      }
      return out;
    }
    if (Node.isIdentifier(n)) {
      const binding = this.resolve(n, w.env);
      if (binding.kind !== 'expr') return null;
      return this.follow(binding.node, null, () => this.alternatives(binding.node, { ...next, env: binding.env }));
    }
    if (Node.isConditionalExpression(n)) {
      // Only a condition fully decided by the dimensions (or by state at rest) can select a lookup value.
      const test = this.cond(n.getCondition(), w.env);
      if (!isExact(test)) return null;
      const out: Alternative[] = [];
      for (const [branch, tri] of [[n.getWhenTrue(), test], [n.getWhenFalse(), this.not(test)]] as const) {
        const assumed = [...new Set([...w.assumed, ...(tri.assumes ?? [])])];
        for (const c of dnfAnd([w.when], tri.definite, this.domains) ?? []) {
          const alts = this.alternatives(branch, { ...next, when: c, assumed });
          if (!alts) return null;
          out.push(...alts);
        }
      }
      return out;
    }
    if (Node.isCallExpression(n)) return null;
    return [{ when: w.when, node: n, env: w.env, assumed: w.assumed }];
  }

  indexKey(node: Node, env: Env): IndexKey | null {
    const s = this.scalar(node, env);
    if (s.kind === 'dim') return { kind: 'dim', dim: s.dim };
    if (s.kind === 'literal') return { kind: 'literal', value: s.value };
    return null;
  }

  // ── style ──

  walkStyle(node: Node, w: Walk): void {
    if (w.depth > MAX_DEPTH) {
      this.note(`style expression nested too deeply to follow: ${shortText(node)}`);
      return;
    }
    const next: Walk = { ...w, depth: w.depth + 1 };
    const n = unwrap(node);
    if (Node.isObjectLiteralExpression(n)) {
      for (const prop of n.getProperties()) {
        if (Node.isSpreadAssignment(prop)) {
          this.walkStyle(prop.getExpression(), next);
        } else if (Node.isPropertyAssignment(prop)) {
          const name = propertyNameText(prop.getNameNode());
          const init = prop.getInitializer();
          if (name === null || !init) {
            this.note(`style key ${shortText(prop.getNameNode())} is computed — not modeled`);
            continue;
          }
          this.walkStyleValue(name, init, next);
        } else if (Node.isShorthandPropertyAssignment(prop)) {
          this.walkStyleValue(prop.getName(), prop, next);
        }
      }
      return;
    }
    if (Node.isConditionalExpression(n)) {
      const test = this.cond(n.getCondition(), w.env);
      for (const b of this.branches(test, next)) if (b.mode !== 'tokens') this.walkStyle(n.getWhenTrue(), b);
      for (const b of this.branches(this.not(test), next)) if (b.mode !== 'tokens') this.walkStyle(n.getWhenFalse(), b);
      return;
    }
    if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
      for (const b of this.branches(this.cond(n.getLeft(), w.env), next)) if (b.mode !== 'tokens') this.walkStyle(n.getRight(), b);
      return;
    }
    if (Node.isCallExpression(n)) {
      this.walkCall(n, next, 'style');
      return;
    }
    if (Node.isIdentifier(n) || Node.isShorthandPropertyAssignment(n)) {
      const binding = this.resolve(n, w.env);
      if (binding.kind === 'expr') this.follow(binding.node, undefined, () => this.walkStyle(binding.node, { ...next, env: binding.env }));
      else if (binding.kind === 'param') this.note(`style: caller-provided value "${binding.name}" ignored — a caller may add or override inline styles`);
      else if (binding.kind !== 'undefined') this.note(`style value \`${shortText(n)}\` is not statically readable — not modeled`);
      return;
    }
    if (Node.isNullLiteral(n) || Node.isFalseLiteral(n)) return;
    this.note(`style expression ${shortText(n)} is not statically readable — not modeled`);
  }

  /** One `name: value` of a style object; the value is followed through ternaries, aliases and lookup maps. */
  walkStyleValue(name: string, valueNode: Node, w: Walk): void {
    const property = kebab(name);
    if (property.startsWith('--')) {
      // A locally set custom property shadows the global token for this element: expectations naming it are unreliable.
      this.localVars.add(property);
      this.note(`style sets ${property} locally — expectations that reference it are dropped`);
      return;
    }
    if (w.depth > MAX_DEPTH) return;
    const next: Walk = { ...w, depth: w.depth + 1 };
    const n = Node.isShorthandPropertyAssignment(valueNode) ? valueNode : unwrap(valueNode);
    const emit = (css: string, sourceText: string, walk: Walk) => {
      const expanded = cssPropertyDeclarations(property, css, this.ctx);
      const mode = walk.mode;
      if (mode === 'tokens') return;
      const base = { source: `${name}: ${sourceText}`, when: walk.when, media: null, origin: 'style' as const, important: false, variants: [], overridesClasses: false, assumed: walk.assumed };
      for (const d of expanded.declarations) {
        if (mode === 'indeterminate') this.push({ ...base, property: d.property, token: null, literal: null });
        else this.push({ ...base, property: d.property, token: d.token, literal: d.literal });
      }
      for (const p of expanded.touched) this.push({ ...base, property: p, token: null, literal: null });
    };
    const touchAll = (walk: Walk) => emit('inherit', shortText(n), { ...walk, mode: walk.mode === 'tokens' ? 'tokens' : 'indeterminate' });

    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) {
      emit(n.getLiteralValue(), n.getText(), w);
      return;
    }
    if (Node.isNumericLiteral(n)) {
      const value = Number(n.getLiteralValue());
      emit(UNITLESS_STYLE.has(property) || value === 0 ? String(value) : `${value}px`, n.getText(), w);
      return;
    }
    if (Node.isConditionalExpression(n)) {
      const test = this.cond(n.getCondition(), w.env);
      for (const b of this.branches(test, next)) this.walkStyleValue(name, n.getWhenTrue(), b);
      for (const b of this.branches(this.not(test), next)) this.walkStyleValue(name, n.getWhenFalse(), b);
      return;
    }
    if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
      for (const b of this.branches(this.cond(n.getLeft(), w.env), next)) this.walkStyleValue(name, n.getRight(), b);
      return;
    }
    if (Node.isElementAccessExpression(n) || Node.isPropertyAccessExpression(n)) {
      const alternatives = this.propsMember(n, w.env) ? null : this.alternatives(n, next);
      if (!alternatives) {
        touchAll(w);
        return;
      }
      for (const alt of alternatives) this.walkStyleValue(name, alt.node, { ...next, when: alt.when, env: alt.env, assumed: alt.assumed });
      return;
    }
    if (Node.isIdentifier(n) || Node.isShorthandPropertyAssignment(n)) {
      const binding = this.resolve(n, w.env);
      if (binding.kind === 'expr') {
        this.follow(binding.node, undefined, () => this.walkStyleValue(name, binding.node, { ...next, env: binding.env }));
        return;
      }
      if (binding.kind === 'dim') {
        // `{ textAlign: align }` — the dimension's own value is the CSS value (an omitted prop sets nothing).
        const dim = this.dims.get(binding.dim) as DimInfo;
        if (dim.kind === 'union') {
          for (const value of dim.values) {
            if (value === UNSET_VALUE) continue;
            const c = andConstraint(w.when, { [dim.name]: [value] }, this.domains);
            if (c) emit(value, `${n.getText()} (= '${value}')`, { ...w, when: c });
          }
          return;
        }
      }
      if (binding.kind === 'undefined') return;
      if (binding.kind === 'param') this.note(`style ${name}: caller-provided value "${binding.name}" — not modeled`);
      touchAll(w);
      return;
    }
    if (Node.isTemplateExpression(n)) {
      // `1px solid ${active ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.08)'}` — every span must resolve to known strings.
      const texts = this.templateAlternatives(n, next);
      if (!texts) {
        touchAll(w);
        return;
      }
      for (const t of texts) emit(t.text, `\`${t.text}\``, t.walk);
      return;
    }
    if (Node.isNullLiteral(n) || Node.isFalseLiteral(n)) return;
    // Calls, arithmetic, anything computed at runtime: the value is unknowable here.
    touchAll(w);
  }

  /** The strings a template can produce, each under the constraints that select it; null when a span is not statically known. */
  templateAlternatives(template: Node, w: Walk): Array<{ text: string; walk: Walk }> | null {
    if (!Node.isTemplateExpression(template)) return null;
    let partial: Array<{ text: string; walk: Walk }> = [{ text: template.getHead().getLiteralText(), walk: w }];
    for (const span of template.getTemplateSpans()) {
      const extended: Array<{ text: string; walk: Walk }> = [];
      for (const p of partial) {
        const values = this.stringAlternatives(span.getExpression(), p.walk);
        if (!values) return null;
        for (const v of values) extended.push({ text: p.text + v.text + span.getLiteral().getLiteralText(), walk: v.walk });
      }
      if (extended.length > 64) return null;
      partial = extended;
    }
    return partial;
  }

  stringAlternatives(node: Node, w: Walk): Array<{ text: string; walk: Walk }> | null {
    if (w.depth > MAX_DEPTH) return null;
    const next: Walk = { ...w, depth: w.depth + 1 };
    const n = Node.isShorthandPropertyAssignment(node) ? node : unwrap(node);
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return [{ text: n.getLiteralValue(), walk: w }];
    if (Node.isNumericLiteral(n)) return [{ text: String(Number(n.getLiteralValue())), walk: w }];
    if (Node.isTemplateExpression(n)) return this.templateAlternatives(n, next);
    if (Node.isConditionalExpression(n)) {
      const test = this.cond(n.getCondition(), w.env);
      const out: Array<{ text: string; walk: Walk }> = [];
      for (const [branch, tri] of [[n.getWhenTrue(), test], [n.getWhenFalse(), this.not(test)]] as const) {
        for (const b of this.branches(tri, next)) {
          if (b.mode === 'tokens') continue;
          const values = this.stringAlternatives(branch, b);
          if (!values) return null;
          out.push(...values);
        }
      }
      return out;
    }
    if (Node.isIdentifier(n) || Node.isShorthandPropertyAssignment(n)) {
      const binding = this.resolve(n, w.env);
      if (binding.kind === 'expr') return this.follow(binding.node, null, () => this.stringAlternatives(binding.node, { ...next, env: binding.env }));
      if (binding.kind === 'dim') {
        const dim = this.dims.get(binding.dim) as DimInfo;
        if (dim.kind !== 'union') return null;
        const out: Array<{ text: string; walk: Walk }> = [];
        for (const value of dim.values) {
          const c = value === UNSET_VALUE ? null : andConstraint(w.when, { [dim.name]: [value] }, this.domains);
          if (c) out.push({ text: value, walk: { ...w, when: c } });
        }
        return out;
      }
      return null;
    }
    if ((Node.isElementAccessExpression(n) || Node.isPropertyAccessExpression(n)) && !this.propsMember(n, w.env)) {
      const alternatives = this.alternatives(n, next);
      if (!alternatives) return null;
      const out: Array<{ text: string; walk: Walk }> = [];
      for (const alt of alternatives) {
        const values = this.stringAlternatives(alt.node, { ...next, when: alt.when, env: alt.env, assumed: alt.assumed });
        if (!values) return null;
        out.push(...values);
      }
      return out;
    }
    return null;
  }

  // ── Assembly ──

  /** Extracted longhands a motion.* root animates inline (see motionProperties), with the note saying so. */
  animatedProperties(root: RootInfo): string[] {
    if (root.motion.length === 0) return [];
    const { properties, readable } = this.motionProperties(root);
    if (!readable) {
      this.note(`<motion.${root.tag}> animation targets are not statically readable — no property of the root is expected`);
      return [...EXTRACTED_PROPERTIES];
    }
    const longhands = [...properties].flatMap((p) => cssPropertyDeclarations(p, 'inherit', this.ctx).touched);
    if (longhands.length > 0) {
      this.note(`<motion.${root.tag}> animates ${longhands.join(', ')} inline — not expected (the value depends on whether the animation has run)`);
    }
    return longhands;
  }

  build(found: FoundComponent): ComponentStyleModel {
    this.collectDims(found);
    const roots = this.roots(found.fn).filter((r) => !isNever(r.reach));
    if (roots.length === 0) this.note(`${this.component}: no JSX root element was found — no rules`);

    // Two roots with the same className/style (Button's `<a {...sharedProps}>` and
    // `<button className={sharedClassName}>`) render the same RULES whatever their tag, so they
    // are one group for rule purposes — but every tag actually seen must still be recorded: B3's
    // root-tag pin (M3, Decision Log #31) needs the FULL set a component can render, not just
    // whichever branch happened to be discovered first.
    const groups: Array<{ id: string; root: RootInfo; reach: Tri; tags: Set<string> }> = [];
    for (const root of roots) {
      const same = groups.find((g) => g.root.signature === root.signature);
      if (same) {
        same.reach = this.or(same.reach, root.reach);
        same.tags.add(root.tag);
      } else groups.push({ id: root.label, root, reach: root.reach, tags: new Set([root.tag]) });
    }
    // Root ids are the tags as written (`a`, `button`, `motion.div`); a repeated tag gets `#2`, `#3`.
    const labelCount = new Map<string, number>();
    for (const g of groups) {
      const count = (labelCount.get(g.root.label) ?? 0) + 1;
      labelCount.set(g.root.label, count);
      if (count > 1) g.id = `${g.root.label}#${count}`;
    }
    const multi = groups.length > 1;
    if (multi) {
      this.domains.set('$root', groups.map((g) => g.id));
      this.note(
        `${this.component} renders ${groups.length} different root elements (${groups.map((g) => `<${g.id}>`).join(', ')}): ` +
          'the "$root" dimension selects one; left unset, only properties every root agrees on are expected',
      );
    }

    for (const g of groups) {
      const animated = this.animatedProperties(g.root);
      const assumed = g.reach.assumes ?? [];
      // Given that this root rendered, its reach (without the unknown parts) is what constrains its rules.
      for (const conj of g.reach.possible) {
        const when: Constraint = multi ? { ...conj, $root: [g.id] } : conj;
        if (g.root.className) this.walkClass(g.root.className.node, { when, mode: 'rules', env: g.root.className.env, depth: 0, assumed });
        if (g.root.style) this.walkStyle(g.root.style.node, { when, mode: 'rules', env: g.root.style.env, depth: 0, assumed });
        for (const property of animated) {
          this.push({ property, token: null, literal: null, source: `<motion.${g.root.tag}> animation`, when, media: null, origin: 'style', important: false, variants: [], overridesClasses: false, assumed });
        }
      }
    }

    for (const r of this.rules) {
      const references = [r.token, r.literal].some((v) => v !== null && [...this.localVars].some((name) => v === name || v.includes(`var(${name}`)));
      if (references) {
        r.token = null;
        r.literal = null;
      }
    }

    const sorted = [...this.rules].sort(cascadeCompare);
    const rules: StyleRule[] = sorted.map((r, order) => ({
      property: r.property,
      token: r.token,
      literal: r.literal,
      source: r.source,
      when: r.when,
      media: r.media,
      order,
      origin: r.origin,
      assumes: r.assumed,
    }));

    const used = new Set<string>();
    for (const r of rules) for (const dim of Object.keys(r.when)) used.add(dim);
    const dimensions: StyleDimension[] = [...this.dims.values()]
      .filter((d) => used.has(d.name))
      .sort((a, b) => a.order - b.order)
      .map((d) => ({ name: d.name, values: d.values, defaultValue: d.defaultValue, kind: d.kind }));
    const model: ComponentStyleModel = {
      file: this.file,
      component: this.component,
      dimensions,
      rules,
      classTokens: [...this.classTokens],
      notes: [...this.notes],
    };
    if (multi && used.has('$root')) {
      dimensions.push({ name: '$root', values: groups.map((g) => g.id), defaultValue: null, kind: 'union' });
    }
    // Always recorded, even for a single-root component: B3's root-tag pin (M3, Decision Log #31)
    // needs to know what tag EVERY component renders, not only the ones with more than one.
    model.roots = groups.map((g) => ({ id: g.id, tag: g.root.tag, tags: [...g.tags], when: g.reach.possible }));
    return model;
  }
}

/**
 * Cascade order: !important beats everything, inline style beats classes, a
 * class that overrides plain classes whatever their order (a state-gated or
 * layered one — see RawRule.overridesClasses) beats the rest, then Tailwind's
 * own breakpoint order in the stylesheet (compareBreakpointOrder), then
 * source order (twMerge keeps the last of two conflicting classes).
 */
function cascadeCompare(a: RawRule, b: RawRule): number {
  const byImportance = Number(a.important) - Number(b.important);
  if (byImportance !== 0) return byImportance;
  const byOrigin = Number(a.origin === 'style') - Number(b.origin === 'style');
  if (byOrigin !== 0) return byOrigin;
  const byOverride = Number(a.overridesClasses) - Number(b.overridesClasses);
  if (byOverride !== 0) return byOverride;
  const byMedia = compareBreakpointOrder(a.variants, b.variants);
  if (byMedia !== 0) return byMedia;
  return a.seq - b.seq;
}

// ── Public API ────────────────────────────────────────────────────────────

const modelCache = new Map<string, Promise<ComponentStyleModel | null>>();

/**
 * The style model of one DS component file (a catalog path such as
 * "atoms/Button.tsx"), read from the real source under
 * `${designSystemPath}/core-v2/src`. Null when the file or a component named
 * like it cannot be found. Cached per (dsRegistryVersion, file): the model
 * is a pure function of the file and the effective tokens, which that
 * version hash covers.
 */
export function buildComponentStyleModel(registry: DsRegistry, file: string): Promise<ComponentStyleModel | null> {
  const key = `${registry.version.dsRegistryVersion} ${file}`;
  const cached = modelCache.get(key);
  if (cached) return cached;
  const pending = buildModel(registry, file);
  modelCache.set(key, pending);
  pending.catch(() => modelCache.delete(key));
  return pending;
}

async function buildModel(registry: DsRegistry, file: string): Promise<ComponentStyleModel | null> {
  let text: string;
  try {
    text = await readFile(join(registry.designSystemPath, 'core-v2/src', file), 'utf-8');
  } catch {
    return null;
  }
  return componentStyleModelFromSource(file, text, effectiveTokenMap(registry, 'editorial-light'));
}

/**
 * The same model from source text (uncached) — what buildComponentStyleModel
 * runs on the real file; exposed so the walk's semantics can be tested on
 * small synthetic components without touching the read-only DS.
 */
export function componentStyleModelFromSource(file: string, source: string, tokens: Map<string, string>): ComponentStyleModel | null {
  // One file, in memory, no lib and no import resolution: the walk only needs this file's own
  // bindings, and it must not depend on node_modules being installed in the DS checkout.
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, noLib: true, noResolve: true, allowJs: true, target: ts.ScriptTarget.ES2022 },
  });
  const sf = project.createSourceFile(`/ds/${file}`, source);
  const found = findComponent(sf, basename(file, '.tsx'));
  if (!found) return null;
  return new ModelBuilder(file, sf, { tokens }, found).build(found);
}

type Satisfaction = 'yes' | 'no' | 'maybe';

function satisfies(when: Record<string, string[]>, assignment: Assignment): Satisfaction {
  let result: Satisfaction = 'yes';
  for (const [dim, allowed] of Object.entries(when)) {
    const value = assignment[dim];
    if (value === undefined) result = 'maybe';
    else if (!allowed.includes(value)) return 'no';
  }
  return result;
}

function mediaMatches(media: StyleRule['media'], viewportWidth: number): boolean {
  if (!media) return true;
  if (media.minWidth !== undefined && viewportWidth < media.minWidth) return false;
  if (media.maxWidth !== undefined && viewportWidth > media.maxWidth) return false;
  return true;
}

/** Every full assignment consistent with a partial one: given values, then defaults, then each value of any dimension without a default. */
function completions(model: ComponentStyleModel, assignment: Assignment): Assignment[] {
  const base: Assignment = {};
  const open: StyleDimension[] = [];
  for (const d of model.dimensions) {
    const given = assignment[d.name];
    if (given !== undefined) base[d.name] = given;
    else if (d.defaultValue !== null) base[d.name] = d.defaultValue;
    else open.push(d);
  }
  let list: Assignment[] = [base];
  for (const d of open) {
    // Past the cap a dimension stays unset; rules that depend on it then count as "maybe".
    if (list.length * d.values.length > 256) continue;
    list = list.flatMap((a) => d.values.map((v) => ({ ...a, [d.name]: v })));
  }
  const roots = model.roots;
  if (!roots) return list;
  return list.filter((a) => {
    const id = a.$root;
    if (id === undefined) return true;
    const root = roots.find((r) => r.id === id);
    return !root || root.when.some((c) => satisfies(c, a) !== 'no');
  });
}

function constraintText(when: Record<string, string[]>): string {
  const parts = Object.entries(when).map(([dim, values]) => `${dim}=${values.join('|')}`);
  return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

/** ` (at rest: isHovering=false)` — the React state the rule was read at. */
function restText(assumes: readonly string[]): string {
  return assumes.length > 0 ? ` (at rest: ${assumes.join(', ')})` : '';
}

function mediaText(media: StyleRule['media']): string {
  if (!media) return '';
  const parts: string[] = [];
  if (media.minWidth !== undefined) parts.push(`min-width: ${media.minWidth}px`);
  if (media.maxWidth !== undefined) parts.push(`max-width: ${media.maxWidth}px`);
  return ` @media (${parts.join(') and (')})`;
}

/**
 * What the root element's computed styles must be for one assignment at one
 * viewport width. For each property, among rules whose `when` holds and
 * whose media matches, the last by order wins. A dimension the assignment
 * leaves out takes its default; one without a default is tried at every
 * value, and the property is expected only if all of them agree. A winner
 * with no value (see StyleRule) yields no expectation.
 */
export function expectationsFor(
  model: ComponentStyleModel,
  assignment: Assignment,
  opts: { viewportWidth: number },
): Array<{ property: string; token: string | null; literal: string | null; why: string }> {
  const candidates = completions(model, assignment);
  if (candidates.length === 0) return [];
  const winnersPerCompletion = candidates.map((completion) => {
    const winners = new Map<string, StyleRule | null>();
    for (const rule of model.rules) {
      const sat = satisfies(rule.when, completion);
      if (sat === 'no' || !mediaMatches(rule.media, opts.viewportWidth)) continue;
      const determinate = sat === 'yes' && (rule.token !== null || rule.literal !== null);
      winners.set(rule.property, determinate ? rule : null);
    }
    return winners;
  });

  const out: Array<{ property: string; token: string | null; literal: string | null; why: string }> = [];
  const properties = new Set<string>();
  for (const w of winnersPerCompletion) for (const p of w.keys()) properties.add(p);
  for (const property of [...properties].sort((a, b) => (EXTRACTED_ORDER.get(a) ?? 999) - (EXTRACTED_ORDER.get(b) ?? 999))) {
    const chosen = winnersPerCompletion.map((w) => w.get(property) ?? null);
    const first = chosen[0];
    if (!first) continue;
    const agree = chosen.every((r) => r !== null && r.token === first.token && r.literal === first.literal);
    if (!agree) continue;
    // Every root agreed when the caller did not pick one — naming the first root would be noise.
    const shownWhen = { ...first.when };
    if (assignment.$root === undefined) delete shownWhen.$root;
    out.push({
      property,
      token: first.token,
      literal: first.literal,
      why: `${model.file}: ${first.source}${constraintText(shownWhen)}${restText(first.assumes)}${mediaText(first.media)}`,
    });
  }
  // `border border-none`: a none/hidden style computes the widths to 0 whatever a width class says.
  const style = out.find((e) => e.property === 'border-top-style');
  if (style && (style.literal === 'none' || style.literal === 'hidden')) {
    return out.filter((e) => !/^border-(top|right|bottom|left)-width$/.test(e.property) || e.literal === '0px');
  }
  return out;
}

/**
 * Assignments to try, closest to the defaults first: the all-defaults
 * assignment, then every single-dimension change, then pairs, … — so that a
 * truncated list still holds the likely ones. Capped at `limit`.
 */
export function enumerateAssignments(model: ComponentStyleModel, limit = 1024): Assignment[] {
  const dims = model.dimensions.map((d) => {
    const first = d.defaultValue ?? d.values[0] ?? null;
    return { name: d.name, first, others: d.values.filter((v) => v !== first) };
  });
  const base: Assignment = {};
  for (const d of dims) if (d.first !== null) base[d.name] = d.first;
  const out: Assignment[] = [];
  for (let distance = 0; distance <= dims.length; distance++) {
    for (const combo of combinations(dims.length, distance)) {
      for (const values of product(combo.map((i) => (dims[i] as (typeof dims)[number]).others))) {
        if (out.length >= limit) return out;
        const assignment: Assignment = { ...base };
        combo.forEach((dimIndex, k) => {
          assignment[(dims[dimIndex] as (typeof dims)[number]).name] = values[k] as string;
        });
        out.push(assignment);
      }
    }
  }
  return out;
}

function* combinations(n: number, k: number, start = 0, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === k) {
    yield prefix;
    return;
  }
  for (let i = start; i < n; i++) yield* combinations(n, k, i + 1, [...prefix, i]);
}

function* product(lists: string[][], prefix: string[] = []): Generator<string[]> {
  if (prefix.length === lists.length) {
    yield prefix;
    return;
  }
  for (const v of lists[prefix.length] as string[]) yield* product(lists, [...prefix, v]);
}

/** "brand · sm · light" — the union dimensions' values in declared order (booleans and `$root` left out). */
export function dimensionLabel(model: ComponentStyleModel, assignment: Assignment): string {
  const parts: string[] = [];
  for (const d of model.dimensions) {
    if (d.kind !== 'union' || d.name.startsWith('$')) continue;
    const value = assignment[d.name] ?? d.defaultValue;
    if (value !== null && value !== undefined && value !== UNSET_VALUE) parts.push(value);
  }
  return parts.join(' · ');
}
