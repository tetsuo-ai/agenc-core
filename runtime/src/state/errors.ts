class StateStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateStoreError";
  }
}

export class StateMigrationError extends StateStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateMigrationError";
  }
}

export class StateSchemaMismatchError extends StateStoreError {
  constructor(
    public readonly appliedVersion: number,
    public readonly knownVersion: number,
  ) {
    super(
      `state schema v${appliedVersion} is newer than runtime v${knownVersion} — ` +
        "please upgrade @tetsuo-ai/runtime",
    );
    this.name = "StateSchemaMismatchError";
  }
}
