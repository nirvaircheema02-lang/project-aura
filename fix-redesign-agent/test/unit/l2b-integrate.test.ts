import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runL2b } from '../../src/agents/l2b-integrate/index.ts';
import { TerminalError } from '../../src/retry.ts';
import type { ComponentSpec, L2Output } from '../../src/library/types.ts';

/** Real filesystem writes, no browser — same tier as `r1-resolve-load.test.ts`. */

// `dsRepoPath` is nested one level under its own mkdtemp root (never `tmpdir()` directly) —
// `regenerateSafelist` looks at `join(dsRepoPath, '..', 'scripts', ...)`, and `tmpdir()` is the
// shared OS temp dir every test in the whole run borrows, so `dsRepoPath`'s parent must be a
// private root or one test's "scripts/" fixture would leak into every other test's lookup.
let root: string;
let dsRepoPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fra-l2b-'));
  dsRepoPath = join(root, 'design-system');
  mkdirSync(join(dsRepoPath, 'core-v2/src/styles'), { recursive: true });
  mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function spec(componentId: string, barrelEntries: ComponentSpec['declaredSharedChanges']['barrelEntries'], tokenAdditions: ComponentSpec['declaredSharedChanges']['tokenAdditions'] = []): ComponentSpec {
  return {
    schemaVersion: 1,
    componentId,
    patternId: `pattern-${componentId}`,
    resolution: 'new',
    updateTarget: null,
    name: componentId,
    category: 'molecules',
    scope: 'page-local',
    scopeEvidenceMissing: false,
    reference: { source: 'live-capture', priorRunId: null, elementStamp: 'e1', cropPath: null },
    anatomy: 'x',
    variantAxes: [],
    tokens: [],
    statesObserved: ['default'],
    statesToDesign: [],
    postFixPrerequisite: null,
    writeSet: [`core-v2/src/molecules/${componentId}.tsx`],
    declaredSharedChanges: { barrelEntries, tokenAdditions },
    dependsOn: { findings: [], components: [] },
    constraints: [],
  };
}

function pass(componentId: string): L2Output {
  return { componentId, filesWritten: [`core-v2/src/molecules/${componentId}.tsx`], writeSetRespected: true, violatingPaths: [], usage: null };
}
function fail(componentId: string): L2Output {
  return { componentId, filesWritten: [], writeSetRespected: false, violatingPaths: [`core-v2/src/molecules/${componentId}.tsx`], usage: null };
}

const barrelPath = () => join(dsRepoPath, 'core-v2/src/molecules/index.ts');
const baseCssPath = () => join(dsRepoPath, 'core-v2/src/styles/base.css');

describe('runL2b — barrel integration is deterministic', () => {
  it('produces byte-identical barrel content regardless of the input array order (never build-completion order)', async () => {
    writeFileSync(barrelPath(), '// molecules barrel\n');
    const specZ = spec('zzz-comp', [{ barrelFile: 'core-v2/src/molecules/index.ts', exportLine: "export { Zeta } from './Zeta';" }]);
    const specA = spec('aaa-comp', [{ barrelFile: 'core-v2/src/molecules/index.ts', exportLine: "export { Alpha } from './Alpha';" }]);
    const resultZ = pass('zzz-comp');
    const resultA = pass('aaa-comp');

    const runOrderOne = await runL2b({ dsRepoPath }, [specZ, specA], [resultZ, resultA]);
    const contentOne = readFileSync(barrelPath(), 'utf-8');

    // Fresh repo, opposite input order.
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'fra-l2b-'));
    dsRepoPath = join(root, 'design-system');
    mkdirSync(join(dsRepoPath, 'core-v2/src/molecules'), { recursive: true });
    writeFileSync(barrelPath(), '// molecules barrel\n');

    const runOrderTwo = await runL2b({ dsRepoPath }, [specA, specZ], [resultA, resultZ]);
    const contentTwo = readFileSync(barrelPath(), 'utf-8');

    expect(contentOne).toBe(contentTwo);
    expect(contentOne).toContain("export { Alpha } from './Alpha';");
    expect(contentOne).toContain("export { Zeta } from './Zeta';");
    expect(runOrderOne.barrelsTouched).toHaveLength(1);
    expect(runOrderTwo.barrelsTouched).toHaveLength(1);
    expect(runOrderOne.safelistRegenerated).toBe(false); // no scripts/gen-ds-safelist.mjs in this fixture — skipped, not fatal
  });

  it("integrates only the SUCCESSFULLY built specs — a failed build's declared shared changes are never applied", async () => {
    writeFileSync(barrelPath(), '// molecules barrel\n');
    const ok = spec('ok-comp', [{ barrelFile: 'core-v2/src/molecules/index.ts', exportLine: "export { Ok } from './Ok';" }]);
    const broken = spec('zz-broken', [{ barrelFile: 'core-v2/src/molecules/index.ts', exportLine: "export { Broken } from './Broken';" }]);

    await runL2b({ dsRepoPath }, [ok, broken], [pass('ok-comp'), fail('zz-broken')]);

    const content = readFileSync(barrelPath(), 'utf-8');
    expect(content).toContain("export { Ok } from './Ok';");
    expect(content).not.toContain('Broken');
  });
});

describe('runL2b — token additions preserve the shared stylesheet\'s unlayered :root block', () => {
  it('inserts new custom properties inside the existing unlayered :root { } block, leaving layered structure and existing declarations untouched', async () => {
    const original = ['@layer reset, base, components, utilities;', '', '@layer base {', '  html { color: black; }', '}', '', ':root {', '  --foo: 1;', '}', ''].join('\n');
    writeFileSync(baseCssPath(), original);
    const layerCountBefore = (original.match(/@layer/g) ?? []).length;

    const withToken = spec('token-comp', [], [{ name: '--new-token', value: '2rem' }, { name: '--foo', value: '999' }]); // --foo already exists — must NOT be overwritten (dedup)
    const result = await runL2b({ dsRepoPath }, [withToken], [pass('token-comp')]);

    const after = readFileSync(baseCssPath(), 'utf-8');
    expect(result.tokenStylesheetTouched).toBe(baseCssPath());
    // Layered structure is untouched — no new @layer was introduced around :root.
    expect((after.match(/@layer/g) ?? []).length).toBe(layerCountBefore);
    expect(after).toContain('@layer base {\n  html { color: black; }\n}');
    // The new property was added; the pre-existing one was left exactly as it was (never overwritten).
    expect(after).toContain('--new-token: 2rem;');
    expect(after).toContain('--foo: 1;');
    expect(after).not.toContain('--foo: 999;');
    // Both custom properties live inside the SAME, still-unlayered :root block.
    const rootBlock = after.slice(after.indexOf(':root {'), after.indexOf(':root {') + after.slice(after.indexOf(':root {')).indexOf('}') + 1);
    expect(rootBlock).toContain('--new-token: 2rem;');
    expect(rootBlock).toContain('--foo: 1;');
  });

  it('§regression: a genuinely NEW token is still inserted even when its name happens to appear elsewhere in the file (a themed override block, a comment, …) — dedup is scoped to the :root block\'s OWN text, not the whole file', async () => {
    const original = [
      ':root {', '  --foo: 1;', '}', '',
      '/* --brand-accent: mentioned only in a comment, never declared */', '',
      '.dark-theme {', '  --brand-accent: #000000;', '}', '', // a DIFFERENT selector happens to use the same custom-property NAME
    ].join('\n');
    writeFileSync(baseCssPath(), original);

    const withToken = spec('token-comp', [], [{ name: '--brand-accent', value: '#b01f24' }]);
    const result = await runL2b({ dsRepoPath }, [withToken], [pass('token-comp')]);

    const after = readFileSync(baseCssPath(), 'utf-8');
    expect(result.tokenStylesheetTouched).toBe(baseCssPath());
    const rootBlock = after.slice(after.indexOf(':root {'), after.indexOf(':root {') + after.slice(after.indexOf(':root {')).indexOf('}') + 1);
    expect(rootBlock).toContain('--brand-accent: #b01f24;'); // actually declared in the root block, not silently skipped
    expect(after).toContain('.dark-theme {\n  --brand-accent: #000000;\n}'); // the unrelated selector is untouched
  });

  it('throws a TerminalError naming base.css when there is no unlayered ":root {" block to insert into', async () => {
    writeFileSync(baseCssPath(), '@layer base {\n  html { color: black; }\n}\n'); // no unlayered :root { marker anywhere
    const withToken = spec('token-comp', [], [{ name: '--new-token', value: '1px' }]);

    const err = await runL2b({ dsRepoPath }, [withToken], [pass('token-comp')]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/no unlayered ":root \{" block/);
    expect((err as Error).message).toContain(baseCssPath());
  });

  it('does nothing to the token stylesheet when no spec declares a token addition (never opened, never touched)', async () => {
    const noTokens = spec('no-token-comp', []);
    // No base.css written at all — if appendTokenAdditions tried to open it, this would throw ENOENT.
    const result = await runL2b({ dsRepoPath }, [noTokens], [pass('no-token-comp')]);
    expect(result.tokenStylesheetTouched).toBeNull();
  });
});

describe('runL2b — safelist regeneration', () => {
  it('invokes the DS repo\'s own safelist generator script via the injectable exec when it exists, and reports the outcome', async () => {
    const scriptsDir = join(dsRepoPath, '..', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = join(scriptsDir, 'gen-ds-safelist.mjs');
    writeFileSync(scriptPath, '// fixture — never actually executed, exec is injected below\n');

    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const exec = async (cmd: string, args: string[], cwd: string) => {
      calls.push({ cmd, args, cwd });
      return { code: 0, stdout: 'safelist regenerated: 42 classes', stderr: '' };
    };

    const noop = spec('noop-comp', []);
    const result = await runL2b({ dsRepoPath, exec }, [noop], [pass('noop-comp')]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ cmd: 'node', args: [scriptPath], cwd: scriptsDir });
    expect(result.safelistRegenerated).toBe(true);
    expect(result.detail).toEqual(['safelist regenerated: 42 classes']);
  });

  it('throws a TerminalError naming the script when regeneration fails (non-zero exit)', async () => {
    const scriptsDir = join(dsRepoPath, '..', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'gen-ds-safelist.mjs'), '// fixture\n');
    const exec = async () => ({ code: 1, stdout: '', stderr: 'safelist script blew up' });

    const noop = spec('noop-comp', []);
    const err = await runL2b({ dsRepoPath, exec }, [noop], [pass('noop-comp')]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as Error).message).toMatch(/safelist regeneration failed/);
    expect((err as Error).message).toContain('safelist script blew up');
  });
});
