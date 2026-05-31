import type {
  AuthBackend,
  AuthProviderSlug,
  AuthSessionId,
  AuthVendedKey,
} from "../auth/backend.js";

/**
 * Clock-skew margin applied when deciding whether a cached vended key has
 * expired. A key is treated as expired slightly before its real expiry so we
 * re-vend before downstream callers present an already-rejected credential.
 */
const VENDED_KEY_EXPIRY_SKEW_MS = 5_000;

interface CachedVendedKey {
  readonly promise: Promise<AuthVendedKey>;
  /**
   * Resolved expiry (epoch ms) of the vended key, or undefined while the
   * vend is still in flight or when the key carries no expiry. A `null`
   * expiry means the resolved key had no `expiresAt` and never expires.
   */
  expiresAtMs: number | null | undefined;
}

export function createAgenCDaemonRuntimeAuthBackend(
  backend: AuthBackend,
  options: AgenCDaemonRuntimeAuthBackendOptions = {},
): AgenCDaemonRuntimeAuthBackend {
  let current = backend;
  const nowMs = options.nowMs ?? (() => Date.now());
  const vendedKeys = new Map<string, CachedVendedKey>();

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
      if (existing !== undefined && !isCachedKeyExpired(existing, nowMs())) {
        return existing.promise;
      }
      if (existing !== undefined) {
        vendedKeys.delete(cacheKey);
      }

      const entry: CachedVendedKey = {
        expiresAtMs: undefined,
        promise: (async () => current.vendKey(provider, sessionId))().then(
          (key) => {
            if (vendedKeys.get(cacheKey) === entry) {
              entry.expiresAtMs = parseExpiresAtMs(key.expiresAt);
            }
            return key;
          },
          (error) => {
            if (vendedKeys.get(cacheKey) === entry) {
              vendedKeys.delete(cacheKey);
            }
            throw error;
          },
        ),
      };
      vendedKeys.set(cacheKey, entry);
      return entry.promise;
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

export interface AgenCDaemonRuntimeAuthBackendOptions {
  /** Injectable clock (epoch ms) for deterministic expiry handling/tests. */
  readonly nowMs?: () => number;
}

export interface AgenCDaemonRuntimeAuthBackend extends AuthBackend {
  replaceBackend(next: AuthBackend): void;
  clearVendedKeyCache(): void;
}

function isCachedKeyExpired(entry: CachedVendedKey, nowMs: number): boolean {
  // While a vend is in flight (expiresAtMs === undefined) the in-progress
  // promise is reused. A null expiry means the key never expires.
  if (entry.expiresAtMs === undefined || entry.expiresAtMs === null) {
    return false;
  }
  return nowMs >= entry.expiresAtMs - VENDED_KEY_EXPIRY_SKEW_MS;
}

function parseExpiresAtMs(expiresAt: string | undefined): number | null {
  if (expiresAt === undefined) return null;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function daemonProviderKeyCacheKey(
  provider: AuthProviderSlug | string,
  sessionId: AuthSessionId,
): string {
  return `${sessionId}\0${provider}`;
}
