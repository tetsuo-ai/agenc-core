import type { AuthBackend, AuthSessionId } from "../auth/backend.js";

/** Keep account authentication replaceable without granting model authority. */
export function createAgenCDaemonRuntimeAuthBackend(
  backend: AuthBackend,
): AgenCDaemonRuntimeAuthBackend {
  let current = backend;
  const retired = async (): Promise<never> => {
    throw new Error("AgenC accounts no longer provide models.");
  };
  return {
    get kind() { return current.kind; },
    login: params => current.login(params),
    logout: params => current.logout(params),
    whoami: params => current.whoami(params),
    getSubscriptionTier: params => current.getSubscriptionTier(params),
    vendKey: retired,
    inferAgencModel: retired,
    getLlmUsage: retired,
    listAgencModels: () => [],
    replaceBackend: next => { current = next; },
    // Session lifecycle callers from older integrations may still clear caches.
    clearVendedKeyCache: () => {},
    clearVendedKeysForSession: () => {},
  };
}

export interface AgenCDaemonRuntimeAuthBackend extends AuthBackend {
  replaceBackend(next: AuthBackend): void;
  clearVendedKeyCache(): void;
  clearVendedKeysForSession(sessionId: AuthSessionId): void;
}
