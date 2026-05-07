import type {
  AuthBackend,
  AuthProviderSlug,
  AuthSessionId,
  AuthVendedKey,
} from "../auth/backend.js";

export function createAgenCDaemonRuntimeAuthBackend(
  backend: AuthBackend,
): AgenCDaemonRuntimeAuthBackend {
  let current = backend;
  const vendedKeys = new Map<string, Promise<AuthVendedKey>>();

  const wrapped: AgenCDaemonRuntimeAuthBackend = {
    get kind() {
      return current.kind;
    },
    login: (params) => current.login(params),
    logout: (params) => current.logout(params),
    whoami: (params) => current.whoami(params),
    vendKey: (provider, sessionId) => {
      const cacheKey = daemonProviderKeyCacheKey(provider, sessionId);
      const existing = vendedKeys.get(cacheKey);
      if (existing !== undefined) return existing;

      const vended = (async () => current.vendKey(provider, sessionId))().catch(
        (error) => {
          vendedKeys.delete(cacheKey);
          throw error;
        },
      );
      vendedKeys.set(cacheKey, vended);
      return vended;
    },
    inferAgencModel: (params) => current.inferAgencModel(params),
    getSubscriptionTier: (params) => current.getSubscriptionTier(params),
    replaceBackend: (next) => {
      current = next;
      vendedKeys.clear();
    },
    clearVendedKeyCache: () => {
      vendedKeys.clear();
    },
  };

  return wrapped;
}

export interface AgenCDaemonRuntimeAuthBackend extends AuthBackend {
  replaceBackend(next: AuthBackend): void;
  clearVendedKeyCache(): void;
}

function daemonProviderKeyCacheKey(
  provider: AuthProviderSlug | string,
  sessionId: AuthSessionId,
): string {
  return `${sessionId}\0${provider}`;
}
