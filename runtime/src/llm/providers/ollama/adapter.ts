/**
 * Ollama local LLM provider adapter.
 *
 * Uses the `ollama` SDK for local model inference.
 * The SDK is loaded lazily on first use — it's an optional dependency.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type {
  LLMChatOptions,
  LLMContentPart,
  LLMProvider,
  LLMMessage,
  LLMProviderTraceEvent,
  LLMRequestMetrics,
  LLMResponse,
  LLMToolCall,
  LLMUsage,
  LLMTool,
  StreamProgressCallback,
} from "../../types.js";
import { validateToolCall } from "../../types.js";
import type { OllamaProviderConfig } from "./types.js";
import { LLMProviderError, mapLLMError } from "../../errors.js";
import { ensureLazyImport } from "../../lazy-import.js";
import {
  buildUnsupportedCompactionDiagnostics,
  resolveLLMCompactionConfig,
  type ResolvedLLMCompactionConfig,
} from "../../provider-capabilities.js";
import { withTimeout } from "../../timeout.js";
import { repairToolTurnSequence, validateToolTurnSequence } from "../../tool-turn-validator.js";
import { safeStringify } from "../../_deps/safe-stringify.js";
import { resolveContextWindowProfile } from "../../_deps/context-window.js";
import { withOllamaHealthSidecar } from "./health.js";
import { isRecord } from "../../../utils/record.js";

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.3";

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  if (timeoutMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function resolveRequestTimeoutMs(
  providerTimeoutMs: number | undefined,
  callTimeoutMs: number | undefined,
): number | undefined {
  const normalizedProviderTimeoutMs = normalizeTimeoutMs(providerTimeoutMs);
  if (typeof callTimeoutMs === "number" && Number.isFinite(callTimeoutMs) && callTimeoutMs <= 0) {
    return undefined;
  }
  const normalizedCallTimeoutMs = normalizeTimeoutMs(callTimeoutMs);
  if (normalizedProviderTimeoutMs === undefined) {
    return normalizedCallTimeoutMs;
  }
  if (normalizedCallTimeoutMs === undefined) {
    return normalizedProviderTimeoutMs;
  }
  return Math.max(1, Math.min(normalizedProviderTimeoutMs, normalizedCallTimeoutMs));
}

type ToolResolutionStrategy =
  | "all_tools_no_filter"
  | "all_tools_empty_filter"
  | "subset_exact"
  | "subset_partial"
  // Mirrors the Grok adapter's `subset_no_resolved_matches`: caller
  // constrained the allowlist but no listed tool matched the catalog.
  // Returns an empty tool set rather than the full catalog.
  | "subset_no_resolved_matches";

interface ToolSelectionDiagnostics {
  readonly tools: LLMTool[];
  readonly requestedToolNames: readonly string[];
  readonly resolvedToolNames: readonly string[];
  readonly missingRequestedToolNames: readonly string[];
  readonly providerCatalogToolCount: number;
  readonly toolResolution: ToolResolutionStrategy;
  readonly toolsAttached: boolean;
  readonly toolSuppressionReason?: string;
}

function collectParamDiagnostics(
  params: Record<string, unknown>,
  selection?: ToolSelectionDiagnostics,
): LLMRequestMetrics {
  const messages = Array.isArray(params.messages)
    ? (params.messages as Array<Record<string, unknown>>)
    : [];
  const tools = Array.isArray(params.tools)
    ? (params.tools as Array<Record<string, unknown>>)
    : [];

  let totalContentChars = 0;
  let maxMessageChars = 0;
  let systemMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;

  for (const message of messages) {
    const role = String(message.role ?? "");
    if (role === "system") systemMessages++;
    if (role === "user") userMessages++;
    if (role === "assistant") assistantMessages++;
    if (role === "tool") toolMessages++;

    const content = typeof message.content === "string"
      ? message.content
      : safeStringify(message.content ?? "");
    totalContentChars += content.length;
    if (content.length > maxMessageChars) {
      maxMessageChars = content.length;
    }
  }

  let serializedChars = 0;
  let toolSchemaChars = 0;
  try {
    serializedChars = safeStringify(params).length;
  } catch {
    serializedChars = -1;
  }
  try {
    toolSchemaChars = safeStringify(tools).length;
  } catch {
    toolSchemaChars = -1;
  }

  return {
    messageCount: messages.length,
    systemMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    totalContentChars,
    maxMessageChars,
    textParts: 0,
    imageParts: 0,
    toolCount: tools.length,
    toolNames: tools
      .map((tool) => {
        const fn = tool.function;
        return fn &&
          typeof fn === "object" &&
          !Array.isArray(fn) &&
          typeof (fn as Record<string, unknown>).name === "string"
          ? String((fn as Record<string, unknown>).name)
          : undefined;
      })
      .filter((name): name is string => Boolean(name)),
    requestedToolNames: selection?.requestedToolNames,
    missingRequestedToolNames: selection?.missingRequestedToolNames,
    toolResolution: selection?.toolResolution,
    providerCatalogToolCount: selection?.providerCatalogToolCount,
    toolsAttached: selection?.toolsAttached,
    toolSuppressionReason: selection?.toolSuppressionReason,
    toolChoice: undefined,
    toolSchemaChars,
    serializedChars,
    store: undefined,
    parallelToolCalls: undefined,
    stream: typeof params.stream === "boolean" ? params.stream : undefined,
  };
}

function cloneProviderTracePayload(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    return JSON.parse(safeStringify(value)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readNonNegativeNumberOrZero(value: unknown): number {
  return readNonNegativeNumber(value) ?? 0;
}

function serializeOllamaToolArguments(value: unknown): string | null {
  if (value === undefined) return "{}";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "{}";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) return trimmed;
    } catch {
      // Fall through to the validator path below; non-JSON strings should not
      // become executable tool arguments.
    }
  }
  try {
    return safeStringify(value);
  } catch {
    return null;
  }
}

function normalizeOllamaToolCall(raw: unknown): LLMToolCall | null {
  if (!isRecord(raw) || !isRecord(raw.function)) return null;
  const serializedArguments = serializeOllamaToolArguments(
    raw.function.arguments,
  );
  if (serializedArguments === null) return null;
  return validateToolCall({
    id: randomUUID(),
    name: readString(raw.function.name),
    arguments: serializedArguments,
  });
}

function normalizeOllamaToolCalls(raw: unknown): LLMToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeOllamaToolCall)
    .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);
}

function buildProviderTraceErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const payload: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) payload.stack = error.stack;
    const status = (error as { status?: unknown }).status;
    if (
      typeof status === "string" ||
      typeof status === "number" ||
      typeof status === "boolean"
    ) {
      payload.status = status;
    }
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" ||
      typeof code === "number" ||
      typeof code === "boolean"
    ) {
      payload.code = code;
    }
    return payload;
  }
  return { error: String(error) };
}

function emitProviderTraceEvent(
  options: LLMChatOptions | undefined,
  event: LLMProviderTraceEvent,
): void {
  options?.trace?.onProviderTraceEvent?.(event);
}

function buildToolSelectionTraceContext(
  selection: ToolSelectionDiagnostics,
  timeoutMs?: number,
): Record<string, unknown> {
  return {
    requestedToolNames: selection.requestedToolNames,
    resolvedToolNames: selection.resolvedToolNames,
    missingRequestedToolNames: selection.missingRequestedToolNames,
    toolResolution: selection.toolResolution,
    providerCatalogToolCount: selection.providerCatalogToolCount,
    toolsAttached: selection.toolsAttached,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function readAbortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Ollama stream aborted");
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    throw readAbortReason(signal);
  }

  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const abort = (): void => reject(readAbortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void iterator.next()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
}

async function* abortableAsyncIterable<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await nextWithAbort(iterator, signal);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    void iterator.return?.();
  }
}

function onAbort(signal: AbortSignal, abort: () => void): () => void {
  if (signal.aborted) {
    abort();
    return () => {};
  }
  const handleAbort = (): void => abort();
  signal.addEventListener("abort", handleAbort, { once: true });
  return () => signal.removeEventListener("abort", handleAbort);
}

function abortOllamaStream(stream: unknown): void {
  const abort = (stream as { abort?: unknown })?.abort;
  if (typeof abort === "function") {
    abort.call(stream);
  }
}

function abortOllamaClient(client: unknown): void {
  const abort = (client as { abort?: unknown })?.abort;
  if (typeof abort === "function") {
    abort.call(client);
  }
}

function parseToolCallArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to an empty object; malformed historical arguments should
    // not make provider serialization fail before the validator can respond.
  }
  return {};
}

// Strips the `data:image/...;base64,` prefix from a data-URL, returning the
// raw base64 payload. Mirrors the data-URL parsing used by the shared wire
// helpers. Returns null for non-data-URL inputs.
function extractImageBase64FromDataUrl(url: string): string | null {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/iu.exec(url.trim());
  if (!match) return null;
  const data = (match[1] ?? "").replace(/\s+/gu, "");
  return data.length > 0 ? data : null;
}

function isHttpImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Splits multimodal `LLMContentPart[]` content into the shape Ollama's chat
 * API expects: text parts joined into `content`, and SDK-supported image
 * strings collected into a separate `images` array (Ollama does NOT accept
 * images inside `content`).
 */
function extractOllamaContent(parts: LLMContentPart[]): {
  content: string;
  images: string[];
} {
  const textPieces: string[] = [];
  const images: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      textPieces.push(part.text);
      continue;
    }
    if (part.type === "image_url") {
      const url = part.image_url.url;
      const base64 = extractImageBase64FromDataUrl(url);
      if (base64 !== null) {
        images.push(base64);
        continue;
      }
      if (isHttpImageUrl(url)) {
        images.push(url.trim());
        continue;
      }
      // The Ollama SDK accepts base64 strings, file paths, and remote URLs.
      // Unknown schemes are kept as visible text rather than dropped.
      textPieces.push(`[image: ${url}]`);
    }
  }
  return { content: textPieces.join("\n"), images };
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";

  private client: unknown | null = null;
  private readonly config: OllamaProviderConfig;
  private readonly tools: LLMTool[];
  private readonly compactionConfig: ResolvedLLMCompactionConfig;

  constructor(config: OllamaProviderConfig) {
    this.config = {
      ...config,
      model: config.model ?? DEFAULT_MODEL,
      host: config.host ?? DEFAULT_HOST,
    };
    this.tools = config.tools ?? [];
    this.compactionConfig = resolveLLMCompactionConfig(undefined);
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const requestTools = options?.tools ? [...options.tools] : this.tools;
    const toolSelection = this.selectTools(
      options?.toolRouting?.allowedToolNames,
      requestTools,
    );
    const params = this.buildParams(messages, options, toolSelection);
    const requestMetrics = collectParamDiagnostics(params, toolSelection);
    const requestTimeoutMs = resolveRequestTimeoutMs(
      this.config.timeoutMs,
      options?.timeoutMs,
    );

    // Wrap the non-streaming chat path with the health sidecar. The
    // streaming path already does this; without it here the
    // `--print` and `oneShotCLI` flows hang on a closed local ollama
    // port until `requestTimeoutMs` expires (minutes by default).
    return await withOllamaHealthSidecar({
      signal: options?.signal,
      healthCheck: async () => await this.healthCheck(),
      operation: async (signal) => await this.runChatWithSignal({
        client,
        params,
        options,
        toolSelection,
        requestTimeoutMs,
        requestMetrics,
        signal,
      }),
    });
  }

  private async runChatWithSignal(args: {
    readonly client: unknown;
    readonly params: Record<string, unknown>;
    readonly options: LLMChatOptions | undefined;
    readonly toolSelection: ReturnType<OllamaProvider["selectTools"]>;
    readonly requestTimeoutMs: number | undefined;
    readonly requestMetrics: ReturnType<typeof collectParamDiagnostics>;
    readonly signal: AbortSignal;
  }): Promise<LLMResponse> {
    const { client, params, options, toolSelection, requestTimeoutMs, requestMetrics, signal } = args;
    try {
      emitProviderTraceEvent(options, {
        kind: "request",
        transport: "chat",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(params) ??
          { error: "provider_request_trace_unavailable" },
        context: buildToolSelectionTraceContext(toolSelection, requestTimeoutMs),
      });
      const response = await withTimeout(
        async () => (client as any).chat(params),
        requestTimeoutMs,
        this.name,
        signal,
      );
      emitProviderTraceEvent(options, {
        kind: "response",
        transport: "chat",
        provider: this.name,
        model: String(response?.model ?? params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(response) ??
          { error: "provider_response_trace_unavailable" },
      });
      return {
        ...this.parseResponse(response, options),
        requestMetrics,
      };
    } catch (err: unknown) {
      emitProviderTraceEvent(options, {
        kind: "error",
        transport: "chat",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload: buildProviderTraceErrorPayload(err),
      });
      throw this.mapError(err, requestTimeoutMs);
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const requestTools = options?.tools ? [...options.tools] : this.tools;
    const toolSelection = this.selectTools(
      options?.toolRouting?.allowedToolNames,
      requestTools,
    );
    const params: Record<string, unknown> = {
      ...this.buildParams(messages, options, toolSelection),
      stream: true,
    };
    const requestMetrics = collectParamDiagnostics(params, toolSelection);
    const requestTimeoutMs = resolveRequestTimeoutMs(
      this.config.timeoutMs,
      options?.timeoutMs,
    );
    let content = "";
    let model = String(params.model ?? this.config.model);
    let toolCalls: LLMToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      emitProviderTraceEvent(options, {
        kind: "request",
        transport: "chat_stream",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(params) ??
          { error: "provider_request_trace_unavailable" },
        context: buildToolSelectionTraceContext(toolSelection, requestTimeoutMs),
      });
      await withOllamaHealthSidecar({
        signal: options?.signal,
        healthCheck: async () => await this.healthCheck(),
        operation: async (signal) => {
          const cleanupClientAbort = onAbort(signal, () =>
            abortOllamaClient(client));
          const stream = await withTimeout(
            async () => (client as any).chat(params),
            requestTimeoutMs,
            this.name,
            signal,
          ).finally(() => {
            cleanupClientAbort();
          });
          const cleanupStreamAbort = onAbort(signal, () =>
            abortOllamaStream(stream));

          try {
            for await (const rawChunk of abortableAsyncIterable(
              stream as AsyncIterable<any>,
              signal,
            )) {
              const chunk = isRecord(rawChunk) ? rawChunk : {};
              const message = isRecord(chunk.message) ? chunk.message : {};
              const chunkContent = readString(message.content);

              if (chunkContent) {
                content += chunkContent;
                onChunk({ content: chunkContent, done: false });
              }

              toolCalls = [
                ...toolCalls,
                ...normalizeOllamaToolCalls(message.tool_calls),
              ];

              const chunkModel = readString(chunk.model);
              if (chunkModel) model = chunkModel;
              promptTokens =
                readNonNegativeNumber(chunk.prompt_eval_count) ?? promptTokens;
              completionTokens =
                readNonNegativeNumber(chunk.eval_count) ?? completionTokens;
            }
          } finally {
            cleanupStreamAbort();
          }
        },
      });

      const finishReason: LLMResponse["finishReason"] =
        toolCalls.length > 0 ? "tool_calls" : "stop";
      onChunk({ content: "", done: true, toolCalls });
      emitProviderTraceEvent(options, {
        kind: "response",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload: {
          message: {
            content,
            role: "assistant",
            ...(toolCalls.length > 0
              ? {
                tool_calls: toolCalls.map((toolCall) => ({
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                  },
                })),
              }
              : {}),
          },
          model,
          prompt_eval_count: promptTokens,
          eval_count: completionTokens,
        },
      });

      return {
        content,
        toolCalls,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        model,
        requestMetrics,
        finishReason,
        ...this.buildUnsupportedDiagnostics(options),
      };
    } catch (err: unknown) {
      emitProviderTraceEvent(options, {
        kind: "error",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload: buildProviderTraceErrorPayload(err),
      });
      if (content.length > 0) {
        const mappedError = this.mapError(err, requestTimeoutMs);
        onChunk({ content: "", done: true, toolCalls });
        return {
          content,
          toolCalls,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
          model,
          requestMetrics,
          finishReason: "error",
          error: mappedError,
          partial: true,
          ...this.buildUnsupportedDiagnostics(options),
        };
      }
      throw this.mapError(err, requestTimeoutMs);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      await (client as any).list();
      return true;
    } catch {
      return false;
    }
  }

  async getExecutionProfile() {
    return (
      await resolveContextWindowProfile({
        provider: "ollama",
        baseUrl: this.config.host,
        model: this.config.model,
        maxTokens:
          typeof this.config.maxTokens === "number" && this.config.maxTokens > 0
            ? this.config.maxTokens
            : undefined,
        contextWindowTokens: this.config.numCtx,
      })
    ) ?? {
      provider: "ollama",
      model: this.config.model,
      maxOutputTokens:
        typeof this.config.maxTokens === "number" && this.config.maxTokens > 0
          ? this.config.maxTokens
          : undefined,
    };
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyImport("ollama", this.name, (mod) => {
      const OllamaClass = (mod.Ollama ?? mod.default) as any;
      return new OllamaClass({ host: this.config.host });
    });
    return this.client;
  }

  private buildParams(
    messages: LLMMessage[],
    options?: LLMChatOptions,
    toolSelection?: ToolSelectionDiagnostics,
  ): Record<string, unknown> {
    const requestMessages =
      options?.systemPrompt?.trim()
        ? [{ role: "system" as const, content: options.systemPrompt.trim() }, ...messages]
        : messages;
    const repairedMessages = repairToolTurnSequence(requestMessages);
    validateToolTurnSequence(repairedMessages, { providerName: this.name });

    const params: Record<string, unknown> = {
      model: options?.model?.trim() || this.config.model,
      messages: repairedMessages.map((m) => this.toOllamaMessage(m)),
    };

    // Build model options
    const modelOptions: Record<string, unknown> = {};
    if (options?.temperature !== undefined)
      modelOptions.temperature = options.temperature;
    else if (this.config.temperature !== undefined)
      modelOptions.temperature = this.config.temperature;
    if (
      typeof (options?.maxOutputTokens ?? this.config.maxTokens) === "number" &&
      Number.isFinite(options?.maxOutputTokens ?? this.config.maxTokens) &&
      (options?.maxOutputTokens ?? this.config.maxTokens)! > 0
    )
      modelOptions.num_predict = Math.floor(
        (options?.maxOutputTokens ?? this.config.maxTokens)!,
      );
    if (this.config.numCtx !== undefined) modelOptions.num_ctx = this.config.numCtx;
    if (this.config.numGpu !== undefined) modelOptions.num_gpu = this.config.numGpu;
    if (options?.stopSequences !== undefined && options.stopSequences.length > 0) {
      modelOptions.stop = [...options.stopSequences];
    }
    if (Object.keys(modelOptions).length > 0) params.options = modelOptions;

    if (this.config.keepAlive !== undefined)
      params.keep_alive = this.config.keepAlive;

    // Tools use the provider-compatible function schema.
    const requestTools = options?.tools ? [...options.tools] : this.tools;
    if (requestTools.length > 0) {
      params.tools = (toolSelection ?? this.selectTools(
        options?.toolRouting?.allowedToolNames,
        requestTools,
      )).tools;
    }

    return params;
  }

  private selectTools(
    allowedToolNames?: readonly string[],
    tools: readonly LLMTool[] = this.tools,
  ): ToolSelectionDiagnostics {
    const providerCatalogToolCount = tools.length;
    const providerCatalogToolNames = tools.map((tool) => tool.function.name);
    if (allowedToolNames === undefined) {
      return {
        tools: [...tools],
        requestedToolNames: [],
        resolvedToolNames: providerCatalogToolNames,
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_no_filter",
        toolsAttached: true,
      };
    }

    if (allowedToolNames.length === 0) {
      return {
        tools: [],
        requestedToolNames: [],
        resolvedToolNames: [],
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_empty_filter",
        toolsAttached: false,
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
        requestedToolNames: [],
        resolvedToolNames: [],
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_empty_filter",
        toolsAttached: false,
      };
    }

    const requestedToolNames = [...allowed];
    const filtered = tools.filter((tool) => allowed.has(tool.function.name));
    const resolvedToolNames = filtered.map((tool) => tool.function.name);
    const missingRequestedToolNames = requestedToolNames.filter((name) =>
      !resolvedToolNames.includes(name)
    );
    if (filtered.length === 0) {
      // Mirror the Grok adapter fix: when zero tools resolve from a
      // non-empty allowlist, return an empty tool set rather than the
      // full catalog. The previous behavior silently bypassed the
      // allowlist constraint and shipped under
      // `fallback_full_catalog_no_matches`.
      console.warn(
        `[OllamaAdapter] Tool allowlist resolved to ${requestedToolNames.length} names but zero matched the provider catalog — suppressing all tools for this call (requested: ${requestedToolNames.join(", ")})`,
      );
      return {
        tools: [],
        requestedToolNames,
        resolvedToolNames: [],
        missingRequestedToolNames: requestedToolNames,
        providerCatalogToolCount,
        toolResolution: "subset_no_resolved_matches",
        toolsAttached: false,
      };
    }

    return {
      tools: filtered,
      requestedToolNames,
      resolvedToolNames,
      missingRequestedToolNames,
      providerCatalogToolCount,
      toolResolution:
        missingRequestedToolNames.length > 0 ? "subset_partial" : "subset_exact",
      toolsAttached: true,
    };
  }

  private buildUnsupportedDiagnostics(
    _options?: LLMChatOptions,
  ): Pick<LLMResponse, "compaction"> {
    return {
      compaction: buildUnsupportedCompactionDiagnostics({
        provider: this.name,
        compaction: this.compactionConfig,
      }),
    };
  }

  private toOllamaMessage(msg: LLMMessage): Record<string, unknown> {
    if (msg.role === "tool") {
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
        ...(msg.toolName ? { tool_name: msg.toolName } : {}),
      };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.toolCalls.map((toolCall) => ({
          function: {
            name: toolCall.name,
            arguments: parseToolCallArguments(toolCall.arguments),
          },
        })),
      };
    }
    const role = msg.role === "developer" ? "system" : msg.role;
    if (Array.isArray(msg.content)) {
      const { content, images } = extractOllamaContent(msg.content);
      return {
        role,
        content,
        ...(images.length > 0 ? { images } : {}),
      };
    }
    return {
      role,
      content: msg.content,
    };
  }

  private parseResponse(response: unknown, options?: LLMChatOptions): LLMResponse {
    const record = isRecord(response) ? response : {};
    const message = isRecord(record.message) ? record.message : {};
    const content = readString(message.content);
    const toolCalls = normalizeOllamaToolCalls(message.tool_calls);

    const promptTokens = readNonNegativeNumberOrZero(record.prompt_eval_count);
    const completionTokens = readNonNegativeNumberOrZero(record.eval_count);
    const usage: LLMUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };

    return {
      content,
      toolCalls,
      usage,
      model:
        readString(record.model) ||
        options?.model?.trim() ||
        this.config.model ||
        DEFAULT_MODEL,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      ...this.buildUnsupportedDiagnostics(options),
    };
  }

  private mapError(err: unknown, timeoutMs?: number): Error {
    // Ollama-specific: connection refused means server isn't running
    const e = err as any;
    if (e?.code === "ECONNREFUSED") {
      return new LLMProviderError(
        this.name,
        `Cannot connect to Ollama at ${this.config.host}. Is the server running?`,
      );
    }

    return mapLLMError(this.name, err, timeoutMs ?? this.config.timeoutMs ?? 0);
  }
}
