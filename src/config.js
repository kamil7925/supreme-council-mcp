import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { IMAGE_LIMITS, visionSupport } from './images.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_PROVIDERS = ['openai', 'claude', 'gemini', 'mistral'];
export const PROVIDERS = [...DEFAULT_PROVIDERS, 'meta'];
export const PROFILES = ['quick', 'deep'];
export const DEEP_MODELS = Object.freeze({ openai: 'gpt-6-astra', claude: 'claude-opus-5',
  gemini: 'gemini-3.1-pro-preview', mistral: 'mistral-medium-3-5', meta: 'muse-spark-1.3' });
const KEY_NAMES = { openai: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', mistral: 'MISTRAL_API_KEY', meta: 'META_API_KEY' };

export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function integer(env, name, fallback, min, max) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function visionMode(env, variable, fallback = 'auto') {
  const value = env[variable]?.trim() || fallback;
  if (!['auto', 'true', 'false'].includes(value)) throw new Error(`${variable} must be auto, true, or false`);
  return value;
}

export function readConfig(env = process.env) {
  const defaultProfile = env.COUNCIL_DEFAULT_PROFILE?.trim() || 'quick';
  if (!PROFILES.includes(defaultProfile)) throw new Error('COUNCIL_DEFAULT_PROFILE must be quick or deep');
  const quick = {
    label: 'Quick / cheap council',
    timeoutMs: integer(env, 'COUNCIL_TIMEOUT_MS', 60000, 100, 180000),
    maxOutputTokens: integer(env, 'COUNCIL_MAX_OUTPUT_TOKENS', 4096, 256, 16384),
    providers: Object.fromEntries(PROVIDERS.map(name => [name, {
      key: env[KEY_NAMES[name]]?.trim() || '',
      keyEnv: KEY_NAMES[name],
      model: (env[`COUNCIL_QUICK_${name.toUpperCase()}_MODEL`] ?? env[`COUNCIL_${name.toUpperCase()}_MODEL`] ?? (name === 'meta' ? DEEP_MODELS.meta : '')).trim(),
      vision: visionMode(env, `COUNCIL_QUICK_${name.toUpperCase()}_VISION`, visionMode(env, `COUNCIL_${name.toUpperCase()}_VISION`)),
    }])),
  };
  quick.timeoutMs = integer(env, 'COUNCIL_QUICK_TIMEOUT_MS', quick.timeoutMs, 100, 180000);
  quick.maxOutputTokens = integer(env, 'COUNCIL_QUICK_MAX_OUTPUT_TOKENS', quick.maxOutputTokens, 256, 16384);
  const deep = {
    label: 'Deep review council',
    timeoutMs: integer(env, 'COUNCIL_DEEP_TIMEOUT_MS', 180000, 100, 180000),
    maxOutputTokens: integer(env, 'COUNCIL_DEEP_MAX_OUTPUT_TOKENS', 16384, 256, 16384),
    providers: Object.fromEntries(PROVIDERS.map(name => [name, {
      key: quick.providers[name].key, keyEnv: KEY_NAMES[name],
      model: (env[`COUNCIL_DEEP_${name.toUpperCase()}_MODEL`] ?? DEEP_MODELS[name]).trim(),
      vision: visionMode(env, `COUNCIL_DEEP_${name.toUpperCase()}_VISION`),
    }])),
  };
  // Legacy direct adapter callers retain quick settings. Consultations explicitly resolve a profile.
  return { ...quick, defaultProfile, profiles: { quick, deep },
    dataDir: path.resolve(env.COUNCIL_DATA_DIR || path.join(ROOT, '.council')),
    maxBriefingChars: integer(env, 'COUNCIL_MAX_BRIEFING_CHARS', 60000, 1000, 200000) };
}

export function selectProfile(config, name = config.defaultProfile) {
  if (!PROFILES.includes(name) || !config.profiles[name]) throw new Error('Profile must be quick or deep');
  // Snapshot per job: concurrent consultations cannot change each other's models/settings.
  return { ...config, ...structuredClone(config.profiles[name]), profile: name };
}

function publicProviders(config) {
  return Object.fromEntries(PROVIDERS.map(name => {
    const provider = config.providers[name];
    return [name, { configured: Boolean(provider.key && provider.model), model: provider.model || null,
      key_present: Boolean(provider.key), key_env: provider.keyEnv, vision: visionSupport(name, provider) }];
  }));
}

export function publicConfig(config) {
  const selected = selectProfile(config);
  return {
    server_version: '0.4.0',
    default_providers: [...DEFAULT_PROVIDERS],
    default_profile: config.defaultProfile,
    profiles: Object.fromEntries(PROFILES.map(name => {
      const profile = selectProfile(config, name);
      return [name, { label: profile.label, providers: publicProviders(profile),
        timeout_ms: profile.timeoutMs, max_output_tokens_per_call: profile.maxOutputTokens }];
    })),
    image_attachments: { supported: true, ...IMAGE_LIMITS, input: 'absolute local PNG/JPEG paths; snapshotted at prepare time' },
    providers: publicProviders(selected),
    data_directory: config.dataDir,
    timeout_ms: selected.timeoutMs,
    max_output_tokens_per_call: selected.maxOutputTokens,
    max_briefing_characters: config.maxBriefingChars,
    billing: 'Token caps limit output, not dollar spend. Set spending limits with each provider.',
  };
}
