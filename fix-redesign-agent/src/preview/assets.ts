import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Makes the preview self-contained: every `data:` URI in the captured markup and CSS becomes a
 * file under `public/`, and remote assets the snapshot could not inline are downloaded once at
 * generation time (plain GETs of static files, small concurrency). The running preview never
 * calls the production site.
 */

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-woff2': 'woff2', 'application/font-woff': 'woff', 'application/x-font-ttf': 'ttf', 'application/vnd.ms-fontobject': 'eot',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'application/octet-stream': 'bin',
};

export function extForMime(mime: string, fallbackUrl = ''): string {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (MIME_EXT[m]) return MIME_EXT[m]!;
  const fromUrl = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(fallbackUrl)?.[1]?.toLowerCase();
  return fromUrl ?? 'bin';
}

export interface AssetWriter {
  /** Resolves a data: URI or a downloaded remote URL to its public path, writing the file on first use. */
  urlFor: (value: string) => string;
  written: () => number;
  /** Writes pending files. */
  flush: () => Promise<void>;
  remoteMissing: string[];
}

export function createAssetWriter(publicDir: string, remoteMap: ReadonlyMap<string, { file: string }>): AssetWriter {
  const pending = new Map<string, Buffer>();
  const remoteMissing: string[] = [];
  const urlFor = (value: string): string => {
    if (value.startsWith('data:')) {
      const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/.exec(value);
      if (!m) return value;
      const mime = m[1] || 'application/octet-stream';
      const buf = m[3] ? Buffer.from(m[4] as string, 'base64') : Buffer.from(decodeURIComponent(m[4] as string), 'utf8');
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
      const dir = mime.startsWith('font') || /font/.test(mime) ? 'fonts' : 'assets';
      const rel = `${dir}/${hash}.${extForMime(mime)}`;
      pending.set(rel, buf);
      return `/${rel}`;
    }
    if (/^https?:/i.test(value)) {
      const hit = remoteMap.get(value);
      if (hit) return `/${hit.file}`;
      remoteMissing.push(value);
    }
    return value;
  };
  return {
    urlFor,
    written: () => pending.size,
    remoteMissing,
    flush: async () => {
      for (const [rel, buf] of pending) {
        const full = join(publicDir, rel);
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, buf);
      }
    },
  };
}

/** Rewrites every url(...) in a CSS text through `urlFor`. */
export function rewriteCssUrls(css: string, urlFor: (v: string) => string): string {
  return css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (whole, _q, v: string) => {
    if (v.startsWith('data:') || /^https?:/i.test(v)) return `url("${urlFor(v)}")`;
    return whole;
  });
}

export interface RemoteAsset { url: string; file: string; bytes: number }

export const IMAGE_ACCEPT = 'image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5';

/** Downloads remote static assets to `<publicDir>/assets/`. Failures are returned, never thrown. */
export async function downloadRemoteAssets(urls: string[], publicDir: string, opts: { concurrency?: number; timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {}): Promise<{ map: Map<string, { file: string }>; downloaded: RemoteAsset[]; failed: Array<{ url: string; reason: string }> }> {
  const concurrency = opts.concurrency ?? 4;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const doFetch = opts.fetchImpl ?? fetch;
  const map = new Map<string, { file: string }>();
  const downloaded: RemoteAsset[] = [];
  const failed: Array<{ url: string; reason: string }> = [];
  const unique = [...new Set(urls.filter((u) => /^https?:/i.test(u)))];
  await mkdir(join(publicDir, 'assets'), { recursive: true });
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const url = unique[next++]!;
      try {
        // Accept must name webp/png: an image optimizer (Next.js `/_next/image`, `Vary: Accept`) answers `*/*` with a JPEG, which drops the alpha channel
        // of a transparent logo/icon/avatar and shows it on a black square. A real browser sends webp, which is what the original page rendered.
        const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: IMAGE_ACCEPT } });
        if (!res.ok) { failed.push({ url, reason: `HTTP ${res.status}` }); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) { failed.push({ url, reason: `larger than ${maxBytes} bytes` }); continue; }
        const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
        const file = `assets/${hash}.${extForMime(res.headers.get('content-type') ?? '', url)}`;
        await writeFile(join(publicDir, file), buf);
        map.set(url, { file });
        downloaded.push({ url, file, bytes: buf.length });
      } catch (err) {
        failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return { map, downloaded, failed };
}
