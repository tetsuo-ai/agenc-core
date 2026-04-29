/**
 * OpenAI-compatible local LLM provider adapter.
 *
 * Connects to any server exposing the OpenAI /v1/chat/completions interface —
 * LM Studio, llama.cpp server, vLLM — using the `openai` npm SDK pointed at
 * a local baseUrl. Does not require xAI credentials or catalog validation.
 *
 * Startup validation is kicked off eagerly in the constructor via
 * {@link validateOpenAICompatConfig} and awaited on first client use. The
 * provider refuses to initialize if the configured baseUrl is not a local/LAN
 * address, the server is unreachable, or the configured model is absent from
 * GET /v1/models.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMProvider,
  LLMMessage,
  LLMProviderTraceEvent,
  LLMRequestMetrics,
  LLMResponse,
  LLMToolCall,
  LLMUsage,
  LLMTool,
  StreamProgressCallback,
} from "../types.js";
import { validateToolCall } from "../types.js";
import type { OpenAICompatProviderConfig } from "./types.js";
import { LLMProviderError, mapLLMError } from "../errors.js";
import { ensureLazyImport } from "../lazy-import.js";
import {
  buildUnsupportedCompactionDiagnostics,
  resolveLLMCompactionConfig,
  type ResolvedLLMCompactionConfig,
} from "../provider-capabilities.js";
import { withTimeout } from "../timeout.js";
import { repairToolTurnSequence, validateToolTurnSequence } from "../tool-turn-validator.js";
import { safeStringify } from "../../tools/types.js";
import { validateOpenAICompatConfig } from "./openai-compat-filter.js";

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

    const content =
      typeof message.content === "string"
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

/** Accumulated state for a single tool call during streaming. */
interface StreamingToolCallAccumulator {
  name: string;
  arguments: string;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name = "openai-compat";

  private client: unknown | null = null;
  private readonly config: OpenAICompatProviderConfig;
  private readonly tools: LLMTool[];
  private readonly compactionConfig: ResolvedLLMCompactionConfig;
  private readonly _validationPromise: Promise<void>;

  constructor(config: OpenAICompatProviderConfig) {
    // Kick off startup validation eagerly. The promise is awaited in
    // ensureClient() so the error surfaces on first API call. Three checks
    // run in order: baseUrl is local/LAN, server is reachable via GET
    // /v1/models, configured model is present in the response.
    this._validationPromise = validateOpenAICompatConfig(config);

    this.config = config;
    this.tools = config.tools ?? [];
    this.compactionConfig = resolveLLMCompactionConfig(undefined);
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const client = await this.ensureClient();
    const toolSelection = this.selectTools(options?.toolRouting?.allowedToolNames);
    const params = this.buildParams(messages, options, toolSelection);
    const requestMetrics = collectParamDiagnostics(params, toolSelection);
    const requestTimeoutMs = resolveRequestTimeoutMs(
      this.config.timeoutMs,
      options?.timeoutMs,
    );

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
        async (signal) =>
          (client as any).chat.completions.create(params, { signal }),
        requestTimeoutMs,
        this.name,
        options?.signal,
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
    const toolSelection = this.selectTools(options?.toolRouting?.allowedToolNames);
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
    let model = this.config.model;
    let toolCalls: LLMToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    // Accumulate OpenAI streaming tool_calls by index across chunks.
    // The id and function.name only appear on the first delta for each
    // index; function.arguments is distributed across subsequent deltas.
    const toolCallAccumulator = new Map<number, StreamingToolCallAccumulator>();

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
      const stream = await withTimeout(
        async (signal) =>
          (client as any).chat.completions.create(params, { signal }),
        requestTimeoutMs,
        this.name,
        options?.signal,
      );

      for await (const chunk of stream as AsyncIterable<any>) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content.length > 0) {
            content += delta.content;
            onChunk({ content: delta.content, done: false });
          }

          // Accumulate tool call deltas by index
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx =
                typeof tc.index === "number" ? tc.index : toolCallAccumulator.size;
              if (!toolCallAccumulator.has(idx)) {
                toolCallAccumulator.set(idx, { name: "", arguments: "" });
              }
              const acc = toolCallAccumulator.get(idx)!;
              if (typeof tc.function?.name === "string") {
                acc.name = tc.function.name;
              }
              if (typeof tc.function?.arguments === "string") {
                acc.arguments += tc.function.arguments;
              }
            }
          }
        }

        if (typeof chunk.model === "string" && chunk.model.length > 0) {
          model = chunk.model;
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      // Convert accumulated deltas to LLMToolCall objects.
      // Each call gets a fresh UUID — never reuse the server-provided id or
      // the function name. Using the function name as an ID (the bug in the
      // Ollama adapter) produces non-unique IDs when the same tool is called
      // multiple times in one turn, corrupting tool-result correlation on
      // follow-up turns.
      toolCalls = [...toolCallAccumulator.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, acc]) =>
          validateToolCall({
            id: crypto.randomUUID(),
            name: acc.name,
            arguments: acc.arguments.length > 0 ? acc.arguments : "{}",
          }),
        )
        .filter((tc): tc is LLMToolCall => tc !== null);

      const finishReason: LLMResponse["finishReason"] =
        toolCalls.length > 0 ? "tool_calls" : "stop";
      onChunk({ content: "", done: true, toolCalls });
      emitProviderTraceEvent(options, {
        kind: "response",
        transport: "chat_stream",
        provider: this.name,
        model,
        payload: {
          choices: [
            {
              message: {
                content,
                role: "assistant",
                ...(toolCalls.length > 0
                  ? {
                    tool_calls: toolCalls.map((tc) => ({
                      type: "function",
                      function: { name: tc.name, arguments: tc.arguments },
                    })),
                  }
                  : {}),
              },
              finish_reason: finishReason,
            },
          ],
          model,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          },
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
      await (client as any).models.list();
      return true;
    } catch {
      return false;
    }
  }

  async getExecutionProfile() {
    return {
      provider: this.name,
      model: this.config.model,
      contextWindowTokens: this.config.contextWindowTokens,
      contextWindowSource: "explicit_config" as const,
      maxOutputTokens:
        typeof this.config.maxTokens === "number" && this.config.maxTokens > 0
          ? this.config.maxTokens
          : undefined,
    };
  }

  private async ensureClient(): Promise<unknown> {
    // Surface any startup validation error (baseUrl, reachability, model
    // presence) before attempting to create the SDK client.
    await this._validationPromise;

    if (this.client) return this.client;

    this.client = await ensureLazyImport("openai", this.name, (mod) => {
      const OpenAI = (mod.OpenAI ?? mod.default) as any;
      return new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
      });
    });
    return this.client;
  }

  private buildParams(
    messages: LLMMessage[],
    options?: LLMChatOptions,
    toolSelection?: ToolSelectionDiagnostics,
  ): Record<string, unknown> {
    const repairedMessages = repairToolTurnSequence(messages);
    validateToolTurnSequence(repairedMessages, { providerName: this.name });

    const params: Record<string, unknown> = {
      model: this.config.model,
      messages: repairedMessages.map((m) => this.toOpenAIMessage(m)),
    };

    if (this.config.temperature !== undefined) {
      params.temperature = this.config.temperature;
    }
    if (
      typeof this.config.maxTokens === "number" &&
      Number.isFinite(this.config.maxTokens) &&
      this.config.maxTokens > 0
    ) {
      params.max_tokens = this.config.maxTokens;
    }

    if (this.tools.length > 0) {
      params.tools = (
        toolSelection ?? this.selectTools(options?.toolRouting?.allowedToolNames)
      ).tools;
    }

    return params;
  }

  private selectTools(
    allowedToolNames?: readonly string[],
  ): ToolSelectionDiagnostics {
    const providerCatalogToolCount = this.tools.length;
    const providerCatalogToolNames = this.tools.map((tool) => tool.function.name);
    if (allowedToolNames === undefined) {
      return {
        tools: this.tools,
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
    const filtered = this.tools.filter((tool) => allowed.has(tool.function.name));
    const resolvedToolNames = filtered.map((tool) => tool.function.name);
    const missingRequestedToolNames = requestedToolNames.filter(
      (name) => !resolvedToolNames.includes(name),
    );
    if (filtered.length === 0) {
      console.warn(
        `[OpenAICompatAdapter] Tool allowlist resolved to ${requestedToolNames.length} names but zero matched the provider catalog — suppressing all tools for this call (requested: ${requestedToolNames.join(", ")})`,
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

    return { role: msg.role, content: msg.content };
  }

  private parseResponse(response: any, options?: LLMChatOptions): LLMResponse {
    const choice = response.choices?.[0];
    const message = choice?.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";

    const toolCalls: LLMToolCall[] = (message.tool_calls ?? [])
      .map((tc: any) =>
        validateToolCall({
          /**
           * Generate a fresh UUID rather than using tc.id (the server-assigned
           * call ID) or tc.function.name. Using the function name as an ID —
           * the bug present in the Ollama adapter — produces non-unique IDs when
           * the same tool is called multiple times in one turn, corrupting
           * tool-result correlation on follow-up turns.
           */
          id: crypto.randomUUID(),
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "{}",
        }),
      )
      .filter((tc: LLMToolCall | null): tc is LLMToolCall => tc !== null);

    const usage: LLMUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens:
        response.usage?.total_tokens ??
        (response.usage?.prompt_tokens ?? 0) +
          (response.usage?.completion_tokens ?? 0),
    };

    return {
      content,
      toolCalls,
      usage,
      model: response.model ?? this.config.model,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      ...this.buildUnsupportedDiagnostics(options),
    };
  }

  private mapError(err: unknown, timeoutMs?: number): Error {
    const e = err as any;
    if (e?.code === "ECONNREFUSED") {
      return new LLMProviderError(
        this.name,
        `Cannot connect to local server at ${this.config.baseUrl}. Is the server running?`,
      );
    }

    return mapLLMError(this.name, err, timeoutMs ?? this.config.timeoutMs ?? 0);
  }
}
