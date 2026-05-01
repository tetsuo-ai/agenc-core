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
export const DEFAULT_REMOTE_AUTH_MODEL_INFERENCE_URL =
  "https://api.agenc.tech/v1/auth/infer-model" as const;
export const DEFAULT_REMOTE_AUTH_SUBSCRIPTION_TIER_URL =
  "https://api.agenc.tech/v1/auth/subscription-tier" as const;
export const REMOTE_AUTH_MODEL_URL_ENV = "AGENC_REMOTE_AUTH_MODEL_URL" as const;
export const REMOTE_AUTH_TIER_URL_ENV = "AGENC_REMOTE_AUTH_TIER_URL" as const;
export const REMOTE_AUTH_URL_ENV = "AGENC_REMOTE_AUTH_URL" as const;
export const REMOTE_AUTH_TOKEN_ENV = "AGENC_REMOTE_AUTH_TOKEN" as const;
export const REMOTE_AUTH_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

export interface RemoteAuthVendKeyRequest {
  readonly provider: AuthProviderSlug | string;
  readonly sessionId: AuthSessionId;
}

export type RemoteAuthKeyVendor = (
  request: RemoteAuthVendKeyRequest,
) => AuthVendedKey | Promise<AuthVendedKey>;

export type RemoteAuthModelInferer = (
  request: AuthInferAgencModelParams,
) => AuthInferredAgencModel | Promise<AuthInferredAgencModel>;

export type RemoteAuthSubscriptionTierResolver = (
  request: AuthSessionRef,
) => AuthSubscriptionTier | Promise<AuthSubscriptionTier>;

export interface RemoteAuthBackendOptions {
  readonly keyVendor?: RemoteAuthKeyVendor;
  readonly modelInferer?: RemoteAuthModelInferer;
  readonly subscriptionTierResolver?: RemoteAuthSubscriptionTierResolver;
  readonly endpoint?: string;
  readonly env?: EnvSnapshot;
  readonly fetchImpl?: typeof fetch;
  readonly keyCacheTtlMs?: number;
  readonly modelEndpoint?: string;
  readonly nowMs?: () => number;
  readonly tierEndpoint?: string;
  readonly token?: string;
}

interface CachedRemoteAuthKey {
  readonly promise: Promise<AuthVendedKey>;
  readonly expiresAtMs: number;
}

export class RemoteAuthBackend implements AuthBackend {
  readonly kind = "remote";

  readonly #keyVendor: RemoteAuthKeyVendor;
  readonly #modelInferer: RemoteAuthModelInferer;
  readonly #subscriptionTierResolver: RemoteAuthSubscriptionTierResolver;
  readonly #keyCacheTtlMs: number;
  readonly #nowMs: () => number;
  readonly #vendedKeys = new Map<string, CachedRemoteAuthKey>();

  constructor(options: RemoteAuthBackendOptions = {}) {
    this.#keyVendor = options.keyVendor ?? createHttpRemoteAuthKeyVendor(options);
    this.#modelInferer =
      options.modelInferer ?? createHttpRemoteAuthModelInferer(options);
    this.#subscriptionTierResolver =
      options.subscriptionTierResolver ??
      createHttpRemoteAuthSubscriptionTierResolver(options);
    this.#keyCacheTtlMs = positiveTtlMs(options.keyCacheTtlMs);
    this.#nowMs = options.nowMs ?? (() => Date.now());
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
    const now = this.#nowMs();
    this.pruneExpiredKeys(now);
    const existing = this.#vendedKeys.get(cacheKey);
    if (existing !== undefined && existing.expiresAtMs > now) {
      return existing.promise;
    }
    if (existing !== undefined) {
      this.#vendedKeys.delete(cacheKey);
    }

    const uncached = this.#requestVendedKey(provider, sessionId).catch((error) => {
      this.#vendedKeys.delete(cacheKey);
      throw error;
    });
    const cached = uncached.then((key) => {
      const expiresAtMs = cacheExpiresAtMs(
        key,
        this.#nowMs(),
        this.#keyCacheTtlMs,
      );
      const current = this.#vendedKeys.get(cacheKey);
      if (current?.promise === cached) {
        this.#vendedKeys.set(cacheKey, {
          promise: cached,
          expiresAtMs,
        });
      }
      return key;
    });
    this.#vendedKeys.set(cacheKey, {
      promise: cached,
      expiresAtMs: now + this.#keyCacheTtlMs,
    });
    return cached;
  }

  pruneExpiredKeys(nowMs: number = this.#nowMs()): number {
    let pruned = 0;
    for (const [cacheKey, cached] of this.#vendedKeys) {
      if (cached.expiresAtMs <= nowMs) {
        this.#vendedKeys.delete(cacheKey);
        pruned += 1;
      }
    }
    return pruned;
  }

  async inferAgencModel(
    params: AuthInferAgencModelParams = {},
  ): Promise<AuthInferredAgencModel> {
    return this.#requestInferredModel(params);
  }

  async getSubscriptionTier(
    params: AuthSessionRef = {},
  ): Promise<AuthSubscriptionTier> {
    return this.#requestSubscriptionTier(params);
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
    if (vended.provider !== provider) {
      throw new Error(
        `RemoteAuthBackend key vending response provider mismatch for "${provider}"`,
      );
    }
    if (vended.sessionId !== sessionId) {
      throw new Error(
        `RemoteAuthBackend key vending response session mismatch for "${sessionId}"`,
      );
    }
    return {
      ...vended,
      apiKey,
    };
  }

  async #requestInferredModel(
    params: AuthInferAgencModelParams,
  ): Promise<AuthInferredAgencModel> {
    const inferred = await this.#modelInferer(params);
    return normalizeRemoteAuthModelInference(inferred);
  }

  async #requestSubscriptionTier(
    params: AuthSessionRef,
  ): Promise<AuthSubscriptionTier> {
    const tier = await this.#subscriptionTierResolver(params);
    return normalizeRequiredSubscriptionTier(tier);
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
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: remoteAuthJsonHeaders(token),
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

function createHttpRemoteAuthModelInferer(
  options: RemoteAuthBackendOptions,
): RemoteAuthModelInferer {
  const env = options.env ?? process.env;
  const endpoint =
    trimNonEmpty(options.modelEndpoint) ??
    trimNonEmpty(env[REMOTE_AUTH_MODEL_URL_ENV]) ??
    DEFAULT_REMOTE_AUTH_MODEL_INFERENCE_URL;
  const token =
    trimNonEmpty(options.token) ?? trimNonEmpty(env[REMOTE_AUTH_TOKEN_ENV]);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return async (request) => {
    if (fetchImpl === undefined) {
      throw new Error("RemoteAuthBackend requires fetch for hosted model routing");
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: remoteAuthJsonHeaders(token),
      body: JSON.stringify(compactRemoteAuthModelRequest(request)),
    });
    if (!response.ok) {
      throw new Error(
        `RemoteAuthBackend hosted model routing failed with HTTP ${response.status}`,
      );
    }
    return parseRemoteAuthModelInferenceResponse(await response.json());
  };
}

function createHttpRemoteAuthSubscriptionTierResolver(
  options: RemoteAuthBackendOptions,
): RemoteAuthSubscriptionTierResolver {
  const env = options.env ?? process.env;
  const endpoint =
    trimNonEmpty(options.tierEndpoint) ??
    trimNonEmpty(env[REMOTE_AUTH_TIER_URL_ENV]) ??
    DEFAULT_REMOTE_AUTH_SUBSCRIPTION_TIER_URL;
  const token =
    trimNonEmpty(options.token) ?? trimNonEmpty(env[REMOTE_AUTH_TOKEN_ENV]);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return async (request) => {
    if (fetchImpl === undefined) {
      throw new Error(
        "RemoteAuthBackend requires fetch for remote subscription tier lookup",
      );
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: remoteAuthJsonHeaders(token),
      body: JSON.stringify(compactRemoteAuthSubscriptionTierRequest(request)),
    });
    if (!response.ok) {
      throw new Error(
        `RemoteAuthBackend subscription tier lookup failed with HTTP ${response.status}`,
      );
    }
    return parseRemoteAuthSubscriptionTierResponse(await response.json());
  };
}

function remoteAuthJsonHeaders(
  token: string | undefined,
): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
  };
}

function compactRemoteAuthModelRequest(
  request: AuthInferAgencModelParams,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      provider: request.provider,
      requestedModel: request.requestedModel,
      sessionId: request.sessionId,
      subscriptionTier: request.subscriptionTier,
      metadata: request.metadata,
    }).filter(([, value]) => value !== undefined),
  );
}

function compactRemoteAuthSubscriptionTierRequest(
  request: AuthSessionRef,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      sessionId: request.sessionId,
    }).filter(([, value]) => value !== undefined),
  );
}

function parseRemoteAuthVendKeyResponse(
  value: unknown,
  request: RemoteAuthVendKeyRequest,
): AuthVendedKey {
  if (!value || typeof value !== "object") {
    throw new Error("RemoteAuthBackend key vending returned a non-object response");
  }
  const record = value as Record<string, unknown>;
  if (record.provider !== request.provider) {
    throw new Error(
      `RemoteAuthBackend key vending response provider mismatch for "${request.provider}"`,
    );
  }
  if (record.sessionId !== request.sessionId) {
    throw new Error(
      `RemoteAuthBackend key vending response session mismatch for "${request.sessionId}"`,
    );
  }
  if (typeof record.apiKey !== "string") {
    throw new Error("RemoteAuthBackend key vending response missing apiKey");
  }
  return {
    provider: record.provider,
    sessionId: record.sessionId,
    apiKey: record.apiKey,
    ...(typeof record.expiresAt === "string" && record.expiresAt.length > 0
      ? { expiresAt: record.expiresAt }
      : {}),
  };
}

function parseRemoteAuthModelInferenceResponse(
  value: unknown,
): AuthInferredAgencModel {
  if (!value || typeof value !== "object") {
    throw new Error(
      "RemoteAuthBackend hosted model routing returned a non-object response",
    );
  }
  return normalizeRemoteAuthModelInference(
    value as Partial<AuthInferredAgencModel>,
  );
}

function parseRemoteAuthSubscriptionTierResponse(
  value: unknown,
): AuthSubscriptionTier {
  if (!value || typeof value !== "object") {
    throw new Error(
      "RemoteAuthBackend subscription tier lookup returned a non-object response",
    );
  }
  const record = value as Record<string, unknown>;
  const rawTier =
    typeof record.subscriptionTier === "string"
      ? record.subscriptionTier
      : typeof record.tier === "string"
        ? record.tier
        : undefined;
  return normalizeRequiredSubscriptionTier(rawTier);
}

function normalizeRemoteAuthModelInference(
  value: Partial<AuthInferredAgencModel>,
): AuthInferredAgencModel {
  const provider =
    typeof value.provider === "string" ? trimNonEmpty(value.provider) : undefined;
  if (provider === undefined) {
    throw new Error("RemoteAuthBackend hosted model routing response missing provider");
  }
  const model =
    typeof value.model === "string" ? trimNonEmpty(value.model) : undefined;
  if (model === undefined) {
    throw new Error("RemoteAuthBackend hosted model routing response missing model");
  }
  const subscriptionTier =
    typeof value.subscriptionTier === "string"
      ? normalizeSubscriptionTier(value.subscriptionTier)
      : undefined;
  if (value.subscriptionTier !== undefined && subscriptionTier === undefined) {
    throw new Error(
      "RemoteAuthBackend hosted model routing response has invalid subscriptionTier",
    );
  }
  return {
    ...value,
    provider,
    model,
    ...(subscriptionTier !== undefined ? { subscriptionTier } : {}),
    ...(typeof value.reason === "string" && value.reason.trim().length > 0
      ? { reason: value.reason.trim() }
      : {}),
  };
}

function normalizeSubscriptionTier(
  value: string,
): AuthSubscriptionTier | undefined {
  switch (value.trim()) {
    case "free":
    case "pro":
    case "team":
    case "enterprise":
      return value.trim() as AuthSubscriptionTier;
    default:
      return undefined;
  }
}

function normalizeRequiredSubscriptionTier(
  value: string | undefined,
): AuthSubscriptionTier {
  const tier =
    typeof value === "string" ? normalizeSubscriptionTier(value) : undefined;
  if (tier === undefined) {
    throw new Error(
      "RemoteAuthBackend subscription tier lookup returned an invalid tier",
    );
  }
  return tier;
}

function trimNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function positiveTtlMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : REMOTE_AUTH_KEY_CACHE_TTL_MS;
}

function cacheExpiresAtMs(
  key: AuthVendedKey,
  nowMs: number,
  ttlMs: number,
): number {
  const ttlExpiresAt = nowMs + ttlMs;
  if (key.expiresAt === undefined) return ttlExpiresAt;
  const keyExpiresAt = Date.parse(key.expiresAt);
  return Number.isFinite(keyExpiresAt)
    ? Math.min(ttlExpiresAt, keyExpiresAt)
    : ttlExpiresAt;
}

function remoteProviderKeyCacheKey(
  provider: AuthProviderSlug | string,
  sessionId: AuthSessionId,
): string {
  return `${sessionId}\0${provider}`;
}
