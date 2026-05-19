import type { ToolInvocation } from "../tools/context.js";
import type { Tool } from "../tools/types.js";
import {
  TRANSACTION_GUARD_DENIED,
  TRANSACTION_GUARD_UNAVAILABLE,
} from "./errors.js";
import { buildToolTransactionGuardInput } from "./tool-intent.js";
import type {
  TransactionGuardAuditMetadata,
  TransactionGuardContext,
  TransactionGuardDecision,
  TransactionGuardInput,
} from "./types.js";

export type ToolTransactionGuardOutcome =
  | { readonly kind: "skipped" }
  | {
      readonly kind: "evaluated";
      readonly input: TransactionGuardInput;
      readonly decision: TransactionGuardDecision;
    };

export async function evaluateToolInvocationTransactionGuard(opts: {
  readonly context: TransactionGuardContext | null;
  readonly tool: Tool;
  readonly invocation: ToolInvocation;
  readonly args: Record<string, unknown>;
}): Promise<ToolTransactionGuardOutcome> {
  if (opts.context === null || !opts.context.policy.enabled) {
    return { kind: "skipped" };
  }
  const input = buildToolTransactionGuardInput(
    opts.tool,
    opts.invocation,
    opts.args,
  );
  if (input === null) {
    return { kind: "skipped" };
  }
  const decision = await opts.context.guard.evaluate(input);
  return { kind: "evaluated", input, decision };
}

export function transactionGuardAuditMetadata(
  decision: TransactionGuardDecision,
): TransactionGuardAuditMetadata {
  return {
    provider: decision.provider,
    model: decision.model,
    verdict: decision.verdict,
    inputHash: decision.inputHash,
    ...(decision.code !== undefined ? { code: decision.code } : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
  };
}

export function formatTransactionGuardEventMessage(
  toolName: string,
  decision: TransactionGuardDecision,
): string {
  const status = decision.allowed ? "allowed" : "denied";
  return [
    `transaction guard ${status} ${toolName}`,
    `verdict=${decision.verdict}`,
    `model=${decision.model}`,
    `inputHash=${decision.inputHash}`,
    decision.reason ? `reason=${decision.reason}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

export function formatTransactionGuardDenialMessage(
  decision: TransactionGuardDecision,
): string {
  const code =
    decision.code ??
    (decision.verdict === "unavailable"
      ? TRANSACTION_GUARD_UNAVAILABLE
      : TRANSACTION_GUARD_DENIED);
  const reason =
    decision.reason ??
    "CourtGuard blocked this Solana transaction-like action.";
  return `${code}: ${reason}. The action was not executed. model=${decision.model} inputHash=${decision.inputHash}`;
}
