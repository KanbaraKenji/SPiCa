// Model configuration for development: the repository's .env.local (variable
// names in .env.example). Parsed into a plain object, never copied into
// process.env, so child processes and the renderer cannot see the keys.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export interface ModelEnv {
  openai?: { baseUrl: string; apiKey: string; model: string };
  anthropic?: { apiKey: string; model: string };
}

export function modelEnvFrom(vars: Record<string, string | undefined>): ModelEnv {
  const env: ModelEnv = {};
  const { SPICA_OPENAI_BASE_URL: base, SPICA_OPENAI_API_KEY: key, SPICA_OPENAI_MODEL: model } = vars;
  if (base && key) env.openai = { baseUrl: base, apiKey: key, model: model || 'deepseek-flash' };
  if (vars.SPICA_ANTHROPIC_API_KEY) env.anthropic = { apiKey: vars.SPICA_ANTHROPIC_API_KEY, model: vars.SPICA_ANTHROPIC_MODEL || 'claude-haiku-5-5' };
  return env;
}

/** Reads a dotenv file; a missing or unreadable file gives an empty config. */
export function readModelEnv(file: string): ModelEnv {
  try {
    return modelEnvFrom(parseEnv(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

export function hasModel(env: ModelEnv): boolean {
  return Boolean(env.openai || env.anthropic);
}
