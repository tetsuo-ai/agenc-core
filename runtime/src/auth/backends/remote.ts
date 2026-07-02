import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AuthBackend,
  AuthIdentity,
  AuthInferAgencModelParams,
  AuthInferredAgencModel,
  AuthLlmUsage,
  AuthLlmUsageAllowance,
  AuthLlmUsageStatus,
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
import {
  resolveAgencHome,
  type EnvSnapshot,
} from "../../config/env.js";

const DEFAULT_REMOTE_AUTH_KEY_VENDING_URL =
  "https://id.agenc.ag/v1/auth/llm-credential" as const;
const DEFAULT_REMOTE_AUTH_LOGIN_START_URL =
  "https://id.agenc.ag/v1/auth/login/start" as const;
const DEFAULT_REMOTE_AUTH_LOGIN_POLL_URL =
  "https://id.agenc.ag/v1/auth/login/poll" as const;
const DEFAULT_REMOTE_AUTH_MODEL_INFERENCE_URL =
  "https://id.agenc.ag/v1/auth/infer-model" as const;
const DEFAULT_REMOTE_AUTH_SUBSCRIPTION_TIER_URL =
  "https://id.agenc.ag/v1/auth/subscription-tier" as const;
const DEFAULT_REMOTE_AUTH_USAGE_URL =
  "https://id.agenc.ag/v1/auth/llm-usage" as const;
const REMOTE_AUTH_MODEL_URL_ENV = "AGENC_REMOTE_AUTH_MODEL_URL" as const;
const REMOTE_AUTH_TIER_URL_ENV = "AGENC_REMOTE_AUTH_TIER_URL" as const;
const REMOTE_AUTH_USAGE_URL_ENV = "AGENC_REMOTE_AUTH_USAGE_URL" as const;
const REMOTE_AUTH_URL_ENV = "AGENC_REMOTE_AUTH_URL" as const;
const REMOTE_AUTH_LOGIN_START_URL_ENV =
  "AGENC_REMOTE_AUTH_LOGIN_START_URL" as const;
const REMOTE_AUTH_LOGIN_POLL_URL_ENV =
  "AGENC_REMOTE_AUTH_LOGIN_POLL_URL" as const;
const REMOTE_AUTH_TOKEN_ENV = "AGENC_REMOTE_AUTH_TOKEN" as const;
const REMOTE_AUTH_STATE_FILENAME = "auth.json" as const;
const REMOTE_AUTH_STATE_VERSION = 1 as const;
const REMOTE_AUTH_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const REMOTE_AUTH_MIN_LOGIN_POLL_INTERVAL_MS = 5_000;

interface RemoteAuthDiskState {
  readonly version: typeof REMOTE_AUTH_STATE_VERSION;
  readonly provider: "remote";
  readonly token: string;
  readonly createdAt: string;
  readonly identity?: AuthIdentity;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly expiresAt?: string;
}

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

export type RemoteAuthLlmUsageResolver = (
  request: AuthSessionRef,
) => AuthLlmUsage | Promise<AuthLlmUsage>;

export interface RemoteAuthLoginRequest extends AuthSessionRef {}

export interface RemoteAuthLoginFlowResult {
  readonly token: string;
  readonly identity?: AuthIdentity;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly expiresAt?: string;
}

export interface RemoteAuthDeviceCodePrompt {
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly expiresAt?: string;
  readonly intervalSeconds?: number;
}

export type RemoteAuthDeviceCodeHandler = (
  prompt: RemoteAuthDeviceCodePrompt,
) => void | Promise<void>;

export type RemoteAuthLoginFlow = (
  request: RemoteAuthLoginRequest,
) => RemoteAuthLoginFlowResult | Promise<RemoteAuthLoginFlowResult>;

export interface RemoteAuthBackendOptions {
  readonly agencHome?: string;
  readonly authFilePath?: string;
  readonly keyVendor?: RemoteAuthKeyVendor;
  readonly loginFlow?: RemoteAuthLoginFlow;
  readonly modelInferer?: RemoteAuthModelInferer;
  readonly onDeviceCode?: RemoteAuthDeviceCodeHandler;
  readonly subscriptionTierResolver?: RemoteAuthSubscriptionTierResolver;
  readonly llmUsageResolver?: RemoteAuthLlmUsageResolver;
  readonly endpoint?: string;
  readonly env?: EnvSnapshot;
  readonly fetchImpl?: typeof fetch;
  readonly keyCacheTtlMs?: number;
  readonly loginPollEndpoint?: string;
  readonly loginStartEndpoint?: string;
  readonly managedKeysEnabled?: boolean;
  readonly modelEndpoint?: string;
  readonly nowMs?: () => number;
  readonly now?: () => Date;
  readonly sleepMs?: (ms: number) => Promise<void>;
  readonly tierEndpoint?: string;
  readonly usageEndpoint?: string;
  readonly token?: string;
}

interface CachedRemoteAuthKey {
  readonly promise: Promise<AuthVendedKey>;
  readonly expiresAtMs: number;
}

export class RemoteAuthBackend implements AuthBackend {
  readonly kind = "remote";

  readonly #authFilePath: string;
  readonly #keyVendor: RemoteAuthKeyVendor;
  readonly #loginFlow: RemoteAuthLoginFlow;
  readonly #modelInferer: RemoteAuthModelInferer;
  readonly #subscriptionTierResolver: RemoteAuthSubscriptionTierResolver;
  readonly #llmUsageResolver: RemoteAuthLlmUsageResolver;
  readonly #managedKeysEnabled: boolean;
  readonly #keyCacheTtlMs: number;
  readonly #now: () => Date;
  readonly #nowMs: () => number;
  readonly #vendedKeys = new Map<string, CachedRemoteAuthKey>();

  constructor(options: RemoteAuthBackendOptions = {}) {
    this.#authFilePath = remoteAuthFilePath(options);
    this.#keyVendor = options.keyVendor ?? createHttpRemoteAuthKeyVendor(options);
    this.#loginFlow = options.loginFlow ?? createHttpRemoteAuthLoginFlow(options);
    this.#modelInferer =
      options.modelInferer ?? createHttpRemoteAuthModelInferer(options);
    this.#subscriptionTierResolver =
      options.subscriptionTierResolver ??
      createHttpRemoteAuthSubscriptionTierResolver(options);
    this.#llmUsageResolver =
      options.llmUsageResolver ?? createHttpRemoteAuthLlmUsageResolver(options);
    this.#managedKeysEnabled = options.managedKeysEnabled === true;
    this.#keyCacheTtlMs = positiveTtlMs(options.keyCacheTtlMs);
    this.#now = options.now ?? (() => new Date());
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  authFile(): string {
    return this.#authFilePath;
  }

  async login(params: AuthLoginParams = {}): Promise<AuthLoginResult> {
    const result = normalizeRemoteAuthLoginResult(
      await this.#loginFlow(params),
    );
    await writeRemoteAuthState(this.#authFilePath, {
      version: REMOTE_AUTH_STATE_VERSION,
      provider: "remote",
      token: result.token,
      createdAt: this.#now().toISOString(),
      ...(result.identity !== undefined ? { identity: result.identity } : {}),
      ...(result.subscriptionTier !== undefined
        ? { subscriptionTier: result.subscriptionTier }
        : {}),
      ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
    });
    this.#vendedKeys.clear();
    return {
      authenticated: true,
      provider: "remote",
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      token: result.token,
      ...(result.identity !== undefined ? { identity: result.identity } : {}),
    };
  }

  async logout(_params: AuthLogoutParams = {}): Promise<AuthLogoutResult> {
    await rm(this.#authFilePath, { force: true });
    this.#vendedKeys.clear();
    return { authenticated: false };
  }

  async whoami(_params: AuthWhoamiParams = {}): Promise<AuthWhoamiResult> {
    const state = await readRemoteAuthState(this.#authFilePath);
    if (state !== null) {
      return {
        authenticated: true,
        provider: "remote",
        ...(state.identity !== undefined ? { identity: state.identity } : {}),
      };
    }
    return { authenticated: false, provider: "remote" };
  }

  vendKey(
    provider: AuthProviderSlug | string,
    sessionId: AuthSessionId,
  ): Promise<AuthVendedKey> {
    if (!this.#managedKeysEnabled) {
      return Promise.reject(
        new Error(
          "RemoteAuthBackend managed key vending is disabled by auth.managedKeys.enabled",
        ),
      );
    }
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

  async getLlmUsage(
    params: AuthSessionRef = {},
  ): Promise<AuthLlmUsage> {
    return this.#requestLlmUsage(params);
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
    const normalized = normalizeRequiredSubscriptionTier(tier);
    const state = await readRemoteAuthState(this.#authFilePath);
    if (state !== null && state.subscriptionTier !== normalized) {
      await writeRemoteAuthState(this.#authFilePath, {
        ...state,
        subscriptionTier: normalized,
      });
    }
    return normalized;
  }

  async #requestLlmUsage(params: AuthSessionRef): Promise<AuthLlmUsage> {
    return normalizeRemoteAuthLlmUsage(await this.#llmUsageResolver(params));
  }
}

function remoteAuthFilePath(options: RemoteAuthBackendOptions): string {
  const agencHome =
    options.agencHome ?? resolveAgencHome(options.env ?? process.env);
  return options.authFilePath ?? join(agencHome, REMOTE_AUTH_STATE_FILENAME);
}

async function resolveRemoteAuthToken(
  options: RemoteAuthBackendOptions,
): Promise<string | undefined> {
  const persisted = (await readRemoteAuthState(remoteAuthFilePath(options)))
    ?.token;
  if (persisted !== undefined) return persisted;
  const env = options.env ?? process.env;
  const explicit = trimNonEmpty(options.token) ??
    trimNonEmpty(env[REMOTE_AUTH_TOKEN_ENV]);
  return explicit;
}

function createHttpRemoteAuthKeyVendor(
  options: RemoteAuthBackendOptions,
): RemoteAuthKeyVendor {
  const env = options.env ?? process.env;
  const endpoint =
    trimNonEmpty(options.endpoint) ??
    trimNonEmpty(env[REMOTE_AUTH_URL_ENV]) ??
    DEFAULT_REMOTE_AUTH_KEY_VENDING_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return async (request) => {
    if (fetchImpl === undefined) {
      throw new Error("RemoteAuthBackend requires fetch for remote key vending");
    }
    const response = await remoteAuthFetch(fetchImpl, endpoint, {
      method: "POST",
      headers: remoteAuthJsonHeaders(await resolveRemoteAuthToken(options)),
      body: JSON.stringify({
        provider: request.provider,
        sessionId: request.sessionId,
      }),
    }, "key vending");
    if (!response.ok) {
      throw new Error(
        `RemoteAuthBackend key vending failed with HTTP ${response.status}`,
      );
    }
    return parseRemoteAuthVendKeyResponse(
      await readRemoteAuthJsonResponse(response, "key vending"),
      request,
    );
  };
}

function createHttpRemoteAuthLoginFlow(
  options: RemoteAuthBackendOptions,
): RemoteAuthLoginFlow {
  const env = options.env ?? process.env;
  const startEndpoint =
    trimNonEmpty(options.loginStartEndpoint) ??
    trimNonEmpty(env[REMOTE_AUTH_LOGIN_START_URL_ENV]) ??
    DEFAULT_REMOTE_AUTH_LOGIN_START_URL;
  const pollEndpoint =
    trimNonEmpty(options.loginPollEndpoint) ??
    trimNonEmpty(env[REMOTE_AUTH_LOGIN_POLL_URL_ENV]) ??
    DEFAULT_REMOTE_AUTH_LOGIN_POLL_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const sleep = options.sleepMs ?? sleepMs;
  return async (request) => {
    if (fetchImpl === undefined) {
      throw new Error("RemoteAuthBackend requires fetch for remote login");
    }
    const startResponse = await remoteAuthFetch(fetchImpl, startEndpoint, {
      method: "POST",
      headers: remoteAuthJsonHeaders(undefined),
      body: JSON.stringify(compactRemoteAuthLoginRequest(request)),
    }, "login start");
    if (!startResponse.ok) {
      throw new Error(
        `RemoteAuthBackend login start failed with HTTP ${startResponse.status}`,
      );
    }
    const started = parseRemoteAuthLoginStartResponse(
      await readRemoteAuthJsonResponse(startResponse, "login start"),
    );
    if ("token" in started) return started;
    await notifyRemoteAuthDeviceCode(options.onDeviceCode, started);

    const expiresAtMs =
      parseExpiresAtMs(started.expiresAt) ??
      Date.now() + (started.expiresInSeconds ?? 10 * 60) * 1000;
    let intervalMs = Math.max(
      REMOTE_AUTH_MIN_LOGIN_POLL_INTERVAL_MS,
      (started.intervalSeconds ?? 2) * 1000,
    );
    while (Date.now() <= expiresAtMs) {
      let pollResponse: Response;
      try {
        pollResponse = await remoteAuthFetch(fetchImpl, pollEndpoint, {
          method: "POST",
          headers: remoteAuthJsonHeaders(undefined),
          body: JSON.stringify({
            deviceCode: started.deviceCode,
            sessionId: request.sessionId,
          }),
        }, "login poll");
      } catch {
        await sleep(intervalMs);
        continue;
      }
      const polled = await readRemoteAuthPollResponse(pollResponse);
      if (pollResponse.status === 202) {
        intervalMs = remoteAuthPollIntervalMs(polled, intervalMs);
        await sleep(intervalMs);
        continue;
      }
      if (!pollResponse.ok) {
        if (isRemoteAuthPendingLoginResponse(polled)) {
          intervalMs = remoteAuthPollIntervalMs(polled, intervalMs);
          await sleep(intervalMs);
          continue;
        }
        if (isRemoteAuthSlowDownLoginResponse(polled)) {
          intervalMs = remoteAuthPollIntervalMs(polled, intervalMs + 5_000);
          await sleep(intervalMs);
          continue;
        }
        if (isRemoteAuthExpiredLoginResponse(polled)) {
          throw new Error("RemoteAuthBackend login device code expired");
        }
        if (isRemoteAuthAccessDeniedLoginResponse(polled)) {
          throw new Error("RemoteAuthBackend login authorization was denied");
        }
        throw new Error(
          `RemoteAuthBackend login poll failed with HTTP ${pollResponse.status}`,
        );
      }
      if (isRemoteAuthPendingLoginResponse(polled)) {
        intervalMs = remoteAuthPollIntervalMs(polled, intervalMs);
        await sleep(intervalMs);
        continue;
      }
      return normalizeRemoteAuthLoginResult(
        polled as Partial<RemoteAuthLoginFlowResult>,
      );
    }
    throw new Error("RemoteAuthBackend login device code expired");
  };
}

async function notifyRemoteAuthDeviceCode(
  onDeviceCode: RemoteAuthDeviceCodeHandler | undefined,
  prompt: RemoteAuthLoginStartDevice,
): Promise<void> {
  if (onDeviceCode === undefined) return;
  await onDeviceCode({
    ...(prompt.verificationUri !== undefined
      ? { verificationUri: prompt.verificationUri }
      : {}),
    ...(prompt.userCode !== undefined ? { userCode: prompt.userCode } : {}),
    ...(prompt.expiresAt !== undefined ? { expiresAt: prompt.expiresAt } : {}),
    ...(prompt.intervalSeconds !== undefined
      ? { intervalSeconds: prompt.intervalSeconds }
      : {}),
  });
}

function createHttpRemoteAuthModelInferer(
  options: RemoteAuthBackendOptions,
): RemoteAuthModelInferer {
  const env = options.env ?? process.env;
  const endpoint =
    trimNonEmpty(options.modelEndpoint) ??
    trimNonEmpty(env[REMOTE_AUTH_MODEL_URL_ENV]) ??
    DEFAULT_REMOTE_AUTH_MODEL_INFERENCE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return async (request) => {
    if (fetchImpl === undefined) {
      throw new Error("RemoteAuthBackend requires fetch for hosted model routing");
    }
    const response = await remoteAuthFetch(fetchImpl, endpoint, {
      method: "POST",
      headers: remoteAuthJsonHeaders(await resolveRemoteAuthToken(options)),
      body: JSON.stringify(compactRemoteAuthModelRequest(request)),
    }, "hosted model routing");
    if (!response.ok) {
      throw new Error(
        `RemoteAuthBackend hosted model routing failed with HTTP ${response.status}`,
      );
    }
    return parseRemoteAuthModelInferenceResponse(
      await readRemoteAuthJsonResponse(response, "hosted model routing"),
    );
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
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return async (request) => {
    if (fetchImpl === undefined) {
      throw new Error(
        "RemoteAuthBackend requires fetch for remote subscription tier lookup",
      );
    }
    const token = await resolveRemoteAuthToken(options);
    if (token === undefined) return "free";
    const response = await remoteAuthFetch(fetchImpl, endpoint, {
      method: "POST",
      headers: remoteAuthJsonHeaders(token),
      body: JSON.stringify(compactRemoteAuthSubscriptionTierRequest(request)),
    }, "subscription tier lookup");
    if (response.status === 401 || response.status === 403) return "free";
    if (!response.ok) {
      throw new Error(
        `RemoteAuthBackend subscription tier lookup failed with HTTP ${response.status}`,
      );
    }
    return parseRemoteAuthSubscriptionTierResponse(
      await readRemoteAuthJsonResponse(response, "subscription tier lookup"),
    );
  };
}

function createHttpRemoteAuthLlmUsageResolver(
  options: RemoteAuthBackendOptions,
): RemoteAuthLlmUsageResolver {
  const env = options.env ?? process.env;
  const endpoint =
    trimNonEmpty(options.usageEndpoint) ??
    trimNonEmpty(env[REMOTE_AUTH_USAGE_URL_ENV]) ??
    DEFAULT_REMOTE_AUTH_USAGE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  return async (request) => {
    if (fetchImpl === undefined) {
      throw new Error("RemoteAuthBackend requires fetch for remote LLM usage");
    }
    const token = await resolveRemoteAuthToken(options);
    if (token === undefined) {
      return freeLlmUsage();
    }
    const response = await remoteAuthFetch(fetchImpl, endpoint, {
      method: "POST",
      headers: remoteAuthJsonHeaders(token),
      body: JSON.stringify(compactRemoteAuthSubscriptionTierRequest(request)),
    }, "LLM usage lookup");
    if (response.status === 401 || response.status === 403) return freeLlmUsage();
    if (!response.ok) {
      throw new Error(
        `RemoteAuthBackend LLM usage lookup failed with HTTP ${response.status}`,
      );
    }
    return parseRemoteAuthLlmUsageResponse(
      await readRemoteAuthJsonResponse(response, "LLM usage lookup"),
    );
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

async function remoteAuthFetch(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (error) {
    throw new Error(
      `RemoteAuthBackend ${operation} network request failed: ${formatRemoteAuthNetworkError(error)}`,
      { cause: error },
    );
  }
}

function formatRemoteAuthNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : undefined;
  return cause !== undefined && !message.includes(cause)
    ? `${message} (${cause})`
    : message;
}

function compactRemoteAuthLoginRequest(
  request: RemoteAuthLoginRequest,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      sessionId: request.sessionId,
    }).filter(([, value]) => value !== undefined),
  );
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
  if (record.provider !== undefined && record.provider !== request.provider) {
    throw new Error(
      `RemoteAuthBackend key vending response provider mismatch for "${request.provider}"`,
    );
  }
  if (record.sessionId !== undefined && record.sessionId !== request.sessionId) {
    throw new Error(
      `RemoteAuthBackend key vending response session mismatch for "${request.sessionId}"`,
    );
  }
  const apiKey = readTrimmedString(record.apiKey ?? record.litellmKey);
  if (apiKey === undefined) {
    throw new Error("RemoteAuthBackend key vending response missing apiKey");
  }
  const baseUrl = readTrimmedString(record.baseUrl ?? record.baseURL);
  return {
    provider: request.provider,
    sessionId: request.sessionId,
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(typeof record.expiresAt === "string" && record.expiresAt.length > 0
      ? { expiresAt: record.expiresAt }
      : {}),
    ...(readTrimmedString(record.secretAccessKey) !== undefined
      ? { secretAccessKey: readTrimmedString(record.secretAccessKey) }
      : {}),
    ...(readTrimmedString(record.sessionToken) !== undefined
      ? { sessionToken: readTrimmedString(record.sessionToken) }
      : {}),
    ...(readTrimmedString(record.region) !== undefined
      ? { region: readTrimmedString(record.region) }
      : {}),
  };
}

interface RemoteAuthLoginStartDevice {
  readonly deviceCode: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly expiresAt?: string;
  readonly expiresInSeconds?: number;
  readonly intervalSeconds?: number;
}

function parseRemoteAuthLoginStartResponse(
  value: unknown,
): RemoteAuthLoginFlowResult | RemoteAuthLoginStartDevice {
  if (!value || typeof value !== "object") {
    throw new Error("RemoteAuthBackend login start returned a non-object response");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.token === "string") {
    return normalizeRemoteAuthLoginResult(
      record as Partial<RemoteAuthLoginFlowResult>,
    );
  }
  const deviceCode = readTrimmedString(record.deviceCode ?? record.device_code);
  if (deviceCode === undefined) {
    throw new Error("RemoteAuthBackend login start response missing deviceCode");
  }
  const expiresInSeconds = readFiniteNumber(
    record.expiresInSeconds ?? record.expires_in,
  );
  const intervalSeconds = readFiniteNumber(
    record.intervalSeconds ?? record.interval,
  );
  return {
    deviceCode,
    ...optionalString("userCode", record.userCode ?? record.user_code),
    ...optionalString(
      "verificationUri",
      record.verificationUri ??
        record.verification_uri_complete ??
        record.verification_uri,
    ),
    ...optionalString("expiresAt", record.expiresAt),
    ...(expiresInSeconds !== undefined
      ? { expiresInSeconds: Math.max(0, expiresInSeconds) }
      : {}),
    ...(intervalSeconds !== undefined
      ? { intervalSeconds: Math.max(0, intervalSeconds) }
      : {}),
  };
}

async function readRemoteAuthPollResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.ok) {
      throw new Error("RemoteAuthBackend login poll returned invalid JSON");
    }
    return undefined;
  }
}

async function readRemoteAuthJsonResponse(
  response: Response,
  operation: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`RemoteAuthBackend ${operation} returned invalid JSON`);
  }
}

function isRemoteAuthPendingLoginResponse(value: unknown): boolean {
  const state = remoteAuthLoginResponseState(value);
  return state === "pending" || state === "authorization_pending";
}

function isRemoteAuthSlowDownLoginResponse(value: unknown): boolean {
  return remoteAuthLoginResponseState(value) === "slow_down";
}

function remoteAuthPollIntervalMs(value: unknown, fallbackMs: number): number {
  const intervalSeconds = remoteAuthLoginResponseIntervalSeconds(value);
  if (intervalSeconds === undefined) return fallbackMs;
  return Math.max(
    REMOTE_AUTH_MIN_LOGIN_POLL_INTERVAL_MS,
    intervalSeconds * 1000,
  );
}

function remoteAuthLoginResponseIntervalSeconds(
  value: unknown,
): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { readonly intervalSeconds?: unknown; readonly interval?: unknown };
  const intervalSeconds = readFiniteNumber(
    record.intervalSeconds ?? record.interval,
  );
  return intervalSeconds === undefined ? undefined : Math.max(0, intervalSeconds);
}

function isRemoteAuthExpiredLoginResponse(value: unknown): boolean {
  return remoteAuthLoginResponseState(value) === "expired_token";
}

function isRemoteAuthAccessDeniedLoginResponse(value: unknown): boolean {
  return remoteAuthLoginResponseState(value) === "access_denied";
}

function remoteAuthLoginResponseState(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { readonly error?: unknown; readonly status?: unknown };
  return typeof record.status === "string"
    ? record.status
    : typeof record.error === "string"
      ? record.error
      : undefined;
}

function normalizeRemoteAuthLoginResult(
  value: Partial<RemoteAuthLoginFlowResult>,
): RemoteAuthLoginFlowResult {
  const token =
    typeof value.token === "string" ? trimNonEmpty(value.token) : undefined;
  if (token === undefined) {
    throw new Error("RemoteAuthBackend login response missing token");
  }
  const subscriptionTier =
    typeof value.subscriptionTier === "string"
      ? normalizeSubscriptionTier(value.subscriptionTier)
      : undefined;
  if (value.subscriptionTier !== undefined && subscriptionTier === undefined) {
    throw new Error("RemoteAuthBackend login response has invalid subscriptionTier");
  }
  return {
    token,
    ...(isAuthIdentity(value.identity) ? { identity: value.identity } : {}),
    ...(subscriptionTier !== undefined ? { subscriptionTier } : {}),
    ...(typeof value.expiresAt === "string" && value.expiresAt.trim().length > 0
      ? { expiresAt: value.expiresAt.trim() }
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

function parseRemoteAuthLlmUsageResponse(value: unknown): AuthLlmUsage {
  if (!value || typeof value !== "object") {
    throw new Error("RemoteAuthBackend LLM usage lookup returned a non-object response");
  }
  return normalizeRemoteAuthLlmUsage(value as Partial<AuthLlmUsage>);
}

function normalizeRemoteAuthLlmUsage(value: Partial<AuthLlmUsage>): AuthLlmUsage {
  const subscriptionTier = typeof value.subscriptionTier === "string"
    ? normalizeSubscriptionTier(value.subscriptionTier)
    : undefined;
  if (subscriptionTier === undefined) {
    throw new Error("RemoteAuthBackend LLM usage response has invalid subscriptionTier");
  }
  const allowance = normalizeRemoteAuthLlmUsageAllowance(value.modelAllowance);
  return {
    managedModelsEnabled: value.managedModelsEnabled === true,
    modelAllowance: allowance,
    subscriptionTier,
  };
}

function normalizeRemoteAuthLlmUsageAllowance(
  value: unknown,
): AuthLlmUsageAllowance {
  if (!value || typeof value !== "object") {
    throw new Error("RemoteAuthBackend LLM usage response missing modelAllowance");
  }
  const record = value as Record<string, unknown>;
  const status = normalizeLlmUsageStatus(record.status);
  const allowedModelCount = readFiniteNumber(record.allowedModelCount);
  const duration = readTrimmedString(record.duration);
  if (status === undefined || allowedModelCount === undefined || duration === undefined) {
    throw new Error("RemoteAuthBackend LLM usage response has invalid modelAllowance");
  }
  return {
    allowedModelCount,
    duration,
    ...(readFiniteNumber(record.includedUsd) !== undefined
      ? { includedUsd: readFiniteNumber(record.includedUsd) }
      : {}),
    ...(readFiniteNumber(record.percentUsed) !== undefined
      ? { percentUsed: readFiniteNumber(record.percentUsed) }
      : {}),
    ...(readFiniteNumber(record.remainingUsd) !== undefined
      ? { remainingUsd: readFiniteNumber(record.remainingUsd) }
      : {}),
    ...(readTrimmedString(record.resetsAt) !== undefined
      ? { resetsAt: readTrimmedString(record.resetsAt) }
      : {}),
    status,
    ...(readFiniteNumber(record.usedUsd) !== undefined
      ? { usedUsd: readFiniteNumber(record.usedUsd) }
      : {}),
  };
}

function normalizeLlmUsageStatus(value: unknown): AuthLlmUsageStatus | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim()) {
    case "free":
    case "pending":
    case "active":
    case "exhausted":
    case "unavailable":
      return value.trim() as AuthLlmUsageStatus;
    default:
      return undefined;
  }
}

function freeLlmUsage(): AuthLlmUsage {
  return {
    managedModelsEnabled: false,
    modelAllowance: {
      allowedModelCount: 0,
      duration: "30d",
      includedUsd: 0,
      percentUsed: 0,
      remainingUsd: 0,
      status: "free",
      usedUsd: 0,
    },
    subscriptionTier: "free",
  };
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
    case "c4e":
      return "enterprise";
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

function isAuthIdentity(value: unknown): value is AuthIdentity {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  const normalized = readTrimmedString(value);
  if (normalized === undefined) return {};
  return { [key]: normalized } as Record<K, string>;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? trimNonEmpty(value) : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function trimNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseExpiresAtMs(expiresAt: string | undefined): number | undefined {
  if (expiresAt === undefined) return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
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

function isRemoteAuthDiskState(value: unknown): value is RemoteAuthDiskState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<RemoteAuthDiskState>;
  return (
    state.version === REMOTE_AUTH_STATE_VERSION &&
    state.provider === "remote" &&
    typeof state.token === "string" &&
    state.token.trim().length > 0 &&
    typeof state.createdAt === "string" &&
    (state.identity === undefined || isAuthIdentity(state.identity)) &&
    (state.subscriptionTier === undefined ||
      normalizeSubscriptionTier(state.subscriptionTier) !== undefined) &&
    (state.expiresAt === undefined || typeof state.expiresAt === "string")
  );
}

async function readRemoteAuthState(
  path: string,
): Promise<RemoteAuthDiskState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRemoteAuthDiskState(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeRemoteAuthState(
  path: string,
  state: RemoteAuthDiskState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}
