import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * A plain static file server for viewing the clean deliverable in a real browser via an actual
 * `http://localhost:PORT/...` URL — not a `file://` path (some browser behavior, e.g. `fetch`
 * from a page, differs or is blocked entirely under `file://`). Zero dependencies: `node:http`
 * plus a directory-traversal-safe file read. Read-only — never used for anything but serving
 * files already written to disk by `src/output/deliverable.ts`.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.tsx': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
};

function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export interface MountedRoot {
  /** URL path prefix this root is served under, e.g. `/redesign` — always starts with `/`, never ends with one. */
  prefix: string;
  /** Absolute directory on disk this prefix maps to. */
  dir: string;
}

export interface StaticServerHandle {
  origin: string;
  port: number;
  close: () => Promise<void>;
}

/** Resolves a request path against a mounted root, refusing anything that would escape it (`..`, absolute overrides, symlink-style traversal via `normalize`). */
function resolveWithinRoot(root: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath);
  const joined = normalize(join(root, decoded));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (joined !== root && !joined.startsWith(rootWithSep)) return null;
  return joined;
}

/**
 * Serves each of `roots` under its own URL prefix from ONE server/port — e.g. `/redesign` →
 * `paths.redesignDir`, `/new-component` → `paths.newComponentDir`. Binds to `preferredPort`,
 * falling back to the next port on `EADDRINUSE` (never fails a run just because a previous
 * server from an earlier invocation is still bound) up to `maxAttempts` tries.
 */
export async function startStaticServer(roots: MountedRoot[], preferredPort = 4173, maxAttempts = 20): Promise<StaticServerHandle> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const urlPath = (req.url ?? '/').split('?')[0] as string;
      const root = roots.find((r) => urlPath === r.prefix || urlPath.startsWith(`${r.prefix}/`));
      if (!root) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const withinPrefix = urlPath === root.prefix ? '/' : urlPath.slice(root.prefix.length);
      // Everything from here on can throw on attacker/browser-supplied input (a malformed
      // percent-encoding, e.g. a bare `%`, makes `decodeURIComponent` inside resolveWithinRoot
      // throw a URIError) — one bad request must 400, never crash the whole server and take
      // down every other link this run is serving.
      try {
        const target = resolveWithinRoot(resolve(root.dir), withinPrefix === '/' ? '/index.html' : withinPrefix);
        if (!target) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        const info = await stat(target);
        const filePath = info.isDirectory() ? join(target, 'index.html') : target;
        const body = await readFile(filePath);
        res.writeHead(200, { 'content-type': contentTypeFor(filePath), 'content-length': body.length });
        res.end(body);
      } catch (err) {
        if (err instanceof URIError) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('bad request');
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    })();
  });

  let port = preferredPort;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((res, rej) => {
        server.once('error', rej);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', rej);
          res();
        });
      });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
        port++;
        continue;
      }
      throw err;
    }
  }
  const bound = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${bound.port}`,
    port: bound.port,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}
