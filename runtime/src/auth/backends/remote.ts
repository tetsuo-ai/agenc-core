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
import type { EnvSnapshot } from "../../config/env.js";

export const DEFAULT_REMOTE_AUTH_KEY_VENDING_URL =
  "https://api.agenc.tech/v1/auth/vend-key" as const;
export const REMOTE_AUTH_URL_ENV = "AGENC_REMOTE_AUTH_URL" as const;
export const REMOTE_AUTH_TOKEN_ENV = "AGENC_REMOTE_AUTH_TOKEN" as const;

export interface RemoteAuthVendKeyRequest {
  readonly provider: AuthProviderSlug | string;
  readonly sessionId: AuthSessionId;
}

export type RemoteAuthKeyVendor = (
  request: RemoteAuthVendKeyRequest,
) => AuthVendedKey | Promise<AuthVendedKey>;

export interface RemoteAuthBackendOptions {
  readonly keyVendor?: RemoteAuthKeyVendor;
  readonly endpoint?: string;
  readonly env?: EnvSnapshot;
  readonly fetchImpl?: typeof fetch;
  readonly token?: string;
}

export class RemoteAuthBackend implements AuthBackend {
  readonly #keyVendor: RemoteAuthKeyVendor;
  readonly #vendedKeys = new Map<string, Promise<AuthVendedKey>>();

  constructor(options: RemoteAuthBackendOptions = {}) {
    this.#keyVendor = options.keyVendor ?? createHttpRemoteAuthKeyVendor(options);
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

function createHttpRemoteAuthKeyVendor(
  options: RemoteAuthBackendOptions,
): RemoteAuthKeyVendor {
  const env = options.env ?? process.env;
  const endpoint =
    trimNonEmpty(options.endpoint) ??
    trimNonEmpty(env[REMOTE_AUTH_URL_ENV]) ??
    DEFAULT_REMOTE_AUTH_KEY_VENDING_URL;
  const token =
    trimNonEmpty(options.token) ?? trimNonEmpty(env[REMOTE_AUTH_TOKEN_ENV]);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return async (request) => {
    if (fetchImpl === undefined) {
      throw new Error("RemoteAuthBackend requires fetch for remote key vending");
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: request.provider,
        sessionId: request.sessionId,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `RemoteAuthBackend key vending failed with HTTP ${response.status}`,
      );
    }
    return parseRemoteAuthVendKeyResponse(await response.json(), request);
  };
}

function parseRemoteAuthVendKeyResponse(
  value: unknown,
  request: RemoteAuthVendKeyRequest,
): AuthVendedKey {
  if (!value || typeof value !== "object") {
    throw new Error("RemoteAuthBackend key vending returned a non-object response");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.apiKey !== "string") {
    throw new Error("RemoteAuthBackend key vending response missing apiKey");
  }
  return {
    provider:
      typeof record.provider === "string" && record.provider.length > 0
        ? record.provider
        : request.provider,
    sessionId:
      typeof record.sessionId === "string" && record.sessionId.length > 0
        ? record.sessionId
        : request.sessionId,
    apiKey: record.apiKey,
    ...(typeof record.expiresAt === "string" && record.expiresAt.length > 0
      ? { expiresAt: record.expiresAt }
      : {}),
  };
}

function trimNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function remoteProviderKeyCacheKey(
  provider: AuthProviderSlug | string,
  sessionId: AuthSessionId,
): string {
  return `${sessionId}\0${provider}`;
}
