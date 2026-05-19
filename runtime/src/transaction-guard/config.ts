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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadTransactionGuardPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TransactionGuardPolicy {
  return {
    enabled: env.AGENC_TRANSACTION_GUARD === "slm",
    provider: "ollama",
    ollamaUrl: env.AGENC_TRANSACTION_GUARD_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    model: env.AGENC_TRANSACTION_GUARD_MODEL ?? DEFAULT_MODEL,
    timeoutMs: parsePositiveInt(
      env.AGENC_TRANSACTION_GUARD_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    failClosed: true,
    maxDocketBytes: parsePositiveInt(
      env.AGENC_TRANSACTION_GUARD_MAX_DOCKET_BYTES,
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

export function resetDefaultTransactionGuardContextForTests(): void {
  defaultEnvContext = undefined;
}
