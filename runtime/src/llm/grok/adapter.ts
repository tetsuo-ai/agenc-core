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
  LLMMessage,
  LLMResponse,
  LLMStatefulDiagnostics,
  LLMStatefulEvent,
  LLMStatefulFallbackReason,
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
} from "../types.js";
import { validateToolCallDetailed } from "../types.js";
import { LLMProviderError, mapLLMError } from "../errors.js";
import {
  assertNoSilentToolDropOnFollowup,
  DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS,
  validateXaiRequestPreFlight,
  validateXaiResponsePostFlight,
  XaiSilentToolDropError,
  XAI_RESPONSES_MAX_TOOL_COUNT,
} from "./xai-strict-filter.js";
import { ensureLazyImport } from "../lazy-import.js";
import {
  assertXaiStructuredOutputToolCompatibility,
  resolveLLMStatefulResponsesConfig,
  type ResolvedLLMStatefulResponsesConfig,
} from "../provider-capabilities.js";
import {
  getProviderNativeToolDefinitions,
  type ProviderNativeToolDefinition,
} from "../provider-native-search.js";
import { parseStructuredOutputText } from "../structured-output.js";
import { withTimeout } from "../timeout.js";
import { repairToolTurnSequence, validateToolTurnSequence } from "../tool-turn-validator.js";
import type { GrokProviderConfig } from "./types.js";
import { resolveContextWindowProfile } from "../../gateway/context-window.js";
import {
  buildIncrementalContinuationMessages,
  buildProviderTraceErrorPayload,
  buildToolSelectionTraceContext,
  cloneProviderTracePayload,
  computePersistedResponseReconciliationHash,
  computeReconciliationChain,
  extractTraceToolNames,
  isContinuationRetrievalFailure,
  slimTools,
  summarizeTraceToolChoice,
  toSlimTool,
  truncate,
  type ToolSelectionDiagnostics,
} from "./adapter-utils.js";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4-1-fast-reasoning";
const DEFAULT_VISION_MODEL = "grok-4-0709";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_MESSAGES_PAYLOAD_CHARS = 80_000;
const MAX_SYSTEM_MESSAGE_CHARS = 16_000;
const MAX_MESSAGE_CHARS_PER_ENTRY = 4_000;
// MAX_TOOL_SCHEMA_CHARS_FOLLOWUP removed 2026-04-09: see buildParams() comment
// near `selectedTools.tools.length > 0`. The 20K limit was silently dropping
// the entire tools array on every tool-followup request.
//
// The canonical /v1/responses field allowlist now lives in
// `xai-strict-filter.ts` as `DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS` and is
// imported above. Single source of truth — both the strict pre-flight
// validator and `sanitizeToDocumentedXaiResponsesParams()` use the same set.
const DOCUMENTED_XAI_RESPONSES_FIELDS = DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS;

/** Vision models known to support function-calling alongside image understanding. */
const VISION_MODELS_WITH_TOOLS = new Set([
  "grok-4-0709",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4.20-beta-0309-reasoning",
  "grok-4.20-beta-0309-non-reasoning",
  "grok-4.20-multi-agent-beta-0309",
]);

const XAI_RESPONSES_TRIM_PRIORITY_TOOL_NAMES = new Set([
  "agenc.inspectMarketplace",
  "agenc.listTasks",
  "agenc.getTask",
  "agenc.getJobSpec",
  "agenc.getReputationSummary",
  "agenc.getTokenBalance",
  "agenc.registerAgent",
  "agenc.createTask",
  "agenc.claimTask",
  "agenc.completeTask",
]);

function prioritizeToolsForXaiResponsesLimit<T extends Record<string, unknown>>(
  tools: readonly T[],
): T[] {
  return tools
    .map((tool, index) => ({
      tool,
      index,
      priority: getXaiResponsesTrimPriority(tool),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ tool }) => tool);
}

function getXaiResponsesTrimPriority(tool: Record<string, unknown>): number {
  const name = extractTraceToolNames([tool])[0] ?? "";
  return XAI_RESPONSES_TRIM_PRIORITY_TOOL_NAMES.has(name) ? 0 : 1;
}

interface StatefulSessionAnchor {
  responseId: string;
  reconciliationHash: string;
  updatedAt: number;
}

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

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (timeoutMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function sanitizeToDocumentedXaiResponsesParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) =>
      DOCUMENTED_XAI_RESPONSES_FIELDS.has(key)
    ),
  );
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
): Promise<IteratorResult<T>> {
  if (!timeoutMs || timeoutMs <= 0) {
    return iterator.next();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(createStreamTimeoutError(providerName, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([iterator.next(), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function closeAsyncIterator(iterator: AsyncIterator<unknown>): void {
  if (typeof iterator.return !== "function") return;
  try {
    const closeResult = iterator.return();
    if (
      closeResult !== null &&
      closeResult !== undefined &&
      typeof closeResult.then === "function"
    ) {
      void closeResult.catch(() => undefined);
    }
  } catch {
    // best-effort stream cleanup
  }
}

function sanitizeLargeText(value: string): string {
  return value
    .replace(
      /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
      "(image omitted)",
    )
    .replace(/[A-Za-z0-9+/=\r\n]{400,}/g, "(base64 omitted)");
}

function normalizeResponsesToolChoice(
  toolChoice: LLMToolChoice | undefined,
): string | Record<string, unknown> | undefined {
  if (toolChoice === undefined || typeof toolChoice === "string") {
    return toolChoice;
  }

  const directName = typeof toolChoice.name === "string"
    ? toolChoice.name.trim()
    : "";
  if (toolChoice.type === "function" && directName.length > 0) {
    return { type: "function", function: { name: directName } };
  }

  const legacyName = typeof (toolChoice as { function?: { name?: unknown } }).function
      ?.name === "string"
    ? (toolChoice as { function?: { name?: string } }).function!.name!.trim()
    : "";
  if (toolChoice.type === "function" && legacyName.length > 0) {
    return { type: "function", function: { name: legacyName } };
  }

  return toolChoice;
}

function resolveResponsesToolChoice(
  toolChoice: LLMToolChoice | undefined,
): string | Record<string, unknown> | undefined {
  // xAI documents `required` as a first-class tool_choice mode. Preserve it
  // instead of tightening it into a named-function selection.
  return normalizeResponsesToolChoice(toolChoice);
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
  statefulInput?: {
    mode: "full_replay" | "incremental_delta";
    omittedMessageCount: number;
  },
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
    previousResponseId:
      typeof params.previous_response_id === "string"
        ? String(params.previous_response_id)
        : undefined,
    ...(statefulInput
      ? {
        statefulInputMode: statefulInput.mode,
        statefulOmittedMessageCount: statefulInput.omittedMessageCount,
      }
      : {}),
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
  statefulDiagnostics?: LLMStatefulDiagnostics,
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
    statefulInputMode: requestMetrics.statefulInputMode,
    statefulOmittedMessageCount: requestMetrics.statefulOmittedMessageCount,
    previousResponseId: requestMetrics.previousResponseId,
    ...(statefulDiagnostics
      ? {
        statefulAttempted: statefulDiagnostics.attempted,
        statefulContinued: statefulDiagnostics.continued,
        statefulFallbackReason: statefulDiagnostics.fallbackReason,
        statefulAnchorMatched: statefulDiagnostics.anchorMatched,
        statefulReconciliationHash: statefulDiagnostics.reconciliationHash,
        statefulPreviousReconciliationHash:
          statefulDiagnostics.previousReconciliationHash,
        statefulReconciliationMessageCount:
          statefulDiagnostics.reconciliationMessageCount,
        statefulReconciliationSource:
          statefulDiagnostics.reconciliationSource,
        statefulHistoryCompacted: statefulDiagnostics.historyCompacted,
        statefulCompactedHistoryTrusted:
          statefulDiagnostics.compactedHistoryTrusted,
      }
      : {}),
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
  statefulDiagnostics?: LLMStatefulDiagnostics,
  compactionDiagnostics?: LLMCompactionDiagnostics,
  responseMeta?: ProviderResponseTraceMeta,
): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = {};
  if (statefulDiagnostics) {
    context.statefulResponseId = statefulDiagnostics.responseId;
    context.statefulReconciliationHash = statefulDiagnostics.reconciliationHash;
    context.statefulContinued = statefulDiagnostics.continued;
    context.statefulAnchorMatched = statefulDiagnostics.anchorMatched;
    context.statefulFallbackReason = statefulDiagnostics.fallbackReason;
  }
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
  const entries = Array.from(response.headers.entries());
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
): Promise<{
  data: T;
  response?: Response;
  requestId?: string | null;
}> {
  const request = (client as any).responses.create(params, { signal });
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

function appendStatefulEvent(
  events: LLMStatefulEvent[],
  type: LLMStatefulEvent["type"],
  options?: {
    reason?: LLMStatefulFallbackReason;
    detail?: string;
  },
): void {
  events.push({
    type,
    reason: options?.reason,
    detail: options?.detail,
  });
}

function hasImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return p.type === "image_url";
  });
}

function compactOpenAIMessage(
  msg: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> {
  const role = String(msg.role ?? "user");
  const compact = { ...msg };
  const content = msg.content;

  if (typeof content === "string") {
    compact.content = truncate(sanitizeLargeText(content), maxChars);
    return compact;
  }

  if (Array.isArray(content)) {
    // In hard-cap mode we collapse multimodal payloads to compact text.
    const text = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        if (p.type === "text") return String(p.text ?? "");
        if (p.type === "image_url") return "[image omitted]";
        return "";
      })
      .filter((s) => s.length > 0)
      .join("\n");
    compact.content = truncate(sanitizeLargeText(text || "[content omitted]"), maxChars);
    return compact;
  }

  compact.content = role === "tool" ? "Tool executed." : "";
  return compact;
}

function enforceMessageBudget(
  messages: Record<string, unknown>[],
  maxChars: number,
): Record<string, unknown>[] {
  const total = messages.reduce(
    (sum, m) => sum + estimateOpenAIContentChars(m.content) + 48,
    0,
  );
  if (total <= maxChars) return messages;

  const firstSystemIndex = messages.findIndex((m) => m.role === "system");
  const firstSystem =
    firstSystemIndex >= 0
      ? compactOpenAIMessage(messages[firstSystemIndex], MAX_SYSTEM_MESSAGE_CHARS)
      : undefined;
  const systemChars = firstSystem
    ? estimateOpenAIContentChars(firstSystem.content) + 48
    : 0;
  const nonSystemBudget = Math.max(4_000, maxChars - systemChars);

  const nonSystem = messages.filter((_, idx) => idx !== firstSystemIndex);
  const selected: Record<string, unknown>[] = [];
  let used = 0;

  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const compact = compactOpenAIMessage(
      nonSystem[i],
      MAX_MESSAGE_CHARS_PER_ENTRY,
    );
    const chars = estimateOpenAIContentChars(compact.content) + 48;
    if (used + chars <= nonSystemBudget) {
      selected.push(compact);
      used += chars;
      continue;
    }
    if (selected.length === 0) {
      const remaining = Math.max(256, nonSystemBudget - used - 48);
      selected.push(compactOpenAIMessage(nonSystem[i], remaining));
    }
    break;
  }

  selected.reverse();
  return firstSystem ? [firstSystem, ...selected] : selected;
}

export class GrokProvider implements LLMProvider {
  readonly name = "grok";

  private client: unknown | null = null;
  private readonly config: GrokProviderConfig;
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
  private readonly statefulConfig: ResolvedLLMStatefulResponsesConfig;
  private readonly statefulSessions = new Map<string, StatefulSessionAnchor>();
  private readonly configuredTimeoutMs: number | undefined;

  constructor(config: GrokProviderConfig) {
    this.configuredTimeoutMs = config.timeoutMs;
    this.config = {
      ...config,
      model: config.model ?? DEFAULT_MODEL,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
      timeoutMs: normalizeTimeoutMs(config.timeoutMs),
      parallelToolCalls: config.parallelToolCalls ?? false,
    };
    this.statefulConfig = resolveLLMStatefulResponsesConfig(
      config.statefulResponses,
    );

    // Build client-side function tools plus provider-native tool definitions.
    const rawTools = [...(config.tools ?? [])];
    for (const tool of rawTools) {
      this.rawToolsByName.set(tool.function.name, tool);
    }
    const slimmed = slimTools(rawTools);
    this.tools = slimmed.tools;
    this.responseTools = this.toResponseTools(this.tools);
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
          activePlan.statefulDiagnostics,
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
            ),
          activeRequestTimeout.timeoutMs,
          this.name,
          options?.signal,
        );
        const originalResponse = result.data;
        // Auto-mitigate the xAI mid-sentence truncation bug by
        // replaying with tool_choice="none" when the strict filter
        // detects the trigger pattern. See report.txt §4.4.
        const mitigatedResponse = await this.maybeRetryMidSentenceTruncation(
          client,
          activePlan.params as Record<string, unknown>,
          originalResponse as Record<string, unknown>,
          options,
          "chat",
        );
        const response = (mitigatedResponse ?? originalResponse) as typeof originalResponse;
        const responseMeta = buildProviderResponseMeta({
          response: result.response,
          requestId: result.requestId,
          payload: response,
        });
        const parsed = this.parseResponse(
          response,
          activePlan.params,
          activePlan.requestMetrics,
          activePlan.statefulDiagnostics,
          activePlan.compactionDiagnostics,
          options?.structuredOutput,
        );
        this.emitToolCallNormalizationIssues(
          parsed.normalizationIssues,
          options,
          "chat",
          parsed.model,
        );
        this.persistStatefulAnchor(activePlan, parsed);
        emitProviderTraceEvent(options, {
          kind: "response",
          transport: "chat",
          provider: this.name,
          model: String(response?.model ?? activePlan.params.model ?? this.config.model),
          payload:
            cloneProviderTracePayload(response) ??
            { error: "provider_response_trace_unavailable" },
          context: buildProviderResponseTraceContext(
            parsed.stateful,
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

    while (true) {
      try {
        return await run(plan);
      } catch (err: unknown) {
        if (this.shouldRetryStatelessFromStateful(err, plan.statefulDiagnostics)) {
          plan = this.buildRequestPlan(messages, options, {
            forceStateless: true,
            fallbackReason: "provider_retrieval_failure",
            inheritedEvents: plan.statefulDiagnostics?.events ?? [],
          });
          continue;
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
    let params: Record<string, unknown> = { ...plan.params, stream: true };
    let requestMetrics = {
      ...plan.requestMetrics,
      stream: true,
    };
    let statefulDiagnostics = plan.statefulDiagnostics;
    let compactionDiagnostics = plan.compactionDiagnostics;
    let content = "";
    let model = this.config.model;
    let finishReason: LLMResponse["finishReason"] = "stop";
    let responseError: Error | undefined;
    let usage: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let providerEvidence: LLMResponse["providerEvidence"];
    let encryptedReasoning: LLMResponse["encryptedReasoning"];
    const toolCallAccum = new Map<string, LLMToolCall>();
    let streamIterator: AsyncIterator<any> | null = null;
    let responseTracePayload: Record<string, unknown> | undefined;
    let streamResponseMeta: ProviderResponseTraceMeta | undefined;
    const streamTimeout = resolveRequestTimeoutMs(
      this.configuredTimeoutMs,
      options?.timeoutMs,
    );
    const streamDeadlineAt =
      typeof streamTimeout.timeoutMs === "number"
        ? Date.now() + streamTimeout.timeoutMs
        : Number.POSITIVE_INFINITY;

    try {
      let stream: AsyncIterable<any>;
      while (true) {
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
            statefulDiagnostics,
            compactionDiagnostics,
            requestAttemptTimeout,
          ),
        });
        try {
          const result = await withTimeout(
            async (signal) =>
              createWithResponseMetadata<AsyncIterable<any>>(
                client,
                params,
                signal,
              ),
            requestAttemptTimeout.timeoutMs,
            this.name,
            options?.signal,
          );
          stream = result.data;
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
          break;
        } catch (err: unknown) {
          if (this.shouldRetryStatelessFromStateful(err, statefulDiagnostics)) {
            plan = this.buildRequestPlan(messages, options, {
              forceStateless: true,
              fallbackReason: "provider_retrieval_failure",
              inheritedEvents: statefulDiagnostics?.events ?? [],
            });
            params = { ...plan.params, stream: true };
            requestMetrics = {
              ...plan.requestMetrics,
              stream: true,
            };
            statefulDiagnostics = plan.statefulDiagnostics;
            compactionDiagnostics = plan.compactionDiagnostics;
            continue;
          }
          throw err;
        }
      }

      streamIterator = stream[Symbol.asyncIterator]();
      let streamEventIndex = 0;
      const streamOpenedAt = Date.now();
      let receivedTerminalEvent = false;

      while (true) {
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

        if (event.type === "response.completed") {
          receivedTerminalEvent = true;
          let response = event.response ?? {};

          // Auto-mitigate the xAI mid-sentence truncation bug on the
          // streaming terminal payload. The user has already seen the
          // truncated deltas via onChunk; the mitigation replaces the
          // accumulated content with the retry result so the final
          // LLMResponse returned to the executor carries the corrected
          // text. A secondary onChunk is emitted with the corrected
          // content so UIs that re-render on the latest delta show
          // the corrected version. See report.txt §4.4.
          const mitigatedResponse = await this.maybeRetryMidSentenceTruncation(
            client,
            params,
            response as Record<string, unknown>,
            options,
            "chat_stream",
          );
          if (mitigatedResponse) {
            response = mitigatedResponse;
            // Reset stream-accumulated tool calls; the mitigation
            // retry ran with tool_choice="none" so it cannot have
            // emitted a function_call, but we still clear the map
            // so any lingering partial deltas from the original
            // stream don't leak into the final response.
            toolCallAccum.clear();
            // Replace streamed content with the corrected text so
            // the returned LLMResponse has the full response.
            const correctedText = String(
              (mitigatedResponse as { output_text?: unknown }).output_text ??
                "",
            );
            const correctedFromOutput = this.extractOutputText(
              mitigatedResponse,
            );
            const effectiveCorrected =
              correctedText.length > 0
                ? correctedText
                : correctedFromOutput ?? "";
            if (effectiveCorrected.length > 0) {
              // Signal the correction as a delta replacing the
              // truncated stream the UI has already rendered.
              onChunk({ content: effectiveCorrected, done: false });
              content = effectiveCorrected;
            }
          }

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

          // Strict post-flight on the streaming terminal payload. Same
          // contract as the non-streaming parseResponse() path: error-level
          // anomalies throw, warn-level anomalies log via console.warn.
          // Mid-sentence truncation is handled above (via the mitigation
          // retry) so it is skipped here — if the retry succeeded, the
          // anomaly is no longer present; if the retry failed, the
          // original anomaly was already logged inside the mitigation
          // path and re-logging would be noise.
          const xaiAnomalies = validateXaiResponsePostFlight({
            request: params,
            response: response as Record<string, unknown>,
          });
          for (const anomaly of xaiAnomalies) {
            if (
              anomaly.severity === "error" &&
              anomaly.code === "silent_tool_drop_promised_in_text"
            ) {
              throw new XaiSilentToolDropError(
                "incoming_promised_tools_missing",
                anomaly.evidence,
              );
            }
            if (anomaly.code === "truncated_response_mid_sentence") continue;
            console.warn(
              `[GrokProvider] xAI post-flight anomaly (${anomaly.code}): ${anomaly.message}`,
              anomaly.evidence,
            );
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
          if (statefulDiagnostics) {
            statefulDiagnostics = {
              ...statefulDiagnostics,
              responseId:
                typeof response.id === "string" ? String(response.id) : undefined,
            };
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

      const parsed: LLMResponse = {
        content,
        toolCalls,
        usage,
        model,
        requestMetrics,
        stateful: statefulDiagnostics,
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
        ...(responseError ? { error: responseError } : {}),
      };
      this.persistStatefulAnchor(plan, parsed);
      emitProviderTraceEvent(options, {
        kind: "response",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload:
          responseTracePayload ?? { error: "provider_response_trace_unavailable" },
          context: buildProviderResponseTraceContext(
            parsed.stateful,
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
      const mappedError = this.mapError(err, streamTimeout.timeoutMs);
      this.logPromptOverflowDiagnostics(mappedError, params);
      if (content.length > 0) {
        const partialToolCalls: LLMToolCall[] = Array.from(toolCallAccum.values());

        onChunk({ content: "", done: true, toolCalls: partialToolCalls });
        return {
          content,
          toolCalls: partialToolCalls,
          usage,
          model,
          requestMetrics,
          stateful: statefulDiagnostics,
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
      if (streamIterator) closeAsyncIterator(streamIterator);
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

  getCapabilities() {
    return {
      provider: this.name,
      stateful: {
        assistantPhase: false,
        previousResponseId: true,
        encryptedReasoning: true,
        storedResponseRetrieval: true,
        storedResponseDeletion: true,
        opaqueCompaction: false,
        deterministicFallback: true,
      },
    } as const;
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
      maxOutputTokens:
        typeof this.config.maxTokens === "number" && this.config.maxTokens > 0
          ? this.config.maxTokens
          : undefined,
    };
  }

  resetSessionState(sessionId: string): void {
    this.statefulSessions.delete(sessionId);
  }

  clearSessionState(): void {
    this.statefulSessions.clear();
  }

  private buildRequestPlan(
    messages: readonly LLMMessage[],
    options?: LLMChatOptions,
    overrides?: {
      forceStateless?: boolean;
      fallbackReason?: LLMStatefulFallbackReason;
      inheritedEvents?: readonly LLMStatefulEvent[];
    },
  ): {
    params: Record<string, unknown>;
    requestMetrics: LLMRequestMetrics;
    toolSelection: ToolSelectionDiagnostics;
    statefulDiagnostics?: LLMStatefulDiagnostics;
    compactionDiagnostics?: LLMCompactionDiagnostics;
    sessionId?: string;
    reconciliationHash?: string;
    requestMessages?: readonly LLMMessage[];
  } {
    const compactionDiagnostics = undefined;
    const sessionId = options?.stateful?.sessionId?.trim();
    if (!this.statefulConfig.enabled || !sessionId) {
      const toolSelection = this.resolveResponseTools(
        options?.toolRouting?.allowedToolNames,
      );
      const built = this.buildParams(messages, {
        store: false,
        allowedToolNames: options?.toolRouting?.allowedToolNames,
        toolChoice: options?.toolChoice,
        maxTurns: options?.maxTurns,
        reasoningEffort: options?.reasoningEffort,
        includeEncryptedReasoning: options?.includeEncryptedReasoning,
        structuredOutput: options?.structuredOutput,
        toolSelection,
        promptCacheKey: options?.stateful?.sessionId?.trim() || undefined,
      });
      return {
        params: built.params,
        requestMetrics: collectParamDiagnostics(
          built.params,
          built.toolSelection,
        ),
        toolSelection: built.toolSelection,
        compactionDiagnostics,
      };
    }

    const events: LLMStatefulEvent[] = [
      ...(overrides?.inheritedEvents ?? []),
    ];
    const reconciliationMessages =
      options?.stateful?.reconciliationMessages ?? messages;
    const continuationTurn = reconciliationMessages.some(
      (message) => message.role === "assistant" || message.role === "tool",
    );
    const reconciliation = computeReconciliationChain(
      reconciliationMessages,
      this.statefulConfig.reconciliationWindow,
    );
    const persistedResumeAnchor = options?.stateful?.resumeAnchor;
    const memoryAnchor = this.statefulSessions.get(sessionId);
    const anchor = memoryAnchor ?? (
      persistedResumeAnchor?.previousResponseId &&
      persistedResumeAnchor.reconciliationHash
        ? {
            responseId: persistedResumeAnchor.previousResponseId,
            reconciliationHash: persistedResumeAnchor.reconciliationHash,
            updatedAt: Date.now(),
          }
        : undefined
    );
    const forceStateless = overrides?.forceStateless === true;
    const providerContinuationEnabled = this.statefulConfig.store === true;
    let attempted = false;
    let continued = false;
    let previousResponseId: string | undefined;
    let fallbackReason = overrides?.fallbackReason;
    let anchorMatched: boolean | undefined;
    let anchorRelevantMessageIndex: number | undefined;
    const historyCompacted = options?.stateful?.historyCompacted === true;
    let compactedHistoryTrusted = false;

    if (!forceStateless && continuationTurn && !providerContinuationEnabled) {
      fallbackReason = "store_disabled";
      appendStatefulEvent(events, "stateful_fallback", {
        reason: "store_disabled",
        detail:
          "provider continuation disabled because store=false; replaying local history instead",
      });
    } else if (!forceStateless && anchor?.responseId) {
      attempted = true;
      previousResponseId = anchor.responseId;
      appendStatefulEvent(events, "stateful_continuation_attempt", {
        detail: `session=${sessionId}`,
      });

      const anchorRelativeIndex = reconciliation.chain.lastIndexOf(
        anchor.reconciliationHash,
      );
      anchorMatched = anchorRelativeIndex >= 0;
      if (anchorMatched) {
        anchorRelevantMessageIndex =
          reconciliation.messageCountUsed - reconciliation.chain.length +
          anchorRelativeIndex;
      }
      if (anchorMatched) {
        continued = true;
        appendStatefulEvent(events, "stateful_continuation_success");
      } else if (historyCompacted) {
        continued = true;
        compactedHistoryTrusted = true;
        appendStatefulEvent(events, "stateful_continuation_success", {
          detail: `session=${sessionId}; trusted_compacted_history=true`,
        });
      } else {
        fallbackReason = "state_reconciliation_mismatch";
        appendStatefulEvent(events, "state_reconciliation_mismatch", {
          reason: "state_reconciliation_mismatch",
          detail: `session=${sessionId}`,
        });
        this.statefulSessions.delete(sessionId);
        previousResponseId = undefined;
        if (!this.statefulConfig.fallbackToStateless) {
          throw new LLMProviderError(
            this.name,
            "state_reconciliation_mismatch: local history does not match previous_response_id anchor",
            400,
          );
        }
        continued = false;
        previousResponseId = undefined;
        appendStatefulEvent(events, "stateful_fallback", {
          reason: "state_reconciliation_mismatch",
        });
      }
    } else if (!forceStateless && continuationTurn) {
      fallbackReason = "missing_previous_response_id";
      appendStatefulEvent(events, "stateful_fallback", {
        reason: "missing_previous_response_id",
      });
      if (!this.statefulConfig.fallbackToStateless) {
        throw new LLMProviderError(
          this.name,
          "missing_previous_response_id: stateful continuation requested but no prior response anchor is available",
          400,
        );
      }
    } else if (forceStateless && fallbackReason) {
      appendStatefulEvent(events, "stateful_fallback", {
        reason: fallbackReason,
      });
    }

    const toolSelection = this.resolveResponseTools(
      options?.toolRouting?.allowedToolNames,
    );
    const statefulInput =
      continued && anchorMatched && anchorRelevantMessageIndex !== undefined
        ? buildIncrementalContinuationMessages(
          messages,
          anchorRelevantMessageIndex,
        )
        : {
          messages,
          mode: "full_replay" as const,
          omittedMessageCount: 0,
        };
    const built = this.buildParams(statefulInput.messages, {
      store: this.statefulConfig.store,
      previousResponseId: continued ? previousResponseId : undefined,
      allowedToolNames: options?.toolRouting?.allowedToolNames,
      toolChoice: options?.toolChoice,
      maxTurns: options?.maxTurns,
      reasoningEffort: options?.reasoningEffort,
      includeEncryptedReasoning: options?.includeEncryptedReasoning,
      structuredOutput: options?.structuredOutput,
      toolSelection,
      promptCacheKey: sessionId,
    });

    return {
      params: built.params,
      requestMetrics: collectParamDiagnostics(
        built.params,
        built.toolSelection,
        statefulInput,
      ),
      toolSelection: built.toolSelection,
      sessionId,
      reconciliationHash: reconciliation.anchorHash,
      requestMessages: reconciliationMessages,
      compactionDiagnostics,
      statefulDiagnostics: {
        enabled: true,
        attempted,
        continued,
        store: this.statefulConfig.store,
        fallbackToStateless: this.statefulConfig.fallbackToStateless,
        previousResponseId: continued ? previousResponseId : undefined,
        fallbackReason,
        reconciliationHash: reconciliation.anchorHash,
        previousReconciliationHash: anchor?.reconciliationHash,
        reconciliationMessageCount: reconciliation.messageCountUsed,
        reconciliationSource: reconciliation.source,
        anchorMatched,
        historyCompacted,
        compactedHistoryTrusted,
        events,
      },
    };
  }

  private persistStatefulAnchor(
    plan: {
      sessionId?: string;
      reconciliationHash?: string;
      requestMessages?: readonly LLMMessage[];
      statefulDiagnostics?: LLMStatefulDiagnostics;
    },
    response: LLMResponse,
  ): void {
    if (!plan.statefulDiagnostics?.enabled) return;
    const sessionId = plan.sessionId;
    const responseId = response.stateful?.responseId;
    const hasMeaningfulAssistantOutput =
      response.toolCalls.length > 0 ||
      response.content.trim().length > 0;
    if (!hasMeaningfulAssistantOutput) {
      if (sessionId) {
        this.statefulSessions.delete(sessionId);
      }
      return;
    }
    const reconciliationHash =
      plan.requestMessages &&
      plan.requestMessages.length > 0
        ? computePersistedResponseReconciliationHash(
          plan.requestMessages,
          response,
          this.statefulConfig.reconciliationWindow,
        )
        : plan.reconciliationHash;
    if (!sessionId || !responseId || !reconciliationHash) {
      if (sessionId) {
        this.statefulSessions.delete(sessionId);
      }
      return;
    }
    if (response.stateful) {
      response.stateful = {
        ...response.stateful,
        reconciliationHash,
      };
    }
    this.statefulSessions.set(sessionId, {
      responseId,
      reconciliationHash,
      updatedAt: Date.now(),
    });
  }

  private shouldRetryStatelessFromStateful(
    error: unknown,
    statefulDiagnostics: LLMStatefulDiagnostics | undefined,
  ): boolean {
    if (!statefulDiagnostics?.attempted) return false;
    if (!statefulDiagnostics.fallbackToStateless) return false;
    return isContinuationRetrievalFailure(error);
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyImport("openai", this.name, (mod) => {
      const OpenAI = (mod.default ?? mod.OpenAI ?? mod) as any;
      return new OpenAI({
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
      previousResponseId?: string;
      allowedToolNames?: readonly string[];
      toolChoice?: LLMToolChoice;
      maxTurns?: number;
      reasoningEffort?: LLMChatOptions["reasoningEffort"];
      includeEncryptedReasoning?: boolean;
      structuredOutput?: LLMChatOptions["structuredOutput"];
      toolSelection?: ToolSelectionDiagnostics;
      promptCacheKey?: string;
    },
  ): {
    params: Record<string, unknown>;
    toolSelection: ToolSelectionDiagnostics;
  } {
    const visionModel = this.config.visionModel ?? DEFAULT_VISION_MODEL;
    const repairedMessages = repairToolTurnSequence(messages);
    validateToolTurnSequence(repairedMessages, {
      providerName: this.name,
      allowLeadingToolResults: Boolean(options?.previousResponseId),
    });

    // Build mapped messages, handling multimodal tool messages.
    // The OpenAI API requires tool message content to be a string.
    // When tool results contain images (e.g. screenshots), we extract
    // the text for the tool message and inject images as a user message
    // after all tool results in the block.
    const mapped: Record<string, unknown>[] = [];
    const pendingImages: Array<{
      type: "image_url";
      image_url: { url: string };
    }> = [];

    for (let i = 0; i < repairedMessages.length; i++) {
      const m = repairedMessages[i];

      // Collect images from multimodal tool messages
      if (m.role === "tool" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "image_url") {
            pendingImages.push({
              type: "image_url",
              image_url: part.image_url,
            });
          }
        }
      }

      mapped.push(this.toOpenAIMessage(m));

      // Flush collected images as a user message after the last tool message
      // in a contiguous tool-result block
      if (pendingImages.length > 0) {
        const nextMsg = repairedMessages[i + 1];
        if (!nextMsg || nextMsg.role !== "tool") {
          mapped.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "Here is the screenshot from the tool result above.",
              },
              ...pendingImages.map((img) => ({
                type: img.type,
                image_url: img.image_url,
              })),
            ],
          });
          pendingImages.length = 0;
        }
      }
    }

    const boundedMessages = enforceMessageBudget(
      mapped,
      MAX_MESSAGES_PAYLOAD_CHARS,
    );
    const hasImages = boundedMessages.some((m) => hasImageContent(m.content));
    const model = hasImages ? visionModel : this.config.model;
    const input = boundedMessages.flatMap((message) =>
      this.toResponseInputItems(message),
    );

    const params: Record<string, unknown> = {
      model,
      input,
      store: options?.store ?? this.statefulConfig?.store ?? false,
    };
    if (options?.previousResponseId) {
      params.previous_response_id = options.previousResponseId;
    }
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
    // Output-token cap removed intentionally. AgenC never sends
    // max_output_tokens on /v1/responses — the whole point of routing
    // through a 2M-context model is that the runtime lets the model
    // finish its thought. Any config value that previously would have
    // become max_output_tokens is now ignored for this field.
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
    if (reasoningEffort) {
      params.reasoning = { effort: reasoningEffort };
    }
    const includeEncryptedReasoning =
      options?.includeEncryptedReasoning ?? this.config.includeEncryptedReasoning;
    if (includeEncryptedReasoning) {
      params.include = ["reasoning.encrypted_content"];
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
      if (!hasImages || VISION_MODELS_WITH_TOOLS.has(visionModel)) {
        // Enforce the documented xAI Responses API maximum of 128
        // tools (developers/rest-api-reference/inference/chat). The
        // strict pre-flight validator throws on any request with more
        // than XAI_RESPONSES_MAX_TOOL_COUNT tools; trim here so a
        // local catalog that legitimately exceeds the limit (e.g.
        // many MCP servers enabled) stays functional instead of
        // failing closed at every request. Preserve critical AgenC
        // task-lifecycle tools before trimming so marketplace runs
        // can still claim and submit completions even with a large
        // MCP catalog. The trim is deterministic and the dropped
        // tool names are logged so operators can reorder their tool
        // registry or drop unused MCP servers to reclaim the slots.
        if (selectedTools.tools.length > XAI_RESPONSES_MAX_TOOL_COUNT) {
          const prioritizedTools = prioritizeToolsForXaiResponsesLimit(
            selectedTools.tools,
          );
          const dropped = prioritizedTools.slice(
            XAI_RESPONSES_MAX_TOOL_COUNT,
          );
          const droppedNames = dropped
            .map((t) => String((t as { name?: unknown }).name ?? "<unnamed>"))
            .join(", ");
          console.warn(
            `[GrokProvider] Tool catalog has ${selectedTools.tools.length} ` +
              `tools but xAI Responses API documents a maximum of ` +
              `${XAI_RESPONSES_MAX_TOOL_COUNT}. Trimming lower-priority ` +
              `tools to stay within the contract. Dropped tools (after ` +
              `preserving critical tools): ${droppedNames}. Reorder your tool ` +
              `registry or disable unused MCP servers if these should be ` +
              `retained.`,
          );
          selectedTools.tools = prioritizedTools.slice(
            0,
            XAI_RESPONSES_MAX_TOOL_COUNT,
          ) as typeof selectedTools.tools;
        }
        params.tools = selectedTools.tools;
        selectedTools.toolsAttached = true;
        params.parallel_tool_calls = this.config.parallelToolCalls;
        const toolChoice = resolveResponsesToolChoice(options?.toolChoice);
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
      // model). The CLAUDE.md learned rule "xAI Compatibility: Treat
      // undocumented 200s as untrusted until semantics are proven" applies:
      // raise the assertion at the adapter boundary so the user fixes the
      // config instead of getting a degraded run.
      assertXaiStructuredOutputToolCompatibility({
        providerName: this.name,
        model: typeof params.model === "string" ? params.model : this.config.model,
        structuredOutputRequested: true,
        toolsRequested: selectedTools.toolsAttached,
      });
      params.text = {
        format: {
          type: structuredOutputSchema.type,
          name: structuredOutputSchema.name,
          schema: structuredOutputSchema.schema,
          strict:
            structuredOutputSchema.strict ??
            this.config.structuredOutputs?.strict ??
            true,
        },
      };
    }
    // Strict pre-flight: validate the outgoing /v1/responses request body
    // against the documented xAI contract before it leaves the runtime.
    // Throws XaiUnknownModelError / XaiUndocumentedFieldError on rejection.
    // The throws map to provider_error via classifyLLMFailure() and flow
    // through the existing retry-with-fallback policy. Runs BEFORE
    // sanitizeToDocumentedXaiResponsesParams() so the validator sees the
    // params as the runtime intends to send them, including any field
    // that the sanitize step would silently strip.
    validateXaiRequestPreFlight(params);

    // Inline silent-tool-drop assertion. Catches the legacy
    // MAX_TOOL_SCHEMA_CHARS_FOLLOWUP bug pattern: the runtime selected
    // tools (`selectedTools.tools.length > 0`) but the final params has
    // no `tools` field. The pre-flight validator can't catch this with
    // the params alone — it needs the runtime's selection intent.
    //
    // The `toolSuppressionReason` argument tells the assertion when an
    // empty `tools` field is *intentional* (e.g.
    // `vision_model_without_tool_support` when an image is sent to a
    // vision model that lacks tool support, or `empty_allowlist` when
    // the routed tool subset resolves to zero matches). In those cases
    // the assertion is a no-op — the runtime deliberately suppressed
    // tools and that is not a bug.
    assertNoSilentToolDropOnFollowup({
      runtimeIntendedToolCount: selectedTools.tools.length,
      toolSuppressionReason: selectedTools.toolSuppressionReason,
      outgoingParams: params,
    });

    return {
      params: sanitizeToDocumentedXaiResponsesParams(params),
      toolSelection: selectedTools,
    };
  }

  private resolveResponseTools(
    allowedToolNames?: readonly string[],
  ): ToolSelectionDiagnostics {
    const providerNativeTools = this.providerNativeTools;
    const providerCatalogToolCount =
      this.responseTools.length + providerNativeTools.length;
    const providerCatalogToolNames = [
      ...extractTraceToolNames(this.responseTools),
      ...providerNativeTools.map((definition) => definition.name),
    ];
    const fullCatalogTools = [
      ...this.responseTools,
      ...providerNativeTools.map((definition) => definition.payload),
    ];
    if (allowedToolNames === undefined) {
      return {
        tools: fullCatalogTools,
        chars: this.toolChars,
        requestedToolNames: [],
        resolvedToolNames: providerCatalogToolNames,
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_no_filter",
        toolsAttached: false,
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
      let responseTool = this.responseToolsByName.get(name);
      let responseToolChars = this.responseToolCharsByName.get(name);
      if (!responseTool) {
        const rawTool = this.rawToolsByName.get(name);
        if (rawTool) {
          const slimTool = toSlimTool(rawTool);
          responseTool = this.toResponseTools([slimTool.tool])[0];
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

  private toOpenAIMessage(msg: LLMMessage): Record<string, unknown> {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        })),
      };
    }

    if (msg.role === "tool") {
      // Tool messages require string content per the OpenAI API spec.
      // When content is a multimodal array (e.g. from screenshot tool results),
      // extract only the text parts. Images are injected separately by buildParams.
      let content: string;
      if (Array.isArray(msg.content)) {
        content =
          msg.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { type: "text"; text: string }).text)
            .join("\n") || "Tool executed successfully.";
      } else {
        content = msg.content;
      }
      return {
        role: "tool",
        content,
        tool_call_id: msg.toolCallId,
      };
    }
    return {
      role: msg.role,
      content: msg.content,
    };
  }

  private toResponseTools(tools: readonly LLMTool[]): Record<string, unknown>[] {
    return tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }

  private toResponseInputItems(
    message: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const role = String(message.role ?? "");
    const content = message.content;

    if (role === "tool") {
      const toolCallId = String(message.tool_call_id ?? "").trim();
      if (!toolCallId) return [];
      let output: string;
      if (typeof content === "string") {
        output = content;
      } else {
        try {
          output = JSON.stringify(content);
        } catch {
          output = String(content ?? "");
        }
      }
      return [
        {
          type: "function_call_output",
          call_id: toolCallId,
          output,
        },
      ];
    }

    if (role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls)
        ? (message.tool_calls as Array<Record<string, unknown>>)
        : [];
      const items: Record<string, unknown>[] = [];
      const normalizedContent = this.normalizeResponseMessageContent(content);
      if (normalizedContent !== undefined) {
        items.push({
          role,
          content: normalizedContent,
        });
      }
      for (const tc of toolCalls) {
        const functionData = (tc.function as Record<string, unknown> | undefined) ?? {};
        const callId = String(tc.id ?? "").trim();
        const name = String(functionData.name ?? "").trim();
        const args = String(functionData.arguments ?? "");
        if (!callId || !name) continue;
        items.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: args,
        });
      }
      return items;
    }

    if (role === "system" || role === "user") {
      const normalizedContent = this.normalizeResponseMessageContent(content);
      if (normalizedContent === undefined) return [];
      return [{ role, content: normalizedContent }];
    }

    const normalizedContent = this.normalizeResponseMessageContent(content);
    if (normalizedContent === undefined) return [];
    return [{ role, content: normalizedContent }];
  }

  private normalizeResponseMessageContent(
    content: unknown,
  ): string | Array<Record<string, unknown>> | undefined {
    if (typeof content === "string") {
      if (content.length === 0) return undefined;
      return content;
    }
    if (!Array.isArray(content)) {
      return undefined;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const entry = part as Record<string, unknown>;
      if (entry.type === "text") {
        const text = String(entry.text ?? "");
        if (text.length > 0) {
          parts.push({ type: "input_text", text });
        }
      } else if (entry.type === "image_url") {
        const image = (entry.image_url as Record<string, unknown> | undefined) ?? {};
        const url = String(image.url ?? "");
        if (url.length > 0) {
          parts.push({ type: "input_image", image_url: url });
        }
      }
    }
    if (parts.length === 0) return undefined;
    return parts;
  }

  /**
   * Auto-mitigate the documented xAI /v1/responses mid-sentence
   * truncation bug (report.txt §4.4). When a response matches the
   * known trigger — status="completed", incomplete_details=null,
   * zero tool-call blocks, tools sent, tool_choice="auto", input has
   * prior function_call_output turns, text ends mid-sentence — this
   * method re-issues the SAME request with tool_choice="none" to
   * force xAI's text-mode decoder path, which the reproduction matrix
   * proves is not affected by the bug.
   *
   * Returns the corrected response payload on successful mitigation,
   * or `undefined` if the original response was not truncated, the
   * retry failed, or the retry itself also truncated (a second
   * truncation would indicate a different failure mode and the
   * original response is returned upstream).
   *
   * The retry is single-shot (no loops), non-streaming (simpler to
   * buffer), and does not propagate any client-side AbortSignal so a
   * user-initiated cancel still fires at the higher level.
   */
  private async maybeRetryMidSentenceTruncation(
    client: unknown,
    originalParams: Record<string, unknown>,
    originalResponse: Record<string, unknown>,
    options: LLMChatOptions | undefined,
    transport: "chat" | "chat_stream",
  ): Promise<Record<string, unknown> | undefined> {
    const anomalies = validateXaiResponsePostFlight({
      request: originalParams,
      response: originalResponse,
    });
    const truncation = anomalies.find(
      (a) => a.code === "truncated_response_mid_sentence",
    );
    if (!truncation) return undefined;

    // Clone params and force the mitigating tool_choice. Keep the
    // retry non-streaming so the caller doesn't have to re-buffer
    // SSE deltas. parallel_tool_calls is meaningless with
    // tool_choice="none" — drop it so the strict pre-flight doesn't
    // see a redundant field on the retry.
    const retryParams: Record<string, unknown> = {
      ...originalParams,
      tool_choice: "none",
      stream: false,
    };
    delete retryParams.parallel_tool_calls;

    emitProviderTraceEvent(options, {
      kind: "request",
      transport,
      provider: this.name,
      model: String(retryParams.model ?? this.config.model),
      payload:
        cloneProviderTracePayload(retryParams) ??
        { error: "provider_retry_request_trace_unavailable" },
      context: {
        retryReason: "xai_mid_sentence_truncation_mitigation",
        originalEvidence: truncation.evidence,
      } as unknown as ReturnType<typeof buildProviderRequestTraceContext>,
    });

    try {
      const retryResult = await createWithResponseMetadata<
        Record<string, unknown>
      >(client, retryParams, undefined);
      const retryResponse = retryResult.data;

      emitProviderTraceEvent(options, {
        kind: "response",
        transport,
        provider: this.name,
        model: String(
          (retryResponse as { model?: unknown }).model ?? retryParams.model,
        ),
        payload:
          cloneProviderTracePayload(retryResponse) ??
          { error: "provider_retry_response_trace_unavailable" },
        context: {
          retryReason: "xai_mid_sentence_truncation_mitigation",
        } as unknown as ReturnType<typeof buildProviderResponseTraceContext>,
      });

      // Re-run post-flight on the retry. If the retry ALSO truncated
      // (a second hit of the same bug on the mitigation path), give
      // up and let the caller surface the original response so the
      // failure stays visible rather than hanging on mitigation.
      const retryAnomalies = validateXaiResponsePostFlight({
        request: retryParams,
        response: retryResponse,
      });
      const retryTruncated = retryAnomalies.some(
        (a) => a.code === "truncated_response_mid_sentence",
      );
      if (retryTruncated) {
        console.warn(
          `[GrokProvider] xAI mid-sentence truncation retry with ` +
            `tool_choice="none" also returned a truncated response; ` +
            `falling through to original.`,
        );
        return undefined;
      }

      return retryResponse;
    } catch (err) {
      console.warn(
        `[GrokProvider] xAI mid-sentence truncation retry failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  private parseResponse(
    response: any,
    request: Record<string, unknown> | undefined,
    requestMetrics?: LLMRequestMetrics,
    statefulDiagnostics?: LLMStatefulDiagnostics,
    compactionDiagnostics?: LLMCompactionDiagnostics,
    structuredOutputRequest?: LLMChatOptions["structuredOutput"],
  ): LLMResponse & {
    normalizationIssues?: readonly ToolCallNormalizationIssue[];
  } {
    const { toolCalls, normalizationIssues } = this.extractToolCallsFromOutput(
      response.output,
    );

    // Strict post-flight: detect xAI silent-degradation patterns. Error-
    // level anomalies throw so the executor sees them as provider_error.
    // Warn-level anomalies (model silent aliasing, incomplete responses)
    // log via console.warn for observability without failing the turn.
    // Pass-through path when no request context is available (e.g. parsing
    // a stored response by ID).
    if (request) {
      const anomalies = validateXaiResponsePostFlight({
        request,
        response: response as Record<string, unknown>,
      });
      for (const anomaly of anomalies) {
        if (
          anomaly.severity === "error" &&
          anomaly.code === "silent_tool_drop_promised_in_text"
        ) {
          throw new XaiSilentToolDropError(
            "incoming_promised_tools_missing",
            anomaly.evidence,
          );
        }
        // truncated_response_mid_sentence is handled upstream by
        // maybeRetryMidSentenceTruncation() BEFORE parseResponse is
        // called. If it surfaces here, it means the retry ran and
        // also truncated, OR parseResponse was called on a stored
        // response that bypassed the mitigation. Either way the
        // truncation has already been logged; don't re-log here.
        if (anomaly.code === "truncated_response_mid_sentence") continue;
        console.warn(
          `[GrokProvider] xAI post-flight anomaly (${anomaly.code}): ${anomaly.message}`,
          anomaly.evidence,
        );
      }
    }

    const finishReason = this.mapResponseFinishReason(response, toolCalls);
    const responseId =
      typeof response?.id === "string" ? String(response.id) : undefined;
    const stateful = statefulDiagnostics
      ? {
        ...statefulDiagnostics,
        responseId,
      }
      : undefined;
    const compaction = compactionDiagnostics;
    const parsedError = this.extractResponseError(response, finishReason);

    return {
      content: this.extractOutputText(response) ?? "",
      toolCalls,
      usage: this.parseUsage(response),
      model: String(response.model ?? this.config.model),
      requestMetrics,
      stateful,
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
    // Stored responses are retrieved by ID; we don't have the original
    // request body, so the post-flight validator runs in pass-through mode.
    const parsed = this.parseResponse(response, undefined);
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
    return {
      promptTokens: Number(usage?.input_tokens ?? 0),
      completionTokens: Number(usage?.output_tokens ?? 0),
      totalTokens: Number(usage?.total_tokens ?? 0),
    };
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
      name: String(candidate.name ?? ""),
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
