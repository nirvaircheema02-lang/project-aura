import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigSchema, type Config } from './schema.ts';

const ENV_PREFIX = 'AUDIT_AGENT_';

/** camelCase config key -> AUDIT_AGENT_SCREAMING_SNAKE env var name. */
function envVarNameFor(key: string): string {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
  return `${ENV_PREFIX}${snake}`;
}

function coerceEnvValue(raw: string): string | number {
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * Decision Log #17: schema-validated defaults from `audit-agent.config.json`
 * (or an explicit path), then AUDIT_AGENT_* env vars override per-field.
 * Throws with a readable, field-specific message on any invalid config —
 * never silently falls back to a wrong default.
 */
export function loadConfig(configPath = resolve(process.cwd(), 'audit-agent.config.json')): Config {
  let fileContents: unknown;
  try {
    fileContents = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `audit-agent: could not read/parse config file at ${configPath}. ` +
        `Create one (see audit-agent.config.json in the repo root) or pass an explicit path. Original error: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }

  if (typeof fileContents !== 'object' || fileContents === null) {
    throw new Error(`audit-agent: config file at ${configPath} must contain a JSON object.`);
  }

  const merged: Record<string, unknown> = { ...(fileContents as Record<string, unknown>) };
  for (const key of Object.keys(ConfigSchema.shape)) {
    const envVar = envVarNameFor(key);
    const envValue = process.env[envVar];
    if (envValue !== undefined) {
      merged[key] = coerceEnvValue(envValue);
    }
  }

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`audit-agent: invalid configuration (from ${configPath} + env overrides):\n${issues}`);
  }
  return result.data;
}

export type { Config } from './schema.ts';
