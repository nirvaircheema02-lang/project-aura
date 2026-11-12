import type { ElementHandle, Page } from 'playwright';

/**
 * Exercises every popup control (select / combobox: aria-haspopup="listbox" or role="combobox") of the rendered
 * sections the way a visitor does — click, keyboard, pick an option, Escape — and checks what a visitor must SEE:
 * a listbox with options that are really on screen and hit-testable, over a painted panel, and a focus indicator.
 * "The click handler fired" or "a role=option exists" is not enough: a transparent or clipped menu passes both.
 */

export interface PopupControlResult {
  section: string;
  label: string;
  /** Clicking the trigger opens a listbox (aria-expanded true). */
  clickOpens: boolean;
  /** Options that are inside the viewport and are the element actually hit at their centre. */
  optionsVisible: number;
  optionsInDom: number;
  /** The panel behind the options has a painted background. */
  panelFilled: boolean;
  escapeCloses: boolean;
  keyboard: { enter: boolean; space: boolean; arrowDown: boolean };
  /** ArrowDown + Enter changes the control's displayed value (null: fewer than two options). */
  keyboardSelects: boolean | null;
  /** Clicking an option closes the menu and changes the displayed value (null: fewer than two options). */
  clickSelects: boolean | null;
  focusIndicator: { present: boolean; detail: string };
  notes: string[];
}

const TRIGGER = '[aria-haspopup="listbox"],[role="combobox"]';

async function triggers(page: Page, sectionId: string): Promise<Array<ElementHandle<Element>>> {
  const arr = await page.evaluateHandle((id) => {
    const out: Element[] = [];
    const host = document.querySelector(`[data-pv-section="${id}"]`);
    const visit = (root: ParentNode) => {
      root.querySelectorAll('*').forEach((e) => {
        if (e.matches('[aria-haspopup="listbox"],[role="combobox"]')) out.push(e);
        if (e.shadowRoot) visit(e.shadowRoot);
      });
      if ((root as Element).shadowRoot) visit((root as Element).shadowRoot!);
    };
    if (host) visit(host);
    return out.filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; });
  }, sectionId);
  const props = await arr.getProperties();
  const handles: Array<ElementHandle<Element>> = [];
  for (const p of props.values()) { const el = p.asElement(); if (el) handles.push(el as ElementHandle<Element>); }
  return handles;
}

const menuState = (page: Page) => page.evaluate(() => {
  const visit = (root: ParentNode, out: Element[]) => { root.querySelectorAll('*').forEach((e) => { if (e.matches('[role="listbox"]')) out.push(e); if (e.shadowRoot) visit(e.shadowRoot, out); }); };
  const lists: Element[] = []; visit(document, lists);
  const list = lists.find((l) => { const r = l.getBoundingClientRect(); const cs = getComputedStyle(l); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05; }) ?? null;
  if (!list) return { open: false, inDom: 0, visible: 0, filled: false };
  const opts = Array.from(list.querySelectorAll('[role="option"]'));
  const vw = innerWidth, vh = innerHeight;
  const visible = opts.filter((o) => {
    const r = o.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (r.width <= 0 || r.height <= 0 || cx < 0 || cy < 0 || cx > vw || cy > vh) return false;
    const hit = document.elementFromPoint(cx, cy);
    return !!hit && (o === hit || o.contains(hit) || hit.contains(o) || list.contains(hit));
  }).length;
  // the panel: the listbox itself or the nearest ancestor within its popper wrapper that paints a background
  let filled = false;
  for (let n: Element | null = list; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const m = cs.backgroundColor.match(/rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+(?:[\s,/]+([\d.]+))?\s*\)/);
    const a = m ? (m[1] === undefined ? 1 : Number(m[1])) : 0;
    if (a >= 0.9 || (cs.backgroundImage && cs.backgroundImage !== 'none')) { filled = true; break; }
    if (n.hasAttribute('data-radix-popper-content-wrapper')) break;
  }
  return { open: true, inDom: opts.length, visible, filled };
});

const expandedOf = (el: ElementHandle<Element>) => el.evaluate((e) => e.getAttribute('aria-expanded') === 'true');
const textOf = (el: ElementHandle<Element>) => el.evaluate((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());

async function focusStyles(el: ElementHandle<Element>): Promise<string> {
  return el.evaluate((e) => {
    const take = (n: Element) => { const c = getComputedStyle(n); return [c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.borderTopColor, c.borderTopWidth, c.backgroundColor].join('|'); };
    const parts: string[] = [take(e)];
    let n: Element | null = e.parentElement;
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) parts.push(take(n));
    return parts.join('||');
  });
}

async function close(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

export async function checkPopupControls(page: Page, sectionIds: string[], opts: { max?: number } = {}): Promise<PopupControlResult[]> {
  const out: PopupControlResult[] = [];
  const max = opts.max ?? 12;
  for (const section of sectionIds) {
    const list = await triggers(page, section);
    for (const trigger of list) {
      if (out.length >= max) return out;
      const label = ((await trigger.evaluate((e) => e.getAttribute('aria-label') ?? '')) || (await textOf(trigger))).slice(0, 50);
      const r: PopupControlResult = { section, label, clickOpens: false, optionsVisible: 0, optionsInDom: 0, panelFilled: false, escapeCloses: false, keyboard: { enter: false, space: false, arrowDown: false }, keyboardSelects: null, clickSelects: null, focusIndicator: { present: false, detail: '' }, notes: [] };
      try {
        await trigger.scrollIntoViewIfNeeded({ timeout: 2000 });
        await page.mouse.move(0, 0);

        // click opens; options are on screen over a painted panel; Escape closes
        await trigger.click({ timeout: 3000 });
        await page.waitForTimeout(450);
        const open = await menuState(page);
        r.clickOpens = open.open && (await expandedOf(trigger));
        r.optionsInDom = open.inDom; r.optionsVisible = open.visible; r.panelFilled = open.filled;
        await close(page);
        r.escapeCloses = !(await menuState(page)).open && !(await expandedOf(trigger));

        // keyboard: focus, then each documented opening key
        const key = async (k: string) => {
          await trigger.focus();
          await page.keyboard.press(k);
          await page.waitForTimeout(450);
          const s = await menuState(page);
          const ok = s.open && s.visible > 0;
          await close(page);
          return ok;
        };
        r.keyboard.enter = await key('Enter');
        r.keyboard.space = await key('Space');
        r.keyboard.arrowDown = await key('ArrowDown');

        // keyboard selection: ArrowDown + Enter changes the displayed value
        if (open.inDom > 1) {
          await trigger.focus();
          const before = await textOf(trigger);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(450);
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(150); // a person's key gap: the menu moves its highlight asynchronously, so a same-tick Enter would select the old item
          await page.keyboard.press('Enter');
          await page.waitForTimeout(450);
          r.keyboardSelects = (await textOf(trigger)) !== before && !(await menuState(page)).open;
          // click selection: open again, click an option that is not the current value
          await trigger.click({ timeout: 3000 });
          await page.waitForTimeout(450);
          const current = await textOf(trigger);
          const pick = await page.evaluateHandle((cur) => {
            const visit = (root: ParentNode, o: Element[]) => { root.querySelectorAll('*').forEach((e) => { if (e.matches('[role="option"]')) o.push(e); if (e.shadowRoot) visit(e.shadowRoot, o); }); };
            const opts: Element[] = []; visit(document, opts);
            return opts.find((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim() !== cur) ?? null;
          }, current);
          const el = pick.asElement();
          if (el) { await el.click({ timeout: 3000 }); await page.waitForTimeout(450); r.clickSelects = (await textOf(trigger)) !== current && !(await menuState(page)).open; }
          else r.clickSelects = false;
        }

        // focus indicator: the focused control (or the frame around it) must look different from idle
        await page.keyboard.press('Escape');
        await trigger.evaluate((e) => (e as HTMLElement).blur());
        await page.waitForTimeout(250);
        const idle = await focusStyles(trigger);
        await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); // arrive by keyboard so :focus-visible applies
        await trigger.focus();
        await page.waitForTimeout(250);
        const focused = await focusStyles(trigger);
        r.focusIndicator = { present: idle !== focused, detail: idle !== focused ? 'the control or its frame changes when keyboard-focused' : 'nothing about the control or its three enclosing frames changes when it is keyboard-focused' };
        await trigger.evaluate((e) => (e as HTMLElement).blur());
      } catch (err) {
        r.notes.push(`threw: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        await close(page).catch(() => undefined);
      }
      out.push(r);
    }
  }
  return out;
}
