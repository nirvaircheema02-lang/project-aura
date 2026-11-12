/**
 * The text a visitor can actually read inside `root`: text nodes that are rendered with a real box,
 * inside every clipping ancestor, and not transparent. Closed menus and panels (display:none, zero-height
 * overflow:hidden, opacity 0, off-screen clipped) contribute nothing. Used on BOTH sides of the content
 * check for hand-authored sections — the original snapshot and the running preview — so the two are
 * measured by exactly the same code.
 *
 * Self-contained on purpose: it is stringified into the page (no imports, no closure variables).
 */
export function visibleTextOf(root: Element): string {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const parts: string[] = [];
  const clipOf = (el: Element): { l: number; t: number; r: number; b: number } | null => {
    let box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let n: Element | null = el; n && n !== root.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return null;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = n.getBoundingClientRect();
        box = { l: Math.max(box.l, cs.overflowX !== 'visible' ? r.left : -Infinity), t: Math.max(box.t, cs.overflowY !== 'visible' ? r.top : -Infinity), r: Math.min(box.r, cs.overflowX !== 'visible' ? r.right : Infinity), b: Math.min(box.b, cs.overflowY !== 'visible' ? r.bottom : Infinity) };
      }
    }
    return box;
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? '').trim();
      if (!text) return;
      const parent = node.parentElement;
      if (!parent) return;
      const clip = clipOf(parent);
      if (!clip) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const w = Math.min(r.right, clip.r) - Math.max(r.left, clip.l);
      const h = Math.min(r.bottom, clip.b) - Math.max(r.top, clip.t);
      if (w > 1 && h > 1) parts.push(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    // a text-like form control shows its value (or its chosen option) to the visitor, though it is not a text node
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      const shows = el.tagName !== 'INPUT' || ['text', 'search', 'number', 'email', 'tel', 'url'].includes(type);
      const value = !shows ? '' : el.tagName === 'SELECT' ? ((el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '').trim() : String(input.value ?? '').trim();
      const clip = value ? clipOf(el) : null;
      const r = clip ? el.getBoundingClientRect() : null;
      if (value && clip && r && Math.min(r.right, clip.r) - Math.max(r.left, clip.l) > 1 && Math.min(r.bottom, clip.b) - Math.max(r.top, clip.t) > 1) parts.push(value);
      return;
    }
    if (el.tagName === 'SLOT') { for (const n of (el as HTMLSlotElement).assignedNodes({ flatten: true })) visit(n); return; }
    for (const c of Array.from(el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes)) visit(c);
  };
  visit(root);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
