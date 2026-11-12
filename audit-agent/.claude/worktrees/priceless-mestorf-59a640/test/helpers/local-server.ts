import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal local HTTP server for offline, deterministic browser-mechanism tests. */
export interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
  /** Never respond — simulates a request that never finishes. */
  hang?: boolean;
}

export async function startLocalServer(routes: Record<string, Route>): Promise<{ origin: string; close: () => Promise<void>; hits: string[]; routes: Record<string, Route> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string;
    hits.push(req.url ?? '/');
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (route.hang) return; // leave the socket open
    setTimeout(() => {
      res.writeHead(route.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...(route.headers ?? {}) });
      res.end(route.body ?? '');
    }, route.delayMs ?? 0);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    // Exposed so a test can set content that depends on the bound port (e.g. a
    // sitemap whose <loc> entries must carry this server's own origin).
    routes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
