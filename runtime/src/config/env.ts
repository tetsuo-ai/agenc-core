// T10 Group D — environment variable resolution.
//
// Precedence order (env wins over TOML):
//   XAI_API_KEY | GROK_API_KEY | AGENC_XAI_API_KEY → grok api key
//   OPENAI_API_KEY / ANTHROPIC_API_KEY / ...       → provider api key
//   AGENC_PROVIDER                                 → provider slug
//   AGENC_PROFILE                                  → profile selector
//   AGENC_MODEL                                    → model slug
//   AGENC_WORKSPACE                                → workspace root
//   AGENC_HOME                                     → ~/.agenc override
//   AGENC_SIMPLE                                   → simple UI/mode
//   AGENC_AUTONOMOUS                              → autonomous tick mode
//   AGENC_MAX_OUTPUT_TOKENS                       → global output budget
//   AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS        → 8k default + retry mode
//   AGENC_MAX_BUDGET_USD                           → session cost budget
//   AGENC_AUTH_BACKEND                             → auth.backend
//   AGENC_AUTH_MANAGED_KEYS_ENABLED               → auth.managedKeys.enabled
//
// `applyEnvOverrides(config)` layers env values onto a base config and
// returns a new frozen snapshot.

import type { AgenCConfig } from "./schema.js";
import { mergeConfigs } from "./schema.js";

// Writable mirror used internally to build override payloads; the public
// `AgenCConfig` surface stays readonly.
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface EnvSnapshot {
  readonly AGENC_HOME?: string;
  readonly AGENC_PROFILE?: string;
  readonly AGENC_PROVIDER?: string;
  readonly AGENC_MODEL?: string;
  readonly AGENC_WORKSPACE?: string;
  readonly AGENC_SIMPLE?: string;
  readonly AGENC_AUTONOMOUS?: string;
  readonly AGENC_MAX_OUTPUT_TOKENS?: string;
  readonly AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS?: string;
  readonly AGENC_MAX_BUDGET_USD?: string;
  readonly AGENC_AUTH_BACKEND?: string;
  readonly AGENC_AUTH_MANAGED_KEYS_ENABLED?: string;
  readonly XAI_API_KEY?: string;
  readonly GROK_API_KEY?: string;
  readonly AGENC_XAI_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_BASE_URL?: string;
  readonly OPENAI_COMPATIBLE_API_KEY?: string;
  readonly OPENAI_COMPATIBLE_BASE_URL?: string;
  readonly OPENAI_COMPATIBLE_MODEL?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly ANTHROPIC_BASE_URL?: string;
  readonly LMSTUDIO_API_KEY?: string;
  readonly LMSTUDIO_BASE_URL?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly OPENROUTER_BASE_URL?: string;
  readonly GROQ_API_KEY?: string;
  readonly GROQ_BASE_URL?: string;
  readonly DEEPSEEK_API_KEY?: string;
  readonly DEEPSEEK_BASE_URL?: string;
  readonly GEMINI_API_KEY?: string;
  readonly GEMINI_BASE_URL?: string;
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly AWS_BEDROCK_ACCESS_KEY_ID?: string;
  readonly AWS_BEDROCK_SECRET_ACCESS_KEY?: string;
  readonly AWS_BEDROCK_BASE_URL?: string;
  readonly AWS_BEDROCK_MODEL?: string;
  readonly AWS_BEDROCK_REGION?: string;
  readonly AWS_REGION?: string;
  readonly AWS_DEFAULT_REGION?: string;
  readonly AWS_BEDROCK_SESSION_TOKEN?: string;
  readonly AWS_SESSION_TOKEN?: string;
  readonly HOME?: string;
  readonly [k: string]: string | undefined;
}

function readEnv(env: EnvSnapshot | NodeJS.ProcessEnv): EnvSnapshot {
  return env as EnvSnapshot;
}

/**
 * Resolve AGENC_HOME. Matches bin/agenc.ts:181.
 *
 * - `AGENC_HOME` wins if set.
 * - Otherwise `$HOME/.agenc`.
 * - Throws if neither is available.
 */
export function resolveAgencHome(env: EnvSnapshot = process.env): string {
  const e = readEnv(env);
  if (e.AGENC_HOME && e.AGENC_HOME.length > 0) return e.AGENC_HOME;
  if (e.HOME && e.HOME.length > 0) return `${e.HOME}/.agenc`;
  throw new Error(
    "HOME unset and AGENC_HOME unset — set AGENC_HOME to a writable dir",
  );
}

/**
 * xAI API key resolution with aliases. Returns `undefined` if none set.
 * Priority: XAI_API_KEY → GROK_API_KEY → AGENC_XAI_API_KEY.
 */
export function resolveApiKey(
  env: EnvSnapshot = process.env,
): string | undefined {
  const e = readEnv(env);
  return e.XAI_API_KEY || e.GROK_API_KEY || e.AGENC_XAI_API_KEY || undefined;
}

function readNonEmpty(
  value: string | undefined,
): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeProvider(
  provider: string | undefined,
): string | undefined {
  const normalized = readNonEmpty(provider)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "xai") return "grok";
  if (normalized === "custom" || normalized === "openai_compatible") {
    return "openai-compatible";
  }
  return normalized;
}

/** Provider slug override from AGENC_PROVIDER, or `undefined`. */
export function resolveProvider(
  env: EnvSnapshot = process.env,
): string | undefined {
  return normalizeProvider(readEnv(env).AGENC_PROVIDER);
}

/** Active profile selector from AGENC_PROFILE, or `undefined`. */
export function resolveProfileName(
  env: EnvSnapshot = process.env,
): string | undefined {
  return readNonEmpty(readEnv(env).AGENC_PROFILE);
}

/**
 * Provider-specific API key resolution for startup/bootstrap paths.
 * Returns `undefined` for providers that do not require a key by default.
 */
export function resolveProviderApiKey(
  provider: string,
  env: EnvSnapshot = process.env,
): string | undefined {
  const e = readEnv(env);
  switch (normalizeProvider(provider)) {
    case "grok":
      return resolveApiKey(e);
    case "openai":
      return readNonEmpty(e.OPENAI_API_KEY);
    case "anthropic":
      return readNonEmpty(e.ANTHROPIC_API_KEY);
    case "lmstudio":
      return readNonEmpty(e.LMSTUDIO_API_KEY) ?? readNonEmpty(e.OPENAI_API_KEY);
    case "openai-compatible":
      return (
        readNonEmpty(e.OPENAI_COMPATIBLE_API_KEY) ??
        readNonEmpty(e.OPENAI_API_KEY)
      );
    case "openrouter":
      return readNonEmpty(e.OPENROUTER_API_KEY);
    case "groq":
      return readNonEmpty(e.GROQ_API_KEY);
    case "deepseek":
      return readNonEmpty(e.DEEPSEEK_API_KEY);
    case "gemini":
      return readNonEmpty(e.GEMINI_API_KEY);
    case "amazon-bedrock":
      return (
        readNonEmpty(e.AWS_BEDROCK_ACCESS_KEY_ID) ??
        readNonEmpty(e.AWS_ACCESS_KEY_ID)
      );
    default:
      return undefined;
  }
}

export function resolveProviderBaseURL(
  provider: string,
  env: EnvSnapshot = process.env,
): string | undefined {
  const e = readEnv(env);
  switch (normalizeProvider(provider)) {
    case "openai":
      return readNonEmpty(e.OPENAI_BASE_URL);
    case "anthropic":
      return readNonEmpty(e.ANTHROPIC_BASE_URL);
    case "lmstudio":
      return (
        readNonEmpty(e.LMSTUDIO_BASE_URL) ?? readNonEmpty(e.OPENAI_BASE_URL)
      );
    case "openai-compatible":
      return (
        readNonEmpty(e.OPENAI_COMPATIBLE_BASE_URL) ??
        readNonEmpty(e.OPENAI_BASE_URL)
      );
    case "openrouter":
      return readNonEmpty(e.OPENROUTER_BASE_URL);
    case "groq":
      return readNonEmpty(e.GROQ_BASE_URL);
    case "deepseek":
      return readNonEmpty(e.DEEPSEEK_BASE_URL);
    case "gemini":
      return readNonEmpty(e.GEMINI_BASE_URL);
    case "amazon-bedrock":
      return readNonEmpty(e.AWS_BEDROCK_BASE_URL);
    default:
      return undefined;
  }
}

/** Model slug from env, falling back to `defaultModel`. */
export function resolveModel(
  defaultModel = "grok-4.5",
  env: EnvSnapshot = process.env,
): string {
  const e = readEnv(env);
  return e.AGENC_MODEL && e.AGENC_MODEL.length > 0 ? e.AGENC_MODEL : defaultModel;
}

/** Workspace root override from AGENC_WORKSPACE, or `undefined`. */
export function resolveWorkspace(
  env: EnvSnapshot = process.env,
): string | undefined {
  const e = readEnv(env);
  return e.AGENC_WORKSPACE && e.AGENC_WORKSPACE.length > 0
    ? e.AGENC_WORKSPACE
    : undefined;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function readPositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readPositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+(?:_\d+)*$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed.replaceAll("_", ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

/** AGENC_SIMPLE truthy → simple mode enabled. */
export function resolveSimpleMode(env: EnvSnapshot = process.env): boolean {
  const e = readEnv(env);
  const raw = (e.AGENC_SIMPLE ?? "").toLowerCase();
  return TRUTHY.has(raw);
}

/**
 * Layer env values onto `config` and return a new frozen snapshot.
 * Env takes precedence over whatever was loaded from TOML.
 *
 * Only fields with an explicit env override are touched — absent env vars
 * leave the base config unchanged.
 */
export function applyEnvOverrides(
  config: AgenCConfig,
  env: EnvSnapshot = process.env,
  onWarn?: (msg: string) => void,
): AgenCConfig {
  const e = readEnv(env);
  const override: Mutable<Partial<AgenCConfig>> = {};

  if (e.AGENC_MODEL && e.AGENC_MODEL.length > 0) {
    override.model = e.AGENC_MODEL;
  }
  const provider = normalizeProvider(e.AGENC_PROVIDER);
  if (provider) {
    override.model_provider = provider;
  }
  if (e.AGENC_HOME && e.AGENC_HOME.length > 0) {
    override.agenc_home = e.AGENC_HOME;
  }
  if (e.AGENC_WORKSPACE && e.AGENC_WORKSPACE.length > 0) {
    override.workspace = e.AGENC_WORKSPACE;
  }
  if (e.AGENC_SIMPLE !== undefined && e.AGENC_SIMPLE.length > 0) {
    override.simpleMode = TRUTHY.has(e.AGENC_SIMPLE.toLowerCase());
  }
  if (e.AGENC_AUTONOMOUS !== undefined && e.AGENC_AUTONOMOUS.length > 0) {
    override.autonomous_mode = TRUTHY.has(e.AGENC_AUTONOMOUS.toLowerCase());
  }
  if (e.AGENC_MAX_OUTPUT_TOKENS !== undefined) {
    const maxOutputTokens = readPositiveInteger(e.AGENC_MAX_OUTPUT_TOKENS);
    if (maxOutputTokens !== undefined) {
      override.max_output_tokens = maxOutputTokens;
    } else if (e.AGENC_MAX_OUTPUT_TOKENS.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_MAX_OUTPUT_TOKENS="${e.AGENC_MAX_OUTPUT_TOKENS}"; expected a positive integer`,
      );
    }
  }
  if (e.AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS !== undefined) {
    const capped = readBoolean(e.AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS);
    if (capped !== undefined) {
      override.capped_default_max_output_tokens = capped;
    } else if (e.AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS="${e.AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS}"; expected boolean-like value`,
      );
    }
  }
  const maxBudgetUsd = readPositiveNumber(e.AGENC_MAX_BUDGET_USD);
  if (maxBudgetUsd !== undefined) {
    override.max_budget_usd = maxBudgetUsd;
  }
  if (e.AGENC_AUTH_BACKEND !== undefined) {
    const backend = readNonEmpty(e.AGENC_AUTH_BACKEND)?.toLowerCase();
    if (backend === "local" || backend === "remote") {
      override.auth = {
        ...(config.auth ?? {}),
        backend,
      };
    } else if (e.AGENC_AUTH_BACKEND.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_AUTH_BACKEND="${e.AGENC_AUTH_BACKEND}"; expected "local" or "remote"`,
      );
    }
  }
  if (e.AGENC_AUTH_MANAGED_KEYS_ENABLED !== undefined) {
    const enabled = readBoolean(e.AGENC_AUTH_MANAGED_KEYS_ENABLED);
    if (enabled !== undefined) {
      override.auth = {
        ...(config.auth ?? {}),
        ...(override.auth ?? {}),
        managedKeys: {
          ...(config.auth?.managedKeys ?? {}),
          ...(override.auth?.managedKeys ?? {}),
          enabled,
        },
      };
    } else if (e.AGENC_AUTH_MANAGED_KEYS_ENABLED.trim().length > 0) {
      onWarn?.(
        `[agenc:config] invalid AGENC_AUTH_MANAGED_KEYS_ENABLED="${e.AGENC_AUTH_MANAGED_KEYS_ENABLED}"; expected boolean-like value`,
      );
    }
  }
  // NOTE: API-key env vars (XAI_API_KEY / GROK_API_KEY / AGENC_XAI_API_KEY)
  // are intentionally NOT layered onto the config snapshot. `resolveApiKey`
  // is the right seam — secrets should not be persisted into the config.
  return mergeConfigs(config, override);
}
