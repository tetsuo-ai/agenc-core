export const TRANSACTION_GUARD_DENIED = "TRANSACTION_GUARD_DENIED";
export const TRANSACTION_GUARD_UNAVAILABLE = "TRANSACTION_GUARD_UNAVAILABLE";

export class TransactionGuardError extends Error {
  readonly code:
    | typeof TRANSACTION_GUARD_DENIED
    | typeof TRANSACTION_GUARD_UNAVAILABLE;

  constructor(code: TransactionGuardError["code"], message: string) {
    super(message);
    this.name = "TransactionGuardError";
    this.code = code;
  }
}
