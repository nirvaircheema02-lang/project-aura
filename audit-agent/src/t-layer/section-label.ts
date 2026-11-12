import type { Locator } from 'playwright';

/** Prefer a section's own title over a nested card heading/price. Returns evidence, not
 * invented marketing names; a content-derived fallback is explicitly marked in the note. */
export async function readSectionLabel(locator: Locator): Promise<{ name: string; note: string } | null> {
  return locator.evaluate(root => {
    const clean = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
    const own = clean(root.getAttribute('aria-label'));
    if (own) return { name: own.slice(0, 100), note: 'section label from container aria-label' };
    const named = root.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    if (clean(named ?? null)) return { name: clean(named!).slice(0, 100), note: 'section label from aria-labelledby' };
    const box = root.getBoundingClientRect();
    const candidates = Array.from(root.querySelectorAll('h1,h2,h3,h4,[role="heading"],p,div,span,strong')).flatMap(el => {
      if (el.closest('button,a,[role="button"]')) return [];
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || r.top < box.top - 2 || r.right <= 0 || r.left >= innerWidth) return [];
      const heading = /^H[1-4]$/.test(el.tagName) || el.getAttribute('role') === 'heading';
      const text = clean(heading ? el.textContent : Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' '));
      if (text.length < 4 || text.length > 120 || /^[₹$€£\d\s.,%+–-]+(?:\s*[LKMB]|\s*(?:lakh|crore|million))?$/i.test(text)) return [];
      if (!heading && (r.top - box.top > 180 || (parseFloat(cs.fontSize) < 18 && Number(cs.fontWeight) < 500))) return [];
      let depth = 0; for (let p = el.parentElement; p && p !== root; p = p.parentElement) depth++;
      return [{ text, heading, depth, y: r.top - box.top, level: Number(el.tagName.slice(1)) || 6, fontSize: parseFloat(cs.fontSize) }];
    });
    const headings = candidates.filter(c => c.heading).sort((a,b) => a.depth - b.depth || a.level - b.level || a.y - b.y);
    const firstText = candidates.filter(c => !c.heading).sort((a,b) => a.y - b.y || a.depth - b.depth)[0];
    const heading = headings.find(c => c.level === 1) ?? headings[0];
    const selected = heading?.level === 1 ? heading : firstText && (!heading || firstText.y + 24 < heading.y && (firstText.depth <= heading.depth || firstText.fontSize > heading.fontSize)) ? firstText : heading ?? firstText;
    return selected ? { name: selected.text.slice(0,100), note: `section label from visible ${selected.heading ? 'heading' : 'title-like text (inferred)'} in the section container` } : null;
  }, undefined, { timeout: 2000 }).catch(() => null);
}
