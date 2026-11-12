import { createWriteStream } from 'node:fs';
import { ZipFile } from 'yazl';

/**
 * Writes a plain (unencrypted, single-disk) zip file from in-memory buffers. Used only for
 * report-package.zip — the fallback when a standalone HTML report would otherwise be too large
 * to share as one file (src/agents/c1-html-reporter/index.ts).
 */
export async function writeZip(path: string, entries: Array<{ name: string; data: Buffer; compress?: boolean }>): Promise<void> {
  const zipfile = new ZipFile();
  for (const entry of entries) zipfile.addBuffer(entry.data, entry.name, { compress: entry.compress ?? true });
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    out.on('close', resolve);
    out.on('error', reject);
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.pipe(out);
    zipfile.end();
  });
}
