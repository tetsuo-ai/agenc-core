/**
 * OpenAI Codex OAuth LLM provider adapter.
 *
 * Reuses Codex CLI ChatGPT OAuth credentials and sends OpenAI Responses API
 * requests to the Codex backend.
 *
 * @module
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMProviderTraceEvent,
  LLMRequestMetrics,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  LLMToolChoice,
  LLMUsage,
  StreamProgressCallback,
} from "../types.js";
import { validateToolCall } from "../types.js";
import { LLMProviderError, mapLLMError } from "../errors.js";
import { ensureLazyImport } from "../lazy-import.js";
import {
  buildUnsupportedCompactionDiagnostics,
  resolveLLMCompactionConfig,
  type ResolvedLLMCompactionConfig,
} from "../provider-capabilities.js";
import { parseStructuredOutputText } from "../structured-output.js";
import { withTimeout } from "../timeout.js";
import {
  repairToolTurnSequence,
  validateToolTurnSequence,
} from "../tool-turn-validator.js";
import { safeStringify } from "../../tools/types.js";
import {
  CodexOAuthCredentialManager,
  type CodexOAuthCredentialHeaders,
} from "./auth.js";
import type { CodexOAuthProviderConfig } from "./types.js";
import {
  DEFAULT_CODEX_CLIENT_VERSION,
  DEFAULT_CODEX_OAUTH_BASE_URL,
  DEFAULT_CODEX_OAUTH_CONTEXT_WINDOW_TOKENS,
  DEFAULT_CODEX_OAUTH_MODEL,
} from "./types.js";
import { sanitizeCodexJsonSchema } from "./schema.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const CODEX_DEFAULT_REASONING_EFFORT = "medium";
const CODEX_REASONING_INCLUDE = "reasoning.encrypted_content";
const CODEX_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CODEX_TOOL_NAME_HASH_CHARS = 10;
const CODEX_MAX_TOOL_NAME_CHARS = 64;
const CODEX_INSTALLATION_ID_METADATA_KEY = "x-codex-installation-id";

type ResolvedCodexOAuthProviderConfig = CodexOAuthProviderConfig & {
  readonly model: string;
  readonly baseUrl: string;
  readonly codexClientVersion: string;
  readonly contextWindowTokens: number;
  readonly parallelToolCalls: boolean;
};

type ToolResolutionStrategy =
  | "all_tools_no_filter"
  | "all_tools_empty_filter"
  | "subset_exact"
  | "subset_partial"
  | "subset_no_resolved_matches";

interface ToolSelectionDiagnostics {
  readonly tools: Record<string, unknown>[];
  readonly requestedToolNames: readonly string[];
  readonly resolvedToolNames: readonly string[];
  readonly missingRequestedToolNames: readonly string[];
  readonly providerCatalogToolCount: number;
  readonly toolResolution: ToolResolutionStrategy;
  readonly toolsAttached: boolean;
  readonly toolSuppressionReason?: string;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (timeoutMs <= 0) return undefined;
  return Math.max(1, Math.floor(timeoutMs));
}

function resolveRequestTimeoutMs(
  providerTimeoutMs: number | undefined,
  callTimeoutMs: number | undefined,
): number | undefined {
  const normalizedProviderTimeoutMs =
    typeof providerTimeoutMs === "number" &&
    Number.isFinite(providerTimeoutMs) &&
    providerTimeoutMs > 0
      ? Math.max(1, Math.floor(providerTimeoutMs))
      : undefined;
  if (
    typeof callTimeoutMs === "number" &&
    Number.isFinite(callTimeoutMs) &&
    callTimeoutMs <= 0
  ) {
    return undefined;
  }
  const normalizedCallTimeoutMs =
    typeof callTimeoutMs === "number" &&
    Number.isFinite(callTimeoutMs) &&
    callTimeoutMs > 0
      ? Math.max(1, Math.floor(callTimeoutMs))
      : undefined;
  if (normalizedProviderTimeoutMs === undefined) {
    return normalizedCallTimeoutMs;
  }
  if (normalizedCallTimeoutMs === undefined) {
    return normalizedProviderTimeoutMs;
  }
  return Math.max(
    1,
    Math.min(normalizedProviderTimeoutMs, normalizedCallTimeoutMs),
  );
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

function sanitizeCodexToolName(
  originalName: string,
  usedNames: Set<string>,
): string {
  const trimmed = originalName.trim();
  if (
    trimmed &&
    CODEX_TOOL_NAME_PATTERN.test(trimmed) &&
    !usedNames.has(trimmed)
  ) {
    usedNames.add(trimmed);
    return trimmed;
  }

  const hash = createHash("sha256")
    .update(originalName)
    .digest("hex")
    .slice(0, CODEX_TOOL_NAME_HASH_CHARS);
  const maxBaseLength =
    CODEX_MAX_TOOL_NAME_CHARS - CODEX_TOOL_NAME_HASH_CHARS - 1;
  let base = trimmed
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxBaseLength);
  if (!base) base = "tool";

  let candidate = `${base}_${hash}`;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(
      0,
      Math.max(1, CODEX_MAX_TOOL_NAME_CHARS - suffixText.length),
    )}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function resolveCodexToolChoice(
  toolChoice: LLMToolChoice | undefined,
  toProviderToolName: (name: string) => string,
): string {
  if (toolChoice === undefined || typeof toolChoice === "string") {
    return toolChoice ?? "auto";
  }
  const name = toolChoice.name.trim();
  return name.length > 0 ? toProviderToolName(name) : "auto";
}

function estimateContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (content === undefined || content === null) return 0;
  return safeStringify(content).length;
}

function collectParamDiagnostics(
  params: Record<string, unknown>,
  selection?: ToolSelectionDiagnostics,
): LLMRequestMetrics {
  const input = Array.isArray(params.input)
    ? (params.input as Array<Record<string, unknown>>)
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
  let textParts = 0;
  let imageParts = 0;

  if (typeof params.instructions === "string" && params.instructions.length > 0) {
    systemMessages++;
    totalContentChars += params.instructions.length;
    maxMessageChars = Math.max(maxMessageChars, params.instructions.length);
    textParts++;
  }

  for (const item of input) {
    const role = String(item.role ?? "");
    const type = String(item.type ?? "");
    if (role === "system") systemMessages++;
    if (role === "user") userMessages++;
    if (role === "assistant" || type === "function_call") assistantMessages++;
    if (role === "tool" || type === "function_call_output") toolMessages++;
    const content =
      type === "function_call_output"
        ? item.output
        : item.content ?? item.arguments;
    const chars = estimateContentChars(content);
    totalContentChars += chars;
    if (chars > maxMessageChars) maxMessageChars = chars;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          (part as { type?: unknown }).type === "input_image"
        ) {
          imageParts++;
        } else {
          textParts++;
        }
      }
    } else if (typeof content === "string" && content.length > 0) {
      textParts++;
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
    messageCount: input.length,
    systemMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    totalContentChars,
    maxMessageChars,
    textParts,
    imageParts,
    toolCount: tools.length,
    toolNames:
      selection?.resolvedToolNames ??
      tools
        .map((tool) =>
          typeof tool.name === "string" ? tool.name : undefined,
        )
        .filter((name): name is string => Boolean(name)),
    requestedToolNames: selection?.requestedToolNames,
    missingRequestedToolNames: selection?.missingRequestedToolNames,
    toolResolution: selection?.toolResolution,
    providerCatalogToolCount: selection?.providerCatalogToolCount,
    toolsAttached: selection?.toolsAttached,
    toolSuppressionReason: selection?.toolSuppressionReason,
    toolChoice:
      typeof params.tool_choice === "string"
        ? params.tool_choice
        : params.tool_choice === undefined
          ? undefined
          : safeStringify(params.tool_choice),
    toolSchemaChars,
    serializedChars,
    store: typeof params.store === "boolean" ? params.store : undefined,
    parallelToolCalls:
      typeof params.parallel_tool_calls === "boolean"
        ? params.parallel_tool_calls
        : undefined,
    stream: typeof params.stream === "boolean" ? params.stream : undefined,
    structuredOutputEnabled:
      typeof params.text === "object" && params.text !== null,
  };
}

export class CodexOAuthProvider implements LLMProvider {
  readonly name = "codex";

  private client: unknown | null = null;
  private clientAuthCacheKey: string | null = null;
  private readonly config: ResolvedCodexOAuthProviderConfig;
  private readonly tools: readonly LLMTool[];
  private readonly responseTools: readonly Record<string, unknown>[];
  private readonly providerToolNameByOriginalName = new Map<string, string>();
  private readonly originalToolNameByProviderName = new Map<string, string>();
  private readonly promptCacheKey: string;
  private readonly installationId: string;
  private readonly credentials: CodexOAuthCredentialManager;
  private readonly compactionConfig: ResolvedLLMCompactionConfig;

  constructor(config: CodexOAuthProviderConfig) {
    this.config = {
      ...config,
      model: config.model || DEFAULT_CODEX_OAUTH_MODEL,
      baseUrl: config.baseUrl ?? DEFAULT_CODEX_OAUTH_BASE_URL,
      timeoutMs: normalizeTimeoutMs(config.timeoutMs),
      contextWindowTokens:
        config.contextWindowTokens ?? DEFAULT_CODEX_OAUTH_CONTEXT_WINDOW_TOKENS,
      codexClientVersion:
        config.codexClientVersion ?? DEFAULT_CODEX_CLIENT_VERSION,
      parallelToolCalls: config.parallelToolCalls ?? false,
    };
    this.tools = config.tools ?? [];
    this.buildToolNameMappings(this.tools);
    this.responseTools = this.toResponseTools(this.tools);
    this.promptCacheKey = `agenc-codex-${randomUUID()}`;
    this.installationId = randomUUID();
    this.credentials = new CodexOAuthCredentialManager({
      codexHome: config.codexHome,
      codexAuthPath: config.codexAuthPath,
      refreshTokenUrl: config.refreshTokenUrl,
    });
    this.compactionConfig = resolveLLMCompactionConfig(undefined);
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    return this.chatStream(messages, () => undefined, options);
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
    const requestMetrics = {
      ...collectParamDiagnostics(params, toolSelection),
      stream: true,
    };
    const requestTimeoutMs = resolveRequestTimeoutMs(
      this.config.timeoutMs,
      options?.timeoutMs,
    );
    let content = "";
    let model = this.config.model;
    const toolCallsById = new Map<string, LLMToolCall>();
    let terminalResponse: Record<string, unknown> | undefined;

    try {
      emitProviderTraceEvent(options, {
        kind: "request",
        transport: "chat_stream",
        provider: this.name,
        model: String(params.model ?? this.config.model),
        payload:
          cloneProviderTracePayload(params) ??
          { error: "provider_request_trace_unavailable" },
        context: { timeoutMs: requestTimeoutMs },
      });
      const stream = await withTimeout(
        async (signal) =>
          (client as any).responses.create(params, { signal }),
        requestTimeoutMs,
        this.name,
        options?.signal,
      );

      for await (const event of stream as AsyncIterable<any>) {
        emitProviderTraceEvent(options, {
          kind: "stream_event",
          transport: "chat_stream",
          provider: this.name,
          model,
          payload:
            cloneProviderTracePayload(event) ??
            { type: String(event?.type ?? "stream.event") },
        });
        if (event?.type === "response.output_text.delta") {
          const delta = String(event.delta ?? "");
          if (delta.length > 0) {
            content += delta;
            onChunk({ content: delta, done: false });
          }
          continue;
        }
        if (event?.type === "response.output_item.done") {
          const toolCall = this.toToolCall(event.item);
          if (toolCall) toolCallsById.set(toolCall.id, toolCall);
          continue;
        }
        if (event?.type === "response.completed" || event?.type === "response.failed") {
          terminalResponse =
            event.response &&
            typeof event.response === "object" &&
            !Array.isArray(event.response)
              ? (event.response as Record<string, unknown>)
              : {};
          if (typeof terminalResponse.model === "string") {
            model = terminalResponse.model;
          }
        }
      }

      const parsed = terminalResponse
        ? this.parseResponse(terminalResponse, options)
        : undefined;
      if (parsed) {
        for (const toolCall of parsed.toolCalls) {
          toolCallsById.set(toolCall.id, toolCall);
        }
        if (content.length === 0 && parsed.content.length > 0) {
          content = parsed.content;
          onChunk({ content, done: false });
        }
        const toolCalls = [...toolCallsById.values()];
        onChunk({ content: "", done: true, toolCalls });
        return {
          ...parsed,
          content: parsed.content || content,
          toolCalls,
          requestMetrics,
        };
      }

      const toolCalls = [...toolCallsById.values()];
      onChunk({ content: "", done: true, toolCalls });
      return {
        content,
        toolCalls,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model,
        requestMetrics,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
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
        const toolCalls = [...toolCallsById.values()];
        onChunk({ content: "", done: true, toolCalls });
        return {
          content,
          toolCalls,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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
      await this.credentials.getAuthHeaders();
      return true;
    } catch {
      return false;
    }
  }

  async getExecutionProfile() {
    const maxOutputTokens =
      typeof this.config.maxTokens === "number" && this.config.maxTokens > 0
        ? this.config.maxTokens
        : undefined;
    return {
      provider: this.name,
      model: this.config.model,
      contextWindowTokens:
        this.config.contextWindowTokens ??
        DEFAULT_CODEX_OAUTH_CONTEXT_WINDOW_TOKENS,
      contextWindowSource:
        this.config.contextWindowTokens !== undefined
          ? ("explicit_config" as const)
          : ("codex_default" as const),
      maxOutputTokens,
    };
  }

  private async ensureClient(): Promise<unknown> {
    const auth = await this.credentials.getAuthHeaders();
    const defaultHeaders = this.buildDefaultHeaders(auth);
    const cacheKey = JSON.stringify({
      baseUrl: this.config.baseUrl,
      accessToken: auth.accessToken,
      defaultHeaders,
    });
    if (this.client && this.clientAuthCacheKey === cacheKey) {
      return this.client;
    }
    this.client = await ensureLazyImport("openai", this.name, (mod) => {
      const OpenAI = (mod.OpenAI ?? mod.default) as any;
      return new OpenAI({
        apiKey: auth.accessToken,
        baseURL: this.config.baseUrl,
        defaultHeaders,
        timeout: this.config.timeoutMs,
      });
    });
    this.clientAuthCacheKey = cacheKey;
    return this.client;
  }

  private buildDefaultHeaders(
    auth: CodexOAuthCredentialHeaders,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      version: this.config.codexClientVersion ?? DEFAULT_CODEX_CLIENT_VERSION,
    };
    for (const [key, value] of Object.entries(auth.headers)) {
      if (key.toLowerCase() === "authorization") continue;
      headers[key] = value;
    }
    return headers;
  }

  private buildParams(
    messages: readonly LLMMessage[],
    options?: LLMChatOptions,
    toolSelection?: ToolSelectionDiagnostics,
  ): Record<string, unknown> {
    const repairedMessages = repairToolTurnSequence(messages);
    validateToolTurnSequence(repairedMessages, { providerName: this.name });
    const instructions = repairedMessages
      .filter((message) => message.role === "system")
      .map((message) => this.stringifyContent(message.content).trim())
      .filter((content) => content.length > 0)
      .join("\n\n");
    const input = repairedMessages
      .filter((message) => message.role !== "system")
      .flatMap((message) => this.toResponseInputItems(message));
    const selectedTools =
      toolSelection ?? this.selectTools(options?.toolRouting?.allowedToolNames);
    const tools = options?.toolChoice === "none" ? [] : selectedTools.tools;
    const params: Record<string, unknown> = {
      model: this.config.model,
      instructions,
      input,
      tools,
      tool_choice: resolveCodexToolChoice(options?.toolChoice, (name) =>
        this.toProviderToolName(name),
      ),
      parallel_tool_calls:
        options?.parallelToolCalls ?? this.config.parallelToolCalls,
      reasoning: {
        effort: options?.reasoningEffort ?? CODEX_DEFAULT_REASONING_EFFORT,
      },
      store: false,
      stream: true,
      include: [CODEX_REASONING_INCLUDE],
      prompt_cache_key: options?.promptCacheKey?.trim() || this.promptCacheKey,
      client_metadata: {
        [CODEX_INSTALLATION_ID_METADATA_KEY]: this.installationId,
      },
    };
    const structuredOutputSchema = options?.structuredOutput?.schema;
    if (
      options?.structuredOutput?.enabled !== false &&
      structuredOutputSchema
    ) {
      params.text = {
        format: {
          type: structuredOutputSchema.type,
          name: structuredOutputSchema.name,
          schema: structuredOutputSchema.schema,
          strict: structuredOutputSchema.strict ?? true,
        },
      };
    }
    return params;
  }

  private selectTools(
    allowedToolNames?: readonly string[],
  ): ToolSelectionDiagnostics {
    const providerCatalogToolCount = this.responseTools.length;
    const providerCatalogToolNames = this.tools.map((tool) => tool.function.name);
    if (allowedToolNames === undefined) {
      return {
        tools: [...this.responseTools],
        requestedToolNames: [],
        resolvedToolNames: providerCatalogToolNames,
        missingRequestedToolNames: [],
        providerCatalogToolCount,
        toolResolution: "all_tools_no_filter",
        toolsAttached: this.responseTools.length > 0,
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
        toolSuppressionReason: "empty_allowlist",
      };
    }

    const allowed = new Set(
      allowedToolNames
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );
    const requestedToolNames = [...allowed];
    const selected: Record<string, unknown>[] = [];
    const resolvedToolNames: string[] = [];
    for (let index = 0; index < this.tools.length; index += 1) {
      const originalName = this.tools[index]?.function.name ?? "";
      if (!allowed.has(originalName)) continue;
      const responseTool = this.responseTools[index];
      if (!responseTool) continue;
      selected.push(responseTool);
      resolvedToolNames.push(originalName);
    }
    const missingRequestedToolNames = requestedToolNames.filter(
      (name) => !resolvedToolNames.includes(name),
    );
    if (selected.length === 0) {
      return {
        tools: [],
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
      requestedToolNames,
      resolvedToolNames,
      missingRequestedToolNames,
      providerCatalogToolCount,
      toolResolution:
        missingRequestedToolNames.length > 0 ? "subset_partial" : "subset_exact",
      toolsAttached: true,
    };
  }

  private buildToolNameMappings(tools: readonly LLMTool[]): void {
    const usedNames = new Set<string>();
    for (const tool of tools) {
      const originalName = tool.function.name;
      const providerName = sanitizeCodexToolName(originalName, usedNames);
      this.providerToolNameByOriginalName.set(originalName, providerName);
      this.originalToolNameByProviderName.set(providerName, originalName);
    }
  }

  private toProviderToolName(originalName: string): string {
    const mapped = this.providerToolNameByOriginalName.get(originalName);
    if (mapped) return mapped;
    const trimmed = originalName.trim();
    if (trimmed && CODEX_TOOL_NAME_PATTERN.test(trimmed)) return trimmed;
    return sanitizeCodexToolName(
      originalName,
      new Set(this.originalToolNameByProviderName.keys()),
    );
  }

  private toOriginalToolName(providerName: string): string {
    return this.originalToolNameByProviderName.get(providerName) ?? providerName;
  }

  private toResponseTools(tools: readonly LLMTool[]): Record<string, unknown>[] {
    return tools.map((tool) => ({
      type: "function",
      name: this.toProviderToolName(tool.function.name),
      description: tool.function.description,
      parameters: sanitizeCodexJsonSchema(tool.function.parameters),
    }));
  }

  private toResponseInputItems(message: LLMMessage): Record<string, unknown>[] {
    if (message.role === "system") {
      return [];
    }

    if (message.role === "tool") {
      const toolCallId = String(message.toolCallId ?? "").trim();
      if (!toolCallId) return [];
      return [
        {
          type: "function_call_output",
          call_id: toolCallId,
          output: this.stringifyContent(message.content),
        },
      ];
    }

    if (message.role === "assistant") {
      const items: Record<string, unknown>[] = [];
      const normalizedContent = this.normalizeResponseMessageContent(
        message.content,
        "assistant",
      );
      if (normalizedContent !== undefined) {
        items.push({
          type: "message",
          role: "assistant",
          content: normalizedContent,
        });
      } else if ((message.toolCalls ?? []).length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Calling tool." }],
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        items.push({
          type: "function_call",
          call_id: toolCall.id,
          name: this.toProviderToolName(toolCall.name),
          arguments: toolCall.arguments,
        });
      }
      return items;
    }

    const normalizedContent = this.normalizeResponseMessageContent(
      message.content,
      "user",
    );
    if (normalizedContent === undefined) return [];
    return [{ type: "message", role: message.role, content: normalizedContent }];
  }

  private normalizeResponseMessageContent(
    content: LLMMessage["content"],
    role: "assistant" | "user",
  ): Array<Record<string, unknown>> | undefined {
    const textType = role === "assistant" ? "output_text" : "input_text";
    if (typeof content === "string") {
      return content.length > 0 ? [{ type: textType, text: content }] : undefined;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (part.type === "text") {
        if (part.text.length > 0) {
          parts.push({ type: textType, text: part.text });
        }
        continue;
      }
      if (part.type === "image_url") {
        parts.push({ type: "input_image", image_url: part.image_url.url });
      }
    }
    return parts.length > 0 ? parts : undefined;
  }

  private stringifyContent(content: LLMMessage["content"]): string {
    if (typeof content === "string") return content;
    const text = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return text.length > 0 ? text : safeStringify(content);
  }

  private parseResponse(
    response: Record<string, unknown>,
    options?: LLMChatOptions,
  ): LLMResponse {
    const toolCalls = this.extractToolCallsFromOutput(response.output);
    const finishReason = this.mapResponseFinishReason(response, toolCalls);
    const error = this.extractResponseError(response, finishReason);
    return {
      content: this.extractOutputText(response) ?? "",
      toolCalls,
      usage: this.parseUsage(response),
      model: String(response.model ?? this.config.model),
      finishReason,
      structuredOutput: this.extractStructuredOutputResult(response, options),
      ...(error ? { error } : {}),
      ...this.buildUnsupportedDiagnostics(options),
    };
  }

  private extractOutputText(
    response: Record<string, unknown>,
  ): string | undefined {
    const direct = response.output_text;
    if (typeof direct === "string") return direct;
    const output = Array.isArray(response.output)
      ? (response.output as Array<Record<string, unknown>>)
      : [];
    const chunks: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object" || item.type !== "message") {
        continue;
      }
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      for (const part of content) {
        if (part.type === "output_text" && typeof part.text === "string") {
          chunks.push(part.text);
        }
      }
    }
    return chunks.length > 0 ? chunks.join("") : "";
  }

  private extractStructuredOutputResult(
    response: Record<string, unknown>,
    options?: LLMChatOptions,
  ): LLMResponse["structuredOutput"] {
    const schema = options?.structuredOutput?.schema;
    if (options?.structuredOutput?.enabled === false || !schema) {
      return undefined;
    }
    const rawText = this.extractOutputText(response);
    if (!rawText || rawText.trim().length === 0) return undefined;
    return parseStructuredOutputText(rawText, schema.name, schema.schema);
  }

  private parseUsage(response: Record<string, unknown>): LLMUsage {
    const usage =
      response.usage && typeof response.usage === "object"
        ? (response.usage as Record<string, unknown>)
        : {};
    const promptTokens = Number(usage.input_tokens ?? 0);
    const completionTokens = Number(usage.output_tokens ?? 0);
    const totalTokens = Number(
      usage.total_tokens ?? promptTokens + completionTokens,
    );
    return {
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
      totalTokens: Number.isFinite(totalTokens)
        ? totalTokens
        : promptTokens + completionTokens,
    };
  }

  private toToolCall(item: unknown): LLMToolCall | null {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const candidate = item as Record<string, unknown>;
    if (candidate.type !== "function_call") return null;
    const providerName = String(candidate.name ?? "");
    return validateToolCall({
      id: String(candidate.call_id ?? candidate.id ?? ""),
      name: this.toOriginalToolName(providerName),
      arguments: String(candidate.arguments ?? "{}"),
    });
  }

  private extractToolCallsFromOutput(output: unknown): LLMToolCall[] {
    if (!Array.isArray(output)) return [];
    return output
      .map((item) => this.toToolCall(item))
      .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);
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
        response.incomplete_details &&
        typeof response.incomplete_details === "object" &&
        !Array.isArray(response.incomplete_details)
          ? (response.incomplete_details as Record<string, unknown>)
          : {};
      const reason = String(details.reason ?? "");
      if (reason.includes("content_filter")) return "content_filter";
      return "length";
    }
    return "stop";
  }

  private extractResponseError(
    response: Record<string, unknown>,
    finishReason: LLMResponse["finishReason"],
  ): Error | undefined {
    if (finishReason !== "error") return undefined;
    const rawError = response.error;
    const errorObj =
      rawError && typeof rawError === "object" && !Array.isArray(rawError)
        ? (rawError as Record<string, unknown>)
        : undefined;
    const message =
      typeof errorObj?.message === "string" && errorObj.message.length > 0
        ? errorObj.message
        : "Codex backend returned failed response status";
    const codeRaw = errorObj?.code ?? errorObj?.status ?? errorObj?.statusCode;
    const statusCode =
      typeof codeRaw === "number"
        ? codeRaw
        : Number.parseInt(String(codeRaw ?? ""), 10);
    return new LLMProviderError(
      this.name,
      message,
      Number.isFinite(statusCode) ? statusCode : undefined,
    );
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

  private mapError(err: unknown, timeoutMs?: number): Error {
    return mapLLMError(this.name, err, timeoutMs ?? this.config.timeoutMs ?? 0);
  }
}
