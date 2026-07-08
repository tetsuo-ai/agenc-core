import type { TransactionGuardConfig } from "../config/schema.js";
import { OllamaCourtGuard } from "./ollama-courtguard.js";
import type {
  TransactionGuardContext,
  TransactionGuardPolicy,
} from "./types.js";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "gemma4:e4b";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_DOCKET_BYTES = 48 * 1024;

let defaultEnvContext: TransactionGuardContext | null | undefined;
let configContextCache = new WeakMap<
  TransactionGuardConfig,
  TransactionGuardContext | null
>();

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Where a resolved transaction-guard policy field came from. */
export type TransactionGuardValueSource = "env" | "config" | "default";

export interface TransactionGuardPolicySources {
  readonly enabled: TransactionGuardValueSource;
  readonly model: TransactionGuardValueSource;
  readonly endpoint: TransactionGuardValueSource;
  readonly failMode: TransactionGuardValueSource;
}

export interface ResolvedTransactionGuardPolicy {
  readonly policy: TransactionGuardPolicy;
  readonly sources: TransactionGuardPolicySources;
}

/**
 * Resolve the transaction-guard policy from the `[transaction_guard]`
 * config block and the environment, with per-field source attribution.
 *
 * Precedence per field: env > config > built-in defaults.
 *
 * - `AGENC_TRANSACTION_GUARD` set non-empty overrides `enabled`
 *   ("slm" enables, any other value disables — an explicit env kill
 *   switch even when config enables the guard).
 * - `AGENC_TRANSACTION_GUARD_MODEL` overrides `model`.
 * - `AGENC_TRANSACTION_GUARD_OLLAMA_URL` overrides `endpoint`.
 * - `AGENC_TRANSACTION_GUARD_FAIL_MODE` ("open" | "closed") overrides
 *   `fail_mode`; unrecognized values are ignored.
 * - Timeout and docket budget remain env-only knobs
 *   (`AGENC_TRANSACTION_GUARD_TIMEOUT_MS`,
 *   `AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES`).
 */
export function resolveTransactionGuardPolicy(
  config?: TransactionGuardConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTransactionGuardPolicy {
  const envEnabledRaw = nonEmpty(env.AGENC_TRANSACTION_GUARD);
  let enabled = false;
  let enabledSource: TransactionGuardValueSource = "default";
  if (envEnabledRaw !== undefined) {
    enabled = envEnabledRaw === "slm";
    enabledSource = "env";
  } else if (config?.enabled !== undefined) {
    enabled = config.enabled;
    enabledSource = "config";
  }

  const envModel = nonEmpty(env.AGENC_TRANSACTION_GUARD_MODEL);
  const configModel = nonEmpty(config?.model);
  const model = envModel ?? configModel ?? DEFAULT_MODEL;
  const modelSource: TransactionGuardValueSource =
    envModel !== undefined ? "env" : configModel !== undefined ? "config" : "default";

  const envEndpoint = nonEmpty(env.AGENC_TRANSACTION_GUARD_OLLAMA_URL);
  const configEndpoint = nonEmpty(config?.endpoint);
  const ollamaUrl = envEndpoint ?? configEndpoint ?? DEFAULT_OLLAMA_URL;
  const endpointSource: TransactionGuardValueSource =
    envEndpoint !== undefined
      ? "env"
      : configEndpoint !== undefined
        ? "config"
        : "default";

  const envFailModeRaw = nonEmpty(
    env.AGENC_TRANSACTION_GUARD_FAIL_MODE,
  )?.toLowerCase();
  const envFailMode =
    envFailModeRaw === "open" || envFailModeRaw === "closed"
      ? envFailModeRaw
      : undefined;
  const failMode = envFailMode ?? config?.fail_mode ?? "closed";
  const failModeSource: TransactionGuardValueSource =
    envFailMode !== undefined
      ? "env"
      : config?.fail_mode !== undefined
        ? "config"
        : "default";

  return {
    policy: {
      enabled,
      provider: "ollama",
      ollamaUrl,
      model,
      timeoutMs: parsePositiveInt(
        env.AGENC_TRANSACTION_GUARD_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
      ),
      failClosed: failMode === "closed",
      maxDocketBytes: parsePositiveInt(
        env.AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES,
        DEFAULT_MAX_DOCKET_BYTES,
      ),
    },
    sources: {
      enabled: enabledSource,
      model: modelSource,
      endpoint: endpointSource,
      failMode: failModeSource,
    },
  };
}

/**
 * Merge the `[transaction_guard]` config block with env overrides into a
 * `TransactionGuardPolicy` (env > config > defaults).
 */
export function loadTransactionGuardPolicy(
  config?: TransactionGuardConfig,
  env: NodeJS.ProcessEnv = process.env,
): TransactionGuardPolicy {
  return resolveTransactionGuardPolicy(config, env).policy;
}

/** Env-only policy resolution — `loadTransactionGuardPolicy` without config. */
export function loadTransactionGuardPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TransactionGuardPolicy {
  return loadTransactionGuardPolicy(undefined, env);
}

export function createTransactionGuardContextFromPolicy(
  policy: TransactionGuardPolicy,
): TransactionGuardContext | null {
  if (!policy.enabled) {
    return null;
  }
  return {
    guard: new OllamaCourtGuard(policy),
    policy,
  };
}

export function createTransactionGuardContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TransactionGuardContext | null {
  if (env === process.env && defaultEnvContext !== undefined) {
    return defaultEnvContext;
  }
  const context = createTransactionGuardContextFromPolicy(
    loadTransactionGuardPolicyFromEnv(env),
  );
  if (env === process.env) {
    defaultEnvContext = context;
  }
  return context;
}

/**
 * Config-aware context factory: merges the `[transaction_guard]` block
 * with env overrides. `config === undefined` falls back to the env-only
 * path so callers without a loaded config keep the previous behavior.
 *
 * Contexts are cached per frozen config snapshot (a config reload swaps
 * the snapshot object, invalidating the cache entry naturally).
 */
export function createTransactionGuardContext(
  config: TransactionGuardConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TransactionGuardContext | null {
  if (config === undefined) {
    return createTransactionGuardContextFromEnv(env);
  }
  if (env === process.env && configContextCache.has(config)) {
    return configContextCache.get(config) ?? null;
  }
  const context = createTransactionGuardContextFromPolicy(
    loadTransactionGuardPolicy(config, env),
  );
  if (env === process.env) {
    configContextCache.set(config, context);
  }
  return context;
}

export function resetDefaultTransactionGuardContextForTests(): void {
  defaultEnvContext = undefined;
  configContextCache = new WeakMap();
}
