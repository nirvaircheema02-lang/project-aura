import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ResolutionFileSchema, type ImplementationStatusValue, type ResolutionFile, type ResolvedTarget, type VerificationStatus } from './schema.ts';

/** Reads and VALIDATES the resolved-targets file. An invalid file is an error, never a silent "no targets". */
export async function readResolution(path: string): Promise<ResolutionFile | null> {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const parsed = ResolutionFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path} is not a valid resolved-targets file: ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export async function writeResolution(path: string, file: ResolutionFile): Promise<void> {
  const parsed = ResolutionFileSchema.parse(file); // a stage can never persist a malformed record
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(parsed, null, 2));
}

export const targetsOf = (file: ResolutionFile | null, findingId: string): ResolvedTarget[] => (file ? file.targets.filter((t) => t.findingId === findingId) : []);

export function setImplementation(file: ResolutionFile, match: (t: ResolvedTarget) => boolean, status: ImplementationStatusValue, detail: string | null): number {
  let n = 0;
  for (const t of file.targets) if (match(t) && t.outcome === 'resolved-target') { t.status.implementation = status; t.status.implementationDetail = detail; n++; }
  return n;
}

export function setVerification(file: ResolutionFile, match: (t: ResolvedTarget) => boolean, status: VerificationStatus, detail: string | null): number {
  let n = 0;
  for (const t of file.targets) if (match(t)) { t.status.verification = status; t.status.verificationDetail = detail; n++; }
  return n;
}
