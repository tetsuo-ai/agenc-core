export const TRANSACTION_GUARD_DENIED = "TRANSACTION_GUARD_DENIED";
export const TRANSACTION_GUARD_UNAVAILABLE = "TRANSACTION_GUARD_UNAVAILABLE";
export const TRANSACTION_GUARD_RECEIPT_MISSING = "TRANSACTION_GUARD_RECEIPT_MISSING";

export class TransactionGuardError extends Error {
  readonly code:
    | typeof TRANSACTION_GUARD_DENIED
    | typeof TRANSACTION_GUARD_UNAVAILABLE
    | typeof TRANSACTION_GUARD_RECEIPT_MISSING;

  constructor(
    code: TransactionGuardError["code"],
    message: string,
  ) {
    super(message);
    this.name = "TransactionGuardError";
    this.code = code;
  }
}
