import { silentLogger } from "../utils/logger.js";
import { OllamaCourtGuard } from "./ollama-courtguard.js";
import { InMemoryTransactionGuardReceiptStore } from "./receipts.js";
import type {
  TransactionGuardContext,
  TransactionGuardPolicy,
  TransactionGuardReceiptStore,
} from "./types.js";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "gemma4:e2b";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECEIPT_TTL_MS = 30_000;
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
    receiptTtlMs: parsePositiveInt(
      env.AGENC_TRANSACTION_GUARD_RECEIPT_TTL_MS,
      DEFAULT_RECEIPT_TTL_MS,
    ),
  };
}

export function createTransactionGuardContextFromPolicy(
  policy: TransactionGuardPolicy,
  receipts?: TransactionGuardReceiptStore,
): TransactionGuardContext | null {
  if (!policy.enabled) {
    return null;
  }
  return {
    guard: new OllamaCourtGuard(policy),
    policy,
    receipts: receipts ?? new InMemoryTransactionGuardReceiptStore(policy.receiptTtlMs),
    logger: silentLogger,
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
