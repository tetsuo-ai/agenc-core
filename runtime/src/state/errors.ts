export class StateStoreError extends Error {
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

export class StateBackfillError extends StateStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateBackfillError";
  }
}

export class StateNotFoundError extends StateStoreError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = "StateNotFoundError";
  }
}
