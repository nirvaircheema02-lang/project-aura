import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyIslandAlignment, applyUserStyleRules, mergeUserStyleRules, parseUserStyle, readUserStyleRules, type UserStyleRulesFile } from '../../src/preview/user-style-rules.ts';
import type { PreviewNode } from '../../src/preview/types.ts';

const el = (tag: string, cls: string, children: PreviewNode[] = []): PreviewNode => ({ t: 'el', tag, attrs: { class: cls }, children });
const tree = (): PreviewNode => el('div', 'grid', [
  el('div', 'border border-[#EDECFB] h-[140px] flex', [el('p', 'x'), el('div', 'absolute rounded-[10px] hover')]),
  el('div', 'border border-[#EDECFB] h-[140px] flex', [el('div', 'rounded-[10px]')]),
  el('div', 'border border-[#000] h-[140px]'),
]);
const FILE: UserStyleRulesFile = { schemaVersion: 1, rules: [{ id: 'square-cards', section: 's', match: { tag: 'div', classIncludes: ['border-[#EDECFB]', 'h-[140px]'] }, style: { 'border-radius': '0' }, descendants: [{ match: { classIncludes: ['rounded-'] }, style: { 'border-radius': '0' } }], reason: 'User: square' }] };

describe('user style rules', () => {
  it('marks only the matching elements (and their matching direct children), and emits a doubled, !important selector', () => {
    const t = tree();
    const { css, applied } = applyUserStyleRules(FILE, [{ id: 's', tree: t }]);
    expect(applied).toEqual([{ id: 'square-cards', section: 's', matched: 2, reason: 'User: square' }]);
    const marked = JSON.stringify(t).match(/"data-pv-user-rule":"[^"]+"/g)!;
    expect(marked.filter((m) => m.includes('square-cards"'))).toHaveLength(2);
    expect(marked.filter((m) => m.includes('square-cards-d0'))).toHaveLength(2);
    expect(css).toContain('[data-pv-user-rule~="square-cards"][data-pv-user-rule] { border-radius: 0 !important; }');
    expect(css).toContain('[data-pv-user-rule~="square-cards-d0"][data-pv-user-rule] { border-radius: 0 !important; }');
  });

  it('a rule for another section matches nothing and is reported as such, never dropped silently', () => {
    const { css, applied } = applyUserStyleRules(FILE, [{ id: 'other', tree: tree() }]);
    expect(applied[0]).toMatchObject({ matched: 0 });
    expect(css).toBe('');
  });

  it('records the user value on the element so the verifier can measure it', () => {
    const t = tree();
    applyUserStyleRules(FILE, [{ id: 's', tree: t }]);
    const first = (t as PreviewNode & { t: 'el' }).children[0] as PreviewNode & { t: 'el' };
    expect(parseUserStyle(first.attrs['data-pv-user-style'] ?? null)).toEqual([['border-radius', '0']]);
  });

  it('no file → no CSS, nothing applied', () => {
    expect(applyUserStyleRules(null, [{ id: 's', tree: tree() }])).toEqual({ css: '', applied: [], islandStyles: new Map() });
  });
});

describe('alignment keywords (justify-content: flex-end, margin-left: auto)', () => {
  const write = async (obj: unknown) => { const dir = await mkdtemp(join(tmpdir(), 'usr-')); const p = join(dir, 'user-style-rules.json'); await writeFile(p, JSON.stringify(obj)); return p; };
  const rule = (style: Record<string, string>) => ({ id: 'a', section: 's', match: { tag: 'div' }, style, reason: 'why' });

  it('accepts exactly those two keyword values', async () => {
    await expect(readUserStyleRules(await write({ schemaVersion: 1, rules: [rule({ 'justify-content': 'flex-end' })] }))).resolves.not.toBeNull();
    await expect(readUserStyleRules(await write({ schemaVersion: 1, rules: [rule({ 'margin-left': 'auto' })] }))).resolves.not.toBeNull();
    await expect(readUserStyleRules(await write({ schemaVersion: 1, rules: [rule({ 'height': 'auto' })] }))).resolves.not.toBeNull();
  });
  it.each([
    ['another justify-content value', { 'justify-content': 'center' }],
    ['auto on another property', { 'margin-right': 'auto' }],
    ['flex-end on another property', { 'align-items': 'flex-end' }],
    ['a raw length', { 'margin-left': '12px' }],
    ['auto on width', { 'width': 'auto' }],
  ])('still refuses %s', async (_n, style) => { await expect(readUserStyleRules(await write({ schemaVersion: 1, rules: [rule(style as Record<string, string>)] }))).rejects.toThrow(/is not allowed/); });

  it('hands the alignment of a matched, stamped element to its island slot — and only the alignment', () => {
    const t: PreviewNode = { t: 'el', tag: 'div', attrs: { class: 'wrap' }, children: [{ t: 'el', tag: 'div', attrs: { class: 'flex w-full' }, elementStamp: 'pvs-7', children: [] }] };
    const file: UserStyleRulesFile = { schemaVersion: 1, rules: [{ id: 'cta-right', section: 's', match: { tag: 'div', classIncludes: ['flex', 'w-full'] }, style: { 'justify-content': 'flex-end', 'border-radius': '0' }, reason: 'User' }] };
    const { islandStyles } = applyUserStyleRules(file, [{ id: 's', tree: t }]);
    expect(islandStyles.get('pvs-7')).toEqual({ 'justify-content': 'flex-end' });
  });
  it('folds justify-content and margin-left into the slot wrapper style', () => {
    expect(applyIslandAlignment({ display: 'flex', margin: '20px 0px 0px 0px', width: '100%' }, { 'justify-content': 'flex-end' })).toEqual({ display: 'flex', margin: '20px 0px 0px 0px', width: '100%', justifyContent: 'flex-end' });
    expect(applyIslandAlignment({ display: 'flex', margin: '4px 0px 8px 0px' }, { 'margin-left': 'auto' }).margin).toBe('4px 0px 8px auto');
    expect(applyIslandAlignment({ display: 'flex' }, undefined)).toEqual({ display: 'flex' });
  });
});

describe('readUserStyleRules — validation', () => {
  const write = async (obj: unknown) => { const dir = await mkdtemp(join(tmpdir(), 'usr-')); const p = join(dir, 'user-style-rules.json'); await writeFile(p, JSON.stringify(obj)); return p; };
  const rule = (over: Record<string, unknown> = {}) => ({ id: 'a', section: 's', match: { tag: 'div' }, style: { 'border-radius': '0' }, reason: 'why', ...over });

  it('returns null for a project with no file', async () => { expect(await readUserStyleRules(join(tmpdir(), 'nope-user-style-rules.json'))).toBeNull(); });
  it('accepts the project file shape', async () => { expect((await readUserStyleRules(await write({ schemaVersion: 1, rules: [rule()] })))!.rules).toHaveLength(1); });
  it.each([
    ['a colour literal', rule({ style: { color: '#ff0000' } })],
    ['a magic length', rule({ style: { 'border-radius': '7px' } })],
    ['an injected declaration', rule({ style: { 'border-radius': '0; color: red' } })],
    ['a rule that selects everything', rule({ match: {} })],
    ['no reason', rule({ reason: ' ' })],
    ['a bad id', rule({ id: 'Bad Id' })],
  ])('refuses %s', async (_n, bad) => { await expect(readUserStyleRules(await write({ schemaVersion: 1, rules: [bad] }))).rejects.toThrow(); });
  it('refuses a duplicate id and a wrong schema version', async () => {
    await expect(readUserStyleRules(await write({ schemaVersion: 1, rules: [rule(), rule()] }))).rejects.toThrow(/unique/);
    await expect(readUserStyleRules(await write({ schemaVersion: 2, rules: [] }))).rejects.toThrow(/not a user-style-rules/);
  });
  it('allows design-system tokens', async () => { expect((await readUserStyleRules(await write({ schemaVersion: 1, rules: [rule({ style: { color: 'var(--black-900)' } })] })))!.rules).toHaveLength(1); });
});

describe('shared rules (repo-level user-style-rules.shared.json)', () => {
  const shared: UserStyleRulesFile = { schemaVersion: 1, rules: [{ id: 'a', section: 's', match: { tag: 'div' }, style: { color: 'var(--black-900)' }, reason: 'why' }] };
  const project: UserStyleRulesFile = { schemaVersion: 1, rules: [{ id: 'b', section: 's', match: { tag: 'div' }, style: { 'border-radius': '0' }, reason: 'why' }] };

  it('merges shared then project rules, and marks the shared ones', () => {
    const m = mergeUserStyleRules(shared, project)!;
    expect(m.rules.map((r) => [r.id, r.shared ?? false])).toEqual([['a', true], ['b', false]]);
    expect(mergeUserStyleRules(null, null)).toBeNull();
    expect(mergeUserStyleRules(shared, null)!.rules).toHaveLength(1);
  });

  it('refuses an id defined in both files — a project never silently redefines a shared rule', () => {
    expect(() => mergeUserStyleRules(shared, { ...project, rules: [{ ...project.rules[0]!, id: 'a' }] })).toThrow(/both/);
  });

  it('a shared rule that matches nothing on a page is reported with shared:true (not an error)', () => {
    const { applied } = applyUserStyleRules(mergeUserStyleRules(shared, null), [{ id: 'other', tree: { t: 'el', tag: 'div', attrs: {}, children: [] } }]);
    expect(applied).toEqual([{ id: 'a', section: 's', matched: 0, reason: 'why', shared: true }]);
  });

  it('the real shared file is valid', async () => {
    const f = await readUserStyleRules(join(process.cwd(), 'user-style-rules.shared.json'));
    expect(f!.rules.length).toBeGreaterThan(0);
  });

  it('section "*" applies a shared rule in every section of the page', () => {
    const ink: UserStyleRulesFile = { schemaVersion: 1, rules: [{ id: 'ink', section: '*', match: { classIncludes: ['text-[#141016]'] }, style: { color: 'var(--black-900)' }, reason: 'why' }] };
    const a = el('div', 'x', [el('p', 'text-[#141016] text-sm')]);
    const b = el('div', 'y', [el('h2', 'text-[#141016]'), el('p', 'text-[#fff]')]);
    const { applied, css } = applyUserStyleRules(mergeUserStyleRules(ink, null), [{ id: 'one', tree: a }, { id: 'two', tree: b }]);
    expect(applied).toEqual([{ id: 'ink', section: '*', matched: 2, reason: 'why', shared: true }]);
    expect(css).toContain('color: var(--black-900) !important;');
    expect(JSON.stringify(b).match(/data-pv-user-rule/g)).toHaveLength(1);
  });

  it('section "*" is refused in a project file', () => {
    const star: UserStyleRulesFile = { schemaVersion: 1, rules: [{ id: 'p', section: '*', match: { tag: 'p' }, style: { color: 'var(--black-900)' }, reason: 'why' }] };
    expect(() => mergeUserStyleRules(null, star)).toThrow(/only allowed in the shared file/);
  });

  it('an element named by two rules keeps both (ids joined, styles merged) — the ink rule never drops the card rule', () => {
    const file: UserStyleRulesFile = { schemaVersion: 1, rules: [
      { id: 'ink', section: '*', match: { classIncludes: ['text-[#141016]'] }, style: { color: 'var(--black-900)' }, reason: 'why', shared: true },
      { id: 'sq', section: 's', match: { classIncludes: ['rounded-'] }, style: { 'border-radius': '0' }, reason: 'why' },
    ] };
    const t = el('div', 'grid', [el('div', 'rounded-[10px] text-[#141016]')]);
    const { css } = applyUserStyleRules(file, [{ id: 's', tree: t }]);
    const n = (t as PreviewNode & { t: 'el' }).children[0] as PreviewNode & { t: 'el' };
    expect(n.attrs['data-pv-user-rule']).toBe('ink sq');
    expect(parseUserStyle(n.attrs['data-pv-user-style'] ?? null)).toEqual([['color', 'var(--black-900)'], ['border-radius', '0']]);
    expect(css).toContain('[data-pv-user-rule~="ink"]');
    expect(css).toContain('[data-pv-user-rule~="sq"]');
  });
});
