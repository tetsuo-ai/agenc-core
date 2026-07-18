/**
 * Turn-scoped provider HTTP session.
 *
 * Ports the upstream runtime provider/session contract into the runtime-facing
 * TypeScript client layer: provider-level query params, auth/header injection,
 * bounded retry budgets, stream idle timeouts, and explicit wire-api metadata.
 *
 * @module
 */

import {
  installStreamWatchdog,
  resolveStreamIdleTimeoutMs,
  STREAM_IDLE_ABORT_REASON,
} from "./stream-watchdog.js";
import {
  prepareResponsesContinuationRequest,
  recordResponsesContinuationResponse,
  type PreparedResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "./shape-request.js";
import {
  LLMCaptivePortalError,
  LLMCertificateError,
  LLMInvalidResponseError,
  extractTlsValidationDetails,
  type TlsValidationDetails,
} from "./errors.js";
import {
  evaluateProviderFallback,
  type ProviderFallbackDecision,
  type ProviderFallbackLadderOptions,
} from "./api/fallback-ladder.js";
import { isFallbackTriggeredError } from "../recovery/api-errors.js";
import { isProviderCapabilityMismatch } from "./capabilities.js";

const DEFAULT_REQUEST_MAX_RETRIES = 4;
const DEFAULT_STREAM_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const MAX_RETRY_AFTER_MS = 300_000;
/**
 * Hard cap on the un-delimited SSE remainder buffered while waiting for a frame
 * separator on the responses-continuation accumulation path. A single SSE event
 * is realistically well under a few MiB; this bounds memory if a provider/proxy
 * streams bytes continuously without ever emitting a `\n\n` boundary, which the
 * idle watchdog (idle-only) would never catch.
 */
const MAX_SSE_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_RETRY_POLICY = {
  maxRetries: DEFAULT_REQUEST_MAX_RETRIES,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  retry429: false,
  retry5xx: true,
  retryTransport: true,
} as const satisfies Required<ProviderHttpRetryBudget>;
const DEFAULT_STREAM_RETRY_POLICY = {
  maxRetries: DEFAULT_STREAM_MAX_RETRIES,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  retry429: false,
  retry5xx: true,
  retryTransport: true,
} as const satisfies Required<ProviderHttpRetryBudget>;

export type ProviderWireApi =
  | "responses"
  | "chat_completions"
  | "messages"
  | "custom";

export interface ProviderHttpRetryBudget {
  /**
   * Retry budget excluding the initial attempt.
   *
   * Matches upstream runtime `request_max_retries` / `stream_max_retries`.
   */
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly retry429?: boolean;
  readonly retry5xx?: boolean;
  readonly retryTransport?: boolean;
}

export interface ProviderAuthHeaderContext {
  readonly providerName: string;
  readonly wireApi: ProviderWireApi;
  readonly attempt: number;
  readonly request: ProviderHttpResolvedRequest;
}

export interface ProviderHttpResolvedRequest {
  readonly url: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "DELETE";
}

export interface ProviderHttpClientSessionConfig {
  readonly providerName: string;
  readonly baseURL: string;
  readonly model?: string;
  readonly wireApi?: ProviderWireApi;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly defaultQuery?: Readonly<
    Record<string, string | number | boolean | undefined>
  >;
  readonly authHeaders?: Readonly<Record<string, string>>;
  readonly resolveAuthHeaders?: (
    context: ProviderAuthHeaderContext,
  ) =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>> | undefined>
    | undefined;
  readonly timeoutMs?: number;
  readonly requestRetry?: ProviderHttpRetryBudget;
  readonly streamRetry?: ProviderHttpRetryBudget;
  readonly providerFallback?: ProviderFallbackLadderOptions;
  readonly streamIdleTimeoutMs?: number;
  readonly supportsStreaming?: boolean;
  readonly supportsWebsockets?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly responsesContinuationState?: ResponsesContinuationState;
  readonly emitWarning?: (warning: {
    cause: string;
    message: string;
  }) => void;
  readonly onCapabilityDrift?: (warning: {
    message: string;
    status?: number;
  }) => void;
}

export interface ProviderHttpRequestOptions {
  readonly path?: string;
  readonly api?: ProviderWireApi;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly retryBudget?: ProviderHttpRetryBudget;
  readonly providerFallback?: ProviderFallbackLadderOptions;
  /** Prevent every transport and continuation retry for an admitted call. */
  readonly singleWireAttempt?: boolean;
}

export interface ProviderHttpJsonResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
}

export interface ProviderHttpTextResponse {
  readonly data: string;
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
}

export interface ProviderHttpStreamChunk {
  readonly value: Uint8Array;
  readonly index: number;
}

export interface ProviderHttpStreamResponse
  extends AsyncIterable<ProviderHttpStreamChunk> {
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
}

export class ProviderHttpError extends Error {
  readonly providerName: string;
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
  readonly body?: unknown;
  readonly retryAfterMs?: number;

  constructor(args: {
    providerName: string;
    status: number;
    headers: Headers;
    url: string;
    message: string;
    body?: unknown;
    retryAfterMs?: number;
  }) {
    super(args.message);
    this.name = "ProviderHttpError";
    this.providerName = args.providerName;
    this.status = args.status;
    this.headers = args.headers;
    this.url = args.url;
    this.body = args.body;
    this.retryAfterMs = args.retryAfterMs;
  }
}

interface ProviderTransportError {
  readonly message: string;
  readonly kind: "network" | "timeout" | "abort" | "tls_cert" | "unknown";
  readonly cause?: unknown;
  readonly tlsDetails?: TlsValidationDetails;
}

type NormalizedRetryBudget = Required<ProviderHttpRetryBudget>;

function normalizePositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return Math.floor(value);
}

function resolveTimeoutMs(
  defaultTimeoutMs: number | undefined,
  requestTimeoutMs: number | undefined,
): number | undefined {
  const resolvedDefault = normalizePositiveInt(defaultTimeoutMs);
  const resolvedRequest = normalizePositiveInt(requestTimeoutMs);
  if (resolvedDefault === undefined) return resolvedRequest;
  if (resolvedRequest === undefined) return resolvedDefault;
  return Math.min(resolvedDefault, resolvedRequest);
}

function normalizeRetryBudget(
  baseBudget: ProviderHttpRetryBudget | undefined,
  overrideBudget: ProviderHttpRetryBudget | undefined,
  defaults: NormalizedRetryBudget,
): NormalizedRetryBudget {
  const merged = {
    ...defaults,
    ...(baseBudget ?? {}),
    ...(overrideBudget ?? {}),
  };
  return {
    maxRetries: normalizePositiveInt(merged.maxRetries) ?? defaults.maxRetries,
    baseDelayMs:
      normalizePositiveInt(merged.baseDelayMs) ?? defaults.baseDelayMs,
    retry429: merged.retry429,
    retry5xx: merged.retry5xx,
    retryTransport: merged.retryTransport,
  };
}

function backoffWithJitter(baseDelayMs: number, retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1);
  const raw = baseDelayMs * 2 ** exponent;
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.max(1, Math.round(raw * jitter));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });
  }
  if (signal.aborted) {
    return Promise.reject(abortReasonToError(signal.reason));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    const onAbort = () => {
      cleanup();
      clearTimeout(timer);
      reject(abortReasonToError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function combineAbortSignals(
  signals: readonly AbortSignal[],
): { readonly signal?: AbortSignal; readonly cleanup: () => void } {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }
    const listener = () => abort(signal.reason);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function createAttemptAbortState(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): {
  readonly signal?: AbortSignal;
  readonly abortController: AbortController;
  readonly cleanup: () => void;
} {
  const abortController = new AbortController();
  const signals = [abortController.signal];
  if (outerSignal) signals.push(outerSignal);

  let timeoutId: NodeJS.Timeout | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      abortController.abort(
        new Error(`provider request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    if (typeof timeoutId.unref === "function") timeoutId.unref();
  }

  const combined = combineAbortSignals(signals);
  return {
    signal: combined.signal,
    abortController,
    cleanup: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      combined.cleanup();
    },
  };
}

function readErrorBodyText(contentType: string, text: string): unknown {
  if (!text) return undefined;
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function isHtmlContentType(contentType: string): boolean {
  return /\btext\/html\b/i.test(contentType);
}

function throwCaptivePortalError(args: {
  providerName: string;
  response: Response;
  expected: "json" | "sse";
}): never {
  throw new LLMCaptivePortalError(args.providerName, {
    contentType: args.response.headers.get("content-type") ?? undefined,
    statusCode: args.response.status,
    url: args.response.url,
    expected: args.expected,
  });
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    return readErrorBodyText(contentType, await response.text());
  } catch {
    return undefined;
  }
}

function errorMessageFromBody(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const direct =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : undefined;
    if (direct) return direct;
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
      if (typeof nested.type === "string") return nested.type;
    }
  }
  if (typeof body === "string" && body.trim().length > 0) {
    return body.trim();
  }
  return `HTTP ${status}`;
}

function parseRetryAfterMs(
  headers: Headers,
  emitWarning?: (warning: { cause: string; message: string }) => void,
  nowMs = Date.now(),
): { delayMs?: number; exceedsMaxWait: boolean } {
  const retryAfter = headers.get("retry-after")?.trim();
  if (!retryAfter) return { exceedsMaxWait: false };

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const delayMs = seconds * 1000;
    if (delayMs > MAX_RETRY_AFTER_MS) {
      return { exceedsMaxWait: true };
    }
    return {
      delayMs: Math.max(100, delayMs),
      exceedsMaxWait: false,
    };
  }

  const absoluteMs = Date.parse(retryAfter);
  if (!Number.isFinite(absoluteMs)) {
    emitWarning?.({
      cause: "retry_after_ambiguous",
      message: `provider returned an ambiguous Retry-After header (${retryAfter}); falling back to exponential backoff`,
    });
    return { exceedsMaxWait: false };
  }

  const delayMs = Math.max(100, absoluteMs - nowMs);
  if (delayMs > MAX_RETRY_AFTER_MS) {
    return { exceedsMaxWait: true };
  }
  return { delayMs, exceedsMaxWait: false };
}

function buildRequestUrl(baseURL: string, path: string): URL {
  const url = new URL(baseURL);
  const basePath = url.pathname.replace(/\/+$/, "");
  const requestPath = path.replace(/^\/+/, "");
  url.pathname = requestPath
    ? `${basePath}/${requestPath}`.replace(/\/{2,}/g, "/")
    : basePath || "/";
  return url;
}

function normalizeTransportError(error: unknown): ProviderTransportError {
  const candidate = error as {
    readonly name?: string;
    readonly message?: string;
    readonly code?: string;
    readonly cause?: unknown;
  };
  const message = candidate?.message ?? String(error);
  const tlsDetails = extractTlsValidationDetails(error);
  if (tlsDetails) {
    return {
      message: tlsDetails.message,
      kind: "tls_cert",
      cause: error,
      tlsDetails,
    };
  }
  if (
    candidate?.name === "AbortError" ||
    candidate?.code === "ABORT_ERR" ||
    /abort/i.test(message)
  ) {
    return {
      message,
      kind: /timed out/i.test(message) ? "timeout" : "abort",
      cause: error,
    };
  }
  if (
    candidate?.code === "ETIMEDOUT" ||
    /timeout|timed out/i.test(message)
  ) {
    return { message, kind: "timeout", cause: error };
  }
  if (/network|fetch failed|socket|econn|connection/i.test(message)) {
    return { message, kind: "network", cause: error };
  }
  return { message, kind: "unknown", cause: error };
}

function shouldRetryHttpStatus(
  status: number,
  retryBudget: NormalizedRetryBudget,
): boolean {
  if (status === 429) return retryBudget.retry429;
  if (status >= 500) return retryBudget.retry5xx;
  return false;
}

function shouldRetryTransportError(
  error: ProviderTransportError,
  retryBudget: NormalizedRetryBudget,
): boolean {
  if (error.kind === "abort") return false;
  if (error.kind === "tls_cert") return false;
  if (!retryBudget.retryTransport) return false;
  return error.kind === "network" || error.kind === "timeout";
}

function shouldRetryTlsCertificateError(
  error: ProviderTransportError,
  attempt: number,
): boolean {
  return error.kind === "tls_cert" && attempt === 0;
}

function resolveRetryDelayMs(
  providerName: string,
  retryBudget: NormalizedRetryBudget,
  retryCount: number,
  emitWarning: ((warning: { cause: string; message: string }) => void) | undefined,
  headers?: Headers,
): { delayMs: number; exceedsMaxWait: boolean } {
  const fallbackDelayMs = Math.max(
    100,
    backoffWithJitter(retryBudget.baseDelayMs, retryCount),
  );
  if (!headers) {
    return {
      delayMs: fallbackDelayMs,
      exceedsMaxWait: false,
    };
  }

  const parsed = parseRetryAfterMs(headers, emitWarning);
  if (parsed.exceedsMaxWait) {
    emitWarning?.({
      cause: "rate_limit_exceeds_max_wait",
      message: `${providerName} requested a Retry-After longer than ${MAX_RETRY_AFTER_MS}ms; aborting retry instead of sleeping unbounded`,
    });
    return {
      delayMs: fallbackDelayMs,
      exceedsMaxWait: true,
    };
  }

  return {
    delayMs: parsed.delayMs !== undefined
      ? Math.max(parsed.delayMs, fallbackDelayMs)
      : fallbackDelayMs,
    exceedsMaxWait: false,
  };
}

function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (reason === STREAM_IDLE_ABORT_REASON) {
    return new Error("provider stream timed out");
  }
  if (typeof reason === "string") return new Error(reason);
  return new Error("request aborted");
}

function isStreamIdleTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === "provider stream timed out";
}

function materializeTransportError(
  providerName: string,
  error: ProviderTransportError,
): Error {
  if (error.kind === "tls_cert" && error.tlsDetails) {
    return new LLMCertificateError(providerName, error.tlsDetails);
  }
  return error.cause instanceof Error
    ? error.cause
    : new Error(error.message);
}

async function readWithAbort(
  reader: {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  },
  signal: AbortSignal | undefined,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (!signal) return await reader.read();
  if (signal.aborted) throw abortReasonToError(signal.reason);

  return await new Promise<{ done: boolean; value?: Uint8Array }>(
    (resolve, reject) => {
      const onAbort = () => reject(abortReasonToError(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      reader.read().then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    },
  );
}

function resolveApiPath(api: ProviderWireApi): string {
  switch (api) {
    case "responses":
      return "/responses";
    case "chat_completions":
      return "/chat/completions";
    case "messages":
      return "/messages";
    case "custom":
      throw new Error("custom wire API requires an explicit request path");
  }
}

function isContinuationExpiryError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.status !== 404 && error.status !== 400) return false;
  const bodyMessage =
    typeof error.body === "string"
      ? error.body
      : error.body && typeof error.body === "object"
        ? JSON.stringify(error.body)
        : "";
  const message = `${error.message} ${bodyMessage}`.toLowerCase();
  if (!message.includes("response")) return false;
  return (
    message.includes("previous_response_id") ||
    message.includes("previous response") ||
    message.includes("not found") ||
    message.includes("expired")
  );
}

function maybeEmitCapabilityDriftWarning(
  config: ProviderHttpClientSessionConfig,
  error: ProviderHttpError,
): void {
  if (!config.onCapabilityDrift) return;
  const bodyMessage =
    typeof error.body === "string"
      ? error.body
      : error.body && typeof error.body === "object"
        ? JSON.stringify(error.body)
        : "";
  const message = `${error.message} ${bodyMessage}`.trim();
  if (!isProviderCapabilityMismatch({ status: error.status, message })) {
    return;
  }
  config.onCapabilityDrift({
    message,
    status: error.status,
  });
}

function evaluateConfiguredProviderFallback(
  fallback: ProviderFallbackLadderOptions | undefined,
  error: unknown,
  consecutiveFailures: number,
): ProviderFallbackDecision | null {
  if (!fallback) return null;
  const decision = evaluateProviderFallback({
    ...fallback,
    error,
    consecutiveFailures,
  });
  if (decision.kind === "trigger") {
    throw decision.error;
  }
  return decision;
}

function clearContinuationState(
  state: ResponsesContinuationState | undefined,
): void {
  if (!state) return;
  delete state.lastResponseId;
  delete state.lastResponseOutput;
}

function buildContinuationFallbackOptions(
  prepared: PreparedProviderHttpRequest,
): ProviderHttpRequestOptions {
  return {
    ...prepared.options,
    body: prepared.continuation?.snapshot ?? prepared.options.body,
  };
}

function warnContinuationExpiry(
  config: ProviderHttpClientSessionConfig,
): void {
  config.emitWarning?.({
    cause: "previous_response_id_expired",
    message: `${config.providerName} rejected previous_response_id; clearing continuation state and retrying once with full history`,
  });
}

function normalizeHeaders(
  headers: Headers,
  additions?: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(additions ?? {})) {
    headers.set(key, value);
  }
}

async function createProviderHttpError(
  providerName: string,
  response: Response,
): Promise<ProviderHttpError> {
  const errorBody = await readErrorBody(response);
  return new ProviderHttpError({
    providerName,
    status: response.status,
    headers: response.headers,
    url: response.url,
    body: errorBody,
    message: errorMessageFromBody(response.status, errorBody),
    retryAfterMs: parseRetryAfterMs(response.headers).delayMs,
  });
}

function createMalformedProviderJsonError(args: {
  readonly providerName: string;
  readonly response: Response;
  readonly body: string;
  readonly message: string;
}): ProviderHttpError {
  return new ProviderHttpError({
    providerName: args.providerName,
    status: args.response.status,
    headers: args.response.headers,
    url: args.response.url,
    body: args.body,
    message: args.message,
  });
}

interface PreparedStreamAttempt {
  readonly attempt: number;
  readonly response: Response;
  readonly attemptState: ReturnType<typeof createAttemptAbortState>;
}

interface PreparedProviderHttpRequest {
  readonly options: ProviderHttpRequestOptions;
  readonly continuation?: PreparedResponsesContinuationRequest;
}

interface ParsedSseEvent {
  readonly event?: string;
  readonly data?: Record<string, unknown>;
}

function isResponsesCreateRequest(
  method: ProviderHttpResolvedRequest["method"],
  path: string,
  body: unknown,
): body is Record<string, unknown> {
  return (
    method === "POST" &&
    path.replace(/\/+$/, "") === "/responses" &&
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body)
  );
}

function decodeSseFrames(
  buffer: string,
  providerName = "provider",
): { readonly events: ParsedSseEvent[]; readonly rest: string } {
  const events: ParsedSseEvent[] = [];
  let remaining = buffer;

  while (true) {
    const separatorMatch = remaining.match(/\r?\n\r?\n/);
    if (!separatorMatch || separatorMatch.index === undefined) {
      if (remaining.length > MAX_SSE_FRAME_BYTES) {
        throw new LLMInvalidResponseError(
          providerName,
          `SSE stream exceeded ${MAX_SSE_FRAME_BYTES} bytes without a frame separator`,
        );
      }
      return { events, rest: remaining };
    }
    const frame = remaining.slice(0, separatorMatch.index);
    remaining = remaining.slice(separatorMatch.index + separatorMatch[0].length);
    if (frame.trim().length === 0) {
      continue;
    }

    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith(":")) continue;
      if (rawLine.startsWith("event:")) {
        eventName = rawLine.slice("event:".length).trim() || undefined;
        continue;
      }
      if (rawLine.startsWith("data:")) {
        dataLines.push(rawLine.slice("data:".length).trimStart());
      }
    }

    const dataText = dataLines.join("\n").trim();
    if (dataText.length === 0 || dataText === "[DONE]") {
      events.push({ event: eventName });
      continue;
    }

    try {
      const parsed = JSON.parse(dataText) as Record<string, unknown>;
      events.push({ event: eventName, data: parsed });
    } catch {
      events.push({ event: eventName });
    }
  }
}

function maybeRecordResponsesContinuationEvent(
  continuation: PreparedResponsesContinuationRequest | undefined,
  state: ResponsesContinuationState | undefined,
  event: ParsedSseEvent,
): void {
  if (!continuation || !state || !event.data) {
    return;
  }
  const eventName = event.event ?? String(event.data.type ?? "");
  if (
    eventName !== "response.completed" &&
    eventName !== "response.incomplete"
  ) {
    return;
  }
  const response =
    event.data.response && typeof event.data.response === "object"
      ? (event.data.response as Record<string, unknown>)
      : undefined;
  if (!response) {
    return;
  }
  recordResponsesContinuationResponse(state, continuation.snapshot, response);
}

export class ProviderHttpClientSession {
  private readonly config: ProviderHttpClientSessionConfig;

  constructor(config: ProviderHttpClientSessionConfig) {
    this.config = config;
  }

  get providerName(): string {
    return this.config.providerName;
  }

  get wireApi(): ProviderWireApi {
    return this.config.wireApi ?? "custom";
  }

  get supportsStreaming(): boolean {
    return this.config.supportsStreaming !== false;
  }

  get supportsWebsockets(): boolean {
    return this.config.supportsWebsockets === true;
  }

  get requestRetryBudget(): Readonly<NormalizedRetryBudget> {
    return normalizeRetryBudget(
      this.config.requestRetry,
      undefined,
      DEFAULT_REQUEST_RETRY_POLICY,
    );
  }

  get streamRetryBudget(): Readonly<NormalizedRetryBudget> {
    return normalizeRetryBudget(
      this.config.streamRetry,
      undefined,
      DEFAULT_STREAM_RETRY_POLICY,
    );
  }

  get streamIdleTimeoutMs(): number {
    return (
      resolveTimeoutMs(this.config.streamIdleTimeoutMs, undefined) ??
      resolveStreamIdleTimeoutMs()
    );
  }

  async requestJson<T>(
    options: ProviderHttpRequestOptions,
  ): Promise<ProviderHttpJsonResponse<T>> {
    const prepared = this.prepareRequest(options);
    let response: Response;
    try {
      response = await this.requestWithRetry(prepared.options, "request");
    } catch (error) {
      if (
        prepared.options.singleWireAttempt === true ||
        !prepared.continuation ||
        !isContinuationExpiryError(error)
      ) {
        throw error;
      }
      warnContinuationExpiry(this.config);
      clearContinuationState(this.config.responsesContinuationState);
      response = await this.requestWithRetry(
        buildContinuationFallbackOptions(prepared),
        "request",
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (isHtmlContentType(contentType)) {
      throwCaptivePortalError({
        providerName: this.config.providerName,
        response,
        expected: "json",
      });
    }
    const text = await response.text();
    let data: T;
    if (contentType.includes("application/json")) {
      if (text.length > 0) {
        try {
          data = JSON.parse(text) as T;
        } catch (error) {
          throw createMalformedProviderJsonError({
            providerName: this.config.providerName,
            response,
            body: text,
            message: `Invalid JSON response from ${this.config.providerName}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      } else {
        data = undefined as T;
      }
    } else if (text.trim().length > 0) {
      throw createMalformedProviderJsonError({
        providerName: this.config.providerName,
        response,
        body: text,
        message: `Non-JSON response from ${this.config.providerName}; content-type=${contentType || "missing"}`,
      });
    } else {
      data = undefined as T;
    }
    if (
      prepared.continuation &&
      data &&
      typeof data === "object" &&
      !Array.isArray(data)
    ) {
      recordResponsesContinuationResponse(
        this.config.responsesContinuationState ?? {},
        prepared.continuation.snapshot,
        data as Record<string, unknown>,
      );
    }
    return {
      data,
      status: response.status,
      headers: response.headers,
      url: response.url,
    };
  }

  async requestText(
    options: ProviderHttpRequestOptions,
  ): Promise<ProviderHttpTextResponse> {
    const response = await this.requestWithRetry(options, "request");
    return {
      data: await response.text(),
      status: response.status,
      headers: response.headers,
      url: response.url,
    };
  }

  async requestStream(
    options: ProviderHttpRequestOptions,
  ): Promise<ProviderHttpStreamResponse> {
    if (!this.supportsStreaming) {
      throw new Error(
        `${this.config.providerName} client session does not support streaming`,
      );
    }
    const prepared = this.prepareRequest(options);

    const retryBudget = normalizeRetryBudget(
      this.config.streamRetry,
      prepared.options.retryBudget,
      DEFAULT_STREAM_RETRY_POLICY,
    );
    const idleTimeoutMs =
      resolveTimeoutMs(this.config.streamIdleTimeoutMs, prepared.options.timeoutMs) ??
      resolveStreamIdleTimeoutMs();
    let initialAttempt: PreparedStreamAttempt;
    try {
      initialAttempt = await this.acquireStreamAttempt(
        prepared.options,
        retryBudget,
        0,
      );
    } catch (error) {
      if (
        prepared.options.singleWireAttempt === true ||
        !prepared.continuation ||
        !isContinuationExpiryError(error)
      ) {
        throw error;
      }
      warnContinuationExpiry(this.config);
      clearContinuationState(this.config.responsesContinuationState);
      initialAttempt = await this.acquireStreamAttempt(
        buildContinuationFallbackOptions(prepared),
        retryBudget,
        0,
      );
    }
    const initialContentType =
      initialAttempt.response.headers.get("content-type") ?? "";
    if (isHtmlContentType(initialContentType)) {
      initialAttempt.attemptState.cleanup();
      throwCaptivePortalError({
        providerName: this.config.providerName,
        response: initialAttempt.response,
        expected: "sse",
      });
    }
    const session = this;
    let decoder = new TextDecoder();
    let sseBuffer = "";

    return {
      status: initialAttempt.response.status,
      headers: initialAttempt.response.headers,
      url: initialAttempt.response.url,
      async *[Symbol.asyncIterator](): AsyncIterator<ProviderHttpStreamChunk> {
        let activeAttempt = initialAttempt;
        let index = 0;
        // LLM-01: once any body bytes have been yielded to the consumer,
        // never transport-retry into a second SSE body (would splice/corrupt).
        let yieldedBodyBytes = false;

        while (true) {
          const currentAttempt = activeAttempt;
          const reader = currentAttempt.response.body!.getReader();
          const watchdog = installStreamWatchdog({
            abortController: currentAttempt.attemptState.abortController,
            timeoutMs: idleTimeoutMs,
          });
          try {
            while (true) {
              const next = await readWithAbort(
                reader,
                currentAttempt.attemptState.abortController.signal,
              );
              if (next.done) return;
              // LLM-09: empty chunks still count as body progress for idle
              // watchdog (providers may send keepalives).
              watchdog.kick();
              if (!next.value || next.value.length === 0) continue;
              if (prepared.continuation) {
                const decoded = decoder.decode(next.value, { stream: true });
                if (decoded.length > 0) {
                  const parsed = decodeSseFrames(
                    sseBuffer + decoded,
                    session.config.providerName,
                  );
                  sseBuffer = parsed.rest;
                  for (const event of parsed.events) {
                    maybeRecordResponsesContinuationEvent(
                      prepared.continuation,
                      session.config.responsesContinuationState,
                      event,
                    );
                  }
                }
              }
              yield { value: next.value, index };
              yieldedBodyBytes = true;
              index += 1;
            }
          } catch (error) {
            if (isStreamIdleTimeoutError(error)) {
              throw new Error(
                `${session.config.providerName} stream idle for ${idleTimeoutMs}ms`,
              );
            }
            const transport = normalizeTransportError(error);
            if (
              !yieldedBodyBytes &&
              currentAttempt.attempt < retryBudget.maxRetries &&
              shouldRetryTransportError(transport, retryBudget)
            ) {
              sseBuffer = "";
              decoder = new TextDecoder();
              activeAttempt = await session.acquireStreamAttempt(
                prepared.options,
                retryBudget,
                currentAttempt.attempt + 1,
              );
              const retryContentType =
                activeAttempt.response.headers.get("content-type") ?? "";
              if (isHtmlContentType(retryContentType)) {
                activeAttempt.attemptState.cleanup();
                throwCaptivePortalError({
                  providerName: session.config.providerName,
                  response: activeAttempt.response,
                  expected: "sse",
                });
              }
              continue;
            }
            throw materializeTransportError(session.config.providerName, transport);
          } finally {
            watchdog.stop();
            reader.releaseLock();
            currentAttempt.attemptState.cleanup();
          }
        }
      },
    };
  }

  private async requestWithRetry(
    options: ProviderHttpRequestOptions,
    mode: "request" | "stream",
  ): Promise<Response> {
    const retryBudget = normalizeRetryBudget(
      mode === "stream" ? this.config.streamRetry : this.config.requestRetry,
      options.retryBudget,
      mode === "stream"
        ? DEFAULT_STREAM_RETRY_POLICY
        : DEFAULT_REQUEST_RETRY_POLICY,
    );
    const maxAttempts = options.singleWireAttempt
      ? 1
      : retryBudget.maxRetries + 2;
    const timeoutMs = resolveTimeoutMs(this.config.timeoutMs, options.timeoutMs);
    let consecutiveFallbackFailures = 0;

    for (
      let attempt = 0;
      attempt < maxAttempts;
      attempt += 1
    ) {
      const attemptState = createAttemptAbortState(options.signal, timeoutMs);
      try {
        const response = await this.fetchResponse(
          options,
          attempt,
          attemptState.signal,
        );
        attemptState.cleanup();
        if (!response.ok) {
          const error = await createProviderHttpError(
            this.config.providerName,
            response,
          );
          const fallbackDecision = evaluateConfiguredProviderFallback(
            options.providerFallback ?? this.config.providerFallback,
            error,
            consecutiveFallbackFailures,
          );
          const shouldRetryFallback =
            fallbackDecision?.kind === "wait";
          consecutiveFallbackFailures = shouldRetryFallback
            ? fallbackDecision.consecutiveFailures
            : 0;
          if (
            !options.singleWireAttempt &&
            attempt < retryBudget.maxRetries &&
            (shouldRetryHttpStatus(response.status, retryBudget) ||
              shouldRetryFallback)
          ) {
            const retryDelay = resolveRetryDelayMs(
              this.config.providerName,
              retryBudget,
              attempt + 1,
              this.config.emitWarning,
              error.headers,
            );
            if (retryDelay.exceedsMaxWait) {
              throw error;
            }
            await sleep(
              retryDelay.delayMs,
              options.signal,
            );
            continue;
          }
          throw error;
        }
        return response;
      } catch (error) {
        attemptState.cleanup();
        if (isFallbackTriggeredError(error)) {
          throw error;
        }
        if (error instanceof ProviderHttpError) {
          maybeEmitCapabilityDriftWarning(this.config, error);
          throw error;
        }
        consecutiveFallbackFailures = 0;
        const transport = normalizeTransportError(error);
        if (
          (!options.singleWireAttempt &&
            attempt < retryBudget.maxRetries &&
            shouldRetryTransportError(transport, retryBudget)) ||
          (!options.singleWireAttempt &&
            shouldRetryTlsCertificateError(transport, attempt))
        ) {
          const retryDelay = resolveRetryDelayMs(
            this.config.providerName,
            retryBudget,
            attempt + 1,
            this.config.emitWarning,
          );
          await sleep(
            retryDelay.delayMs,
            options.signal,
          );
          continue;
        }
        throw materializeTransportError(this.config.providerName, transport);
      }
    }

    throw new Error(`${this.config.providerName} request retry budget exhausted`);
  }

  private async acquireStreamAttempt(
    options: ProviderHttpRequestOptions,
    retryBudget: NormalizedRetryBudget,
    initialAttempt: number,
  ): Promise<PreparedStreamAttempt> {
    // LLM-02: stream open/headers use the same request timeout as non-stream;
    // body silence is still covered by the idle watchdog after yield.
    const timeoutMs = resolveTimeoutMs(this.config.timeoutMs, options.timeoutMs);
    const maxAttempts = options.singleWireAttempt
      ? 1
      : retryBudget.maxRetries + 2;
    let consecutiveFallbackFailures = 0;
    for (
      let attempt = initialAttempt;
      attempt < maxAttempts;
      attempt += 1
    ) {
      const attemptState = createAttemptAbortState(options.signal, timeoutMs);
      try {
        const response = await this.fetchResponse(
          options,
          attempt,
          attemptState.signal,
        );
        if (!response.ok) {
          const error = await createProviderHttpError(
            this.config.providerName,
            response,
          );
          const fallbackDecision = evaluateConfiguredProviderFallback(
            options.providerFallback ?? this.config.providerFallback,
            error,
            consecutiveFallbackFailures,
          );
          const shouldRetryFallback =
            fallbackDecision?.kind === "wait";
          consecutiveFallbackFailures = shouldRetryFallback
            ? fallbackDecision.consecutiveFailures
            : 0;
          if (
            !options.singleWireAttempt &&
            attempt < retryBudget.maxRetries &&
            (shouldRetryHttpStatus(response.status, retryBudget) ||
              shouldRetryFallback)
          ) {
            attemptState.cleanup();
            const retryDelay = resolveRetryDelayMs(
              this.config.providerName,
              retryBudget,
              attempt + 1,
              this.config.emitWarning,
              error.headers,
            );
            if (retryDelay.exceedsMaxWait) {
              throw error;
            }
            await sleep(
              retryDelay.delayMs,
              options.signal,
            );
            continue;
          }
          attemptState.cleanup();
          throw error;
        }
        if (!response.body) {
          attemptState.cleanup();
          throw new Error(
            `${this.config.providerName} stream response missing body`,
          );
        }
        return { attempt, response, attemptState };
      } catch (error) {
        attemptState.cleanup();
        if (isFallbackTriggeredError(error)) {
          throw error;
        }
        if (error instanceof ProviderHttpError) {
          maybeEmitCapabilityDriftWarning(this.config, error);
          throw error;
        }
        consecutiveFallbackFailures = 0;
        const transport = normalizeTransportError(error);
        if (
          (!options.singleWireAttempt &&
            attempt < retryBudget.maxRetries &&
            shouldRetryTransportError(transport, retryBudget)) ||
          (!options.singleWireAttempt &&
            shouldRetryTlsCertificateError(transport, attempt))
        ) {
          const retryDelay = resolveRetryDelayMs(
            this.config.providerName,
            retryBudget,
            attempt + 1,
            this.config.emitWarning,
          );
          await sleep(
            retryDelay.delayMs,
            options.signal,
          );
          continue;
        }
        throw materializeTransportError(this.config.providerName, transport);
      }
    }

    throw new Error(`${this.config.providerName} stream retry budget exhausted`);
  }

  private async fetchResponse(
    options: ProviderHttpRequestOptions,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const method = options.method ?? "POST";
    const path =
      options.path ??
      (options.api ? resolveApiPath(options.api) : resolveApiPath(this.wireApi));
    const url = buildRequestUrl(this.config.baseURL, path);

    for (const [key, value] of Object.entries(this.config.defaultQuery ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const request = {
      path,
      method,
      url: url.toString(),
    } satisfies ProviderHttpResolvedRequest;

    const headers = new Headers(this.config.defaultHeaders ?? {});
    normalizeHeaders(headers, this.config.authHeaders);
    if (this.config.resolveAuthHeaders) {
      const resolved = await this.config.resolveAuthHeaders({
        providerName: this.config.providerName,
        wireApi: options.api ?? this.wireApi,
        attempt,
        request,
      });
      normalizeHeaders(headers, resolved ?? undefined);
    }
    normalizeHeaders(headers, options.headers);

    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }

    const fetchImpl = this.config.fetchImpl ?? fetch;
    return await fetchImpl(url, {
      method,
      headers,
      body,
      signal,
    });
  }

  private prepareRequest(
    options: ProviderHttpRequestOptions,
  ): PreparedProviderHttpRequest {
    const method = options.method ?? "POST";
    const path =
      options.path ??
      (options.api ? resolveApiPath(options.api) : resolveApiPath(this.wireApi));
    if (
      !isResponsesCreateRequest(method, path, options.body) ||
      !this.config.responsesContinuationState
    ) {
      return { options };
    }
    const continuation = prepareResponsesContinuationRequest(
      options.body,
      this.config.responsesContinuationState,
    );
    return {
      options: {
        ...options,
        path,
        method,
        body: continuation.request,
      },
      continuation,
    };
  }
}
