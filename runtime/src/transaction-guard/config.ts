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

let configContextCache = new WeakMap<
  TransactionGuardConfig,
  TransactionGuardContext | null
>();

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? value as number
    : fallback;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Project an already-layered `[transaction_guard]` config block onto the
 * runtime policy. Environment precedence belongs exclusively to config/env.ts.
 */
export function resolveTransactionGuardPolicy(
  config?: TransactionGuardConfig,
): TransactionGuardPolicy {
  const configModel = nonEmpty(config?.model);
  const configEndpoint = nonEmpty(config?.endpoint);
  return {
    enabled: config?.enabled === true,
    provider: "ollama",
    ollamaUrl: configEndpoint ?? DEFAULT_OLLAMA_URL,
    model: configModel ?? DEFAULT_MODEL,
    timeoutMs: positiveInteger(config?.timeout_ms, DEFAULT_TIMEOUT_MS),
    failClosed: config?.fail_mode !== "open",
    maxDocketBytes: positiveInteger(
      config?.max_docket_bytes,
      DEFAULT_MAX_DOCKET_BYTES,
    ),
  };
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

/**
 * Contexts are cached per resolved config block (a config reload swaps
 * the snapshot object, invalidating the cache entry naturally).
 */
export function createTransactionGuardContext(
  config: TransactionGuardConfig | undefined,
): TransactionGuardContext | null {
  if (config === undefined) return null;
  if (configContextCache.has(config)) {
    return configContextCache.get(config) ?? null;
  }
  const context = createTransactionGuardContextFromPolicy(
    resolveTransactionGuardPolicy(config),
  );
  configContextCache.set(config, context);
  return context;
}

export function resetDefaultTransactionGuardContextForTests(): void {
  configContextCache = new WeakMap();
}
