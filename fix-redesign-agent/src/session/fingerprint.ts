import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * ARCHITECTURE.md §11.3 — every approval carries a fingerprint of exactly what was approved,
 * and is reused only when the recomputed fingerprint is identical. One canonical hashing
 * routine so every gate's "did anything change" check means the same thing.
 */

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Canonical JSON (sorted keys) so field order in the source object never changes the fingerprint. */
export function fingerprintOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** sha256 of a file's bytes — used for §11.3's per-file blob hash in the push fingerprint. */
export async function sha256OfFile(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}
