import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startStaticServer, type StaticServerHandle } from '../../src/serve/static-server.ts';

/**
 * The zero-dependency static server `serve <redesignRunId>` uses to give REAL
 * `http://localhost:PORT/...` links (not `file://`) for the two sibling deliverables. Read-only,
 * directory-traversal-safe, and never fails a run just because a previous server is still bound
 * to the preferred port.
 */

let root: string;
let handle: StaticServerHandle | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-static-server-'));
});
afterEach(async () => {
  await handle?.close();
  handle = null;
  rmSync(root, { recursive: true, force: true });
});

describe('startStaticServer', () => {
  it('serves a file under its mounted prefix, mapping the prefix to the right directory', async () => {
    const redesignDir = join(root, 'redesign');
    mkdirSync(redesignDir, { recursive: true });
    writeFileSync(join(redesignDir, 'redesigned-page.html'), '<!doctype html><html><body>hello</body></html>');

    handle = await startStaticServer([{ prefix: '/redesign', dir: redesignDir }], 0);
    const res = await fetch(`${handle.origin}/redesign/redesigned-page.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hello');
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves two independently-mounted roots from ONE server without cross-contamination', async () => {
    const redesignDir = join(root, 'redesign');
    const newComponentDir = join(root, 'new-component');
    mkdirSync(redesignDir, { recursive: true });
    mkdirSync(join(newComponentDir, 'Card'), { recursive: true });
    writeFileSync(join(redesignDir, 'redesigned-page.html'), 'PAGE');
    writeFileSync(join(newComponentDir, 'Card', 'Card.tsx'), 'export const Card = () => null;');

    handle = await startStaticServer([
      { prefix: '/redesign', dir: redesignDir },
      { prefix: '/new-component', dir: newComponentDir },
    ], 0);
    const page = await fetch(`${handle.origin}/redesign/redesigned-page.html`);
    const component = await fetch(`${handle.origin}/new-component/Card/Card.tsx`);
    expect(await page.text()).toBe('PAGE');
    expect(await component.text()).toContain('export const Card');
  });

  it('a request for a directory falls back to that directory\'s index.html', async () => {
    const dir = join(root, 'new-component');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>index</body></html>');
    handle = await startStaticServer([{ prefix: '/new-component', dir }], 0);
    const res = await fetch(`${handle.origin}/new-component`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('index');
  });

  it('404s a path outside any mounted prefix, and a file that genuinely does not exist', async () => {
    const dir = join(root, 'redesign');
    mkdirSync(dir, { recursive: true });
    handle = await startStaticServer([{ prefix: '/redesign', dir }], 0);
    expect((await fetch(`${handle.origin}/nope`)).status).toBe(404);
    expect((await fetch(`${handle.origin}/redesign/missing.html`)).status).toBe(404);
  });

  it('a malformed percent-encoded path (e.g. a bare "%") is answered 400, never crashes the server (adversarial-review regression)', async () => {
    const dir = join(root, 'redesign');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'redesigned-page.html'), 'PAGE');
    handle = await startStaticServer([{ prefix: '/redesign', dir }], 0);

    const bad = await fetch(`${handle.origin}/redesign/%`);
    expect(bad.status).toBe(400);

    // The server must still be alive and serving other requests afterward.
    const stillWorks = await fetch(`${handle.origin}/redesign/redesigned-page.html`);
    expect(stillWorks.status).toBe(200);
    expect(await stillWorks.text()).toBe('PAGE');
  });

  it('refuses a directory-traversal attempt that would escape the mounted root, never reading a file outside it', async () => {
    const dir = join(root, 'redesign');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'secret.json'), '{"leak":true}');
    handle = await startStaticServer([{ prefix: '/redesign', dir }], 0);
    const res = await fetch(`${handle.origin}/redesign/../secret.json`);
    expect(res.status).not.toBe(200);
    const body = await res.text();
    expect(body).not.toContain('leak');
  });

  it('falls back to the next port when the preferred one is already bound, rather than failing the run', async () => {
    const dirA = join(root, 'a');
    const dirB = join(root, 'b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const first = await startStaticServer([{ prefix: '/a', dir: dirA }], 0);
    const preferred = first.port;
    const second = await startStaticServer([{ prefix: '/b', dir: dirB }], preferred);
    expect(second.port).not.toBe(preferred);
    await first.close();
    await second.close();
    handle = null;
  });

  it('correct content-type per extension (html vs tsx vs png)', async () => {
    const dir = join(root, 'new-component', 'Card');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Card.tsx'), 'export const Card = () => null;');
    writeFileSync(join(dir, 'reference.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    handle = await startStaticServer([{ prefix: '/new-component', dir: join(root, 'new-component') }], 0);
    const tsx = await fetch(`${handle.origin}/new-component/Card/Card.tsx`);
    const png = await fetch(`${handle.origin}/new-component/Card/reference.png`);
    expect(tsx.headers.get('content-type')).toContain('text/plain');
    expect(png.headers.get('content-type')).toContain('image/png');
  });
});
