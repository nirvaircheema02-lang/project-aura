import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildReferenceHooks } from '../../src/reference/hooks.ts';
import { defaultRegistryPath } from '../../src/reference/registry.ts';
import { TerminalError } from '../../src/retry.ts';

/**
 * buildReferenceHooks and the registry: an INVALID registry fails the run loudly (it must never silently switch every reference off), a MISSING one
 * degrades to "no references" with a logged line.
 */

const dir = mkdtempSync(join(tmpdir(), 'reference-hooks-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const dsTokens = { lookup: () => [] };

type Registry = { projects: Array<{ patterns: Array<{ appliesTo: { elementKinds: string[] } }> }> };
function registryWith(name: string, mutate: (r: Registry) => void): string {
  const r = JSON.parse(readFileSync(defaultRegistryPath(), 'utf8')) as Registry;
  mutate(r);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(r));
  return path;
}

describe('buildReferenceHooks — registry failures', () => {
  it('a registry whose pattern lists a raw tag as an element kind fails the run with a TerminalError that names it', async () => {
    const registryPath = registryWith('raw-tag.json', (r) => { r.projects.find((p) => p.patterns.length > 0)!.patterns[0]!.appliesTo.elementKinds = ['div']; });
    const logged: string[] = [];
    const err = await buildReferenceHooks({ registryPath, dsTokens, log: (l) => logged.push(l) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/approved-reference registry/);
    expect((err as Error).message).toMatch(/"div" is not a component category/);
    expect((err as Error).message).toMatch(/fix or remove it/);
  });

  it('a registry that is not valid JSON, or has the wrong schema, fails the run too', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    await expect(buildReferenceHooks({ registryPath: bad, dsTokens })).rejects.toBeInstanceOf(TerminalError);
    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ schemaVersion: 2 }));
    await expect(buildReferenceHooks({ registryPath: wrong, dsTokens })).rejects.toBeInstanceOf(TerminalError);
  });

  it('a MISSING registry file still degrades to no references, with a logged line', async () => {
    const logged: string[] = [];
    const hooks = await buildReferenceHooks({ registryPath: join(dir, 'does-not-exist.json'), dsTokens, log: (l) => logged.push(l) });
    expect(hooks).toBeNull();
    expect(logged.join('\n')).toMatch(/approved-reference registry unavailable.*no reference pattern can be used/);
  });

  it('the shipped registry loads', async () => {
    const hooks = await buildReferenceHooks({ dsTokens });
    expect(hooks).not.toBeNull();
    expect(hooks!.registry.approvedProjects.length).toBeGreaterThan(0);
  });
});
