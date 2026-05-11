import type { Logger } from "../utils/logger.js";

export type TransactionGuardProvider = "ollama";
export type TransactionGuardVerdict = "benign" | "adversarial";

export interface TransactionGuardAccountMeta {
  readonly name?: string;
  readonly pubkey: string;
  readonly isSigner?: boolean;
  readonly isWritable?: boolean;
}

export interface TransactionGuardInput {
  readonly source: string;
  readonly kind: string;
  readonly programId?: string | null;
  readonly signer?: string | null;
  readonly userText?: string | null;
  readonly transactionSummary?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly accountMetas?: readonly TransactionGuardAccountMeta[];
}

export interface TransactionGuardPolicy {
  readonly enabled: boolean;
  readonly provider: TransactionGuardProvider;
  readonly ollamaUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly failClosed: boolean;
  readonly receiptTtlMs: number;
}

export interface TransactionGuardDecision {
  readonly allowed: boolean;
  readonly verdict: TransactionGuardVerdict | "unavailable";
  readonly code?: string;
  readonly reason?: string;
  readonly provider: TransactionGuardProvider;
  readonly model: string;
  readonly inputHash: string;
  readonly raw?: Readonly<Record<string, string>>;
}

export interface TransactionGuard {
  evaluate(input: TransactionGuardInput): Promise<TransactionGuardDecision>;
}

export interface TransactionGuardContext {
  readonly guard: TransactionGuard;
  readonly policy: TransactionGuardPolicy;
  readonly receipts?: TransactionGuardReceiptStore;
  readonly logger?: Logger;
}

export interface TransactionGuardReceipt {
  readonly inputHash: string;
  readonly decision: TransactionGuardDecision;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

export interface TransactionGuardReceiptStore {
  record(decision: TransactionGuardDecision): TransactionGuardReceipt;
  consumeFresh(now?: number): TransactionGuardReceipt | null;
  clearExpired(now?: number): void;
}
