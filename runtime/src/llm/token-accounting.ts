/**
 * Provider-aware token accounting for complete model requests.
 *
 * The service owns the only admission-grade local fallback. Compatibility
 * estimators may call {@link estimateUtf8TokenUnits}, but must never duplicate
 * its UTF-8 conversion or apply safety margins independently per message.
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { LLMContextWindowExceededError } from "./errors.js";
import type { LLMChatOptions, LLMMessage, LLMTool } from "./types.js";
import { prepareMessagesForWire } from "./wire/shared.js";

export const TOKEN_COUNT_CACHE_MAX_ENTRIES = 1_024;
export const TOKEN_COUNT_CACHE_MAX_BYTES = 67_108_864;
export const TOKEN_COUNT_CACHE_TTL_MS = 300_000;
export const MAX_TOKEN_COUNT_SINGLE_FLIGHTS = 64;
export const MAX_TOKEN_COUNT_WAITERS_PER_FLIGHT = 1_024;
export const MAX_TOKEN_COUNT_WAITERS_GLOBAL = 4_096;
export const MAX_TOKEN_COUNT_WAITER_BYTES = 4_194_304;
export const MAX_TOKEN_ACCOUNTING_REQUEST_BYTES = 16_777_216;
export const TOKEN_COUNT_PROVIDER_TIMEOUT_MS = 5_000;
export const TOKEN_ACCOUNTING_METRICS_MAX_PARTITIONS = 4_096;
export const TOKEN_FALLBACK_MARGIN_RATIO = 0.1;
export const TOKEN_FALLBACK_MARGIN_TOKENS = 256;

export const TOKEN_ACCOUNTING_CALIBRATION_VERSION =
  "token-accounting-fallback-v1";
export const TOKEN_ACCOUNTING_REQUEST_VERSION = 1;

const TOKEN_ACCOUNTING_DIGEST_DOMAIN = "agenc-token-accounting-request-v1\0";
const TOKEN_ACCOUNTING_CONFIG_DIGEST_DOMAIN =
  "agenc-token-accounting-config-v1\0";
const TOKEN_ACCOUNTING_DEFAULT_ENDPOINT_PATH = "/";
const TOKEN_ACCOUNTING_DEFAULT_REVISION = "unspecified";
const TOKEN_ACCOUNTING_WAITER_BYTES = 1_024;
const TOKEN_ACCOUNTING_REQUEST_FRAME_TOKENS = 8;
const TOKEN_ACCOUNTING_MESSAGE_FRAME_TOKENS = 8;
const TOKEN_ACCOUNTING_TOOL_FRAME_TOKENS = 16;
const TOKEN_ACCOUNTING_TOOL_CHOICE_FRAME_TOKENS = 8;
const TOKEN_ACCOUNTING_MEDIA_FRAME_TOKENS = 64;
const TOKEN_ACCOUNTING_MINIMUM_INPUT_TOKENS = 1;
const TOKEN_ACCOUNTING_UTF8_WORST_CASE_BYTES_PER_TOKEN = 1;
const TOKEN_ACCOUNTING_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const TOKEN_ACCOUNTING_METRICS_OVERFLOW_MODEL = "other";
const TOKEN_ACCOUNTING_METRICS_OVERFLOW_PROVIDER = "other";
const TOKEN_ACCOUNTING_UNICODE_NORMALIZATION_FORMS = [
  "NFC",
  "NFD",
  "NFKC",
  "NFKD",
] as const;

export type TokenAccountingSource =
  "provider_native" | "local_tokenizer" | "conservative_fallback";

export type TokenAccountingConfidence =
  "exact" | "high" | "conservative" | "unknown";

export type TokenAccountingCacheStatus = "miss" | "hit" | "shared" | "bypass";

export type TokenAccountingComponent =
  | "system"
  | "messages"
  | "tools"
  | "tool_choice"
  | "structured_output"
  | "images"
  | "documents"
  | "provider_framing"
  | "reserved_output";

export type TokenAccountingContentType =
  | "text"
  | "tool_schema"
  | "image_inline"
  | "image_remote"
  | "document_inline"
  | "document_remote"
  | "provider_specific"
  | "unknown";

export interface TokenAccountingCoverage {
  readonly complete: boolean;
  readonly countedComponents: readonly TokenAccountingComponent[];
  readonly contentTypes: readonly TokenAccountingContentType[];
  readonly uncertainComponents: readonly string[];
}

export interface TokenAccountingResult {
  readonly inputTokens: number;
  readonly reservedOutputTokens: number;
  readonly totalTokens: number;
  readonly provider: string;
  readonly model: string;
  readonly source: TokenAccountingSource;
  readonly confidence: TokenAccountingConfidence;
  readonly coverage: TokenAccountingCoverage;
  readonly cacheStatus: TokenAccountingCacheStatus;
  readonly calibrationVersion: string;
  readonly safetyMarginTokens: number;
  readonly admissible: boolean;
}

export interface ProviderNativeTokenCountResult {
  readonly inputTokens: number;
  readonly complete: boolean;
  readonly confidence: "exact" | "high";
  readonly countedComponents: readonly TokenAccountingComponent[];
  readonly contentTypes?: readonly TokenAccountingContentType[];
  readonly modelRevision?: string;
}

export interface ProviderTokenCountCapability {
  readonly capabilityVersion: string;
  readonly adapterRevision: string;
  /** A digest/revision only. It must not contain credentials or raw prompts. */
  readonly configurationRevision: string;
  countTokens(
    request: TokenAccountingRequest,
    signal: AbortSignal,
  ): Promise<ProviderNativeTokenCountResult>;
}

export interface TokenAccountingRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly options: LLMChatOptions;
  readonly providerNativeTools?: readonly Readonly<Record<string, unknown>>[];
  readonly endpointIdentity?: string;
  readonly adapterRevision?: string;
  readonly configurationRevision?: string;
  readonly modelRevision?: string;
  readonly tokenizerRevision?: string;
  readonly endpointCapabilityVersion?: string;
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens: number;
}

export interface CreateTokenAccountingRequestOptions {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly options: LLMChatOptions;
  readonly providerNativeTools?: readonly Readonly<Record<string, unknown>>[];
  readonly endpointIdentity?: string;
  readonly adapterRevision?: string;
  readonly configurationRevision?: string;
  readonly modelRevision?: string;
  readonly tokenizerRevision?: string;
  readonly endpointCapabilityVersion?: string;
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
}

export interface TokenAccountingCountOptions {
  readonly capability?: ProviderTokenCountCapability;
  readonly signal?: AbortSignal;
}

export interface TokenAccountingServiceLimits {
  readonly cacheMaxEntries?: number;
  readonly cacheMaxBytes?: number;
  readonly cacheTtlMs?: number;
  readonly maxSingleFlights?: number;
  readonly maxWaitersPerFlight?: number;
  readonly maxWaitersGlobal?: number;
  readonly maxWaiterBytes?: number;
  readonly maxRequestBytes?: number;
  readonly providerTimeoutMs?: number;
}

export interface TokenAccountingServiceOptions extends TokenAccountingServiceLimits {
  readonly now?: () => number;
}

export interface TokenAccountingDebugState {
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly physicalFlights: number;
  readonly attachableFlights: number;
  readonly abandonedFlights: number;
  readonly waiters: number;
  readonly waiterBytes: number;
}

export interface TokenAccountingMetric {
  readonly provider: string;
  readonly model: string;
  readonly source: TokenAccountingSource;
  readonly contentTypes: readonly TokenAccountingContentType[];
  readonly samples: number;
  readonly estimatedInputTokens: number;
  readonly reportedInputTokens: number;
  readonly undercountSamples: number;
  readonly maximumUndercountTokens: number;
}

interface CacheEntry {
  readonly result: TokenAccountingResult;
  readonly expiresAt: number;
  readonly bytes: number;
}

interface PreparedAccountingRequest {
  readonly request: TokenAccountingRequest;
  readonly digest: string;
  readonly fallback: TokenAccountingResult;
}

interface TokenCountFlight {
  readonly digest: string;
  readonly controller: AbortController;
  readonly deadlineAt: number;
  promise: Promise<TokenAccountingResult>;
  waiters: number;
  waiterBytes: number;
  abandoned: boolean;
  physicallySettled: boolean;
  released: boolean;
}

interface MutableTokenAccountingMetric {
  provider: string;
  model: string;
  source: TokenAccountingSource;
  contentTypes: readonly TokenAccountingContentType[];
  samples: number;
  estimatedInputTokens: number;
  reportedInputTokens: number;
  undercountSamples: number;
  maximumUndercountTokens: number;
}

export class TokenAccountingError extends Error {
  constructor(
    readonly code:
      | "request_too_large"
      | "request_not_canonicalizable"
      | "uncertain_content"
      | "invalid_provider_count",
    message: string,
  ) {
    super(message);
    this.name = "TokenAccountingError";
  }
}

export class TokenAccountingService {
  readonly #now: () => number;
  readonly #cacheMaxEntries: number;
  readonly #cacheMaxBytes: number;
  readonly #cacheTtlMs: number;
  readonly #maxSingleFlights: number;
  readonly #maxWaitersPerFlight: number;
  readonly #maxWaitersGlobal: number;
  readonly #maxWaiterBytes: number;
  readonly #maxRequestBytes: number;
  readonly #providerTimeoutMs: number;

  readonly #cache = new Map<string, CacheEntry>();
  readonly #flights = new Map<string, TokenCountFlight>();
  readonly #abandonedDigests = new Set<string>();
  readonly #metrics = new Map<string, MutableTokenAccountingMetric>();

  #cacheBytes = 0;
  #physicalFlights = 0;
  #waiters = 0;
  #waiterBytes = 0;

  constructor(options: TokenAccountingServiceOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#cacheMaxEntries = positiveLimit(
      options.cacheMaxEntries,
      TOKEN_COUNT_CACHE_MAX_ENTRIES,
    );
    this.#cacheMaxBytes = positiveLimit(
      options.cacheMaxBytes,
      TOKEN_COUNT_CACHE_MAX_BYTES,
    );
    this.#cacheTtlMs = positiveLimit(
      options.cacheTtlMs,
      TOKEN_COUNT_CACHE_TTL_MS,
    );
    this.#maxSingleFlights = positiveLimit(
      options.maxSingleFlights,
      MAX_TOKEN_COUNT_SINGLE_FLIGHTS,
    );
    this.#maxWaitersPerFlight = positiveLimit(
      options.maxWaitersPerFlight,
      MAX_TOKEN_COUNT_WAITERS_PER_FLIGHT,
    );
    this.#maxWaitersGlobal = positiveLimit(
      options.maxWaitersGlobal,
      MAX_TOKEN_COUNT_WAITERS_GLOBAL,
    );
    this.#maxWaiterBytes = positiveLimit(
      options.maxWaiterBytes,
      MAX_TOKEN_COUNT_WAITER_BYTES,
    );
    this.#maxRequestBytes = positiveLimit(
      options.maxRequestBytes,
      MAX_TOKEN_ACCOUNTING_REQUEST_BYTES,
    );
    this.#providerTimeoutMs = positiveLimit(
      options.providerTimeoutMs,
      TOKEN_COUNT_PROVIDER_TIMEOUT_MS,
    );
  }

  async count(
    request: TokenAccountingRequest,
    options: TokenAccountingCountOptions = {},
  ): Promise<TokenAccountingResult> {
    throwIfAborted(options.signal);
    const prepared = prepareAccountingRequest(
      request,
      options.capability,
      this.#maxRequestBytes,
    );
    const capability = options.capability;
    if (capability === undefined) {
      return prepared.fallback;
    }

    const cached = this.#readCache(prepared.digest);
    if (cached !== undefined) {
      return withCacheStatus(cached, "hit");
    }

    let flight = this.#flights.get(prepared.digest);
    let shared = flight !== undefined;
    if (flight === undefined) {
      if (
        this.#physicalFlights >= this.#maxSingleFlights ||
        this.#abandonedDigests.has(prepared.digest) ||
        !this.#canAllocateWaiter(0, 0)
      ) {
        return withCacheStatus(prepared.fallback, "bypass");
      }
      flight = this.#startFlight(prepared, capability);
      shared = false;
    }

    if (!this.#canAttachWaiter(flight)) {
      return withCacheStatus(prepared.fallback, "bypass");
    }
    return this.#awaitFlight(flight, prepared.fallback, options.signal, shared);
  }

  recordProviderUsage(
    result: TokenAccountingResult,
    reportedInputTokens: number,
  ): void {
    if (!isNonNegativeSafeInteger(reportedInputTokens)) return;
    const contentTypes = [...result.coverage.contentTypes].sort();
    let key = stableStringify({
      provider: result.provider,
      model: result.model,
      source: result.source,
      contentTypes,
    });
    let provider = result.provider;
    let model = result.model;
    let metricContentTypes: readonly TokenAccountingContentType[] =
      contentTypes;
    if (
      !this.#metrics.has(key) &&
      this.#metrics.size >= TOKEN_ACCOUNTING_METRICS_MAX_PARTITIONS
    ) {
      provider = TOKEN_ACCOUNTING_METRICS_OVERFLOW_PROVIDER;
      model = TOKEN_ACCOUNTING_METRICS_OVERFLOW_MODEL;
      metricContentTypes = ["unknown"];
      key = stableStringify({
        provider,
        model,
        source: result.source,
        contentTypes: metricContentTypes,
      });
      if (!this.#metrics.has(key)) {
        const oldestKey = this.#metrics.keys().next().value as
          string | undefined;
        if (oldestKey !== undefined) this.#metrics.delete(oldestKey);
      }
    }
    const metric = this.#metrics.get(key) ?? {
      provider,
      model,
      source: result.source,
      contentTypes: metricContentTypes,
      samples: 0,
      estimatedInputTokens: 0,
      reportedInputTokens: 0,
      undercountSamples: 0,
      maximumUndercountTokens: 0,
    };
    metric.samples = safeTokenSum(metric.samples, 1);
    metric.estimatedInputTokens = safeTokenSum(
      metric.estimatedInputTokens,
      result.inputTokens,
    );
    metric.reportedInputTokens = safeTokenSum(
      metric.reportedInputTokens,
      reportedInputTokens,
    );
    const undercount = Math.max(0, reportedInputTokens - result.inputTokens);
    if (undercount > 0) {
      metric.undercountSamples = safeTokenSum(metric.undercountSamples, 1);
      metric.maximumUndercountTokens = Math.max(
        metric.maximumUndercountTokens,
        undercount,
      );
    }
    this.#metrics.set(key, metric);
  }

  metricsSnapshot(): readonly TokenAccountingMetric[] {
    return [...this.#metrics.values()]
      .map((metric) => ({ ...metric, contentTypes: [...metric.contentTypes] }))
      .sort((left, right) =>
        `${left.provider}\0${left.model}\0${left.source}`.localeCompare(
          `${right.provider}\0${right.model}\0${right.source}`,
        ),
      );
  }

  debugState(): TokenAccountingDebugState {
    return {
      cacheEntries: this.#cache.size,
      cacheBytes: this.#cacheBytes,
      physicalFlights: this.#physicalFlights,
      attachableFlights: this.#flights.size,
      abandonedFlights: this.#abandonedDigests.size,
      waiters: this.#waiters,
      waiterBytes: this.#waiterBytes,
    };
  }

  clear(): void {
    this.#cache.clear();
    this.#cacheBytes = 0;
    this.#metrics.clear();
  }

  #readCache(digest: string): TokenAccountingResult | undefined {
    const entry = this.#cache.get(digest);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#deleteCacheEntry(digest, entry);
      return undefined;
    }
    this.#cache.delete(digest);
    this.#cache.set(digest, entry);
    return entry.result;
  }

  #writeCache(digest: string, result: TokenAccountingResult): void {
    const cacheResult = withCacheStatus(result, "miss");
    const bytes = utf8Length(digest) + utf8Length(stableStringify(cacheResult));
    if (bytes > this.#cacheMaxBytes) return;

    const existing = this.#cache.get(digest);
    if (existing !== undefined) this.#deleteCacheEntry(digest, existing);
    const entry: CacheEntry = {
      result: cacheResult,
      expiresAt: this.#now() + this.#cacheTtlMs,
      bytes,
    };
    this.#cache.set(digest, entry);
    this.#cacheBytes += bytes;
    while (
      this.#cache.size > this.#cacheMaxEntries ||
      this.#cacheBytes > this.#cacheMaxBytes
    ) {
      const oldest = this.#cache.entries().next().value as
        [string, CacheEntry] | undefined;
      if (oldest === undefined) break;
      this.#deleteCacheEntry(oldest[0], oldest[1]);
    }
  }

  #deleteCacheEntry(digest: string, entry: CacheEntry): void {
    if (!this.#cache.delete(digest)) return;
    this.#cacheBytes = Math.max(0, this.#cacheBytes - entry.bytes);
  }

  #startFlight(
    prepared: PreparedAccountingRequest,
    capability: ProviderTokenCountCapability,
  ): TokenCountFlight {
    const { request, digest, fallback } = prepared;
    const controller = new AbortController();
    const flight: TokenCountFlight = {
      digest,
      controller,
      deadlineAt: this.#now() + this.#providerTimeoutMs,
      promise: Promise.resolve(fallback),
      waiters: 0,
      waiterBytes: 0,
      abandoned: false,
      physicallySettled: false,
      released: false,
    };

    this.#physicalFlights += 1;
    this.#flights.set(digest, flight);
    const physicalPromise = invokeProviderTokenCount(
      capability,
      request,
      controller.signal,
    );
    flight.promise = physicalPromise
      .then((nativeResult) => resultFromNativeCount(fallback, nativeResult))
      .then((result) => {
        if (
          !flight.abandoned &&
          flight.waiters > 0 &&
          result.source === "provider_native"
        ) {
          this.#writeCache(digest, result);
        }
        return result;
      })
      .finally(() => {
        flight.physicallySettled = true;
        this.#releaseFlight(flight);
      });
    void flight.promise.catch(() => {});
    return flight;
  }

  #releaseFlight(flight: TokenCountFlight): void {
    if (flight.released) return;
    flight.released = true;
    this.#physicalFlights = Math.max(0, this.#physicalFlights - 1);
    if (this.#flights.get(flight.digest) === flight) {
      this.#flights.delete(flight.digest);
    }
    this.#abandonedDigests.delete(flight.digest);
  }

  #canAttachWaiter(flight: TokenCountFlight): boolean {
    return (
      !flight.abandoned &&
      this.#canAllocateWaiter(flight.waiters, flight.waiterBytes)
    );
  }

  #canAllocateWaiter(
    flightWaiters: number,
    flightWaiterBytes: number,
  ): boolean {
    return (
      flightWaiters < this.#maxWaitersPerFlight &&
      this.#waiters < this.#maxWaitersGlobal &&
      flightWaiterBytes + TOKEN_ACCOUNTING_WAITER_BYTES <=
        this.#maxWaiterBytes &&
      this.#waiterBytes + TOKEN_ACCOUNTING_WAITER_BYTES <= this.#maxWaiterBytes
    );
  }

  #awaitFlight(
    flight: TokenCountFlight,
    fallback: TokenAccountingResult,
    signal: AbortSignal | undefined,
    shared: boolean,
  ): Promise<TokenAccountingResult> {
    flight.waiters += 1;
    flight.waiterBytes += TOKEN_ACCOUNTING_WAITER_BYTES;
    this.#waiters += 1;
    this.#waiterBytes += TOKEN_ACCOUNTING_WAITER_BYTES;

    return new Promise<TokenAccountingResult>((resolve, reject) => {
      let settled = false;
      const remainingMs = Math.max(0, flight.deadlineAt - this.#now());
      const timer = setTimeout(() => {
        finish(() => resolve(withCacheStatus(fallback, "bypass")));
      }, remainingMs);
      timer.unref?.();

      const onAbort = () => {
        finish(() => reject(abortReason(signal?.reason)));
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#detachWaiter(flight);
        complete();
      };

      flight.promise.then(
        (result) =>
          finish(() =>
            resolve(withCacheStatus(result, shared ? "shared" : "miss")),
          ),
        () => finish(() => resolve(withCacheStatus(fallback, "bypass"))),
      );

      if (signal?.aborted === true) onAbort();
    });
  }

  #detachWaiter(flight: TokenCountFlight): void {
    flight.waiters = Math.max(0, flight.waiters - 1);
    flight.waiterBytes = Math.max(
      0,
      flight.waiterBytes - TOKEN_ACCOUNTING_WAITER_BYTES,
    );
    this.#waiters = Math.max(0, this.#waiters - 1);
    this.#waiterBytes = Math.max(
      0,
      this.#waiterBytes - TOKEN_ACCOUNTING_WAITER_BYTES,
    );
    if (
      flight.waiters === 0 &&
      !flight.physicallySettled &&
      !flight.abandoned
    ) {
      flight.abandoned = true;
      this.#abandonedDigests.add(flight.digest);
      if (this.#flights.get(flight.digest) === flight) {
        this.#flights.delete(flight.digest);
      }
      flight.controller.abort(
        new Error("token count abandoned after its last waiter detached"),
      );
    }
  }
}

export const tokenAccountingService = new TokenAccountingService();

export function createTokenAccountingRequest(
  input: CreateTokenAccountingRequestOptions,
): TokenAccountingRequest {
  const reservedOutputTokens = nonNegativeInteger(
    input.reservedOutputTokens ?? input.options.maxOutputTokens ?? 0,
  );
  const contextWindowTokens = optionalPositiveInteger(
    input.contextWindowTokens ?? input.options.contextWindowTokens,
  );
  return {
    provider: normalizeIdentityPart(input.provider, "unknown"),
    // Model identifiers are opaque and may be case-sensitive at custom/local
    // endpoints. Trim them, but never case-fold cache or wire identity.
    model: normalizeOpaqueIdentityPart(input.model, "unknown"),
    // Preserve authenticated runtime metadata until the service takes its
    // immutable snapshot. prepareAccountingRequest performs the one wire
    // projection used for hashing/provider counting; projecting here as well
    // would strip invocation metadata and make the second validation mistake
    // the authenticated channel JSON for an unbound payload.
    messages: input.messages,
    options: input.options,
    ...(input.providerNativeTools !== undefined
      ? { providerNativeTools: input.providerNativeTools }
      : {}),
    ...(input.endpointIdentity !== undefined
      ? { endpointIdentity: input.endpointIdentity }
      : {}),
    ...(input.adapterRevision !== undefined
      ? { adapterRevision: input.adapterRevision }
      : {}),
    ...(input.configurationRevision !== undefined
      ? { configurationRevision: input.configurationRevision }
      : {}),
    ...(input.modelRevision !== undefined
      ? { modelRevision: input.modelRevision }
      : {}),
    ...(input.tokenizerRevision !== undefined
      ? { tokenizerRevision: input.tokenizerRevision }
      : {}),
    ...(input.endpointCapabilityVersion !== undefined
      ? { endpointCapabilityVersion: input.endpointCapabilityVersion }
      : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    reservedOutputTokens,
  };
}

export function estimateTokenAccountingRequest(
  request: TokenAccountingRequest,
): TokenAccountingResult {
  return prepareAccountingRequest(
    request,
    undefined,
    MAX_TOKEN_ACCOUNTING_REQUEST_BYTES,
  ).fallback;
}

export function requireAdmissibleTokenAccounting(
  result: TokenAccountingResult,
): TokenAccountingResult {
  if (result.admissible) return result;
  const uncertainty = result.coverage.uncertainComponents.join(", ");
  throw new TokenAccountingError(
    "uncertain_content",
    `token accounting cannot safely bound request content: ${uncertainty || "unknown component"}`,
  );
}

export function assertTokenAccountingWithinContext(
  result: TokenAccountingResult,
  contextWindowTokens: number,
): void {
  const normalizedWindow = optionalPositiveInteger(contextWindowTokens);
  if (normalizedWindow === undefined) {
    throw new TokenAccountingError(
      "uncertain_content",
      "token accounting requires a positive context window at inference admission",
    );
  }
  if (result.totalTokens <= normalizedWindow) return;
  throw new LLMContextWindowExceededError(
    result.provider,
    `accounted input (${result.inputTokens}) plus reserved output (${result.reservedOutputTokens}) exceeds context window (${normalizedWindow})`,
    {
      effectiveTokens: result.totalTokens,
      maxTokens: normalizedWindow,
    },
  );
}

export function canonicalTokenEndpointIdentity(
  endpoint: string | undefined,
  provider: string,
): string {
  const fallback = `${normalizeIdentityPart(provider, "unknown")}://${TOKEN_ACCOUNTING_DEFAULT_ENDPOINT_PATH}`;
  const raw = endpoint?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const path = normalizeEndpointPath(url.pathname);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
  } catch {
    // Non-URL endpoint syntaxes still need isolation. Hash the opaque value so
    // credentials or private paths cannot escape through diagnostics.
    const opaqueDigest = createHash("sha256")
      .update(TOKEN_ACCOUNTING_DIGEST_DOMAIN)
      .update(normalizeIdentityPart(provider, "unknown"), "utf8")
      .update("\0")
      .update(raw, "utf8")
      .digest("hex");
    return `opaque://${opaqueDigest}`;
  }
}

export function createTokenAccountingConfigurationRevision(
  value: unknown,
): string {
  return createHash("sha256")
    .update(TOKEN_ACCOUNTING_CONFIG_DIGEST_DOMAIN)
    .update(stableStringify(value), "utf8")
    .digest("hex");
}

/** UTF-8-aware whole-value estimate used by legacy display/budget adapters. */
export function estimateUtf8TokenUnits(
  value: string,
  bytesPerToken: number,
): number {
  const divisor =
    Number.isFinite(bytesPerToken) && bytesPerToken > 0
      ? bytesPerToken
      : TOKEN_ACCOUNTING_UTF8_WORST_CASE_BYTES_PER_TOKEN;
  return Math.ceil(normalizedUtf8UpperBound(value) / divisor);
}

function prepareAccountingRequest(
  request: TokenAccountingRequest,
  capability: ProviderTokenCountCapability | undefined,
  maxRequestBytes: number,
): PreparedAccountingRequest {
  let snapshot: TokenAccountingRequest;
  let promptIdentity: Readonly<Record<string, unknown>>;
  let cacheIdentity: Readonly<Record<string, unknown>>;
  let serializedCacheIdentity: string;
  try {
    snapshot = snapshotAccountingRequest(request);
    promptIdentity = promptIdentityForRequest(snapshot);
    cacheIdentity = cacheIdentityForRequest(
      snapshot,
      promptIdentity,
      capability,
    );
    serializedCacheIdentity = stableStringify(cacheIdentity);
  } catch (error) {
    throw new TokenAccountingError(
      "request_not_canonicalizable",
      `token accounting request is not canonicalizable: ${errorMessage(error)}`,
    );
  }
  const requestBytes = utf8Length(serializedCacheIdentity);
  if (requestBytes > maxRequestBytes) {
    throw new TokenAccountingError(
      "request_too_large",
      `token accounting request is ${requestBytes} bytes; limit is ${maxRequestBytes}`,
    );
  }
  const digest = createHash("sha256")
    .update(TOKEN_ACCOUNTING_DIGEST_DOMAIN)
    .update(serializedCacheIdentity, "utf8")
    .digest("hex");
  return {
    request: snapshot,
    digest,
    fallback: conservativeFallbackResult(snapshot, promptIdentity),
  };
}

function snapshotAccountingRequest(
  request: TokenAccountingRequest,
): TokenAccountingRequest {
  const options = request.options;
  const snapshotOptions: LLMChatOptions = Object.freeze({
    ...options,
    ...(options.stopSequences !== undefined
      ? { stopSequences: canonicalSnapshot(options.stopSequences) }
      : {}),
    ...(options.toolRouting !== undefined
      ? { toolRouting: canonicalSnapshot(options.toolRouting) }
      : {}),
    ...(options.tools !== undefined
      ? { tools: canonicalSnapshot(options.tools) }
      : {}),
    ...(options.toolChoice !== undefined
      ? { toolChoice: canonicalSnapshot(options.toolChoice) }
      : {}),
    ...(options.structuredOutput !== undefined
      ? { structuredOutput: canonicalSnapshot(options.structuredOutput) }
      : {}),
  });
  return Object.freeze({
    ...request,
    // Keep authenticated runtime metadata in the immutable snapshot. Each
    // consumer (cache identity and provider-native counter) performs its own
    // single wire projection from this source; a pre-projected snapshot is not
    // safely projectable again because authority metadata is intentionally
    // stripped at the external boundary.
    messages: canonicalSnapshot(request.messages),
    options: snapshotOptions,
    ...(request.providerNativeTools !== undefined
      ? {
          providerNativeTools: canonicalSnapshot(request.providerNativeTools),
        }
      : {}),
  });
}

function promptIdentityForRequest(
  request: TokenAccountingRequest,
): Readonly<Record<string, unknown>> {
  const options = request.options;
  return {
    version: TOKEN_ACCOUNTING_REQUEST_VERSION,
    system: options.systemPrompt ?? "",
    messages: prepareMessagesForWire(request.messages, options),
    tools: options.tools ?? [],
    providerNativeTools: request.providerNativeTools ?? [],
    toolChoice: options.toolChoice ?? null,
    structuredOutput: options.structuredOutput ?? null,
    providerFraming: {
      model: options.model ?? null,
      parallelToolCalls: options.parallelToolCalls ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
      reasoningSummary: options.reasoningSummary ?? null,
      modelVerbosity: options.modelVerbosity ?? null,
      serviceTier: options.serviceTier ?? null,
      stopSequences: options.stopSequences ?? [],
      temperature: options.temperature ?? null,
      includeEncryptedReasoning: options.includeEncryptedReasoning ?? false,
      maxTurns: options.maxTurns ?? null,
      promptCacheKey: options.promptCacheKey ?? null,
      skipCacheWrite: options.skipCacheWrite ?? false,
      toolRouting: options.toolRouting ?? null,
    },
  };
}

function cacheIdentityForRequest(
  request: TokenAccountingRequest,
  promptIdentity: Readonly<Record<string, unknown>>,
  capability: ProviderTokenCountCapability | undefined,
): Readonly<Record<string, unknown>> {
  return {
    domain: TOKEN_ACCOUNTING_DIGEST_DOMAIN,
    provider: request.provider,
    model: request.model,
    prompt: promptIdentity,
    endpoint: canonicalTokenEndpointIdentity(
      request.endpointIdentity,
      request.provider,
    ),
    adapterRevision:
      capability?.adapterRevision ??
      request.adapterRevision ??
      TOKEN_ACCOUNTING_DEFAULT_REVISION,
    configurationRevision:
      capability?.configurationRevision ??
      request.configurationRevision ??
      TOKEN_ACCOUNTING_DEFAULT_REVISION,
    modelRevision: request.modelRevision ?? TOKEN_ACCOUNTING_DEFAULT_REVISION,
    tokenizerRevision:
      request.tokenizerRevision ?? TOKEN_ACCOUNTING_DEFAULT_REVISION,
    endpointCapabilityVersion:
      capability?.capabilityVersion ??
      request.endpointCapabilityVersion ??
      TOKEN_ACCOUNTING_DEFAULT_REVISION,
    contextWindowTokens: request.contextWindowTokens ?? null,
    reservedOutputTokens: request.reservedOutputTokens,
  };
}

function conservativeFallbackResult(
  request: TokenAccountingRequest,
  promptIdentity: Readonly<Record<string, unknown>>,
): TokenAccountingResult {
  const inspection = inspectRequestContent(
    request.messages,
    request.options.tools,
    request.providerNativeTools,
    request.provider,
    request.options.promptCacheKey,
  );
  const promptBytes = normalizedUtf8UpperBound(stableStringify(promptIdentity));
  const frameTokens =
    TOKEN_ACCOUNTING_REQUEST_FRAME_TOKENS +
    request.messages.length * TOKEN_ACCOUNTING_MESSAGE_FRAME_TOKENS +
    ((request.options.tools?.length ?? 0) +
      (request.providerNativeTools?.length ?? 0)) *
      TOKEN_ACCOUNTING_TOOL_FRAME_TOKENS +
    (request.options.toolChoice === undefined
      ? 0
      : TOKEN_ACCOUNTING_TOOL_CHOICE_FRAME_TOKENS) +
    inspection.mediaCount * TOKEN_ACCOUNTING_MEDIA_FRAME_TOKENS;
  const beforeMargin = safeTokenSum(promptBytes, frameTokens);
  const safetyMarginTokens = safetyMarginForTokens(beforeMargin);
  const inputTokens = Math.max(
    TOKEN_ACCOUNTING_MINIMUM_INPUT_TOKENS,
    safeTokenSum(beforeMargin, safetyMarginTokens),
  );
  const complete = inspection.uncertainComponents.length === 0;
  const countedComponents = componentSetForRequest(request, inspection);
  return {
    inputTokens,
    reservedOutputTokens: request.reservedOutputTokens,
    totalTokens: safeTokenSum(inputTokens, request.reservedOutputTokens),
    provider: request.provider,
    model: request.model,
    source: "conservative_fallback",
    confidence: complete ? "conservative" : "unknown",
    coverage: {
      complete,
      countedComponents,
      contentTypes: inspection.contentTypes,
      uncertainComponents: inspection.uncertainComponents,
    },
    cacheStatus: "bypass",
    calibrationVersion: TOKEN_ACCOUNTING_CALIBRATION_VERSION,
    safetyMarginTokens,
    admissible: complete,
  };
}

function resultFromNativeCount(
  fallback: TokenAccountingResult,
  native: ProviderNativeTokenCountResult,
): TokenAccountingResult {
  if (!isNonNegativeSafeInteger(native.inputTokens)) {
    throw new TokenAccountingError(
      "invalid_provider_count",
      "provider token counter returned an invalid input token count",
    );
  }
  if (native.inputTokens === 0) {
    // A complete inference request still has provider/message framing. Treat a
    // zero response as unusable instead of allowing a zero-token admission.
    return fallback;
  }
  if (!native.complete) {
    const inputTokens = Math.max(fallback.inputTokens, native.inputTokens);
    return {
      ...fallback,
      inputTokens,
      totalTokens: safeTokenSum(inputTokens, fallback.reservedOutputTokens),
      coverage: {
        ...fallback.coverage,
        countedComponents: sortedUnique([
          ...fallback.coverage.countedComponents,
          ...native.countedComponents,
        ]),
        contentTypes: sortedUnique([
          ...fallback.coverage.contentTypes,
          ...(native.contentTypes ?? []),
        ]),
      },
      cacheStatus: "miss",
    };
  }
  const safetyMarginTokens =
    native.confidence === "high"
      ? safetyMarginForTokens(native.inputTokens)
      : 0;
  const inputTokens = safeTokenSum(native.inputTokens, safetyMarginTokens);
  return {
    inputTokens,
    reservedOutputTokens: fallback.reservedOutputTokens,
    totalTokens: safeTokenSum(inputTokens, fallback.reservedOutputTokens),
    provider: fallback.provider,
    model: fallback.model,
    source: "provider_native",
    confidence: native.confidence,
    coverage: {
      complete: true,
      countedComponents: sortedUnique([
        ...native.countedComponents,
        "reserved_output",
      ]),
      contentTypes: sortedUnique([
        ...fallback.coverage.contentTypes,
        ...(native.contentTypes ?? []),
      ]),
      uncertainComponents: [],
    },
    cacheStatus: "miss",
    calibrationVersion: TOKEN_ACCOUNTING_CALIBRATION_VERSION,
    safetyMarginTokens,
    admissible: true,
  };
}

function inspectRequestContent(
  messages: readonly LLMMessage[],
  tools: readonly LLMTool[] | undefined,
  providerNativeTools: readonly Readonly<Record<string, unknown>>[] | undefined,
  provider: string,
  promptCacheKey: string | undefined,
): {
  readonly contentTypes: readonly TokenAccountingContentType[];
  readonly uncertainComponents: readonly string[];
  readonly mediaCount: number;
  readonly hasImages: boolean;
  readonly hasDocuments: boolean;
} {
  const contentTypes = new Set<TokenAccountingContentType>();
  const uncertainComponents = new Set<string>();
  let mediaCount = 0;
  let hasImages = false;
  let hasDocuments = false;

  if (
    provider === "gemini" &&
    promptCacheKey?.trim().startsWith("cachedContents/")
  ) {
    contentTypes.add("provider_specific");
    uncertainComponents.add("provider_cached_content");
  }

  if ((tools?.length ?? 0) > 0 || (providerNativeTools?.length ?? 0) > 0) {
    contentTypes.add("tool_schema");
  }
  for (const [toolIndex, tool] of (providerNativeTools ?? []).entries()) {
    if (tool.toolType !== "mcp") continue;
    contentTypes.add("provider_specific");
    uncertainComponents.add(
      `providerNativeTools[${toolIndex}].remote_mcp_catalog`,
    );
  }
  for (const [messageIndex, message] of messages.entries()) {
    if (typeof message.content === "string") {
      contentTypes.add("text");
      continue;
    }
    if (!Array.isArray(message.content)) {
      contentTypes.add("unknown");
      uncertainComponents.add(`messages[${messageIndex}].content`);
      continue;
    }
    for (const [partIndex, part] of message.content.entries()) {
      const providerPart = part as unknown as Record<string, unknown>;
      if (part.type === "text") {
        contentTypes.add("text");
        continue;
      }
      if (part.type === "image_url") {
        hasImages = true;
        mediaCount += 1;
        const url = part.image_url?.url?.trim() ?? "";
        if (isInlineDataUrl(url)) {
          contentTypes.add("image_inline");
        } else {
          contentTypes.add("image_remote");
          uncertainComponents.add(
            `messages[${messageIndex}].content[${partIndex}].image_url`,
          );
        }
        continue;
      }
      if (providerPart.type === "image") {
        hasImages = true;
        mediaCount += 1;
        const source = isPlainRecord(providerPart.source)
          ? providerPart.source
          : {};
        if (source.type === "base64" && typeof source.data === "string") {
          contentTypes.add("image_inline");
        } else {
          contentTypes.add("image_remote");
          uncertainComponents.add(
            `messages[${messageIndex}].content[${partIndex}].image`,
          );
        }
        continue;
      }
      if (part.type === "document") {
        hasDocuments = true;
        mediaCount += 1;
        if (part.source?.type === "base64" && part.source.data.length > 0) {
          contentTypes.add("document_inline");
        } else if (typeof part.fallbackText === "string") {
          contentTypes.add("text");
        } else {
          contentTypes.add("document_remote");
          uncertainComponents.add(
            `messages[${messageIndex}].content[${partIndex}].document`,
          );
        }
        continue;
      }
      contentTypes.add("provider_specific");
      uncertainComponents.add(
        `messages[${messageIndex}].content[${partIndex}].${String((part as { type?: unknown }).type ?? "unknown")}`,
      );
    }
  }
  if (contentTypes.size === 0) contentTypes.add("text");
  return {
    contentTypes: [...contentTypes].sort(),
    uncertainComponents: [...uncertainComponents].sort(),
    mediaCount,
    hasImages,
    hasDocuments,
  };
}

function componentSetForRequest(
  request: TokenAccountingRequest,
  inspection: ReturnType<typeof inspectRequestContent>,
): readonly TokenAccountingComponent[] {
  const components = new Set<TokenAccountingComponent>([
    "system",
    "messages",
    "provider_framing",
    "reserved_output",
  ]);
  if (
    (request.options.tools?.length ?? 0) > 0 ||
    (request.providerNativeTools?.length ?? 0) > 0
  ) {
    components.add("tools");
  }
  if (request.options.toolChoice !== undefined) components.add("tool_choice");
  if (request.options.structuredOutput !== undefined) {
    components.add("structured_output");
  }
  if (inspection.hasImages) components.add("images");
  if (inspection.hasDocuments) components.add("documents");
  return [...components].sort();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

function canonicalSnapshot<T>(value: T): T {
  return freezeCanonicalValue(canonicalize(value, new Set())) as T;
}

function freezeCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  for (const entry of Object.values(value)) freezeCanonicalValue(entry);
  return Object.freeze(value);
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined") return null;
  if (
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    throw new Error(`unsupported ${typeof value} value`);
  }
  if (typeof value !== "object") return String(value);
  if (ancestors.has(value)) throw new Error("cyclic value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry, ancestors));
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key], ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function withCacheStatus(
  result: TokenAccountingResult,
  cacheStatus: TokenAccountingCacheStatus,
): TokenAccountingResult {
  return result.cacheStatus === cacheStatus
    ? result
    : { ...result, cacheStatus };
}

function invokeProviderTokenCount(
  capability: ProviderTokenCountCapability,
  request: TokenAccountingRequest,
  signal: AbortSignal,
): Promise<ProviderNativeTokenCountResult> {
  const countTokens = capability.countTokens.bind(capability);
  return Promise.resolve().then(() => countTokens(request, signal));
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return optionalPositiveInteger(value) ?? fallback;
}

function optionalPositiveInteger(
  value: number | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(TOKEN_ACCOUNTING_MAX_SAFE_INTEGER, Math.floor(value));
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(TOKEN_ACCOUNTING_MAX_SAFE_INTEGER, Math.floor(value));
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeTokenSum(left: number, right: number): number {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= 0
    ? total
    : TOKEN_ACCOUNTING_MAX_SAFE_INTEGER;
}

function safetyMarginForTokens(tokens: number): number {
  return safeTokenSum(
    Math.ceil(tokens * TOKEN_FALLBACK_MARGIN_RATIO),
    TOKEN_FALLBACK_MARGIN_TOKENS,
  );
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedUtf8UpperBound(value: string): number {
  let upperBound = utf8Length(value);
  for (const form of TOKEN_ACCOUNTING_UNICODE_NORMALIZATION_FORMS) {
    upperBound = Math.max(upperBound, utf8Length(value.normalize(form)));
  }
  return upperBound;
}

function normalizeIdentityPart(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeOpaqueIdentityPart(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeEndpointPath(pathname: string): string {
  // Repeated slashes inside a URL path can be semantically significant to a
  // reverse proxy. Preserve them so two distinct endpoints can never share a
  // token-count cache entry; only a trailing slash is canonicalized.
  const trimmed = pathname.replace(/\/+$/u, "");
  return trimmed.length > 0 ? trimmed : TOKEN_ACCOUNTING_DEFAULT_ENDPOINT_PATH;
}

function isInlineDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?;base64,/iu.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw abortReason(signal.reason);
}

function abortReason(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "token accounting aborted",
  );
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort();
}
