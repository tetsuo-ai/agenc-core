import type {
  TransactionGuardDecision,
  TransactionGuardReceipt,
  TransactionGuardReceiptStore,
} from "./types.js";

export class InMemoryTransactionGuardReceiptStore
  implements TransactionGuardReceiptStore
{
  private readonly receipts = new Map<string, TransactionGuardReceipt>();

  constructor(private readonly receiptTtlMs: number) {}

  record(decision: TransactionGuardDecision): TransactionGuardReceipt {
    const now = Date.now();
    const receipt: TransactionGuardReceipt = {
      inputHash: decision.inputHash,
      decision,
      expiresAt: now + this.receiptTtlMs,
      consumedAt: null,
    };
    this.receipts.set(decision.inputHash, receipt);
    this.clearExpired(now);
    return receipt;
  }

  consumeFresh(now = Date.now()): TransactionGuardReceipt | null {
    this.clearExpired(now);
    const fresh = [...this.receipts.values()]
      .filter((receipt) => receipt.consumedAt === null && receipt.expiresAt >= now)
      .sort((left, right) => left.expiresAt - right.expiresAt)[0];
    if (!fresh) {
      return null;
    }
    const consumed: TransactionGuardReceipt = {
      ...fresh,
      consumedAt: now,
    };
    this.receipts.set(fresh.inputHash, consumed);
    return consumed;
  }

  clearExpired(now = Date.now()): void {
    for (const [hash, receipt] of this.receipts) {
      if (receipt.expiresAt < now || receipt.consumedAt !== null) {
        this.receipts.delete(hash);
      }
    }
  }
}
