/**
 * Grok (xAI) LLM provider adapter.
 *
 * Uses the `openai` SDK pointed at the xAI API endpoint.
 * The SDK is loaded lazily on first use — it's an optional dependency.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMCompactionDiagnostics,
  LLMProviderTraceEvent,
  LLMToolChoice,
  LLMProvider,
  LLMProviderStartupPrewarmHandle,
  LLMProviderStartupPrewarmParams,
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  LLMUsage,
  LLMRequestMetrics,
  LLMProviderNativeServerToolCall,
  LLMProviderServerSideToolUsageEntry,
  LLMTool,
  LLMStoredResponse,
  LLMStoredResponseDeleteResult,
  StreamProgressCallback,
  ToolCallValidationFailure,
} from "../../types.js";
import { validateToolCallDetailed } from "../../types.js";
import { decodeMcpToolNameFromWire } from "../../wire/mcp-tool-naming.js";
import { LLMProviderError, mapLLMError } from "../../errors.js";
import { ensureLazyImport } from "../../lazy-import.js";
import {
  assertProviderStructuredOutputCompatibility,
  assertXaiStructuredOutputToolCompatibility,
} from "../../provider-capabilities.js";
import {
  getProviderNativeToolDefinitions,
  isGrokMultiAgentModel,
  type ProviderNativeToolDefinition,
} from "../../provider-native-search.js";
import {
  buildStructuredOutputTextFormat,
  parseStructuredOutputText,
  supportsXaiReasoningEffortParam,
} from "../../structured-output.js";
import { withTimeout } from "../../timeout.js";
import { repairToolTurnSequence, validateToolTurnSequence } from "../../tool-turn-validator.js";
import type { GrokProviderConfig } from "./types.js";
import {
  IncrementalTracker,
  registerIncrementalTracker,
  type IncrementalRequestShape,
  type LastResponseSnapshot,
} from "./incremental.js";
import {
  isUnauthorizedError,
  retryWithAuthRefresh,
  type AuthRefreshCallbacks,
  type AuthRefreshOutcome,
} from "./auth-refresh.js";
import { monotonicMs } from "../../_deps/monotonic.js";
import { resolveContextWindowProfile } from "../../_deps/context-window.js";
import {
  buildProviderTraceErrorPayload,
  isContinuationRetrievalFailure,
  buildToolSelectionTraceContext,
  cloneProviderTracePayload,
  extractTraceToolNames,
  slimTools,
  summarizeTraceToolChoice,
  toSlimTool,
  truncate,
  type ToolSelectionDiagnostics,
} from "./adapter-utils.js";
import { isProviderCapabilityMismatch } from "../../capabilities.js";
import {
  evaluateProviderFallback,
  normalizeFallbackRetryBudget,
  type ProviderFallbackDecision,
} from "../../api/fallback-ladder.js";
import { getRetryDelay, sleepMs } from "../../api/retry.js";
import { isFallbackTriggeredError } from "../../../recovery/api-errors.js";
import {
  buildXaiResponsesInputItems,
  resolveXaiResponsesToolChoice,
  toXaiResponsesTools,
  XAI_ENCRYPTED_REASONING_INCLUDE,
} from "../../wire/responses-xai.js";
import {
  coerceUsage,
  splitSystemPromptOnDynamicBoundary,
} from "../../wire/shared.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
} from "../../registry/provider-info.js";

const DEFAULT_VISION_MODEL = "grok-4-0709";
const DEFAULT_TIMEOUT_MS = 120_000;
// MAX_TOOL_SCHEMA_CHARS_FOLLOWUP removed 2026-04-09: see buildParams() comment
// near `selectedTools.tools.length > 0`. The 20K limit was silently dropping
// the entire tools array on every tool-followup request.
//

type ProviderFallbackWaitDecision = Extract<
  ProviderFallbackDecision,
  { readonly kind: "wait" }
>;

/**
 * Vision models known to support client-side function-calling alongside image
 * understanding. Multi-agent models are intentionally excluded: xAI rejects
 * client function tools on that family (built-ins + remote MCP only).
 */
const VISION_MODELS_WITH_TOOLS = new Set([
  "grok-4.5",
  "grok-4.5-latest",
  "grok-4-0709",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
]);

interface ProviderResponseTraceMeta {
  readonly providerRequestId?: string;
  readonly providerResponseId?: string;
  readonly responseStatus?: number;
  readonly responseStatusText?: string;
  readonly responseUrl?: string;
  readonly responseHeaders?: Record<string, string>;
}

interface ToolCallNormalizationIssue {
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly failure: ToolCallValidationFailure;
  readonly argumentsPreview?: string;
}

function createStreamTimeoutError(providerName: string, timeoutMs: number): Error {
  const err = new Error(
    `${providerName} stream stalled after ${timeoutMs}ms without a chunk`,
  );
  (err as { name?: string }).name = "AbortError";
  (err as { code?: string }).code = "ABORT_ERR";
  return err;
}

// gaphunt3 #21: caller-abort error for the open-stream chunk loop. Shaped as an
// AbortError so it propagates/maps the same way as a one-shot abort.
function createStreamAbortError(providerName: string): Error {
  const err = new Error(`${providerName} stream aborted by caller`);
  (err as { name?: string }).name = "AbortError";
  (err as { code?: string }).code = "ABORT_ERR";
  return err;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (timeoutMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

type RequestTimeoutSource =
  | "provider_default"
  | "provider_config"
  | "call_override";

interface RequestTimeoutResolution {
  readonly configuredProviderTimeoutMs: number | null;
  readonly callOverrideTimeoutMs: number | null;
  readonly timeoutMs: number | undefined;
  readonly source: RequestTimeoutSource;
}

function normalizeConfiguredTimeoutMs(
  timeoutMs: number | undefined,
): number | null {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return null;
  }
  if (timeoutMs <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function resolveRequestTimeoutMs(
  providerTimeoutMs: number | undefined,
  callTimeoutMs: number | undefined,
): RequestTimeoutResolution {
  const configuredProviderTimeoutMs =
    normalizeConfiguredTimeoutMs(providerTimeoutMs);
  const callOverrideTimeoutMs = normalizeConfiguredTimeoutMs(callTimeoutMs);

  if (callOverrideTimeoutMs !== null) {
    if (callOverrideTimeoutMs === 0) {
      return {
        configuredProviderTimeoutMs,
        callOverrideTimeoutMs,
        timeoutMs: undefined,
        source: "call_override",
      };
    }
    if (
      configuredProviderTimeoutMs === null ||
      configuredProviderTimeoutMs === 0
    ) {
      return {
        configuredProviderTimeoutMs,
        callOverrideTimeoutMs,
        timeoutMs: callOverrideTimeoutMs,
        source: "call_override",
      };
    }
    return {
      configuredProviderTimeoutMs,
      callOverrideTimeoutMs,
      timeoutMs: Math.max(
        1,
        Math.min(configuredProviderTimeoutMs, callOverrideTimeoutMs),
      ),
      source: "call_override",
    };
  }

  if (configuredProviderTimeoutMs === 0) {
    return {
      configuredProviderTimeoutMs,
      callOverrideTimeoutMs,
      timeoutMs: undefined,
      source: "provider_config",
    };
  }
  if (configuredProviderTimeoutMs !== null) {
    return {
      configuredProviderTimeoutMs,
      callOverrideTimeoutMs,
      timeoutMs: configuredProviderTimeoutMs,
      source: "provider_config",
    };
  }
  return {
    configuredProviderTimeoutMs,
    callOverrideTimeoutMs,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    source: "provider_default",
  };
}

async function nextStreamChunkWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number | undefined,
  providerName: string,
  // gaphunt3 #21: the caller's AbortSignal must keep teeing the open stream;
  // withTimeout detaches at stream-open, so the chunk loop re-supplies it here.
  externalSignal?: AbortSignal,
): Promise<IteratorResult<T>> {
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined;
  if (effectiveTimeoutMs === undefined && !externalSignal) {
    return iterator.next();
  }

  // gaphunt3 #21: already-aborted signals must reject before awaiting the next
  // chunk so a mid-stream cancel cannot block on a slow iterator.next().
  if (externalSignal?.aborted) {
    await closeAsyncIterator(iterator);
    throw createStreamAbortError(providerName);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let resolveInterrupted!: () => void;
  const interrupted = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });
  const interruption: { error?: Error } = {};
  let nextOutcome:
    | Promise<
        | { readonly kind: "result"; readonly result: IteratorResult<T> }
        | { readonly kind: "error"; readonly error: unknown }
      >
    | undefined;
  const interrupt = (error: Error): void => {
    if (interruption.error !== undefined) return;
    interruption.error = error;
    void (async () => {
      // `return()` requests teardown, but the AsyncIterator contract does not
      // guarantee that its resolution also settles an already-pending
      // `next()`. Retain admission until both teardown and that physical read
      // settle, including for custom abort-ignoring iterators.
      await Promise.all([
        closeAsyncIterator(iterator),
        ...(nextOutcome !== undefined ? [nextOutcome] : []),
      ]);
      resolveInterrupted();
    })();
  };
  if (effectiveTimeoutMs !== undefined) {
    timer = setTimeout(() => {
      interrupt(createStreamTimeoutError(providerName, effectiveTimeoutMs));
    }, effectiveTimeoutMs);
  }
  if (externalSignal) {
    abortHandler = () => interrupt(createStreamAbortError(providerName));
    externalSignal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    let nextCall: Promise<IteratorResult<T>>;
    try {
      nextCall = Promise.resolve(iterator.next());
    } catch (error) {
      throw error;
    }
    nextOutcome = nextCall.then(
      (result) => ({ kind: "result" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const outcome = await Promise.race([
      nextOutcome,
      interrupted.then(() => ({ kind: "interrupted" as const })),
    ]);
    if (interruption.error !== undefined) throw interruption.error;
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "interrupted") {
      throw createStreamAbortError(providerName);
    }
    return outcome.result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal && abortHandler) {
      externalSignal.removeEventListener("abort", abortHandler);
    }
  }
}

const iteratorCloseTasks = new WeakMap<object, Promise<boolean>>();

function closeAsyncIterator(iterator: AsyncIterator<unknown>): Promise<boolean> {
  const key = iterator as object;
  const existing = iteratorCloseTasks.get(key);
  if (existing !== undefined) return existing;
  const task = (async () => {
    if (typeof iterator.return !== "function") return false;
    try {
      await iterator.return();
      return true;
    } catch {
      // The caller must retain capacity until an outstanding next() settles
      // when teardown cannot be confirmed.
      return false;
    }
  })();
  iteratorCloseTasks.set(key, task);
  return task;
}

function estimateOpenAIContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (!part || typeof part !== "object") return sum;
      const p = part as Record<string, unknown>;
      if (p.type === "text" || p.type === "input_text") {
        return sum + String(p.text ?? "").length;
      }
      if (p.type === "image_url") {
        const imageUrl = p.image_url as Record<string, unknown> | undefined;
        return sum + String(imageUrl?.url ?? "").length;
      }
      if (p.type === "input_image") {
        return sum + String(p.image_url ?? "").length;
      }
      return sum;
    }, 0);
  }
  return 0;
}

function isPromptOverflowErrorMessage(message: string): boolean {
  return /maximum prompt length|maximum context length|request contains\s+\d+\s+tokens/i.test(
    message,
  );
}

function collectParamDiagnostics(
  params: Record<string, unknown>,
  selection?: ToolSelectionDiagnostics,
): LLMRequestMetrics {
  const messages = Array.isArray(params.messages)
    ? (params.messages as Array<Record<string, unknown>>)
    : [];
  const inputItems = Array.isArray(params.input)
    ? (params.input as Array<Record<string, unknown>>)
    : [];
  const effectiveMessages = messages.length > 0
    ? messages
    : inputItems;
  const tools = Array.isArray(params.tools)
    ? (params.tools as unknown[])
    : [];
  const toolNames = selection?.resolvedToolNames ?? extractTraceToolNames(tools);

  let totalContentChars = 0;
  let maxMessageChars = 0;
  let imageParts = 0;
  let textParts = 0;
  let systemMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;

  for (const msg of effectiveMessages) {
    const role = String(msg.role ?? "");
    const itemType = String(msg.type ?? "");

    if (role === "system") systemMessages++;
    if (role === "user") userMessages++;
    if (role === "assistant") assistantMessages++;
    if (role === "tool" || itemType === "function_call_output") toolMessages++;

    const content = itemType === "function_call_output"
      ? String(msg.output ?? "")
      : msg.content;
    const chars = estimateOpenAIContentChars(content);
    totalContentChars += chars;
    if (chars > maxMessageChars) maxMessageChars = chars;

    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "image_url" || p.type === "input_image") imageParts++;
        if (p.type === "text" || p.type === "input_text") textParts++;
      }
    }
  }

  let serializedChars = 0;
  let toolSchemaChars = 0;
  try {
    serializedChars = JSON.stringify(params).length;
  } catch {
    serializedChars = -1;
  }
  try {
    toolSchemaChars = JSON.stringify(tools).length;
  } catch {
    toolSchemaChars = -1;
  }
  const structuredFormat =
    params.text &&
    typeof params.text === "object" &&
    !Array.isArray(params.text) &&
    (params.text as Record<string, unknown>).format &&
    typeof (params.text as Record<string, unknown>).format === "object" &&
    !Array.isArray((params.text as Record<string, unknown>).format)
      ? ((params.text as Record<string, unknown>).format as Record<string, unknown>)
      : undefined;

  return {
    messageCount: effectiveMessages.length,
    systemMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    totalContentChars,
    maxMessageChars,
    textParts,
    imageParts,
    toolCount: tools.length,
    toolNames,
    requestedToolNames: selection?.requestedToolNames,
    missingRequestedToolNames: selection?.missingRequestedToolNames,
    toolResolution: selection?.toolResolution,
    providerCatalogToolCount: selection?.providerCatalogToolCount,
    toolsAttached: selection?.toolsAttached,
    toolSuppressionReason: selection?.toolSuppressionReason,
    toolChoice: summarizeTraceToolChoice(params.tool_choice),
    toolSchemaChars,
    structuredOutputEnabled: structuredFormat !== undefined,
    structuredOutputName:
      typeof structuredFormat?.name === "string"
        ? structuredFormat.name
        : undefined,
    structuredOutputStrict:
      typeof structuredFormat?.strict === "boolean"
        ? structuredFormat.strict
        : undefined,
    serializedChars,
    store: typeof params.store === "boolean" ? params.store : undefined,
    parallelToolCalls:
      typeof params.parallel_tool_calls === "boolean"
        ? params.parallel_tool_calls
        : undefined,
    stream: typeof params.stream === "boolean" ? params.stream : undefined,
  };
}

function buildProviderRequestTraceContext(
  selection: ToolSelectionDiagnostics,
  toolChoice: LLMToolChoice | undefined,
  requestMetrics: LLMRequestMetrics,
  compactionDiagnostics?: LLMCompactionDiagnostics,
  timeout?: RequestTimeoutResolution,
): Record<string, unknown> {
  return {
    ...buildToolSelectionTraceContext(selection, toolChoice),
    messageCount: requestMetrics.messageCount,
    systemMessages: requestMetrics.systemMessages,
    userMessages: requestMetrics.userMessages,
    assistantMessages: requestMetrics.assistantMessages,
    toolMessages: requestMetrics.toolMessages,
    totalContentChars: requestMetrics.totalContentChars,
    maxMessageChars: requestMetrics.maxMessageChars,
    serializedChars: requestMetrics.serializedChars,
    ...(compactionDiagnostics
      ? {
        compactionActive: compactionDiagnostics.active,
        compactionThreshold: compactionDiagnostics.threshold,
      }
      : {}),
    configuredProviderTimeoutMs:
      timeout?.configuredProviderTimeoutMs ?? null,
    callOverrideTimeoutMs: timeout?.callOverrideTimeoutMs ?? null,
    effectiveTimeoutMs: timeout?.timeoutMs ?? null,
    timeoutSource: timeout?.source ?? "provider_default",
    timeoutMs: timeout?.timeoutMs ?? null,
  };
}

function buildProviderResponseTraceContext(
  compactionDiagnostics?: LLMCompactionDiagnostics,
  responseMeta?: ProviderResponseTraceMeta,
): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = {};
  if (compactionDiagnostics) {
    context.compactionActive = compactionDiagnostics.active;
    context.compactionObservedItemCount = compactionDiagnostics.observedItemCount;
    if (compactionDiagnostics.latestItem) {
      context.compactionLatestItem = compactionDiagnostics.latestItem;
    }
  }
  if (responseMeta?.providerRequestId) {
    context.providerRequestId = responseMeta.providerRequestId;
  }
  if (responseMeta?.providerResponseId) {
    context.providerResponseId = responseMeta.providerResponseId;
  }
  if (responseMeta?.responseStatus !== undefined) {
    context.responseStatus = responseMeta.responseStatus;
  }
  if (responseMeta?.responseStatusText) {
    context.responseStatusText = responseMeta.responseStatusText;
  }
  if (responseMeta?.responseUrl) {
    context.responseUrl = responseMeta.responseUrl;
  }
  if (responseMeta?.responseHeaders) {
    context.responseHeaders = responseMeta.responseHeaders;
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

function extractProviderRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const requestId =
    (value as { _request_id?: unknown })._request_id ??
    (value as { request_id?: unknown }).request_id ??
    (value as { requestID?: unknown }).requestID;
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : undefined;
}

function extractProviderResponseId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id =
    (value as { id?: unknown }).id ??
    (value as { response_id?: unknown }).response_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function serializeResponseHeaders(
  response: Response | undefined,
): Record<string, string> | undefined {
  if (!response) return undefined;
  const entries = Array.from(
    response.headers as unknown as Iterable<readonly [string, string]>,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function buildProviderResponseMeta(input: {
  response?: Response;
  requestId?: string | null;
  payload?: unknown;
}): ProviderResponseTraceMeta | undefined {
  const providerRequestId =
    (typeof input.requestId === "string" && input.requestId.length > 0
      ? input.requestId
      : undefined) ?? extractProviderRequestId(input.payload);
  const providerResponseId = extractProviderResponseId(input.payload);
  const responseHeaders = serializeResponseHeaders(input.response);
  const responseStatus = input.response?.status;
  const responseStatusText = input.response?.statusText;
  const responseUrl = input.response?.url;
  if (
    !providerRequestId &&
    !providerResponseId &&
    responseHeaders === undefined &&
    responseStatus === undefined &&
    !responseStatusText &&
    !responseUrl
  ) {
    return undefined;
  }
  return {
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(responseStatus !== undefined ? { responseStatus } : {}),
    ...(responseStatusText ? { responseStatusText } : {}),
    ...(responseUrl ? { responseUrl } : {}),
    ...(responseHeaders ? { responseHeaders } : {}),
  };
}

async function createWithResponseMetadata<T>(
  client: unknown,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  singleWireAttempt = false,
): Promise<{
  data: T;
  response?: Response;
  requestId?: string | null;
}> {
  const request = (client as any).responses.create(params, {
    signal,
    ...(singleWireAttempt ? { maxRetries: 0 } : {}),
  });
  if (
    request &&
    typeof request === "object" &&
    typeof (request as { withResponse?: unknown }).withResponse === "function"
  ) {
    const result = await (
      request as {
        withResponse(): Promise<{
          data: T;
          response: Response;
          request_id: string | null;
        }>;
      }
    ).withResponse();
    return {
      data: result.data,
      response: result.response,
      requestId: result.request_id,
    };
  }
  const data = await request as T;
  return {
    data,
    requestId: extractProviderRequestId(data),
  };
}

function emitProviderTraceEvent(
  options: LLMChatOptions | undefined,
  event: LLMProviderTraceEvent,
): void {
  options?.trace?.onProviderTraceEvent?.(event);
}

function errorMessageFromStreamEvent(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "Provider stream returned an error event";
  }
  const record = event as Record<string, unknown>;
  const nestedError =
    record.error &&
    typeof record.error === "object" &&
    !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  const message = record.message ?? nestedError?.message ?? record.error;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : "Provider stream returned an error event";
}

function statusFromStreamEvent(event: unknown): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const nestedError =
    record.error &&
    typeof record.error === "object" &&
    !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  const raw =
    record.status ??
    record.status_code ??
    record.statusCode ??
    nestedError?.status ??
    nestedError?.status_code ??
    nestedError?.statusCode ??
    nestedError?.code;
  const parsed =
    typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorFromStreamEvent(event: unknown): Error {
  const message = errorMessageFromStreamEvent(event);
  const status = statusFromStreamEvent(event);
  const error = new Error(message) as Error & { status?: number };
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

export class GrokProvider implements LLMProvider {
  readonly name = "grok";

  private client: unknown | null = null;
  private readonly config: GrokProviderConfig;
  /** I-2 / I-14 tracker — zeroed by AgenC post-compact cleanup via
   *  clearAllResponseIds(); used to send delta input with
   *  previous_response_id when the request shape is unchanged. */
  private readonly incrementalTracker = new IncrementalTracker();
  /** Registry unsubscribe; called on dispose to drop the tracker. */
  private readonly unregisterIncrementalTracker: () => void;
  /** I-14 auth refresh callback. Bearer-key auth has no refresh;
   *  callers can override via `withAuthRefreshCallbacks()` for OAuth
   *  flows. */
  private authRefreshCallbacks: AuthRefreshCallbacks = {
    refreshBearer: async (): Promise<AuthRefreshOutcome> => ({
      kind: "skipped",
      reason: "grok_bearer_key_mode_has_no_refresh",
    }),
  };
  private readonly rawToolsByName = new Map<string, LLMTool>();
  private readonly tools: LLMTool[];
  private readonly responseTools: Record<string, unknown>[];
  private readonly responseToolsByName = new Map<string, Record<string, unknown>>();
  private readonly responseToolCharsByName = new Map<string, number>();
  private readonly providerNativeTools: readonly ProviderNativeToolDefinition[];
  private readonly providerNativeToolsByName = new Map<
    string,
    ProviderNativeToolDefinition
  >();
  private readonly toolChars: number;
  private readonly configuredTimeoutMs: number | undefined;

  constructor(config: GrokProviderConfig) {
    this.configuredTimeoutMs = config.timeoutMs;
    this.config = {
      ...config,
      model: config.model ?? BUILT_IN_PROVIDER_DEFAULT_MODELS.grok,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS.grok,
      timeoutMs: normalizeTimeoutMs(config.timeoutMs),
      parallelToolCalls: config.parallelToolCalls ?? false,
    };

    // Build client-side function tools plus provider-native tool definitions.
    const rawTools = [...(config.tools ?? [])];
    for (const tool of rawTools) {
      this.rawToolsByName.set(tool.function.name, tool);
    }
    const slimmed = slimTools(rawTools);
    this.tools = slimmed.tools;
    this.responseTools = toXaiResponsesTools(this.tools);
    for (let i = 0; i < this.tools.length; i++) {
      const name = this.tools[i]?.function?.name;
      const responseTool = this.responseTools[i];
      if (!name || !responseTool) continue;
      this.responseToolsByName.set(name, responseTool);
      this.responseToolCharsByName.set(name, JSON.stringify(responseTool).length);
    }
    this.providerNativeTools = getProviderNativeToolDefinitions({
      provider: "grok",
      model: this.config.model,
      webSearch: this.config.webSearch,
      searchMode: this.config.searchMode,
      webSearchOptions: this.config.webSearchOptions,
      xSearch: this.config.xSearch,
      xSearchOptions: this.config.xSearchOptions,
      codeExecution: this.config.codeExecution,
      collectionsSearch: this.config.collectionsSearch,
      remoteMcp: this.config.remoteMcp,
    });
    for (const definition of this.providerNativeTools) {
      this.providerNativeToolsByName.set(definition.name, definition);
    }
    this.toolChars =
      slimmed.chars +
      this.providerNativeTools.reduce(
        (sum, definition) => sum + definition.schemaChars,
        0,
      );
    // I-2: register the tracker so AgenC post-compact cleanup can zero it.
    this.unregisterIncrementalTracker = registerIncrementalTracker(
      this.incrementalTracker,
    );
  }

  /**
   * I-14 hook point: supply real OAuth-refresh callbacks. Bearer-key
   * mode leaves the default (no-refresh) in place.
   */
  withAuthRefreshCallbacks(callbacks: AuthRefreshCallbacks): this {
    this.authRefreshCallbacks = callbacks;
    this.oauthCallbacksInstalled = true;
    return this;
  }

  /**
   * Refresh the OAuth bearer before the wire attempt when the stored grant
   * is inside its expiry window. singleWireAttempt turns cannot rely on the
   * in-band 401 retry (they are forbidden by the admission lease), so this
   * is the only recovery point on that path. No-ops in bearer-key mode, and
   * never throws: a failed pre-flight leaves the current bearer in place so
   * the wire error reports itself instead of a local refresh crash.
   */
  private oauthCallbacksInstalled = false;
  private async refreshOAuthBearerIfExpiring(): Promise<void> {
    if (!this.oauthCallbacksInstalled) return;
    try {
      const { readXaiOauthCredentials, xaiOauthTokenIsExpiring } =
        await import("../../../utils/xaiOauthCredentials.js");
      const blob = readXaiOauthCredentials();
      if (blob === undefined || blob.quarantinedAt !== undefined) return;
      if (!xaiOauthTokenIsExpiring(blob)) return;
      await this.authRefreshCallbacks.refreshBearer({
        attempt: 0,
        previousError: Object.assign(new Error("oauth_bearer_expiring"), {
          status: 401 as const,
        }),
      });
    } catch {
      // best-effort: the wire attempt surfaces its own auth failure
    }
  }

  /**
   * Swap the bearer after an OAuth refresh. The in-flight `run(plan)`
   * closures hold the already-constructed SDK client, so the new key must
   * land on that instance too — nulling the cache alone would only fix
   * requests that construct a fresh client.
   */
  applyRefreshedBearer(bearer: string): void {
    (this.config as { apiKey: string }).apiKey = bearer;
    const client = this.client as { apiKey?: string } | null;
    if (client && typeof client === "object" && "apiKey" in client) {
      client.apiKey = bearer;
    } else {
      this.client = null;
    }
  }

  /** Drop the tracker registration (used on provider swap / session shutdown). */
  dispose(): void {
    this.unregisterIncrementalTracker();
  }

  /**
   * I-2 / I-14 incremental-tracker integration for chat path.
   * Records the pre-flight request shape + post-response snapshot so
   * `clearAllResponseIds()` (called from AgenC post-compact cleanup) can
   * zero the cached previous_response_id. Matching follow-up turns reuse
   * the cached response ID and send only the delta input.
   */
  private noteIncrementalRequest(
    messages: readonly LLMMessage[],
    params: Record<string, unknown>,
  ): void {
    const shape = this.buildIncrementalRequestShape(params);
    this.incrementalTracker.recordRequest(shape, messages);
  }

  private noteIncrementalResponse(
    previousResponseId: string | undefined,
    itemsAdded: LLMMessage[],
  ): void {
    if (!previousResponseId) return;
    const snapshot: LastResponseSnapshot = {
      previousResponseId,
      itemsAdded,
      recordedAtMs: monotonicMs(),
    };
    this.incrementalTracker.recordResponse(snapshot);
  }

  private emitRuntimeWarning(cause: string, message: string): void {
    this.config.emitWarning?.({ cause, message });
  }

  private evaluateConfiguredFallback(
    error: unknown,
    consecutiveFailures: number,
    model: string = this.config.model,
    singleWireAttempt = false,
  ): ProviderFallbackDecision | null {
    if (!this.config.providerFallback) return null;
    const decision = evaluateProviderFallback({
      ...this.config.providerFallback,
      ...(singleWireAttempt ? { maxFailures: 1 } : {}),
      model,
      error,
      consecutiveFailures,
    });
    if (decision.kind === "trigger") {
      throw decision.error;
    }
    return decision;
  }

  private async waitForConfiguredFallbackRetry(
    decision: ProviderFallbackWaitDecision,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (
      decision.consecutiveFailures >
      normalizeFallbackRetryBudget(this.config.maxRetries)
    ) {
      return false;
    }
    await sleepMs(getRetryDelay(decision.consecutiveFailures), signal);
    return true;
  }

  private notifyCapabilityDrift(error: unknown): void {
    if (!this.config.onCapabilityDrift) return;
    const candidate = error as {
      readonly status?: number;
      readonly statusCode?: number;
      readonly message?: string;
    };
    const status =
      typeof candidate.status === "number"
        ? candidate.status
        : typeof candidate.statusCode === "number"
          ? candidate.statusCode
          : undefined;
    const message = String(candidate.message ?? "");
    if (!isProviderCapabilityMismatch({ status, message })) {
      return;
    }
    this.config.onCapabilityDrift({ message, status });
  }

  private buildIncrementalRequestShape(
    params: Record<string, unknown>,
  ): IncrementalRequestShape {
    return {
      model: String(params.model ?? this.config.model),
      instructions:
        typeof params.instructions === "string" ? params.instructions : undefined,
      tools: params.tools,
      parallelToolCalls:
        typeof params.parallel_tool_calls === "boolean"
          ? params.parallel_tool_calls
          : Boolean(this.config.parallelToolCalls),
      extra: {
        ...(params.prompt_cache_key !== undefined
          ? { prompt_cache_key: params.prompt_cache_key }
          : {}),
        ...(params.temperature !== undefined
          ? { temperature: params.temperature }
          : {}),
        ...(params.max_output_tokens !== undefined
          ? { max_output_tokens: params.max_output_tokens }
          : {}),
        ...(params.max_turns !== undefined ? { max_turns: params.max_turns } : {}),
        ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
        ...(params.include !== undefined ? { include: params.include } : {}),
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.tool_choice !== undefined
          ? { tool_choice: params.tool_choice }
          : {}),
      },
    };
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    let plan = this.buildRequestPlan(messages, options);
    let lastAttemptTimeoutMs: number | undefined;
    const requestTimeout = resolveRequestTimeoutMs(
      this.configuredTimeoutMs,
      options?.timeoutMs,
    );
    const requestDeadlineAt =
      typeof requestTimeout.timeoutMs === "number"
        ? Date.now() + requestTimeout.timeoutMs
        : Number.POSITIVE_INFINITY;

    const run = async (activePlan: ReturnType<GrokProvider["buildRequestPlan"]>) => {
      const activeRequestTimeout =
        Number.isFinite(requestDeadlineAt)
          ? {
            ...requestTimeout,
            timeoutMs: Math.max(1, requestDeadlineAt - Date.now()),
          }
          : requestTimeout;
      lastAttemptTimeoutMs = activeRequestTimeout.timeoutMs;
      emitProviderTraceEvent(options, {
        kind: "request",
        transport: "chat",
        provider: this.name,
        model: String(activePlan.params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(activePlan.params) ??
          { error: "provider_request_trace_unavailable" },
        context: buildProviderRequestTraceContext(
          activePlan.toolSelection,
          options?.toolChoice,
          activePlan.requestMetrics,
          activePlan.compactionDiagnostics,
          activeRequestTimeout,
        ),
      });
      try {
        const result = await withTimeout(
          async (signal) =>
            createWithResponseMetadata<Record<string, unknown>>(
              client,
              activePlan.params,
              signal,
              options?.singleWireAttempt,
            ),
          activeRequestTimeout.timeoutMs,
          this.name,
          options?.signal,
        );
        const response = result.data;
        const responseMeta = buildProviderResponseMeta({
          response: result.response,
          requestId: result.requestId,
          payload: response,
        });
        const parsed = this.parseResponse(
          response,
          activePlan.requestMetrics,
          activePlan.compactionDiagnostics,
          options?.structuredOutput,
        );
        this.emitToolCallNormalizationIssues(
          parsed.normalizationIssues,
          options,
          "chat",
          parsed.model,
        );
        emitProviderTraceEvent(options, {
          kind: "response",
          transport: "chat",
          provider: this.name,
          model: String(response?.model ?? activePlan.params.model ?? this.config.model),
          payload:
            cloneProviderTracePayload(response) ??
            { error: "provider_response_trace_unavailable" },
          context: buildProviderResponseTraceContext(
            parsed.compaction,
            responseMeta,
          ),
        });
        return parsed;
      } catch (error) {
        emitProviderTraceEvent(options, {
          kind: "error",
          transport: "chat",
          provider: this.name,
          model: String(activePlan.params.model ?? this.config.model),
          payload: buildProviderTraceErrorPayload(error),
        });
        throw error;
      }
    };

    let consecutiveFallbackFailures = 0;
    while (true) {
      try {
      // I-2 / I-14: record the outbound request shape for the
      // incremental tracker before the HTTP call. clearAllResponseIds
      // (called from AgenC post-compact cleanup) zeros this on every
      // compaction.
      this.noteIncrementalRequest(
        plan.requestMessages ?? messages,
        plan.params as Record<string, unknown>,
      );

      // OAuth pre-flight: admitted calls run singleWireAttempt (no in-band
      // retry by design — a retry needs a new durable reservation), so an
      // expiring OAuth bearer must be refreshed HERE, before the wire
      // attempt. Without this, an expired token surfaces as a bare 403
      // (xAI's expired-token status, not 401) and the turn dies with zero
      // recovery — observed in production 2026-07-19.
      await this.refreshOAuthBearerIfExpiring();

      // I-14: retry-on-401 wrapper. Bearer-key mode's refresh callback
      // returns `skipped`, so the original 401 bubbles up unchanged.
      // OAuth-capable providers install real refresh callbacks via
      // withAuthRefreshCallbacks(); bearer-key mode skips refresh.
      const parsed = options?.singleWireAttempt === true
        ? await run(plan)
        : await retryWithAuthRefresh(
          String(this.config.apiKey),
          async () => run(plan),
          this.authRefreshCallbacks,
        );

      // Record the response metadata so the tracker can supply
      // previous_response_id and delta input on the next compatible call.
      const respId = (parsed as { requestMetrics?: { responseId?: string } })
        ?.requestMetrics?.responseId;
      if (respId) {
        this.noteIncrementalResponse(respId, [
          {
            role: "assistant",
            content: parsed.content,
            ...(parsed.toolCalls.length > 0
              ? { toolCalls: parsed.toolCalls }
              : {}),
          },
        ]);
      }
      return parsed;
      } catch (err: unknown) {
      if (
        options?.singleWireAttempt !== true &&
        isContinuationRetrievalFailure(err) &&
        "previous_response_id" in plan.params
      ) {
        this.incrementalTracker.clearResponseId();
        this.emitRuntimeWarning(
          "previous_response_id_expired",
          `${this.name} rejected previous_response_id; clearing continuation state and retrying once with full history`,
        );
        try {
          const retryPlan = this.buildRequestPlan(messages, options, {
            disableIncremental: true,
          });
          this.noteIncrementalRequest(
            retryPlan.requestMessages ?? messages,
            retryPlan.params as Record<string, unknown>,
          );
          const parsed = await retryWithAuthRefresh(
            String(this.config.apiKey),
            async () => run(retryPlan),
            this.authRefreshCallbacks,
          );
          const respId = (parsed as { requestMetrics?: { responseId?: string } })
            ?.requestMetrics?.responseId;
          if (respId) {
            this.noteIncrementalResponse(respId, [
              {
                role: "assistant",
                content: parsed.content,
                ...(parsed.toolCalls.length > 0
                  ? { toolCalls: parsed.toolCalls }
                  : {}),
              },
            ]);
          }
          return parsed;
        } catch (retryErr) {
          err = retryErr;
        }
      }
      // 401s that propagated past the refresh wrapper classify through
      // the normal mapper so callers see `LLMProviderError` rather
      // than the raw transport.
      if (isFallbackTriggeredError(err)) {
        throw err;
      }
      const fallbackDecision = this.evaluateConfiguredFallback(
        err,
        consecutiveFallbackFailures,
        String(plan.params.model ?? this.config.model),
        options?.singleWireAttempt,
      );
      if (
        options?.singleWireAttempt !== true &&
        fallbackDecision?.kind === "wait" &&
        await this.waitForConfiguredFallbackRetry(
          fallbackDecision,
          options?.signal,
        )
      ) {
        consecutiveFallbackFailures = fallbackDecision.consecutiveFailures;
        continue;
      }
      consecutiveFallbackFailures = 0;
      this.notifyCapabilityDrift(err);
      if (isUnauthorizedError(err)) {
        const mapped = this.mapError(
          err,
          lastAttemptTimeoutMs ?? requestTimeout.timeoutMs,
        );
        this.logPromptOverflowDiagnostics(mapped, plan.params);
        throw mapped;
      }
      const mapped = this.mapError(
        err,
        lastAttemptTimeoutMs ?? requestTimeout.timeoutMs,
      );
      this.logPromptOverflowDiagnostics(mapped, plan.params);
      throw mapped;
      }
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    let plan = this.buildRequestPlan(messages, options);
    this.noteIncrementalRequest(
      plan.requestMessages ?? messages,
      plan.params as Record<string, unknown>,
    );
    let params: Record<string, unknown> = { ...plan.params, stream: true };
    const requestMetrics = {
      ...plan.requestMetrics,
      stream: true,
    };
    const compactionDiagnostics = plan.compactionDiagnostics;
    const streamTimeout = resolveRequestTimeoutMs(
      this.configuredTimeoutMs,
      options?.timeoutMs,
    );
    const streamDeadlineAt =
      typeof streamTimeout.timeoutMs === "number"
        ? Date.now() + streamTimeout.timeoutMs
        : Number.POSITIVE_INFINITY;

    let consecutiveFallbackFailures = 0;
    while (true) {
      // Per-attempt accumulators must be re-initialised on every retry so a
      // configured-fallback retry (continue below) starts clean. Declaring
      // these outside the loop would carry attempt-1 state (e.g. streamed
      // reasoning summaries) into attempt 2 and duplicate it.
      let content = "";
      let model = this.config.model;
      let finishReason: LLMResponse["finishReason"] = "stop";
      let responseError: Error | undefined;
      let usage: LLMUsage = coerceUsage({});
      let providerEvidence: LLMResponse["providerEvidence"];
      let encryptedReasoning: LLMResponse["encryptedReasoning"];
      const toolCallAccum = new Map<string, LLMToolCall>();
      // Per-summary-index buffers for streamed reasoning summaries. xAI may
      // emit multiple summary blocks in one turn; each lands at its own index.
      const reasoningSummaryBuffers = new Map<number, string>();
      let streamIterator: AsyncIterator<any> | null = null;
      let responseTracePayload: Record<string, unknown> | undefined;
      let streamResponseMeta: ProviderResponseTraceMeta | undefined;
      try {
      // OAuth pre-flight (same as the chat path): admitted turns stream with
      // singleWireAttempt, so the in-band 401 retry never runs here — the
      // expiring bearer must be refreshed before the wire attempt.
      await this.refreshOAuthBearerIfExpiring();
      const requestAttemptTimeout =
        Number.isFinite(streamDeadlineAt)
          ? {
            ...streamTimeout,
            timeoutMs: Math.max(1, streamDeadlineAt - Date.now()),
          }
          : streamTimeout;
      emitProviderTraceEvent(options, {
        kind: "request",
        transport: "chat_stream",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(params) ??
          { error: "provider_request_trace_unavailable" },
        context: buildProviderRequestTraceContext(
          plan.toolSelection,
          options?.toolChoice,
          requestMetrics,
          compactionDiagnostics,
          requestAttemptTimeout,
        ),
      });
      let result;
      try {
        result = await withTimeout(
          async (signal) =>
            createWithResponseMetadata<AsyncIterable<any>>(
              client,
              params,
              signal,
              options?.singleWireAttempt,
            ),
          requestAttemptTimeout.timeoutMs,
          this.name,
          options?.signal,
        );
      } catch (err) {
        if (
          options?.singleWireAttempt !== true &&
          isContinuationRetrievalFailure(err) &&
          "previous_response_id" in params
        ) {
          this.incrementalTracker.clearResponseId();
          this.emitRuntimeWarning(
            "previous_response_id_expired",
            `${this.name} rejected previous_response_id; clearing continuation state and retrying once with full history`,
          );
          plan = this.buildRequestPlan(messages, options, {
            disableIncremental: true,
          });
          this.noteIncrementalRequest(
            plan.requestMessages ?? messages,
            plan.params as Record<string, unknown>,
          );
          params = { ...plan.params, stream: true };
          result = await withTimeout(
            async (signal) =>
              createWithResponseMetadata<AsyncIterable<any>>(
                client,
                params,
                signal,
                options?.singleWireAttempt,
              ),
            requestAttemptTimeout.timeoutMs,
            this.name,
            options?.signal,
          );
        } else {
          throw err;
        }
      }
      const stream = result.data;
      streamResponseMeta = buildProviderResponseMeta({
        response: result.response,
        requestId: result.requestId,
      });
      emitProviderTraceEvent(options, {
        kind: "stream_event",
        transport: "chat_stream",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload: { type: "stream.open" },
        context: {
          eventIndex: 0,
          eventType: "stream.open",
          ...(
            streamResponseMeta
              ? streamResponseMeta
              : {}
          ),
        },
      });

      streamIterator = stream[Symbol.asyncIterator]();
      if (streamIterator === null) {
        throw new LLMProviderError(this.name, "provider stream did not open");
      }
      let streamEventIndex = 0;
      const streamOpenedAt = Date.now();
      let receivedTerminalEvent = false;

      while (true) {
        // gaphunt3 #21: a caller abort mid-stream must tear the open stream
        // down promptly. withTimeout only links options.signal until the stream
        // opens, so re-check it here and inside nextStreamChunkWithTimeout
        // (which rejects when the signal fires while awaiting the next chunk).
        if (options?.signal?.aborted) {
          throw createStreamAbortError(this.name);
        }
        const remainingStreamMs = Number.isFinite(streamDeadlineAt)
          ? Math.max(0, streamDeadlineAt - Date.now())
          : undefined;
        if (
          typeof remainingStreamMs === "number" &&
          remainingStreamMs <= 0
        ) {
          throw createStreamTimeoutError(
            this.name,
            streamTimeout.timeoutMs ?? options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          );
        }
        const iterResult = await nextStreamChunkWithTimeout(
          streamIterator,
          remainingStreamMs,
          this.name,
          options?.signal,
        );
        if (iterResult.done) break;
        const event = iterResult.value;
        streamEventIndex += 1;
        emitProviderTraceEvent(options, {
          kind: "stream_event",
          transport: "chat_stream",
          provider: this.name,
          model,
          payload:
            cloneProviderTracePayload(event) ??
            {
              type:
                typeof event?.type === "string" && event.type.length > 0
                  ? event.type
                  : "stream.event",
            },
          context: {
            eventIndex: streamEventIndex,
            eventType:
              typeof event?.type === "string" && event.type.length > 0
                ? event.type
                : "stream.event",
            streamElapsedMs: Math.max(0, Date.now() - streamOpenedAt),
            ...(streamResponseMeta ? streamResponseMeta : {}),
          },
        });

        if (event.type === "response.output_text.delta") {
          const delta = String(event.delta ?? "");
          if (delta.length > 0) {
            content += delta;
            onChunk({ content: delta, done: false });
          }
          continue;
        }

        if (event.type === "response.reasoning_summary_text.delta") {
          // grok-4.3 reasoning summary chunks. xAI emits these alongside
          // `response.output_text.delta`; both can interleave during a turn.
          // Forward as a `reasoningSummaryDelta` so stream-model translates
          // into the same `assistant_thinking_*` session-event family the
          // messages-API thinking blocks ride. The summary index lets us
          // distinguish multiple summary blocks per response.
          const delta = String(event.delta ?? "");
          const summaryIndex =
            typeof event.summary_index === "number" ? event.summary_index : 0;
          if (delta.length > 0) {
            const previous = reasoningSummaryBuffers.get(summaryIndex) ?? "";
            reasoningSummaryBuffers.set(summaryIndex, previous + delta);
            onChunk({
              content: "",
              done: false,
              reasoningSummaryDelta: { delta, summaryIndex },
            });
          }
          continue;
        }

        if (event.type === "response.output_item.done") {
          const { toolCall, issue } = this.toToolCall(event.item);
          if (toolCall) {
            toolCallAccum.set(toolCall.id, toolCall);
          }
          if (issue) {
            this.emitToolCallNormalizationIssues(
              [issue],
              options,
              "chat_stream",
              model,
            );
          }
          continue;
        }

        if (event.type === "error") {
          receivedTerminalEvent = true;
          emitProviderTraceEvent(options, {
            kind: "error",
            transport: "chat_stream",
            provider: this.name,
            model,
            payload:
              cloneProviderTracePayload(event) ??
              { error: "provider_error_trace_unavailable" },
            context: buildProviderResponseTraceContext(
              undefined,
              streamResponseMeta,
            ),
          });
          finishReason = "error";
          responseError = this.mapError(
            errorFromStreamEvent(event),
            streamTimeout.timeoutMs,
          );
          break;
        }

        if (event.type === "response.completed") {
          receivedTerminalEvent = true;
          const response = event.response ?? {};

          streamResponseMeta = {
            ...(streamResponseMeta ?? {}),
            ...(buildProviderResponseMeta({ payload: response }) ?? {}),
          };
          responseTracePayload =
            cloneProviderTracePayload(response) ??
            { error: "provider_response_trace_unavailable" };
          model = String(response.model ?? model);
          usage = this.parseUsage(response);
          providerEvidence = this.extractProviderEvidence(
            response as Record<string, unknown>,
          );
          encryptedReasoning = this.extractEncryptedReasoningDiagnostics(
            response as Record<string, unknown>,
          );
          const {
            toolCalls: completedToolCalls,
            normalizationIssues,
          } = this.extractToolCallsFromOutput(response.output);
          for (const toolCall of completedToolCalls) {
            toolCallAccum.set(toolCall.id, toolCall);
          }

          this.emitToolCallNormalizationIssues(
            normalizationIssues,
            options,
            "chat_stream",
            model,
          );
          finishReason = this.mapResponseFinishReason(response, Array.from(toolCallAccum.values()));
          responseError = this.extractResponseError(response, finishReason);
          const outputText = String(response.output_text ?? "");
          if (outputText && content.length === 0) {
            content = outputText;
          }
          break;
        }

        if (event.type === "response.failed") {
          receivedTerminalEvent = true;
          const failedResponse =
            event.response && typeof event.response === "object"
              ? (event.response as Record<string, unknown>)
              : {};
          streamResponseMeta = {
            ...(streamResponseMeta ?? {}),
            ...(buildProviderResponseMeta({ payload: failedResponse }) ?? {}),
          };
          emitProviderTraceEvent(options, {
            kind: "error",
            transport: "chat_stream",
            provider: this.name,
            model: String(failedResponse.model ?? model),
            payload:
              cloneProviderTracePayload(failedResponse) ??
              { error: "provider_error_trace_unavailable" },
            context: buildProviderResponseTraceContext(
              undefined,
              streamResponseMeta,
            ),
          });
          finishReason = "error";
          responseError =
            this.extractResponseError(failedResponse, "error") ??
            new LLMProviderError(this.name, "Provider returned status failed");
          break;
        }
      }

      if (!receivedTerminalEvent && finishReason === "stop") {
        finishReason = "error";
        responseError = responseError ?? new LLMProviderError(
          this.name,
          "Stream closed without a response.completed or response.failed event",
        );
      }

      const toolCalls = Array.from(toolCallAccum.values());
      if (toolCalls.length > 0 && finishReason === "stop") finishReason = "tool_calls";

      onChunk({ content: "", done: true, toolCalls });

      // Materialise the streamed reasoning summaries into the LLMResponse
      // shape so stream-model emits a final `agent_thinking` per block,
      // which the TUI reducer dedupes and persists as a transcript row.
      const thinking = Array.from(reasoningSummaryBuffers.entries())
        .sort(([a], [b]) => a - b)
        .map(([, text]) => ({
          text,
          redacted: false,
          kind: "reasoning_summary" as const,
        }))
        .filter((block) => block.text.length > 0);

      const parsed: LLMResponse = {
        content,
        toolCalls,
        usage,
        model,
        requestMetrics,
        compaction: compactionDiagnostics,
        providerEvidence,
        structuredOutput:
          options?.structuredOutput?.enabled === false ||
            !options?.structuredOutput?.schema ||
            content.trim().length === 0
            ? undefined
            : parseStructuredOutputText(
              content,
              options.structuredOutput.schema.name,
              options.structuredOutput.schema.schema,
            ),
        encryptedReasoning,
        finishReason,
        ...(thinking.length > 0 ? { thinking } : {}),
        ...(responseError ? { error: responseError } : {}),
      };
      emitProviderTraceEvent(options, {
        kind: "response",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload:
          responseTracePayload ?? { error: "provider_response_trace_unavailable" },
          context: buildProviderResponseTraceContext(
            parsed.compaction,
            streamResponseMeta,
          ),
        });
      return parsed;
      } catch (err: unknown) {
      emitProviderTraceEvent(options, {
        kind: "error",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload: buildProviderTraceErrorPayload(err),
      });
      if (isFallbackTriggeredError(err)) {
        throw err;
      }
      if (content.length === 0 && toolCallAccum.size === 0) {
        const fallbackDecision = this.evaluateConfiguredFallback(
          err,
          consecutiveFallbackFailures,
          String(params.model ?? this.config.model),
          options?.singleWireAttempt,
        );
        if (
          options?.singleWireAttempt !== true &&
          fallbackDecision?.kind === "wait" &&
          await this.waitForConfiguredFallbackRetry(
            fallbackDecision,
            options?.signal,
          )
        ) {
          consecutiveFallbackFailures = fallbackDecision.consecutiveFailures;
          params = { ...plan.params, stream: true };
          continue;
        }
      }
      consecutiveFallbackFailures = 0;
      this.notifyCapabilityDrift(err);
      const mappedError = this.mapError(err, streamTimeout.timeoutMs);
      this.logPromptOverflowDiagnostics(mappedError, params);
      if (content.length > 0) {
        const partialToolCalls: LLMToolCall[] = Array.from(toolCallAccum.values());

        onChunk({ content: "", done: true, toolCalls: partialToolCalls });
        return {
          content,
          toolCalls: partialToolCalls,
          usage: {
            ...usage,
            availability: "unknown",
            provenance: "synthetic",
          },
          model,
          requestMetrics,
          compaction: compactionDiagnostics,
          providerEvidence,
          structuredOutput:
            options?.structuredOutput?.enabled === false ||
              !options?.structuredOutput?.schema ||
              content.trim().length === 0
              ? undefined
              : parseStructuredOutputText(
                content,
                options.structuredOutput.schema.name,
                options.structuredOutput.schema.schema,
              ),
          finishReason: "error",
          error: mappedError,
          partial: true,
        };
      }
      throw mappedError;
      } finally {
      if (streamIterator) await closeAsyncIterator(streamIterator);
      streamIterator = null;
    }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      await (client as any).models.list();
      return true;
    } catch {
      return false;
    }
  }

  async prewarmStartup(
    _params: LLMProviderStartupPrewarmParams,
  ): Promise<LLMProviderStartupPrewarmHandle> {
    const client = await this.ensureClient();
    await (client as any).models.list();
    return {
      chatStream: (messages, onChunk, options) =>
        this.chatStream(messages, onChunk, options),
    };
  }

  async retrieveStoredResponse(responseId: string): Promise<LLMStoredResponse> {
    const trimmedResponseId = responseId.trim();
    if (trimmedResponseId.length === 0) {
      throw new LLMProviderError(
        this.name,
        "Stored response retrieval requires a non-empty response ID.",
        400,
      );
    }
    try {
      const client = await this.ensureClient();
      const response = await (client as any).responses.retrieve(trimmedResponseId);
      return this.toStoredResponse(response);
    } catch (error) {
      throw mapLLMError(this.name, error, this.config.timeoutMs ?? 0);
    }
  }

  async deleteStoredResponse(
    responseId: string,
  ): Promise<LLMStoredResponseDeleteResult> {
    const trimmedResponseId = responseId.trim();
    if (trimmedResponseId.length === 0) {
      throw new LLMProviderError(
        this.name,
        "Stored response deletion requires a non-empty response ID.",
        400,
      );
    }
    try {
      const client = await this.ensureClient();
      const response = await (client as any).responses.delete(trimmedResponseId);
      return {
        id:
          typeof response?.id === "string" && response.id.trim().length > 0
            ? response.id.trim()
            : trimmedResponseId,
        provider: this.name,
        deleted: response?.deleted === true,
        raw:
          response && typeof response === "object" && !Array.isArray(response)
            ? cloneProviderTracePayload(response as Record<string, unknown>)
            : undefined,
      };
    } catch (error) {
      throw mapLLMError(this.name, error, this.config.timeoutMs ?? 0);
    }
  }


  async getExecutionProfile() {
    return (
      await resolveContextWindowProfile({
        provider: "grok",
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseURL,
        model: this.config.model,
        maxTokens:
          typeof this.config.maxTokens === "number" && this.config.maxTokens > 0
            ? this.config.maxTokens
            : undefined,
        contextWindowTokens: this.config.contextWindowTokens,
      })
    ) ?? {
      provider: "grok",
      model: this.config.model,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
      maxOutputTokens:
        typeof this.config.maxTokens === "number" && this.config.maxTokens > 0
          ? this.config.maxTokens
          : undefined,
    };
  }

  private buildRequestPlan(
    messages: readonly LLMMessage[],
    options?: LLMChatOptions,
    overrides?: {
      disableIncremental?: boolean;
    },
  ): {
    params: Record<string, unknown>;
    requestMetrics: LLMRequestMetrics;
    toolSelection: ToolSelectionDiagnostics;
    compactionDiagnostics?: LLMCompactionDiagnostics;
    requestMessages?: readonly LLMMessage[];
  } {
    const compactionDiagnostics = undefined;
    const toolSelection = this.resolveResponseTools(
      options?.toolRouting?.allowedToolNames,
      options?.toolChoice,
      options?.tools,
    );
    const built = this.buildParams(messages, {
      store: false,
      allowedToolNames: options?.toolRouting?.allowedToolNames,
      toolChoice: options?.toolChoice,
      maxOutputTokens: options?.maxOutputTokens,
      maxTurns: options?.maxTurns,
      model: options?.model?.trim() || undefined,
      reasoningEffort: options?.reasoningEffort,
      includeEncryptedReasoning: options?.includeEncryptedReasoning,
      structuredOutput: options?.structuredOutput,
      toolSelection,
      promptCacheKey: options?.promptCacheKey?.trim() || undefined,
      systemPrompt: options?.systemPrompt?.trim() || undefined,
      disableIncremental: overrides?.disableIncremental,
    });
    return {
      params: built.params,
      requestMetrics: collectParamDiagnostics(
        built.params,
        built.toolSelection,
      ),
      toolSelection: built.toolSelection,
      compactionDiagnostics,
      requestMessages: built.requestMessages,
    };
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyImport("openai", this.name, (mod) => {
      const ProviderSdk = (mod.default ?? mod.OpenAI ?? mod) as any; // branding-scan: allow real SDK export
      return new ProviderSdk({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        timeout: this.config.timeoutMs,
        maxRetries: this.config.maxRetries ?? 2,
      });
    });
    return this.client;
  }

  private buildParams(
    messages: readonly LLMMessage[],
    options?: {
      store?: boolean;
      allowedToolNames?: readonly string[];
      toolChoice?: LLMToolChoice;
      maxOutputTokens?: number;
      maxTurns?: number;
      reasoningEffort?: LLMChatOptions["reasoningEffort"];
      includeEncryptedReasoning?: boolean;
      structuredOutput?: LLMChatOptions["structuredOutput"];
      toolSelection?: ToolSelectionDiagnostics;
      model?: string;
      promptCacheKey?: string;
      systemPrompt?: string;
      disableIncremental?: boolean;
    },
  ): {
    params: Record<string, unknown>;
    toolSelection: ToolSelectionDiagnostics;
    requestMessages: readonly LLMMessage[];
  } {
    const visionModel = this.config.visionModel ?? DEFAULT_VISION_MODEL;
    // Prefix-cache split: xAI caching is prefix-based ("never modify
    // earlier messages — only append"), so the volatile tail of the
    // system prompt (timestamp, git state, …) must not sit at the front
    // where it diverges every turn and prevents the system + history
    // prefix from ever being served from cache. Static head leads,
    // dynamic tail becomes the FINAL message.
    const { staticPrefix: staticSystemPrompt, dynamicSuffix: dynamicSystemPrompt } =
      splitSystemPromptOnDynamicBoundary(options?.systemPrompt);
    const requestMessages = [
      ...(staticSystemPrompt !== undefined
        ? [{ role: "system" as const, content: staticSystemPrompt }]
        : []),
      ...messages,
      ...(dynamicSystemPrompt !== undefined
        ? [{ role: "system" as const, content: dynamicSystemPrompt }]
        : []),
    ];
    const repairedMessages = repairToolTurnSequence(requestMessages);
    validateToolTurnSequence(repairedMessages, {
      providerName: this.name,
    });

    const xaiInput = buildXaiResponsesInputItems(repairedMessages);
    const model =
      options?.model ?? (xaiInput.hasImages ? visionModel : this.config.model);

    const params: Record<string, unknown> = {
      model,
      input: xaiInput.input,
      store: options?.store ?? false,
    };
    // Cut 5.10: xAI prompt caching is prefix-based and is maximized by
    // routing requests with the same conversation ID to the same
    // server. For the Responses API, that routing hint is the
    // `prompt_cache_key` request field. Feed it the session ID so
    // every turn in the same AgenC session lands on the same backend
    // and reuses the previously-cached system + history prefix.
    if (options?.promptCacheKey) {
      params.prompt_cache_key = options.promptCacheKey;
    }
    if (this.config.temperature !== undefined)
      params.temperature = this.config.temperature;
    if (
      typeof options?.maxOutputTokens === "number" &&
      Number.isFinite(options.maxOutputTokens) &&
      options.maxOutputTokens > 0
    ) {
      params.max_output_tokens = Math.floor(options.maxOutputTokens);
    }
    const maxTurns = options?.maxTurns ?? this.config.maxTurns;
    if (
      typeof maxTurns === "number" &&
      Number.isFinite(maxTurns) &&
      maxTurns > 0
    ) {
      params.max_turns = Math.floor(maxTurns);
    }
    const reasoningEffort =
      options?.reasoningEffort ?? this.config.reasoningEffort;
    // Send `reasoning.effort` only for documented xAI models. Strip the field
    // for unsupported models (matching the chat-completions wire strip) so an
    // inherited config cannot hard-fail an otherwise valid request.
    if (reasoningEffort && supportsXaiReasoningEffortParam(model)) {
      params.reasoning = { effort: reasoningEffort };
    }
    const includeEncryptedReasoning =
      options?.includeEncryptedReasoning ?? this.config.includeEncryptedReasoning;
    if (includeEncryptedReasoning) {
      params.include = [XAI_ENCRYPTED_REASONING_INCLUDE];
    }
    const selectedTools = {
      ...(options?.toolSelection ??
        this.resolveResponseTools(options?.allowedToolNames)),
    };
    const structuredOutputSchema = options?.structuredOutput?.schema;
    const structuredOutputEnabled =
      options?.structuredOutput?.enabled !== false &&
      structuredOutputSchema !== undefined;
    // Enable tools unless the vision model is known to not support them.
    //
    // Removed 2026-04-09: the previous logic also dropped the entire tools
    // array on any follow-up turn whose tool-schema serialized to more than
    // MAX_TOOL_SCHEMA_CHARS_FOLLOWUP (= 20_000) characters, on the
    // assumption that this would save tokens. With AgenC's full system tool
    // catalog (40+ tools, verbose descriptions) the schema sits well above
    // 20K, so every chat turn that produced a tool result was followed by a
    // model call with `tools: []`. The model would then return text-only
    // (because there were no tools to call), the tool loop would exit
    // because `finishReason !== "tool_calls"`, and from the user's
    // perspective the agent would do exactly one tool call per chat turn
    // and then "give up". xAI's prompt cache deduplicates the tool schema
    // across requests in the same session, so always sending the tools
    // array is cheap; the previous guard was a token-saving theory that
    // silently broke multi-step tool sequences end-to-end.
    if (selectedTools.tools.length > 0) {
      if (!xaiInput.hasImages || VISION_MODELS_WITH_TOOLS.has(visionModel)) {
        params.tools = selectedTools.tools;
        selectedTools.toolsAttached = true;
        params.parallel_tool_calls = this.config.parallelToolCalls;
        const toolChoice = resolveXaiResponsesToolChoice(options?.toolChoice);
        if (toolChoice !== undefined) {
          params.tool_choice = toolChoice;
        }
      } else {
        selectedTools.toolSuppressionReason = "vision_model_without_tool_support";
      }
    }
    if (structuredOutputEnabled && structuredOutputSchema) {
      // Fail closed when the configured model cannot honor structured outputs
      // with tools. The previous "graceful fallback" silently stripped the
      // structured output and continued, which masked configuration errors
      // (e.g. a planner step routed to grok-code-fast-1 instead of a Grok 4
      // model). The runtime compatibility rule for undocumented 200s
      // applies here: raise the assertion at the adapter boundary so the
      // user fixes the config instead of getting a degraded run.
      assertProviderStructuredOutputCompatibility({
        providerName: this.name,
        model: typeof params.model === "string" ? params.model : this.config.model,
        structuredOutput: options?.structuredOutput,
        toolsRequested: selectedTools.toolsAttached,
        api: "responses",
      });
      assertXaiStructuredOutputToolCompatibility({
        providerName: this.name,
        model: typeof params.model === "string" ? params.model : this.config.model,
        structuredOutputRequested: true,
        toolsRequested: selectedTools.toolsAttached,
      });
      const structuredFormat = buildStructuredOutputTextFormat(
        options?.structuredOutput,
        this.config.structuredOutputs?.strict ?? true,
      );
      params.text = {
        format: structuredFormat,
      };
    }
    if (!options?.disableIncremental) {
      const previousResponseId = this.incrementalTracker.previousResponseId();
      const decision = this.incrementalTracker.decide({
        currentShape: this.buildIncrementalRequestShape(params),
        currentInput: repairedMessages,
      });
      if (decision.kind === "reuse" && previousResponseId) {
        const deltaBuilt = this.buildParams(decision.delta, {
          ...options,
          disableIncremental: true,
        });
        params.input = deltaBuilt.params.input;
        params.previous_response_id = previousResponseId;
      }
    }

    return {
      params,
      toolSelection: selectedTools,
      requestMessages: repairedMessages,
    };
  }

  private resolveResponseTools(
    allowedToolNames?: readonly string[],
    toolChoice?: LLMToolChoice,
    requestTools?: readonly LLMTool[],
  ): ToolSelectionDiagnostics {
    // xAI multi-agent: no client-side function tools — built-ins + remote MCP only.
    const multiAgentNoClientTools = isGrokMultiAgentModel(this.config.model);
    const rawRequestTools = requestTools ? [...requestTools] : undefined;
    const requestToolCatalog = multiAgentNoClientTools
      ? undefined
      : rawRequestTools
        ? slimTools(rawRequestTools).tools
        : undefined;
    const responseTools = multiAgentNoClientTools
      ? []
      : requestToolCatalog
        ? toXaiResponsesTools(requestToolCatalog)
        : this.responseTools;
    const rawToolsByName = multiAgentNoClientTools
      ? new Map<string, LLMTool>()
      : rawRequestTools
        ? new Map(rawRequestTools.map((tool) => [tool.function.name, tool]))
        : this.rawToolsByName;
    const responseToolsByName = multiAgentNoClientTools
      ? new Map<string, Record<string, unknown>>()
      : requestToolCatalog
        ? new Map(
            responseTools
              .map((tool, index) => {
                const name = requestToolCatalog[index]?.function?.name;
                return name ? [name, tool] : undefined;
              })
              .filter(
                (
                  entry,
                ): entry is [string, Record<string, unknown>] =>
                  entry !== undefined,
              ),
          )
        : this.responseToolsByName;
    const responseToolCharsByName = multiAgentNoClientTools
      ? new Map<string, number>()
      : requestToolCatalog
        ? new Map(
            responseTools
              .map((tool, index) => {
                const name = requestToolCatalog[index]?.function?.name;
                return name ? [name, JSON.stringify(tool).length] : undefined;
              })
              .filter(
                (
                  entry,
                ): entry is [string, number] => entry !== undefined,
              ),
          )
        : this.responseToolCharsByName;
    const providerNativeTools = this.providerNativeTools;
    const providerCatalogToolCount =
      responseTools.length + providerNativeTools.length;
    const providerCatalogToolNames = [
      ...extractTraceToolNames(responseTools),
      ...providerNativeTools.map((definition) => definition.name),
    ];
    const fullCatalogTools = [
      ...responseTools,
      ...providerNativeTools.map((definition) => definition.payload),
    ];
    if (allowedToolNames === undefined) {
      if (toolChoice === "none") {
        return {
          tools: [],
          chars: 0,
          requestedToolNames: [],
          resolvedToolNames: [],
          missingRequestedToolNames: [],
          providerCatalogToolCount,
          toolResolution: "all_tools_empty_filter",
          toolsAttached: false,
          toolSuppressionReason: "tool_choice_none",
        };
      }
      return {
        tools: fullCatalogTools,
        chars: multiAgentNoClientTools
          ? fullCatalogTools.reduce(
              (sum, tool) => sum + JSON.stringify(tool).length,
              0,
            )
          : rawRequestTools
            ? fullCatalogTools.reduce(
                (sum, tool) => sum + JSON.stringify(tool).length,
                0,
              )
            : this.toolChars,
        requestedToolNames: [],
        resolvedToolNames: providerCatalogToolNames,
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: multiAgentNoClientTools
          ? "multi_agent_server_tools_only"
          : "all_tools_no_filter",
        toolsAttached: false,
        ...(multiAgentNoClientTools
          ? { toolSuppressionReason: "multi_agent_no_client_function_tools" }
          : {}),
      };
    }

    if (allowedToolNames.length === 0) {
      console.warn("[GrokProvider] Tool allowlist resolved to empty set — all tools suppressed for this call");
      return {
        tools: [],
        chars: 0,
        requestedToolNames: [],
        resolvedToolNames: [],
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_empty_filter",
        toolsAttached: false,
        toolSuppressionReason: "empty_allowlist",
      };
    }

    const allowed = new Set(
      allowedToolNames
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );
    if (allowed.size === 0) {
      return {
        tools: [],
        chars: 0,
        requestedToolNames: [],
        resolvedToolNames: [],
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_empty_filter",
        toolsAttached: false,
        toolSuppressionReason: "empty_allowlist",
      };
    }

    const requestedToolNames = [...allowed];
    const selected: Record<string, unknown>[] = [];
    const resolvedToolNames: string[] = [];
    let chars = 0;
    for (const name of requestedToolNames) {
      let responseTool = responseToolsByName.get(name);
      let responseToolChars = responseToolCharsByName.get(name);
      if (!responseTool) {
        const rawTool = rawToolsByName.get(name);
        if (rawTool) {
          const slimTool = toSlimTool(rawTool);
          responseTool = toXaiResponsesTools([slimTool.tool])[0];
          responseToolChars = JSON.stringify(responseTool).length;
        }
      }
      if (responseTool) {
        selected.push(responseTool);
        resolvedToolNames.push(name);
        chars += responseToolChars ?? JSON.stringify(responseTool).length;
        continue;
      }
      const providerNativeTool = this.providerNativeToolsByName.get(name);
      if (!providerNativeTool) continue;
      selected.push(providerNativeTool.payload);
      resolvedToolNames.push(name);
      chars += providerNativeTool.schemaChars;
    }
    const missingRequestedToolNames = requestedToolNames.filter((name) =>
      !resolvedToolNames.includes(name)
    );

    if (selected.length === 0) {
      // The caller explicitly constrained the allowlist to a set of tool
      // names, but none of those names resolved against the provider
      // catalog (typo, removed tool, role mismatch, etc.). Returning the
      // FULL catalog here would silently bypass the allowlist constraint
      // — exactly the fail-open behavior the audit flagged. Instead emit
      // an empty tool set with a diagnostic resolution code so the
      // executor can decide to abort, retry without tools, or surface a
      // clear error to the operator. The previous behavior shipped under
      // `fallback_full_catalog_no_matches` is removed.
      console.warn(
        `[GrokProvider] Tool allowlist resolved to ${requestedToolNames.length} names but zero matched the provider catalog — suppressing all tools for this call (requested: ${requestedToolNames.join(", ")})`,
      );
      return {
        tools: [],
        chars: 0,
        requestedToolNames,
        resolvedToolNames: [],
        missingRequestedToolNames: requestedToolNames,
        providerCatalogToolCount,
        toolResolution: "subset_no_resolved_matches",
        toolsAttached: false,
        toolSuppressionReason: "no_allowlist_matches",
      };
    }

    return {
      tools: selected,
      chars,
      requestedToolNames,
      resolvedToolNames,
      missingRequestedToolNames,
      providerCatalogToolCount,
      toolResolution:
        missingRequestedToolNames.length > 0 ? "subset_partial" : "subset_exact",
      toolsAttached: false,
    };
  }

  private parseResponse(
    response: any,
    requestMetrics?: LLMRequestMetrics,
    compactionDiagnostics?: LLMCompactionDiagnostics,
    structuredOutputRequest?: LLMChatOptions["structuredOutput"],
  ): LLMResponse & {
    normalizationIssues?: readonly ToolCallNormalizationIssue[];
  } {
    const { toolCalls, normalizationIssues } = this.extractToolCallsFromOutput(
      response.output,
    );

    const finishReason = this.mapResponseFinishReason(response, toolCalls);
    const compaction = compactionDiagnostics;
    const parsedError = this.extractResponseError(response, finishReason);

    return {
      content: this.extractOutputText(response) ?? "",
      toolCalls,
      usage: this.parseUsage(response),
      model: String(response.model ?? this.config.model),
      requestMetrics,
      compaction,
      providerEvidence: this.extractProviderEvidence(response),
      structuredOutput: this.extractStructuredOutputResult(
        response,
        structuredOutputRequest,
      ),
      encryptedReasoning: this.extractEncryptedReasoningDiagnostics(response, {
        requested: this.config.includeEncryptedReasoning,
      }),
      finishReason,
      ...(normalizationIssues.length > 0 ? { normalizationIssues } : {}),
      ...(parsedError ? { error: parsedError } : {}),
    };
  }

  private toStoredResponse(response: Record<string, unknown>): LLMStoredResponse {
    const parsed = this.parseResponse(response);
    const encryptedReasoning = this.extractEncryptedReasoningDiagnostics(response, {
      requested: undefined,
    });
    const responseId =
      typeof response.id === "string" && response.id.trim().length > 0
        ? response.id.trim()
        : undefined;
    if (!responseId) {
      throw new LLMProviderError(
        this.name,
        "Stored response payload did not include an id.",
        502,
      );
    }
    const rawOutput = Array.isArray(response.output)
      ? response.output
          .filter((item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item)
          )
          .map((item) => cloneProviderTracePayload(item))
          .filter((item): item is Record<string, unknown> => item !== undefined)
      : undefined;
    return {
      id: responseId,
      provider: this.name,
      ...(typeof response.model === "string" && response.model.trim().length > 0
        ? { model: response.model.trim() }
        : {}),
      ...(typeof response.status === "string" && response.status.trim().length > 0
        ? { status: response.status.trim() }
        : {}),
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      ...(parsed.usage.totalTokens > 0 ||
        parsed.usage.promptTokens > 0 ||
        parsed.usage.completionTokens > 0
        ? { usage: parsed.usage }
        : {}),
      ...(parsed.providerEvidence ? { providerEvidence: parsed.providerEvidence } : {}),
      ...(parsed.structuredOutput ? { structuredOutput: parsed.structuredOutput } : {}),
      ...(encryptedReasoning ? { encryptedReasoning } : {}),
      ...(rawOutput ? { output: rawOutput } : {}),
      raw: cloneProviderTracePayload(response),
    };
  }

  private extractOutputText(response: Record<string, unknown>): string | undefined {
    const direct = response.output_text;
    if (typeof direct === "string") return direct;

    const output = Array.isArray(response.output)
      ? (response.output as Array<Record<string, unknown>>)
      : [];
    const chunks: string[] = [];
    let hasReasoningItems = false;
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "reasoning") hasReasoningItems = true;
      if (item.type !== "message") continue;
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      for (const part of content) {
        if (part.type === "output_text") {
          const text = part.text;
          if (typeof text === "string" && text.length > 0) {
            chunks.push(text);
          }
        }
      }
    }
    return chunks.length > 0 ? chunks.join("") : (hasReasoningItems ? undefined : "");
  }

  private extractStructuredOutputResult(
    response: Record<string, unknown>,
    structuredOutputRequest?: LLMChatOptions["structuredOutput"],
  ): LLMResponse["structuredOutput"] {
    const schema = structuredOutputRequest?.schema;
    if (structuredOutputRequest?.enabled === false || !schema) {
      return undefined;
    }
    const rawText = this.extractOutputText(response);
    if (rawText === undefined || rawText.trim().length === 0) return undefined;
    return parseStructuredOutputText(rawText, schema.name, schema.schema);
  }

  private parseUsage(response: Record<string, unknown>): LLMUsage {
    const usage = response.usage as Record<string, unknown> | undefined;
    const inputDetails =
      usage?.input_tokens_details &&
        typeof usage.input_tokens_details === "object" &&
        !Array.isArray(usage.input_tokens_details)
        ? (usage.input_tokens_details as Record<string, unknown>)
        : {};
    const outputDetails =
      usage?.output_tokens_details &&
        typeof usage.output_tokens_details === "object" &&
        !Array.isArray(usage.output_tokens_details)
        ? (usage.output_tokens_details as Record<string, unknown>)
        : {};
    const serverSideToolUsage =
      response.server_side_tool_usage &&
        typeof response.server_side_tool_usage === "object" &&
        !Array.isArray(response.server_side_tool_usage)
        ? (response.server_side_tool_usage as Record<string, unknown>)
        : {};
    return coerceUsage({
      promptTokens: usage?.input_tokens,
      completionTokens: usage?.output_tokens,
      totalTokens: usage?.total_tokens,
      cachedInputTokens: inputDetails.cached_tokens,
      reasoningOutputTokens: outputDetails.reasoning_tokens,
      webSearchRequests: serverSideToolUsage.SERVER_SIDE_TOOL_WEB_SEARCH,
    });
  }

  private extractProviderEvidence(
    response: Record<string, unknown>,
  ): LLMResponse["providerEvidence"] {
    const citations = this.extractCitations(response);
    const serverSideToolCalls = this.extractServerSideToolCalls(response);
    const serverSideToolUsage = this.extractServerSideToolUsage(response);
    if (
      citations.length === 0 &&
      serverSideToolCalls.length === 0 &&
      serverSideToolUsage.length === 0
    ) {
      return undefined;
    }
    return {
      ...(citations.length > 0 ? { citations } : {}),
      ...(serverSideToolCalls.length > 0 ? { serverSideToolCalls } : {}),
      ...(serverSideToolUsage.length > 0 ? { serverSideToolUsage } : {}),
    };
  }

  private extractEncryptedReasoningDiagnostics(
    response: Record<string, unknown>,
    options?: {
      requested?: boolean;
    },
  ): LLMResponse["encryptedReasoning"] {
    const output = Array.isArray(response.output)
      ? (response.output as Array<Record<string, unknown>>)
      : [];
    const available = output.some(
      (item) =>
        item && typeof item === "object" &&
        item.type === "reasoning" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0,
    );
    const requested =
      options?.requested ??
      (available ? true : this.config.includeEncryptedReasoning === true);
    if (!requested && !available) {
      return undefined;
    }
    return {
      requested,
      available,
    };
  }

  private extractCitations(response: Record<string, unknown>): string[] {
    const citations = new Set<string>();
    const topLevel = Array.isArray(response.citations)
      ? response.citations
      : [];
    for (const entry of topLevel) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        citations.add(entry.trim());
        continue;
      }
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { url?: unknown }).url === "string"
      ) {
        citations.add(String((entry as { url: string }).url).trim());
      }
    }
    if (citations.size > 0) {
      return [...citations];
    }

    const output = Array.isArray(response.output)
      ? (response.output as Array<Record<string, unknown>>)
      : [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "message") continue;
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      for (const part of content) {
        const annotations = Array.isArray(part.annotations)
          ? (part.annotations as Array<Record<string, unknown>>)
          : [];
        for (const annotation of annotations) {
          const url = annotation.url;
          if (typeof url === "string" && url.trim().length > 0) {
            citations.add(url.trim());
          }
        }
      }
    }

    return [...citations];
  }

  private extractServerSideToolCalls(
    response: Record<string, unknown>,
  ): readonly LLMProviderNativeServerToolCall[] {
    const output = Array.isArray(response.output)
      ? (response.output as Array<Record<string, unknown>>)
      : [];
    const calls: LLMProviderNativeServerToolCall[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      if (
        item.type !== "web_search_call" &&
        item.type !== "x_search_call" &&
        item.type !== "code_interpreter_call" &&
        item.type !== "file_search_call" &&
        item.type !== "mcp_call"
      ) {
        continue;
      }
      calls.push({
        type: item.type,
        toolType: this.mapServerSideOutputTypeToToolType(item.type),
        id: typeof item.id === "string" ? item.id : undefined,
        functionName:
          typeof item.name === "string"
            ? item.name
            : typeof item.function_name === "string"
              ? item.function_name
              : undefined,
        arguments:
          typeof item.arguments === "string"
            ? item.arguments
            : undefined,
        status: typeof item.status === "string" ? item.status : undefined,
        raw: cloneProviderTracePayload(item),
      });
    }
    return calls;
  }

  private extractServerSideToolUsage(
    response: Record<string, unknown>,
  ): readonly LLMProviderServerSideToolUsageEntry[] {
    const usage =
      response.server_side_tool_usage &&
      typeof response.server_side_tool_usage === "object" &&
      !Array.isArray(response.server_side_tool_usage)
        ? (response.server_side_tool_usage as Record<string, unknown>)
        : undefined;
    if (!usage) return [];

    const entries: LLMProviderServerSideToolUsageEntry[] = [];
    for (const [category, count] of Object.entries(usage)) {
      if (typeof count !== "number" || !Number.isFinite(count)) continue;
      entries.push({
        category,
        toolType: this.mapServerSideUsageCategoryToToolType(category),
        count,
      });
    }
    return entries;
  }

  private mapServerSideOutputTypeToToolType(
    type: string,
  ): "web_search" | "x_search" | "code_interpreter" | "file_search" | "mcp" {
    switch (type) {
      case "web_search_call":
        return "web_search";
      case "x_search_call":
        return "x_search";
      case "code_interpreter_call":
        return "code_interpreter";
      case "file_search_call":
        return "file_search";
      case "mcp_call":
      default:
        return "mcp";
    }
  }

  private mapServerSideUsageCategoryToToolType(
    category: string,
  ):
    | "web_search"
    | "x_search"
    | "code_interpreter"
    | "file_search"
    | "mcp"
    | "view_image"
    | "view_x_video"
    | undefined {
    switch (category) {
      case "SERVER_SIDE_TOOL_WEB_SEARCH":
        return "web_search";
      case "SERVER_SIDE_TOOL_X_SEARCH":
        return "x_search";
      case "SERVER_SIDE_TOOL_CODE_EXECUTION":
        return "code_interpreter";
      case "SERVER_SIDE_TOOL_COLLECTIONS_SEARCH":
        return "file_search";
      case "SERVER_SIDE_TOOL_MCP":
        return "mcp";
      case "SERVER_SIDE_TOOL_VIEW_IMAGE":
        return "view_image";
      case "SERVER_SIDE_TOOL_VIEW_X_VIDEO":
        return "view_x_video";
      default:
        return undefined;
    }
  }

  private toToolCall(item: unknown): {
    toolCall: LLMToolCall | null;
    issue?: ToolCallNormalizationIssue;
  } {
    if (!item || typeof item !== "object") {
      return { toolCall: null };
    }
    const candidate = item as Record<string, unknown>;
    if (candidate.type !== "function_call") return { toolCall: null };
    const validation = validateToolCallDetailed({
      id: String(candidate.call_id ?? candidate.id ?? ""),
      // Decode the strict-regex wire name back to the internal
      // `mcp.<server>.<tool>` form before dispatch. Non-MCP names
      // pass through unchanged.
      name: decodeMcpToolNameFromWire(String(candidate.name ?? "")),
      arguments: String(candidate.arguments ?? ""),
    });
    if (validation.toolCall) {
      return { toolCall: validation.toolCall };
    }
    return {
      toolCall: null,
      issue: {
        toolCallId:
          typeof candidate.call_id === "string"
            ? candidate.call_id
            : typeof candidate.id === "string"
              ? candidate.id
              : undefined,
        toolName:
          typeof candidate.name === "string" && candidate.name.trim().length > 0
            ? candidate.name.trim()
            : undefined,
        failure: validation.failure ?? {
          code: "invalid_shape",
          message: "Tool call validation failed.",
        },
        argumentsPreview:
          typeof candidate.arguments === "string"
            ? truncate(candidate.arguments, 240)
            : undefined,
      },
    };
  }

  private extractToolCallsFromOutput(output: unknown): {
    toolCalls: LLMToolCall[];
    normalizationIssues: ToolCallNormalizationIssue[];
  } {
    if (!Array.isArray(output)) {
      return { toolCalls: [], normalizationIssues: [] };
    }
    const toolCalls: LLMToolCall[] = [];
    const normalizationIssues: ToolCallNormalizationIssue[] = [];
    for (const item of output) {
      const { toolCall, issue } = this.toToolCall(item);
      if (toolCall) toolCalls.push(toolCall);
      if (issue) normalizationIssues.push(issue);
    }
    return { toolCalls, normalizationIssues };
  }

  private emitToolCallNormalizationIssues(
    issues: readonly ToolCallNormalizationIssue[] | undefined,
    options: LLMChatOptions | undefined,
    transport: "chat" | "chat_stream",
    model: string,
  ): void {
    if (!issues || issues.length === 0) return;
    for (const issue of issues) {
      emitProviderTraceEvent(options, {
        kind: "stream_event",
        transport,
        provider: this.name,
        model,
        payload: {
          eventType: "tool_call_validation_failed",
          failureCode: issue.failure.code,
          failureMessage: issue.failure.message,
          toolCallId: issue.toolCallId,
          toolName: issue.toolName,
          argumentsPreview: issue.argumentsPreview,
        },
      });
    }
  }

  private mapResponseFinishReason(
    response: Record<string, unknown>,
    toolCalls: readonly LLMToolCall[],
  ): LLMResponse["finishReason"] {
    if (toolCalls.length > 0) return "tool_calls";

    const status = String(response.status ?? "");
    if (status === "failed") return "error";
    if (status === "incomplete") {
      const details =
        (response.incomplete_details as Record<string, unknown> | undefined) ??
        {};
      const reason = String(details.reason ?? "");
      if (reason.includes("content_filter")) return "content_filter";
      if (reason.includes("max_output_tokens")) return "length";
      return "length";
    }
    return "stop";
  }

  private extractResponseError(
    response: Record<string, unknown>,
    finishReason: LLMResponse["finishReason"],
  ): Error | undefined {
    if (finishReason !== "error") return undefined;
    const status = String(response.status ?? "");
    const rawError = response.error;
    const errorObj =
      rawError && typeof rawError === "object" && !Array.isArray(rawError)
        ? (rawError as Record<string, unknown>)
        : undefined;
    const message = (
      typeof errorObj?.message === "string" && errorObj.message.length > 0
        ? errorObj.message
        : (status === "failed"
            ? "Provider returned failed response status"
            : "Provider returned error response")
    );
    const codeRaw = errorObj?.code ?? errorObj?.status ?? errorObj?.statusCode;
    const statusCode = typeof codeRaw === "number"
      ? codeRaw
      : Number.parseInt(String(codeRaw ?? ""), 10);
    return new LLMProviderError(
      this.name,
      message,
      Number.isFinite(statusCode) ? statusCode : undefined,
    );
  }

  private mapError(err: unknown, timeoutMs?: number): Error {
    return mapLLMError(this.name, err, timeoutMs ?? this.config.timeoutMs ?? 0);
  }

  private logPromptOverflowDiagnostics(
    error: Error,
    params: Record<string, unknown>,
  ): void {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode !== 400) return;
    if (!isPromptOverflowErrorMessage(error.message)) return;

    const diagnostics = collectParamDiagnostics(params);
    // eslint-disable-next-line no-console
    console.warn(
      `[GrokProvider] Prompt overflow diagnostics: ${JSON.stringify(
        diagnostics,
      )}`,
    );
  }
}
