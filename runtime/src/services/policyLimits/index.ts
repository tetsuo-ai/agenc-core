/**
 * Policy-limit loading through AgenC's injected auth backend, provider
 * factory state, and runtime home directory. Bootstrap supplies any selected
 * key or AuthBackend; this service does not read provider key environment
 * variables directly.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  AuthBackend,
  AuthSubscriptionTier,
} from "../../auth/backend.js";
import {
  resolveAgencHome,
  type EnvSnapshot,
} from "../../config/env.js";
import { classifyApiError } from "../../llm/api/errors.js";
import { getRetryDelay } from "../../llm/api/retry.js";
import {
  parsePolicyLimitsResponse,
  type PolicyLimitsFetchResult,
  type PolicyLimitsRestrictions,
  type PolicyLimitsResponse,
} from "./types.js";

export type {
  PolicyLimitsFetchResult,
  PolicyLimitsResponse,
  PolicyLimitsRestrictions,
  PolicyRestriction,
} from "./types.js";

const POLICY_LIMITS_CACHE_FILENAME = "policy-limits.json" as const;
const DEFAULT_POLICY_LIMITS_ENDPOINT =
  "https://id.agenc.ag/v1/policy-limits" as const;
const POLICY_LIMITS_ENDPOINT_ENV = "AGENC_POLICY_LIMITS_URL" as const;
const DEFAULT_POLICY_LIMITS_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_POLICY_LIMITS_MAX_RETRIES = 5;
const DEFAULT_POLICY_LIMITS_POLLING_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_POLICY_LIMITS_LOADING_TIMEOUT_MS = 30_000;
const POLICY_ALLOW_PRODUCT_FEEDBACK = "allow_product_feedback" as const;

const ESSENTIAL_TRAFFIC_DENY_ON_MISS = new Set<string>([
  POLICY_ALLOW_PRODUCT_FEEDBACK,
]);
type PolicyLimitsSubscriptionTier = AuthSubscriptionTier | "c4e";

type TimerHandle = ReturnType<typeof setInterval> & {
  unref?: () => void;
};

interface PolicyLimitsAuthHeaders {
  readonly headers: Record<string, string>;
  readonly error?: string;
}

export interface PolicyLimitsServiceOptions {
  readonly agencHome?: string;
  readonly authBackend?: AuthBackend;
  readonly authSubscriptionTier?: PolicyLimitsSubscriptionTier;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly endpoint?: string;
  readonly env?: EnvSnapshot;
  readonly essentialTrafficOnly?: boolean | (() => boolean);
  readonly fetchImpl?: typeof fetch;
  readonly loadingTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly pollingIntervalMs?: number;
  readonly providerName?: string;
  readonly requestTimeoutMs?: number;
  readonly sessionId?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly userAgent?: string;
}

export class PolicyLimitsService {
  readonly #agencHome: string;
  readonly #apiKey: string | undefined;
  readonly #authBackend: AuthBackend | undefined;
  readonly #baseURL: string | undefined;
  readonly #endpoint: string;
  readonly #env: EnvSnapshot;
  readonly #essentialTrafficOnly: boolean | (() => boolean);
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #loadingTimeoutMs: number;
  readonly #maxRetries: number;
  readonly #pollingIntervalMs: number;
  readonly #providerName: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #sessionId: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent: string;

  #loadingCompletePromise: Promise<void> | null = null;
  #loadingCompleteResolve: (() => void) | null = null;
  #pollingIntervalId: TimerHandle | null = null;
  #sessionCache: PolicyLimitsRestrictions | null = null;
  #subscriptionTier: PolicyLimitsSubscriptionTier | undefined;

  constructor(options: PolicyLimitsServiceOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#agencHome = options.agencHome ?? resolveAgencHome(this.#env);
    this.#apiKey = trimNonEmpty(options.apiKey);
    this.#authBackend = options.authBackend;
    this.#baseURL = trimNonEmpty(options.baseURL);
    this.#endpoint = resolvePolicyLimitsEndpoint({
      endpoint:
        trimNonEmpty(options.endpoint) ??
        trimNonEmpty(this.#env[POLICY_LIMITS_ENDPOINT_ENV]) ??
        DEFAULT_POLICY_LIMITS_ENDPOINT,
      allowInjectedNonAgenCEndpoint:
        trimNonEmpty(options.endpoint) !== undefined &&
        options.fetchImpl !== undefined,
    });
    this.#essentialTrafficOnly = options.essentialTrafficOnly ?? (() =>
      envFlag(this.#env.AGENC_ESSENTIAL_TRAFFIC_ONLY));
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.#loadingTimeoutMs = positiveMs(
      options.loadingTimeoutMs,
      DEFAULT_POLICY_LIMITS_LOADING_TIMEOUT_MS,
    );
    this.#maxRetries = positiveInteger(
      options.maxRetries,
      DEFAULT_POLICY_LIMITS_MAX_RETRIES,
    );
    this.#pollingIntervalMs = positiveMs(
      options.pollingIntervalMs,
      DEFAULT_POLICY_LIMITS_POLLING_INTERVAL_MS,
    );
    this.#providerName = trimNonEmpty(options.providerName);
    this.#requestTimeoutMs = positiveMs(
      options.requestTimeoutMs,
      DEFAULT_POLICY_LIMITS_FETCH_TIMEOUT_MS,
    );
    this.#sessionId = trimNonEmpty(options.sessionId) ?? "default";
    this.#sleep = options.sleep ?? sleepMs;
    this.#subscriptionTier = options.authSubscriptionTier;
    this.#userAgent = trimNonEmpty(options.userAgent) ?? "agenc-runtime";
  }

  cachePath(): string {
    return join(this.#agencHome, POLICY_LIMITS_CACHE_FILENAME);
  }

  isPolicyLimitsEligible(): boolean {
    if (!this.#isFirstPartyProvider()) return false;
    if (this.#apiKey !== undefined) return true;
    if (this.#authBackend?.kind === "remote") {
      return isEligibleSubscriptionTier(this.#subscriptionTier);
    }
    return false;
  }

  initializePolicyLimitsLoadingPromise(): void {
    if (this.#loadingCompletePromise !== null) return;
    if (!this.#isFirstPartyProvider()) return;

    this.#loadingCompletePromise = new Promise((resolve) => {
      this.#loadingCompleteResolve = resolve;
      const timeout = setTimeout(() => {
        this.#resolveLoadingComplete();
      }, this.#loadingTimeoutMs);
      timeout.unref?.();
    });
  }

  async waitForPolicyLimitsToLoad(): Promise<void> {
    if (this.#loadingCompletePromise !== null) {
      await this.#loadingCompletePromise;
    }
  }

  async loadPolicyLimits(): Promise<void> {
    if (this.#loadingCompletePromise === null && this.#isFirstPartyProvider()) {
      this.#loadingCompletePromise = new Promise((resolve) => {
        this.#loadingCompleteResolve = resolve;
      });
    }

    try {
      await this.#fetchAndLoadPolicyLimits();
      if (await this.#canFetchPolicyLimits()) {
        this.startBackgroundPolling();
      }
    } finally {
      this.#resolveLoadingComplete();
    }
  }

  async refreshPolicyLimits(): Promise<void> {
    await this.clearPolicyLimitsCache();
    await this.#fetchAndLoadPolicyLimits();
  }

  async clearPolicyLimitsCache(): Promise<void> {
    this.stopBackgroundPolling();
    this.#sessionCache = null;
    this.#loadingCompletePromise = null;
    this.#loadingCompleteResolve = null;
    await rm(this.cachePath(), { force: true }).catch(() => {});
  }

  isPolicyAllowed(policy: string): boolean {
    const restrictions = this.#getRestrictionsFromCache();
    if (restrictions === null) {
      if (this.#isEssentialTrafficOnly() && ESSENTIAL_TRAFFIC_DENY_ON_MISS.has(policy)) {
        return false;
      }
      return true;
    }

    if (!hasOwn(restrictions, policy)) return true;
    return restrictions[policy]!.allowed;
  }

  async pollPolicyLimits(): Promise<void> {
    if (!(await this.#canFetchPolicyLimits())) return;
    try {
      await this.#fetchAndLoadPolicyLimits();
    } catch {
      // Background polling must never convert a transient API issue into a deny.
    }
  }

  startBackgroundPolling(): void {
    if (this.#pollingIntervalId !== null) return;
    if (!this.isPolicyLimitsEligible()) return;

    const interval = setInterval(() => {
      void this.pollPolicyLimits();
    }, this.#pollingIntervalMs) as TimerHandle;
    interval.unref?.();
    this.#pollingIntervalId = interval;
  }

  stopBackgroundPolling(): void {
    if (this.#pollingIntervalId === null) return;
    clearInterval(this.#pollingIntervalId);
    this.#pollingIntervalId = null;
  }

  _resetForTesting(): void {
    this.stopBackgroundPolling();
    this.#sessionCache = null;
    this.#loadingCompletePromise = null;
    this.#loadingCompleteResolve = null;
    this.#subscriptionTier = undefined;
  }

  async #fetchAndLoadPolicyLimits(): Promise<PolicyLimitsRestrictions | null> {
    if (!(await this.#canFetchPolicyLimits())) return null;

    const cachedRestrictions = this.#loadCachedRestrictions();
    const cachedChecksum =
      cachedRestrictions !== null ? computePolicyLimitsChecksum(cachedRestrictions) : undefined;

    try {
      const result = await this.#fetchWithRetry(cachedChecksum);
      if (!result.success) {
        if (cachedRestrictions !== null) {
          this.#sessionCache = cachedRestrictions;
          return cachedRestrictions;
        }
        return null;
      }

      if (result.restrictions === null && cachedRestrictions !== null) {
        this.#sessionCache = cachedRestrictions;
        return cachedRestrictions;
      }

      const nextRestrictions = result.restrictions ?? {};
      this.#sessionCache = nextRestrictions;

      if (Object.keys(nextRestrictions).length > 0) {
        await this.#saveCachedRestrictions(nextRestrictions).catch(() => {});
      } else {
        await rm(this.cachePath(), { force: true }).catch(() => {});
      }
      return nextRestrictions;
    } catch {
      if (cachedRestrictions !== null) {
        this.#sessionCache = cachedRestrictions;
        return cachedRestrictions;
      }
      return null;
    }
  }

  async #fetchWithRetry(
    cachedChecksum?: string,
  ): Promise<PolicyLimitsFetchResult> {
    let lastResult: PolicyLimitsFetchResult | null = null;
    for (let attempt = 1; attempt <= this.#maxRetries + 1; attempt += 1) {
      lastResult = await this.#fetchPolicyLimits(cachedChecksum);
      if (lastResult.success || lastResult.skipRetry) return lastResult;
      if (attempt > this.#maxRetries) return lastResult;
      await this.#sleep(getRetryDelay(attempt));
    }
    return lastResult ?? { success: false, error: "Policy limits fetch failed" };
  }

  async #fetchPolicyLimits(
    cachedChecksum?: string,
  ): Promise<PolicyLimitsFetchResult> {
    const authHeaders = await this.#resolveAuthHeaders();
    if (authHeaders.error !== undefined) {
      return {
        success: false,
        error: authHeaders.error,
        skipRetry: true,
      };
    }
    if (this.#fetchImpl === undefined) {
      return {
        success: false,
        error: "Policy limits fetch requires fetch support",
        skipRetry: true,
      };
    }

    const headers: Record<string, string> = {
      ...authHeaders.headers,
      "user-agent": this.#userAgent,
      ...(cachedChecksum !== undefined
        ? { "if-none-match": `"${cachedChecksum}"` }
        : {}),
    };

    try {
      const response = await this.#fetchWithTimeout(this.#endpoint, {
        method: "GET",
        headers,
      });

      if (response.status === 304) {
        return {
          success: true,
          restrictions: null,
          etag: cachedChecksum,
        };
      }

      if (response.status === 404) {
        return {
          success: true,
          restrictions: {},
        };
      }

      if (!response.ok) {
        const kind = classifyApiError({
          status: response.status,
          message: `Policy limits request failed with HTTP ${response.status}`,
        });
        return {
          success: false,
          error: `Policy limits request failed with HTTP ${response.status}`,
          skipRetry: kind === "auth_error",
        };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return {
          success: false,
          error: "Invalid policy limits response format",
          skipRetry: true,
        };
      }

      const parsed = parsePolicyLimitsResponse(payload);
      if (parsed === null) {
        return {
          success: false,
          error: "Invalid policy limits response format",
          skipRetry: true,
        };
      }

      return {
        success: true,
        restrictions: parsed.restrictions,
      };
    } catch (error) {
      const kind = classifyApiError(error);
      switch (kind) {
        case "auth_error":
          return {
            success: false,
            error: "Not authorized for policy limits",
            skipRetry: true,
          };
        case "aborted":
        case "api_timeout":
          return { success: false, error: "Policy limits request timeout" };
        case "connection_error":
        case "network_error":
          return { success: false, error: "Cannot connect to policy service" };
        default:
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
      }
    }
  }

  async #fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      return await this.#fetchImpl!(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #resolveAuthHeaders(): Promise<PolicyLimitsAuthHeaders> {
    if (this.#apiKey !== undefined) {
      return { headers: { "x-api-key": this.#apiKey } };
    }

    if (this.#authBackend?.kind !== "remote") {
      return {
        headers: {},
        error: "Authentication required for policy limits",
      };
    }

    const tier = await this.#resolveSubscriptionTier();
    if (!isEligibleSubscriptionTier(tier)) {
      return {
        headers: {},
        error: "Subscription tier is not eligible for policy limits",
      };
    }

    try {
      const key = await this.#authBackend.vendKey(
        this.#providerName ?? "agenc",
        this.#sessionId,
      );
      const apiKey = trimNonEmpty(key.apiKey);
      if (apiKey === undefined) {
        return {
          headers: {},
          error: "Authentication required for policy limits",
        };
      }
      return { headers: { "x-api-key": apiKey } };
    } catch {
      return {
        headers: {},
        error: "Authentication required for policy limits",
      };
    }
  }

  async #resolveSubscriptionTier(): Promise<PolicyLimitsSubscriptionTier | undefined> {
    if (this.#subscriptionTier !== undefined) return this.#subscriptionTier;
    if (this.#authBackend === undefined) return undefined;
    try {
      this.#subscriptionTier = normalizePolicyLimitsSubscriptionTier(
        await this.#authBackend.getSubscriptionTier({
          sessionId: this.#sessionId,
        }),
      );
      return this.#subscriptionTier;
    } catch {
      return undefined;
    }
  }

  async #canFetchPolicyLimits(): Promise<boolean> {
    if (!this.#isFirstPartyProvider()) return false;
    if (this.#apiKey !== undefined) return true;
    if (this.#authBackend?.kind !== "remote") return false;
    return isEligibleSubscriptionTier(await this.#resolveSubscriptionTier());
  }

  #getRestrictionsFromCache(): PolicyLimitsRestrictions | null {
    if (!this.isPolicyLimitsEligible()) return null;
    if (this.#sessionCache !== null) return this.#sessionCache;
    const cachedRestrictions = this.#loadCachedRestrictions();
    if (cachedRestrictions !== null) {
      this.#sessionCache = cachedRestrictions;
      return cachedRestrictions;
    }
    return null;
  }

  #loadCachedRestrictions(): PolicyLimitsRestrictions | null {
    try {
      const content = readFileSync(this.cachePath(), "utf8");
      return parsePolicyLimitsResponse(JSON.parse(content))?.restrictions ?? null;
    } catch {
      return null;
    }
  }

  async #saveCachedRestrictions(
    restrictions: PolicyLimitsRestrictions,
  ): Promise<void> {
    const path = this.cachePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const data: PolicyLimitsResponse = { restrictions };
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${stablePolicyLimitsStringify(data, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, path);
  }

  #isFirstPartyProvider(): boolean {
    const provider = (this.#providerName ?? "agenc").toLowerCase();
    if (provider !== "agenc" && provider !== "anthropic") return false;
    if (this.#baseURL === undefined) return true;
    return isFirstPartyBaseURL(provider, this.#baseURL);
  }

  #isEssentialTrafficOnly(): boolean {
    return typeof this.#essentialTrafficOnly === "function"
      ? this.#essentialTrafficOnly()
      : this.#essentialTrafficOnly;
  }

  #resolveLoadingComplete(): void {
    if (this.#loadingCompleteResolve === null) return;
    this.#loadingCompleteResolve();
    this.#loadingCompleteResolve = null;
  }
}

let defaultPolicyLimitsService: PolicyLimitsService | null = null;

export function configurePolicyLimitsService(
  options: PolicyLimitsServiceOptions,
): PolicyLimitsService {
  defaultPolicyLimitsService?.stopBackgroundPolling();
  defaultPolicyLimitsService = new PolicyLimitsService(options);
  return defaultPolicyLimitsService;
}

export function createPolicyLimitsService(
  options: PolicyLimitsServiceOptions = {},
): PolicyLimitsService {
  return new PolicyLimitsService(options);
}

function getPolicyLimitsService(): PolicyLimitsService {
  defaultPolicyLimitsService ??= new PolicyLimitsService();
  return defaultPolicyLimitsService;
}

export function initializePolicyLimitsLoadingPromise(): void {
  getPolicyLimitsService().initializePolicyLimitsLoadingPromise();
}

export function isPolicyAllowed(policy: string): boolean {
  return getPolicyLimitsService().isPolicyAllowed(policy);
}

export async function loadPolicyLimits(): Promise<void> {
  await getPolicyLimitsService().loadPolicyLimits();
}

export function startBackgroundPolling(): void {
  getPolicyLimitsService().startBackgroundPolling();
}

export function stopBackgroundPolling(): void {
  getPolicyLimitsService().stopBackgroundPolling();
}
export function computePolicyLimitsChecksum(
  restrictions: PolicyLimitsRestrictions,
): string {
  const normalized = stablePolicyLimitsStringify(restrictions);
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `sha256:${hash}`;
}

export function stablePolicyLimitsStringify(
  value: unknown,
  space?: number,
): string {
  return JSON.stringify(sortKeysDeep(value), null, space) ?? "null";
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      sorted[key] = sortKeysDeep(child);
    }
    return sorted;
  }
  return value;
}

function isEligibleSubscriptionTier(
  tier: PolicyLimitsSubscriptionTier | undefined,
): boolean {
  return tier === "team" || tier === "enterprise" || tier === "c4e";
}

function normalizePolicyLimitsSubscriptionTier(
  tier: AuthSubscriptionTier | string,
): PolicyLimitsSubscriptionTier | undefined {
  const normalized = tier.trim().toLowerCase();
  if (
    normalized === "free" ||
    normalized === "pro" ||
    normalized === "team" ||
    normalized === "enterprise" ||
    normalized === "c4e"
  ) {
    return normalized;
  }
  return undefined;
}

function resolvePolicyLimitsEndpoint(opts: {
  readonly endpoint: string;
  readonly allowInjectedNonAgenCEndpoint: boolean;
}): string {
  if (isAgenCEndpoint(opts.endpoint)) return opts.endpoint;
  return opts.allowInjectedNonAgenCEndpoint && isLoopbackEndpoint(opts.endpoint)
    ? opts.endpoint
    : DEFAULT_POLICY_LIMITS_ENDPOINT;
}

function isAgenCEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isAgenCHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isFirstPartyBaseURL(provider: string, value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (provider === "agenc") {
      return isAgenCHost(hostname);
    }
    return hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

function isAgenCHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "api.agenc.tech" ||
    normalized.endsWith(".agenc.tech") ||
    normalized === "agenc.ag" ||
    normalized.endsWith(".agenc.ag");
}

function hasOwn(
  restrictions: PolicyLimitsRestrictions,
  policy: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(restrictions, policy);
}

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function trimNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 0
    ? value
    : fallback;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
