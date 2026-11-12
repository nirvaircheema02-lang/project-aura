import type { Finding } from '../audit-link/index.ts';

/**
 * R1.4 ("Two-Font Pairing") is the one rule violation whose fix can be MEASURED on a rendered
 * page: the typeface actually used by the element's text. Used by R5 (the live, edited page) and
 * by R8 (the generated React preview), so "fixed" means the same thing in both.
 */

export const DS_TYPEFACES = ['dm sans', 'noto serif'];

/** The offending family named by each R1.4 violation, e.g. `set in "manrope" (Manrope, …)` → `manrope`. */
export function typefaceRuleChecks(f: Finding): Array<{ ruleId: string; offending: string }> {
  return f.comparison.ruleViolations
    .filter((v) => /^R1\.4\b/.test(v.ruleId) || /two-font pairing/i.test(v.title))
    .map((v) => ({ ruleId: v.ruleId, offending: /set in "([^"]+)"/i.exec(v.why)?.[1]?.trim().toLowerCase() ?? '' }))
    .filter((c) => c.offending !== '');
}

/**
 * Runs IN the page (`locator.evaluate(typefaceInPage, args)` / `handle.evaluate(...)`): every
 * text-bearing element at or below `root` must be set in a design-system typeface, not the
 * offending one. `offenders` names the elements that are not, as selectors relative to `root`
 * (` > span:nth-of-type(1)`; empty for the root itself), so a retry can target exactly them.
 * Self-contained on purpose — Playwright serializes only this function's source.
 */
export function typefaceInPage(root: Element, args: { bad: string; ds: string[] }): { families: string[]; ok: boolean; offenders: Array<{ path: string; family: string }> } {
  const first = (el: Element) => getComputedStyle(el).fontFamily.split(',')[0]!.replace(/["']/g, '').trim().toLowerCase();
  const holders: Element[] = [];
  const visit = (el: Element) => {
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.nodeValue ?? '').trim() !== '');
    if (own) holders.push(el);
    for (const c of Array.from(el.children)) visit(c);
  };
  visit(root);
  if (holders.length === 0) holders.push(root);
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
      const tag = n.localName;
      const same = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.localName === tag) : [n];
      parts.unshift(`${tag}:nth-of-type(${same.indexOf(n) + 1})`);
    }
    return parts.length ? ' > ' + parts.join(' > ') : '';
  };
  const bad = holders.filter((h) => { const f = first(h); return f === args.bad || !args.ds.includes(f); });
  const families = [...new Set(holders.map(first))];
  return { families, ok: bad.length === 0, offenders: bad.map((h) => ({ path: pathOf(h), family: first(h) })) };
}
