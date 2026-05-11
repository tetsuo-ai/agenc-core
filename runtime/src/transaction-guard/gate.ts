import type { Connection } from "@solana/web3.js";
import { isWriteMethod } from "../connection/retry.js";
import {
  TRANSACTION_GUARD_DENIED,
  TRANSACTION_GUARD_RECEIPT_MISSING,
  TRANSACTION_GUARD_UNAVAILABLE,
  TransactionGuardError,
} from "./errors.js";
import type {
  TransactionGuardContext,
  TransactionGuardDecision,
  TransactionGuardInput,
} from "./types.js";
import { InMemoryTransactionGuardReceiptStore } from "./receipts.js";

const PATCHED = Symbol.for("agenc.transactionGuard.patched");

type PatchableConnection = Connection & {
  _rpcRequest?: (method: string, args: unknown[]) => Promise<unknown>;
  [PATCHED]?: boolean;
};

function requireAllowedDecision(decision: TransactionGuardDecision): void {
  if (decision.allowed) return;
  const code =
    decision.code === TRANSACTION_GUARD_DENIED
      ? TRANSACTION_GUARD_DENIED
      : TRANSACTION_GUARD_UNAVAILABLE;
  throw new TransactionGuardError(
    code,
    decision.reason ?? "Transaction guard denied the Solana write",
  );
}

export async function guardTransactionIntent(
  context: TransactionGuardContext | null | undefined,
  input: TransactionGuardInput,
): Promise<TransactionGuardDecision | null> {
  if (!context?.policy.enabled) {
    return null;
  }
  const decision = await context.guard.evaluate(input);
  requireAllowedDecision(decision);
  (context.receipts ?? new InMemoryTransactionGuardReceiptStore(context.policy.receiptTtlMs)).record(
    decision,
  );
  return decision;
}

export function assertTransactionGuardReceipt(
  context: TransactionGuardContext | null | undefined,
): void {
  if (!context?.policy.enabled) {
    return;
  }
  const receipt = context.receipts?.consumeFresh();
  if (!receipt?.decision.allowed) {
    throw new TransactionGuardError(
      TRANSACTION_GUARD_RECEIPT_MISSING,
      "Solana write blocked because no fresh benign transaction guard receipt was found",
    );
  }
}

export function patchConnectionForTransactionGuard(
  connection: Connection,
  context: TransactionGuardContext | null | undefined,
): Connection {
  if (!context?.policy.enabled) {
    return connection;
  }
  const target = connection as PatchableConnection;
  if (target[PATCHED]) {
    return connection;
  }
  target[PATCHED] = true;

  if (typeof target._rpcRequest === "function") {
    const originalRpcRequest = target._rpcRequest.bind(connection);
    target._rpcRequest = async (method: string, args: unknown[]) => {
      if (isWriteMethod(method)) {
        assertTransactionGuardReceipt(context);
      }
      return originalRpcRequest(method, args);
    };
    return connection;
  }

  const rawTarget = connection as unknown as {
    sendEncodedTransaction?: (...args: unknown[]) => Promise<unknown>;
    sendRawTransaction?: (...args: unknown[]) => Promise<unknown>;
    sendTransaction?: (...args: unknown[]) => Promise<unknown>;
  };
  if (typeof rawTarget.sendEncodedTransaction === "function") {
    const original = rawTarget.sendEncodedTransaction.bind(connection);
    rawTarget.sendEncodedTransaction = async (...args: unknown[]) => {
      assertTransactionGuardReceipt(context);
      return original(...args);
    };
  }
  if (typeof rawTarget.sendRawTransaction === "function") {
    const original = rawTarget.sendRawTransaction.bind(connection);
    rawTarget.sendRawTransaction = async (...args: unknown[]) => {
      assertTransactionGuardReceipt(context);
      return original(...args);
    };
  }
  if (typeof rawTarget.sendTransaction === "function") {
    const original = rawTarget.sendTransaction.bind(connection);
    rawTarget.sendTransaction = async (...args: unknown[]) => {
      assertTransactionGuardReceipt(context);
      return original(...args);
    };
  }

  return connection;
}
