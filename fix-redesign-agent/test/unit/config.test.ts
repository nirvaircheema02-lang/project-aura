import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envVarNameFor, loadConfig } from '../../src/config/index.ts';

describe('loadConfig (Decision Log #2 — same mechanism as audit-agent)', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fra-config-'));
    configPath = join(dir, 'fix-redesign-agent.config.json');
    for (const key of Object.keys(process.env)) if (key.startsWith('FIX_REDESIGN_AGENT_')) delete process.env[key];
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a valid config with defaults applied', () => {
    writeFileSync(configPath, JSON.stringify({ auditAgentRepoRoot: '/tmp/audit-agent', designSystemPath: '/tmp/ds' }));
    const config = loadConfig(configPath);
    expect(config.auditAgentRepoRoot).toBe('/tmp/audit-agent');
    expect(config.anthropicModel).toBe('claude-opus-5');
    expect(config.browserChannel).toBe('chromium');
    expect(config.maxIterations).toBe(3);
    expect(config.politeness.minNavigationIntervalMs).toBe(2000);
    expect(config.politeness.userAgentProduct).toBe('KenResearchDSRedesign/0.1');
  });

  it('rejects a missing auditAgentRepoRoot with the field named', () => {
    writeFileSync(configPath, JSON.stringify({ designSystemPath: '/tmp/ds' }));
    expect(() => loadConfig(configPath)).toThrow(/auditAgentRepoRoot/);
  });

  it('rejects an out-of-range maxIterations with the field named', () => {
    writeFileSync(configPath, JSON.stringify({ auditAgentRepoRoot: '/a', designSystemPath: '/d', maxIterations: 0 }));
    expect(() => loadConfig(configPath)).toThrow(/maxIterations/);
  });

  it('throws a clear error when the file is missing', () => {
    expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/could not read\/parse config file/);
  });

  it('FIX_REDESIGN_AGENT_* env vars override the file, per field', () => {
    writeFileSync(configPath, JSON.stringify({ auditAgentRepoRoot: '/a', designSystemPath: '/d', maxIterations: 3 }));
    process.env.FIX_REDESIGN_AGENT_MAX_ITERATIONS = '2';
    process.env.FIX_REDESIGN_AGENT_AUDIT_AGENT_REPO_ROOT = '/other/audit-agent';
    const config = loadConfig(configPath);
    expect(config.maxIterations).toBe(2);
    expect(config.auditAgentRepoRoot).toBe('/other/audit-agent');
    expect(config.designSystemPath).toBe('/d'); // untouched
  });

  it('maps camelCase keys to the documented env var names', () => {
    expect(envVarNameFor('auditAgentRepoRoot')).toBe('FIX_REDESIGN_AGENT_AUDIT_AGENT_REPO_ROOT');
    expect(envVarNameFor('designSystemPath')).toBe('FIX_REDESIGN_AGENT_DESIGN_SYSTEM_PATH');
  });

  it('the checked-in config file is itself valid and points at the two sibling repos', () => {
    const config = loadConfig(join(import.meta.dirname, '..', '..', 'fix-redesign-agent.config.json'));
    expect(config.auditAgentRepoRoot).toMatch(/\/audit-agent$/);
    expect(config.designSystemPath).toMatch(/\/design-system$/);
  });
});
