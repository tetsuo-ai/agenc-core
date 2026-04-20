// T10 Group D — environment variable resolution.
//
// Precedence order (env wins over TOML):
//   XAI_API_KEY | GROK_API_KEY | AGENC_XAI_API_KEY → api key
//   AGENC_MODEL                                    → model slug
//   AGENC_WORKSPACE                                → workspace root
//   AGENC_HOME                                     → ~/.agenc override
//   AGENC_SIMPLE                                   → simple UI/mode
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
  readonly AGENC_MODEL?: string;
  readonly AGENC_WORKSPACE?: string;
  readonly AGENC_SIMPLE?: string;
  readonly XAI_API_KEY?: string;
  readonly GROK_API_KEY?: string;
  readonly AGENC_XAI_API_KEY?: string;
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

/** Model slug from env, falling back to `defaultModel`. */
export function resolveModel(
  defaultModel = "grok-4-fast",
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
): AgenCConfig {
  const e = readEnv(env);
  const override: Mutable<Partial<AgenCConfig>> = {};

  if (e.AGENC_MODEL && e.AGENC_MODEL.length > 0) {
    override.model = e.AGENC_MODEL;
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
  // NOTE: API-key env vars (XAI_API_KEY / GROK_API_KEY / AGENC_XAI_API_KEY)
  // are intentionally NOT layered onto the config snapshot. `resolveApiKey`
  // is the right seam — secrets should not be persisted into the config.
  return mergeConfigs(config, override);
}
