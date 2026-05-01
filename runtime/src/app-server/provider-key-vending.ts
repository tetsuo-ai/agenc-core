import type {
  AuthBackend,
  AuthProviderSlug,
  AuthSessionId,
  AuthVendedKey,
} from "../auth/backend.js";

export function createAgenCDaemonRuntimeAuthBackend(
  backend: AuthBackend,
): AuthBackend {
  const vendedKeys = new Map<string, Promise<AuthVendedKey>>();

  const wrapped: AuthBackend = {
    login: (params) => backend.login(params),
    logout: (params) => backend.logout(params),
    whoami: (params) => backend.whoami(params),
    vendKey: (provider, sessionId) => {
      const cacheKey = daemonProviderKeyCacheKey(provider, sessionId);
      const existing = vendedKeys.get(cacheKey);
      if (existing !== undefined) return existing;

      const vended = (async () => backend.vendKey(provider, sessionId))().catch(
        (error) => {
          vendedKeys.delete(cacheKey);
          throw error;
        },
      );
      vendedKeys.set(cacheKey, vended);
      return vended;
    },
    inferAgencModel: (params) => backend.inferAgencModel(params),
    getSubscriptionTier: (params) => backend.getSubscriptionTier(params),
  };

  return wrapped;
}

function daemonProviderKeyCacheKey(
  provider: AuthProviderSlug | string,
  sessionId: AuthSessionId,
): string {
  return `${sessionId}\0${provider}`;
}
