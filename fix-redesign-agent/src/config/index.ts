import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigSchema, type Config } from './schema.ts';

export const CONFIG_FILE_NAME = 'fix-redesign-agent.config.json';
const ENV_PREFIX = 'FIX_REDESIGN_AGENT_';

/** camelCase config key -> FIX_REDESIGN_AGENT_SCREAMING_SNAKE env var name. */
export function envVarNameFor(key: string): string {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
  return `${ENV_PREFIX}${snake}`;
}

function coerceEnvValue(raw: string): string | number {
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * Schema-validated defaults from `fix-redesign-agent.config.json` (or an explicit path),
 * then FIX_REDESIGN_AGENT_* env vars override per-field. Throws with a readable,
 * field-specific message on any invalid config (ARCHITECTURE.md Decision Log #2).
 */
export function loadConfig(configPath = resolve(process.cwd(), CONFIG_FILE_NAME)): Config {
  let fileContents: unknown;
  try {
    fileContents = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `fix-redesign-agent: could not read/parse config file at ${configPath}. ` +
        `Create one (see ${CONFIG_FILE_NAME} in the repo root) or pass an explicit path. Original error: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }

  if (typeof fileContents !== 'object' || fileContents === null) {
    throw new Error(`fix-redesign-agent: config file at ${configPath} must contain a JSON object.`);
  }

  const merged: Record<string, unknown> = { ...(fileContents as Record<string, unknown>) };
  for (const key of Object.keys(ConfigSchema.shape)) {
    const envValue = process.env[envVarNameFor(key)];
    if (envValue !== undefined) merged[key] = coerceEnvValue(envValue);
  }

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`fix-redesign-agent: invalid configuration (from ${configPath} + env overrides):\n${issues}`);
  }
  return result.data;
}

export type { Config } from './schema.ts';
