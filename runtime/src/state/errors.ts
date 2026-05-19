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
