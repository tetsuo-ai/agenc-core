export type TransactionGuardProvider = "ollama";
export type TransactionGuardVerdict = "benign" | "adversarial";

export interface TransactionGuardInput {
  readonly source: string;
  readonly kind: string;
  readonly toolName?: string | null;
  readonly callId?: string | null;
  readonly cwd?: string | null;
  readonly command?: string | null;
  readonly userText?: string | null;
  readonly transactionSummary?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TransactionGuardPolicy {
  readonly enabled: boolean;
  readonly provider: TransactionGuardProvider;
  readonly ollamaUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly failClosed: boolean;
  readonly maxDocketBytes: number;
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
}

export interface TransactionGuardAuditMetadata {
  readonly provider: TransactionGuardProvider;
  readonly model: string;
  readonly verdict: TransactionGuardDecision["verdict"];
  readonly inputHash: string;
  readonly code?: string;
  readonly reason?: string;
}
