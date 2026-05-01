import type {
  AuthBackend,
  AuthInferAgencModelParams,
  AuthInferredAgencModel,
  AuthLoginParams,
  AuthLoginResult,
  AuthLogoutParams,
  AuthLogoutResult,
  AuthProviderSlug,
  AuthSessionId,
  AuthSessionRef,
  AuthSubscriptionTier,
  AuthVendedKey,
  AuthWhoamiParams,
  AuthWhoamiResult,
} from "../backend.js";

export interface RemoteAuthVendKeyRequest {
  readonly provider: AuthProviderSlug | string;
  readonly sessionId: AuthSessionId;
}

export type RemoteAuthKeyVendor = (
  request: RemoteAuthVendKeyRequest,
) => AuthVendedKey | Promise<AuthVendedKey>;

export interface RemoteAuthBackendOptions {
  readonly keyVendor?: RemoteAuthKeyVendor;
}

export class RemoteAuthBackend implements AuthBackend {
  readonly #keyVendor: RemoteAuthKeyVendor | undefined;
  readonly #vendedKeys = new Map<string, Promise<AuthVendedKey>>();

  constructor(options: RemoteAuthBackendOptions = {}) {
    this.#keyVendor = options.keyVendor;
  }

  login(_params: AuthLoginParams = {}): AuthLoginResult {
    throw new Error(
      "RemoteAuthBackend login is not available until the remote login flow is configured",
    );
  }

  logout(_params: AuthLogoutParams = {}): AuthLogoutResult {
    return { authenticated: false };
  }

  whoami(_params: AuthWhoamiParams = {}): AuthWhoamiResult {
    return { authenticated: false, provider: "remote" };
  }

  vendKey(
    provider: AuthProviderSlug | string,
    sessionId: AuthSessionId,
  ): Promise<AuthVendedKey> {
    const cacheKey = remoteProviderKeyCacheKey(provider, sessionId);
    const existing = this.#vendedKeys.get(cacheKey);
    if (existing !== undefined) return existing;

    const vended = this.#requestVendedKey(provider, sessionId).catch((error) => {
      this.#vendedKeys.delete(cacheKey);
      throw error;
    });
    this.#vendedKeys.set(cacheKey, vended);
    return vended;
  }

  inferAgencModel(
    _params: AuthInferAgencModelParams = {},
  ): AuthInferredAgencModel {
    throw new Error(
      "RemoteAuthBackend model inference is not available until hosted model routing is configured",
    );
  }

  getSubscriptionTier(
    _params: AuthSessionRef = {},
  ): AuthSubscriptionTier {
    return "free";
  }

  async #requestVendedKey(
    provider: AuthProviderSlug | string,
    sessionId: AuthSessionId,
  ): Promise<AuthVendedKey> {
    if (this.#keyVendor === undefined) {
      throw new Error(
        "RemoteAuthBackend key vending is not configured in this AgenC build",
      );
    }
    const vended = await this.#keyVendor({ provider, sessionId });
    const apiKey = vended.apiKey.trim();
    if (apiKey.length === 0) {
      throw new Error(
        `RemoteAuthBackend returned an empty managed key for provider "${provider}" in session "${sessionId}"`,
      );
    }
    return {
      ...vended,
      provider,
      sessionId,
      apiKey,
    };
  }
}

function remoteProviderKeyCacheKey(
  provider: AuthProviderSlug | string,
  sessionId: AuthSessionId,
): string {
  return `${sessionId}\0${provider}`;
}
