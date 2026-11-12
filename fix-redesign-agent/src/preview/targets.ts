import type { ElementHandle, JSHandle, Page } from 'playwright';
import { propertyMatchesExpected } from '../style/compare-expected.ts';
import { lengthToPx } from '../t-layer/computed-style.ts';
import { judgeRenderedColour, measureUsedGapOf, readInState, settleState } from '../resolution/rendered.ts';
import type { ResolvedTarget } from '../resolution/schema.ts';
import { coveredProperties } from '../fidelity/compare.ts';
import { parseUserStyle } from './user-style-rules.ts';

/**
 * Measures a RESOLVED target in the rendered preview — the element the finding maps to, in the target's
 * state, compared with the target's value by the target's own comparison method. Hover and keyboard
 * focus are exercised the way a visitor does (never a click, never a submit).
 */

export interface TargetMeasurement {
  targetId: string;
  findingId: string;
  property: string;
  state: ResolvedTarget['state'];
  part: string;
  expected: string;
  actual: string | null;
  matches: boolean;
  /** Could the target be measured at all? A target that cannot be measured is `unverified`, never matched. */
  measured: boolean;
  note: string;
}

const handleFor = async (page: Page, findingId: string): Promise<ElementHandle<Element> | null> => {
  const h = (await page.evaluateHandle((id) => {
    const wrapper = (window as any).__pvVerify.findByFinding(id) as Element | null;
    if (!wrapper) return null;
    // a design-system island is wrapped in an element; the thing to measure is the component inside it
    const comp = wrapper.getAttribute('data-pv-island');
    return !comp ? wrapper : comp === 'Button' ? (wrapper.querySelector('a,button') ?? wrapper) : (wrapper.querySelector('h1,h2,h3,h4,h5,h6') ?? wrapper);
  }, findingId)) as JSHandle<Element | null>;
  return h.asElement() as ElementHandle<Element> | null;
};

/** The deepest element that holds the finding's visible text (the `label` part), or the element itself. */
const labelOf = async (el: ElementHandle<Element>): Promise<ElementHandle<Element>> => {
  const h = (await el.evaluateHandle((root) => {
    const text = (root.textContent ?? '').replace(/\s+/g, ' ').trim();
    const all = [root, ...Array.from(root.querySelectorAll('*'))];
    return all.reverse().find((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim() === text && e.children.length === 0) ?? root;
  })) as JSHandle<Element>;
  return (h.asElement() as ElementHandle<Element>) ?? el;
};

export async function measureResolvedTarget(page: Page, t: ResolvedTarget): Promise<TargetMeasurement> {
  const base = { targetId: t.id, findingId: t.findingId, property: t.property, state: t.state, part: t.part, expected: t.target?.value ?? '', actual: null as string | null };
  const fail = (note: string): TargetMeasurement => ({ ...base, matches: false, measured: false, note });
  if (!t.target) return fail('not a resolved target');
  let el = await handleFor(page, t.findingId);
  if (!el) return fail('no element carrying this finding is rendered in the preview');
  if (t.part === 'label') el = await labelOf(el);
  else if (t.part !== 'self') return fail(`the part "${t.part}" is not measurable in the preview`);
  // A user style rule (projects/<p>/user-style-rules.json) restyles this element: for the properties it names, the USER's value is the one that is measured —
  // the audit's expectation is superseded by the explicit instruction, and the note says so. Anything the rule does not name is still the target's.
  const userRule = await el.evaluate((n) => ({ id: n.getAttribute('data-pv-user-rule'), style: n.getAttribute('data-pv-user-style') })).catch(() => ({ id: null, style: null }));
  const userValue = userRule.id ? parseUserStyle(userRule.style).find(([p]) => coveredProperties(p).has(t.property))?.[1] : undefined;
  if (userValue !== undefined && t.state === 'default') {
    const read = await el.evaluate((node, [prop, val]) => {
      const probe = document.createElement('span');
      probe.style.setProperty(prop as string, val as string);
      (node.parentElement ?? node).appendChild(probe);
      const want = getComputedStyle(probe).getPropertyValue(prop as string);
      probe.remove();
      return { actual: getComputedStyle(node).getPropertyValue(prop as string), want };
    }, [t.property, userValue] as const);
    return { ...base, expected: read.want, actual: read.actual, matches: read.actual === read.want, measured: true, note: `user style rule "${userRule.id}" supersedes the audit's expectation (${t.target.value}): measured against the user's ${userValue}` };
  }
  const state = t.state;
  if (state !== 'default' && state !== 'hover' && state !== 'focus' && state !== 'focus-visible') return fail(`the ${state} state cannot be exercised without a script-driven interaction`);

  // the same keyword-comparison escape hatch as the audit's gap: compare USED spacing for gap targets
  if (t.target.comparison === 'rendered-length-px' && /^(?:row-|column-)?gap$/.test(t.property)) {
    const used = await measureUsedGapOf(page, el, t.property.startsWith('column') ? 'column' : 'row');
    const exp = lengthToPx(t.target.value);
    if (!used.applicable) return { ...base, actual: 'not applicable', matches: false, measured: true, note: 'gap has no effect on this element (not a flex/grid container)' };
    if (used.px === null || exp === null) return fail('the spacing could not be measured');
    return { ...base, actual: `${used.px}px`, matches: Math.abs(used.px - exp) <= 0.5, measured: true, note: `${used.px}px vs expected ${exp}px` };
  }

  // a colour target is met only if it is also VISIBLE on the backdrop it is drawn over and, in a hover/focus state, differs from the default. The default colour
  // belongs to the resting element, so it is read BEFORE the state is applied; the backdrop is read IN the state (a card can change its own background on hover)
  const wantsColour = t.acceptance.some((a) => (a.kind === 'colour-visible' || a.kind === 'state-distinct') && a.property === t.property && a.state === state);
  const wantsDistinct = state !== 'default' && t.acceptance.some((a) => a.kind === 'state-distinct' && a.property === t.property && a.state === state);
  // ... and only once the resting element itself has settled (a way back from an earlier hover/focus, or a page-load animation, is waited out): null otherwise
  const defaultColour = wantsDistinct && (await settleState(page, el, t.property)).settled ? await el.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), t.property).catch(() => null) : null;

  try {
    if (state === 'hover') { await el.scrollIntoViewIfNeeded({ timeout: 1500 }); await el.hover({ timeout: 2000 }); }
    else if (state === 'focus' || state === 'focus-visible') { await page.keyboard.press('Shift'); await el.scrollIntoViewIfNeeded({ timeout: 1500 }); await el.focus(); }
    // the element (and its ancestors) must have SETTLED - a transition is waited out, not guessed at - and the colour and its backdrop are read in the same
    // evaluation of that state; one that never settles is unverified, never judged on whatever frame was caught
    const settled = await settleState(page, el, t.property);
    if (!settled.settled) return fail(`the ${state} state did not settle, so ${t.property} is not judged: ${settled.why ?? 'it kept changing'}`);
    const read = await readInState(page, el, t.property, wantsColour);
    const backdrop = read.backdrop;
    const resolved = await el.evaluate((node, [prop, val]) => {
      const probe = document.createElement('span');
      probe.style.setProperty(prop as string, val as string);
      (node.parentElement ?? node).appendChild(probe);
      const out = probe.style.getPropertyValue(prop as string) ? getComputedStyle(probe).getPropertyValue(prop as string) : (val as string);
      probe.remove();
      return out;
    }, [t.property, t.target.value] as const);
    const r = { actual: read.value, resolved };
    const method = t.target.comparison === 'rendered-length-px' ? 'length-px' : t.target.comparison;
    const cmp = propertyMatchesExpected(method, r.actual, r.resolved);
    if (!cmp.matches || backdrop === null) return { ...base, expected: r.resolved, actual: r.actual, matches: cmp.matches, measured: true, note: cmp.note };
    const judged = judgeRenderedColour(t, { by: 'R8', colour: r.actual, defaultColour, backdrop });
    if (judged.status === 'passed' || judged.status === 'not-required') return { ...base, expected: r.resolved, actual: r.actual, matches: true, measured: true, note: `${cmp.note}; ${judged.note}` };
    // the value matches but the colour is invisible / collapsed (failed), or its backdrop cannot be measured (unverified: measured = false): never "verified"
    const note = `the value matches (${cmp.note}) but ${judged.note}`;
    return judged.status === 'unverified' ? { ...base, expected: r.resolved, actual: r.actual, matches: false, measured: false, note } : { ...base, expected: r.resolved, actual: r.actual, matches: false, measured: true, note };
  } catch (err) {
    return fail(`the target could not be measured: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  } finally {
    if (state === 'hover') await page.mouse.move(0, 0).catch(() => undefined);
    else if (state === 'focus' || state === 'focus-visible') await el.evaluate((n) => (n as HTMLElement).blur()).catch(() => undefined);
    // the way back settles before the next target of this element is measured (its default colour is read at rest)
    if (state !== 'default') await settleState(page, el, null).catch(() => undefined);
  }
}
