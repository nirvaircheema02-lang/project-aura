import { afterAll, describe, expect, it } from 'vitest';
import { resolveTargets } from '../../src/resolution/resolve.ts';
import { authorizedProperties } from '../../src/resolution/schema.ts';
import { cleanupDsFixtures, miniDsIndex } from '../helpers/ds-colour-fixture.ts';
import { decision, entryFor, now, prop, residual, RUN, targetFor } from '../helpers/resolver-stub.ts';

afterAll(() => cleanupDsFixtures());

/**
 * Reference lane round 3: a judgment target that carries no DS token is only keywords / 0 / a hairline. For a colour, shape, shadow or typography property that is
 * a legitimate design value (`transparent`, `none`, `0`); for `opacity: 0`, `pointer-events: none`, `visibility: initial`, `all: unset` it is a change of
 * behaviour or composition with nothing from the DS behind it - and R3 would synthesize and apply it. Refused, with a reason that says so.
 */

async function judge(property: string, value: string, extraTokens = '') {
  const f = residual('f-card', 'card', [prop({ property })]);
  const out = await resolveTargets({ page: null, dsIndex: miniDsIndex(extraTokens), dsRegistryVersion: 'v1', decisions: null, reference: null, now }, { run: RUN, findings: [f], entries: [entryFor('eCard', 'f-card')], judgment: { decisions: [decision({ property, value, source: 'proposed-local-variant', dsToken: null, reference: null })], notes: [] } });
  return { file: out.file, t: targetFor(out.file.targets, property) };
}

describe('a zero-token judgment of a behaviour property is refused', () => {
  it.each([
    ['opacity', '0'],
    ['all', 'unset'],
    ['pointer-events', 'none'],
    ['visibility', 'initial'],
    ['filter', 'none'],
    ['cursor', 'none'],
  ])('%s: %s', async (property, value) => {
    const { file, t } = await judge(property, value);
    expect(t.outcome, `${property}: ${value}`).toBe('unresolved');
    expect(t.target).toBeNull();
    expect(t.reason).toBe('policy-conflict');
    expect(t.decisionReason).toMatch(/no DS token/);
    expect(t.decisionReason).toMatch(/colour, shape, shadow or typography/);
    expect(authorizedProperties(file, 'f-card').size).toBe(0);
  });
});

describe('round 4: a zero-token judgment inside an allowed category may still hide or remove content', () => {
  it.each([
    ['font-size', '0'], ['font-size', '0px'], ['font-size', 'normal'], ['line-height', '0'], ['line-height', 'normal'], ['letter-spacing', '0'], ['letter-spacing', '0px'], ['word-spacing', '0'],
    ['color', 'transparent'], ['color', 'none'], ['caret-color', 'transparent'], ['text-decoration-color', 'transparent'], ['fill', 'none'], ['fill', 'transparent'], ['stroke', 'transparent'],
    ['border-style', 'none'], ['border-top-style', 'none'], ['border-bottom-style', 'none'], ['outline-style', 'none'], ['column-rule-style', 'none'],
    ['background-image', 'none'], ['text-transform', 'initial'], ['text-decoration', 'unset'], ['font-weight', 'normal'],
  ])('%s: %s is refused with a reason that says what it would do', async (property, value) => {
    const { file, t } = await judge(property, value);
    expect(t.outcome, `${property}: ${value}`).toBe('unresolved');
    expect(t.target).toBeNull();
    expect(t.reason).toBe('policy-conflict');
    expect(t.decisionReason).toMatch(/no DS token/);
    expect(t.decisionReason).toMatch(new RegExp(property.replace(/[-]/g, '\\-')));
    expect(authorizedProperties(file, 'f-card').size).toBe(0);
  });

  it.each([
    ['border-top-color', 'transparent'], ['border-top-color', 'currentcolor'], ['outline-color', 'transparent'], ['background-color', 'transparent'], ['background', 'transparent'], ['column-rule-color', 'transparent'],
    ['border-top-left-radius', '0'], ['border-radius', '0'], ['border-start-start-radius', '0px'],
    ['border-top-width', '0'], ['border-width', '0'], ['border-top-width', '1px'], ['outline-width', '0'],
    ['border-top-style', 'solid'], ['border-top-style', 'dashed'], ['outline-style', 'solid'],
    ['border', 'none'], ['border-top', '1px solid transparent'], ['outline', 'none'], ['box-shadow', 'none'], ['text-shadow', 'none'],
    ['text-decoration', 'none'], ['text-decoration-line', 'none'], ['letter-spacing', 'normal'], ['text-transform', 'none'], ['font-style', 'normal'], ['color', 'currentcolor'], ['color', 'inherit'],
  ])('%s: %s stays a design value', async (property, value) => {
    const { t } = await judge(property, value);
    expect(t, `${property}: ${value} - ${t.decisionReason}`).toMatchObject({ outcome: 'resolved-target', target: { value } });
  });

  it.each([
    ['font-size', '0', '--font-size-0: 0px;'], ['line-height', '0', '--lh-0: 0;'], ['color', 'transparent', '--ink-clear: transparent;'],
  ])('%s from a DS token is not affected (the token, not the keyword, is the DS guidance)', async (property, _value, tokens) => {
    const name = tokens.slice(0, tokens.indexOf(':'));
    const { t } = await judge(property, `var(${name})`, tokens);
    expect(t).toMatchObject({ outcome: 'resolved-target', target: { token: name } });
  });
});

describe('a zero-token judgment of a colour, shape, shadow or typography property is still a design value', () => {
  it.each([
    ['border-top-color', 'transparent'],
    ['border-top-left-radius', '0'],
    ['box-shadow', 'none'],
    ['text-shadow', 'none'],
    ['outline', 'none'],
    ['text-decoration', 'none'],
    ['letter-spacing', 'normal'],
  ])('%s: %s', async (property, value) => {
    const { t } = await judge(property, value);
    expect(t, `${property}: ${value} - ${t.decisionReason}`).toMatchObject({ outcome: 'resolved-target', target: { value } });
  });
});

describe('a judgment that carries a DS token is not affected', () => {
  it('opacity from a DS token resolves', async () => {
    const { t } = await judge('opacity', 'var(--opacity-muted)', '--opacity-muted: 0.6;');
    expect(t).toMatchObject({ outcome: 'resolved-target', target: { value: '0.6', token: '--opacity-muted' } });
  });
});
