import type {
  AuthBackend,
} from "./backend.js";

export interface AccountModelAccess {
  readonly authenticated: boolean;
  readonly unavailable?: boolean;
  readonly managedModelsEnabled: false;
  readonly models: readonly never[];
}

/** Compatibility response for clients that previously queried account models. */
export async function readAccountModelAccess(backend: AuthBackend): Promise<AccountModelAccess> {
  try {
    const account = await backend.whoami({ sessionId: "cli" });
    return { authenticated: account.authenticated, managedModelsEnabled: false, models: [] };
  } catch {
    return { authenticated: false, unavailable: true, managedModelsEnabled: false, models: [] };
  }
}
