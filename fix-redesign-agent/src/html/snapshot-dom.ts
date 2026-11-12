import type { Page } from 'playwright';

/**
 * The live DOM can hold structures that HTML text cannot represent: React/JS may put a `<p>` (or `<div>`, `<ul>`…) INSIDE a
 * `<p>`. Serialized to text and parsed again, the browser closes the outer `<p>` at the first inner block, so the children
 * fall OUT of their container. On the dealers-voice-survey FAQ the answers sit in `<p style="height:0;overflow:hidden"><p>…</p></p>`:
 * after the round trip every answer was visible and the accordion looked fully open and cluttered.
 *
 * The snapshot therefore turns every `<p>` that contains block-level content into a `<div>` with the same attributes
 * (classes, inline style, data-fra-* stamps) and children, so the structure — and the collapsed state — survives. The live
 * page itself is never touched; only the serialized copy is.
 */
export async function serializeSnapshotDom(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const BLOCK = 'address,article,aside,blockquote,details,div,dl,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,main,menu,nav,ol,p,pre,section,table,ul';
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    for (const p of Array.from(root.querySelectorAll('p')).reverse()) {
      if (!p.querySelector(BLOCK)) continue;
      const div = document.createElement('div');
      for (const a of Array.from(p.attributes)) div.setAttribute(a.name, a.value);
      while (p.firstChild) div.appendChild(p.firstChild);
      p.replaceWith(div);
    }
    // FROZEN CAPTURE: every stylesheet link becomes an inline <style> NOW, with its url(...) made absolute. A saved capture must never need
    // the live site again — a redeploy replaces the hashed CSS files, and a snapshot that still points at them renders unstyled. A stylesheet
    // that cannot be read, or reads as (almost) empty, stops the capture instead of producing a page that only looks captured.
    const bad: string[] = [];
    for (const link of Array.from(root.querySelectorAll('link[rel~="stylesheet"]'))) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const abs = new URL(href, document.baseURI).href;
      try {
        const res = await fetch(abs, { credentials: 'omit' });
        const css = await res.text();
        if (!res.ok || css.trim().length < 20) { bad.push(`${href} (HTTP ${res.status}, ${css.length} bytes)`); continue; }
        const style = document.createElement('style');
        style.setAttribute('data-fra-inlined-from', href);
        style.textContent = css.replace(/url\(\s*(['"]?)(?!data:|https?:|#|\/\/)([^'")]+)\1\s*\)/g, (_m, q: string, u: string) => `url(${q}${new URL(u, abs).href}${q})`);
        link.replaceWith(style);
      } catch (e) { bad.push(`${href} (${e instanceof Error ? e.message : String(e)})`); }
    }
    if (bad.length > 0) throw new Error(`capture stopped: ${bad.length} stylesheet(s) could not be frozen into the snapshot — ${bad.join('; ')}`);
    const dt = document.doctype;
    const doctype = dt ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>` : '<!DOCTYPE html>';
    return doctype + root.outerHTML;
  });
}
