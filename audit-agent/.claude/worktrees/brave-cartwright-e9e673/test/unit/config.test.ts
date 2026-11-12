import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';

describe('loadConfig', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-agent-config-'));
    configPath = join(dir, 'audit-agent.config.json');
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('AUDIT_AGENT_')) delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a valid config file with defaults applied', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        designSystemPath: '/tmp/ds',
        figmaTeamPlanKey: 'team::123',
      }),
    );
    const config = loadConfig(configPath);
    expect(config.designSystemPath).toBe('/tmp/ds');
    expect(config.figmaTeamPlanKey).toBe('team::123');
    expect(config.anthropicModel).toBe('claude-opus-5'); // default
    expect(config.dashboardPort).toBe(4173); // default, Decision Log #20
  });

  it('rejects a malformed figmaTeamPlanKey with a readable field-specific error', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ designSystemPath: '/tmp/ds', figmaTeamPlanKey: 'not-a-valid-key' }),
    );
    expect(() => loadConfig(configPath)).toThrow(/figmaTeamPlanKey/);
  });

  it('rejects a missing required field', () => {
    writeFileSync(configPath, JSON.stringify({ figmaTeamPlanKey: 'team::123' }));
    expect(() => loadConfig(configPath)).toThrow(/designSystemPath/);
  });

  it('throws a clear error when the file is missing', () => {
    expect(() => loadConfig(join(dir, 'does-not-exist.json'))).toThrow(/could not read\/parse config file/);
  });

  it('AUDIT_AGENT_* env vars override the file, per field (Decision Log #17)', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ designSystemPath: '/tmp/ds', figmaTeamPlanKey: 'team::123', dashboardPort: 4173 }),
    );
    process.env.AUDIT_AGENT_DASHBOARD_PORT = '5000';
    process.env.AUDIT_AGENT_DESIGN_SYSTEM_PATH = '/other/ds';
    const config = loadConfig(configPath);
    expect(config.dashboardPort).toBe(5000);
    expect(config.designSystemPath).toBe('/other/ds');
    expect(config.figmaTeamPlanKey).toBe('team::123'); // untouched, not overridden
  });
});
