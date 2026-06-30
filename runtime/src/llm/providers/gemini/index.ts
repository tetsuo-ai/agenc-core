/**
 * Native Google Gemini provider module.
 *
 * @module
 */

import { ProviderHttpClient } from "../../client.js";
import {
  ProviderHttpError,
  type ProviderHttpStreamResponse,
} from "../../client-session.js";
import { parseSSEFrames } from "../../_deps/sse.js";
import { LLMProviderError } from "../../errors.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMRequestMetrics,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
  LLMUsage,
  StreamProgressCallback,
} from "../../types.js";
import { validateToolCallDetailed } from "../../types.js";
import { coerceUsage } from "../../wire/shared.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  resolveGeminiCredential,
  type GeminiResolvedCredential,
} from "../../../utils/geminiAuth.js";

export interface GeminiProviderConfig extends OpenAIProviderConfig {
  readonly cachedContent?: string;
  readonly accessToken?: string;
  readonly resolveCredential?: (
    env?: NodeJS.ProcessEnv,
  ) => Promise<GeminiResolvedCredential>;
}

const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MAX_OUTPUT_TOKENS = 4096;
const GEMINI_INVALID_FUNCTION_CALL_MESSAGE =
  "Gemini response emitted invalid functionCall";

type GeminiPart = Record<string, unknown>;
type GeminiThinkingBlock = NonNullable<LLMResponse["thinking"]>[number];

interface GeminiParsedResponse {
  readonly content: string;
  readonly toolCalls: readonly LLMToolCall[];
  readonly usage: LLMUsage;
  readonly model: string;
  readonly thinking?: LLMResponse["thinking"];
  readonly finishReason: LLMResponse["finishReason"];
}

function normalizeGeminiBaseURL(baseURL: string | undefined): string {
  const normalized = baseURL?.trim();
  if (!normalized) {
    return DEFAULT_GEMINI_BASE_URL;
  }
  return normalized
    .replace(/\/openai\/?$/iu, "")
    .replace(/\/+$/u, "");
}

function normalizeGeminiModel(model: string): string {
  return model.trim().replace(/^models\//iu, "");
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isVertexGeminiBaseURL(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    return new URL(baseURL).hostname.endsWith("aiplatform.googleapis.com");
  } catch {
    return false;
  }
}

function hasVertexGooglePublisherBasePath(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    return /\/publishers\/google\/?$/iu.test(new URL(baseURL).pathname);
  } catch {
    return false;
  }
}

function geminiModelName(model: string): string {
  return normalizeGeminiModel(model).replace(
    /^publishers\/google\/models\//iu,
    "",
  );
}

function modelPath(
  baseURL: string | undefined,
  model: string,
  operation: "generateContent" | "streamGenerateContent",
): string {
  const encodedModel = encodeURIComponent(geminiModelName(model));
  if (isVertexGeminiBaseURL(baseURL) && !hasVertexGooglePublisherBasePath(baseURL)) {
    return `/publishers/google/models/${encodedModel}:${operation}`;
  }
  return `/models/${encodedModel}:${operation}`;
}

function modelsListPath(baseURL: string | undefined): string {
  return isVertexGeminiBaseURL(baseURL) && !hasVertexGooglePublisherBasePath(baseURL)
    ? "/publishers/google/models"
    : "/models";
}

function googleProjectHeaders(project: string | undefined): Record<string, string> {
  const normalized = nonEmptyString(project);
  return normalized ? { "x-goog-user-project": normalized } : {};
}

function authHeadersForCredential(
  credential: GeminiResolvedCredential,
  project: string | undefined,
): Record<string, string> | undefined {
  switch (credential.kind) {
    case "api-key":
      return {
        "x-goog-api-key": credential.credential,
        ...googleProjectHeaders(project),
      };
    case "access-token":
    case "adc":
      return {
        authorization: `Bearer ${credential.credential}`,
        ...googleProjectHeaders(project ?? credential.projectId),
      };
    case "none":
      return undefined;
  }
}

async function resolveGeminiAuthHeaders(
  config: GeminiProviderConfig,
): Promise<Record<string, string>> {
  const explicitAccessToken =
    nonEmptyString(config.accessToken) ??
    (config.authMode === "oauth"
      ? nonEmptyString(config.oauth?.accessToken)
      : undefined);
  if (explicitAccessToken) {
    return {
      authorization: `Bearer ${explicitAccessToken}`,
      ...googleProjectHeaders(config.project),
    };
  }

  const apiKey = nonEmptyString(config.apiKey);
  if (apiKey && config.authMode !== "oauth") {
    return {
      "x-goog-api-key": apiKey,
      ...googleProjectHeaders(config.project),
    };
  }

  const resolved = await (config.resolveCredential ?? resolveGeminiCredential)(
    process.env,
  );
  const headers = authHeadersForCredential(resolved, config.project);
  if (headers) return headers;

  throw new LLMProviderError(
    "gemini",
    "Gemini provider requires credentials: set GEMINI_API_KEY, GOOGLE_API_KEY, GEMINI_ACCESS_TOKEN, or Google ADC credentials",
    401,
  );
}

function finiteInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestUsageFromGemini(usage: unknown): LLMUsage {
  const record = isRecord(usage) ? usage : {};
  return coerceUsage({
    promptTokens: record.promptTokenCount,
    completionTokens: record.candidatesTokenCount,
    totalTokens: record.totalTokenCount,
    cachedInputTokens: record.cachedContentTokenCount,
    reasoningOutputTokens: record.thoughtsTokenCount,
  });
}

function geminiFinishReason(
  rawReason: unknown,
  toolCalls: readonly LLMToolCall[],
): LLMResponse["finishReason"] {
  if (toolCalls.length > 0) return "tool_calls";
  switch (String(rawReason ?? "").toUpperCase()) {
    case "STOP":
    case "":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "OTHER":
    default:
      return "error";
  }
}

function parseJsonObjectText(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function functionResponsePayload(content: string): Record<string, unknown> {
  return parseJsonObjectText(content) ?? { result: content };
}

function parseDataUrl(
  url: string,
  expectedPrefix: "image" | "application",
): { readonly mimeType: string; readonly data: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(url.trim());
  if (!match) return null;
  const mimeType = (match[1] ?? "").trim().toLowerCase();
  if (!mimeType.startsWith(`${expectedPrefix}/`)) return null;
  const data = (match[2] ?? "").replace(/\s+/gu, "");
  if (!mimeType || !data) return null;
  return { mimeType, data };
}

function inferMimeTypeFromUrl(url: string): string {
  const lower = url.split("?")[0]?.toLowerCase() ?? "";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function geminiPartsFromContent(
  content: LLMMessage["content"],
): readonly GeminiPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ text: content }] : [];
  }

  const parts: GeminiPart[] = [];
  for (const part of content as readonly unknown[]) {
    if (!isRecord(part)) continue;
    switch (part.type) {
      case "text": {
        if (typeof part.text === "string" && part.text.length > 0) {
          parts.push({ text: part.text });
        }
        break;
      }
      case "image_url": {
        const imageUrl = isRecord(part.image_url)
          ? nonEmptyString(part.image_url.url)
          : undefined;
        if (!imageUrl) break;
        const inline = parseDataUrl(imageUrl, "image");
        if (inline) {
          parts.push({
            inlineData: {
              mimeType: inline.mimeType,
              data: inline.data,
            },
          });
        } else {
          parts.push({
            fileData: {
              mimeType: inferMimeTypeFromUrl(imageUrl),
              fileUri: imageUrl,
            },
          });
        }
        break;
      }
      case "document": {
        const source = isRecord(part.source) ? part.source : undefined;
        if (
          source?.type === "base64" &&
          typeof source.data === "string" &&
          source.data.trim().length > 0
        ) {
          parts.push({
            inlineData: {
              mimeType: String(source.media_type ?? source.mediaType ?? "application/pdf"),
              data: source.data.replace(/\s+/gu, ""),
            },
          });
        } else if (typeof part.fallbackText === "string") {
          parts.push({ text: part.fallbackText });
        }
        break;
      }
      case "thinking":
      case "redacted_thinking": {
        const text =
          typeof part.thinking === "string"
            ? part.thinking
            : typeof part.data === "string"
              ? part.data
              : "";
        const signature = nonEmptyString(part.signature);
        if (text.length > 0 || signature) {
          parts.push({
            ...(text.length > 0 ? { text } : {}),
            thought: true,
            ...(signature ? { thoughtSignature: signature } : {}),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

function geminiFunctionCallPart(toolCall: LLMToolCall): GeminiPart {
  const args = parseJsonObjectText(toolCall.arguments) ?? {};
  return {
    functionCall: {
      name: toolCall.name,
      args,
    },
  };
}

function buildGeminiContents(messages: readonly LLMMessage[]): {
  readonly contents: readonly Record<string, unknown>[];
  readonly systemInstruction?: Record<string, unknown>;
} {
  const contents: Record<string, unknown>[] = [];
  const systemParts: GeminiPart[] = [];
  const toolCallNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const parts = geminiPartsFromContent(message.content);
      systemParts.push(...parts.filter((part) => typeof part.text === "string"));
      continue;
    }

    if (message.role === "tool") {
      const name =
        nonEmptyString(message.toolName) ??
        (message.toolCallId ? toolCallNames.get(message.toolCallId) : undefined) ??
        "tool";
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response: functionResponsePayload(
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              ),
            },
          },
        ],
      });
      continue;
    }

    const parts = [...geminiPartsFromContent(message.content)];
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        toolCallNames.set(toolCall.id, toolCall.name);
        parts.push(geminiFunctionCallPart(toolCall));
      }
    }
    if (parts.length === 0) continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return {
    contents,
    ...(systemParts.length > 0
      ? { systemInstruction: { parts: systemParts } }
      : {}),
  };
}

function geminiTools(tools: readonly LLMTool[]): readonly Record<string, unknown>[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    },
  ];
}

function geminiToolConfig(
  options: LLMChatOptions | undefined,
): Record<string, unknown> | undefined {
  const choice = options?.toolChoice;
  if (choice === undefined || choice === "auto") return undefined;
  if (choice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (choice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [choice.name],
    },
  };
}

function geminiGenerationConfig(
  options: LLMChatOptions | undefined,
  defaultMaxTokens: number | undefined,
): Record<string, unknown> {
  const maxOutputTokens =
    finiteInteger(options?.maxOutputTokens) ??
    finiteInteger(defaultMaxTokens) ??
    DEFAULT_GEMINI_MAX_OUTPUT_TOKENS;
  const config: Record<string, unknown> = { maxOutputTokens };
  if (typeof options?.temperature === "number" && Number.isFinite(options.temperature)) {
    config.temperature = options.temperature;
  }
  if (options?.stopSequences !== undefined && options.stopSequences.length > 0) {
    config.stopSequences = [...options.stopSequences];
  }
  const structuredSchema = options?.structuredOutput?.schema;
  if (options?.structuredOutput?.enabled || structuredSchema) {
    config.responseMimeType = "application/json";
    if (structuredSchema) {
      config.responseSchema = structuredSchema.schema;
    }
  }
  return config;
}

function cachedContentName(
  config: GeminiProviderConfig,
  options: LLMChatOptions | undefined,
): string | undefined {
  const requestKey = options?.promptCacheKey?.trim();
  if (requestKey?.startsWith("cachedContents/")) {
    return requestKey;
  }
  const configured = config.cachedContent?.trim();
  return configured?.startsWith("cachedContents/") ? configured : undefined;
}

function buildGeminiRequest(args: {
  readonly config: GeminiProviderConfig;
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
}): Record<string, unknown> {
  const contents = buildGeminiContents([
    ...(args.options?.systemPrompt
      ? [{ role: "system" as const, content: args.options.systemPrompt }]
      : []),
    ...args.messages,
  ]);
  const tools = geminiTools(args.tools);
  const toolConfig = geminiToolConfig(args.options);
  const cachedContent = cachedContentName(args.config, args.options);
  return {
    contents: contents.contents,
    ...(contents.systemInstruction
      ? { systemInstruction: contents.systemInstruction }
      : {}),
    generationConfig: geminiGenerationConfig(
      args.options,
      args.config.maxTokens,
    ),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(cachedContent ? { cachedContent } : {}),
  };
}

function validateGeminiToolCall(raw: unknown): LLMToolCall {
  const result = validateToolCallDetailed(raw);
  if (result.toolCall) return result.toolCall;
  throw new LLMProviderError(
    "gemini",
    `${GEMINI_INVALID_FUNCTION_CALL_MESSAGE}: ${
      result.failure?.message ?? "invalid payload"
    }`,
  );
}

function toolCallFromGeminiFunctionCall(
  functionCall: Record<string, unknown>,
  index: number,
): LLMToolCall {
  return validateGeminiToolCall({
    id: `gemini_call_${index}`,
    name: String(functionCall.name ?? ""),
    arguments: JSON.stringify(
      isRecord(functionCall.args) ? functionCall.args : {},
    ),
  });
}

function readCandidateParts(
  response: Record<string, unknown>,
): readonly GeminiPart[] {
  const candidates = Array.isArray(response.candidates)
    ? (response.candidates as readonly unknown[])
    : [];
  const firstCandidate = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(firstCandidate.content) ? firstCandidate.content : {};
  return Array.isArray(content.parts)
    ? (content.parts.filter(isRecord) as readonly GeminiPart[])
    : [];
}

function readFirstCandidate(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const candidates = Array.isArray(response.candidates)
    ? (response.candidates as readonly unknown[])
    : [];
  return isRecord(candidates[0]) ? candidates[0] : {};
}

function parseGeminiResponse(
  model: string,
  response: Record<string, unknown>,
): GeminiParsedResponse {
  const parts = readCandidateParts(response);
  let content = "";
  const toolCalls: LLMToolCall[] = [];
  const thinking: GeminiThinkingBlock[] = [];

  for (const [index, part] of parts.entries()) {
    if (part.thought === true) {
      const text = typeof part.text === "string" ? part.text : "";
      const signature =
        nonEmptyString(part.thoughtSignature) ??
        nonEmptyString(part.thought_signature);
      if (text.length > 0 || signature) {
        thinking.push({
          text,
          redacted: text.length === 0,
          ...(signature ? { signature } : {}),
          kind: "thinking",
        });
      }
      continue;
    }
    if (typeof part.text === "string") {
      content += part.text;
      continue;
    }
    if (isRecord(part.functionCall)) {
      toolCalls.push(toolCallFromGeminiFunctionCall(part.functionCall, index));
    }
  }

  const candidate = readFirstCandidate(response);
  return {
    content,
    toolCalls,
    usage: requestUsageFromGemini(response.usageMetadata),
    model,
    ...(thinking.length > 0 ? { thinking } : {}),
    finishReason: geminiFinishReason(candidate.finishReason, toolCalls),
  };
}

function requestMetrics(args: {
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly body: Record<string, unknown>;
  readonly stream: boolean;
}): LLMRequestMetrics {
  const contentLengths = args.messages.map((message) =>
    typeof message.content === "string"
      ? message.content.length
      : JSON.stringify(message.content).length,
  );
  const totalContentChars = contentLengths.reduce((sum, value) => sum + value, 0);
  return {
    messageCount: args.messages.length,
    systemMessages: args.messages.filter((message) => message.role === "system").length,
    userMessages: args.messages.filter((message) => message.role === "user").length,
    assistantMessages: args.messages.filter((message) => message.role === "assistant").length,
    toolMessages: args.messages.filter((message) => message.role === "tool").length,
    totalContentChars,
    maxMessageChars: contentLengths.length > 0 ? Math.max(...contentLengths) : 0,
    textParts: 0,
    imageParts: 0,
    toolCount: args.tools.length,
    toolNames: args.tools.map((tool) => tool.function.name),
    toolSchemaChars: JSON.stringify(args.tools).length,
    serializedChars: JSON.stringify(args.body).length,
    toolsAttached: args.tools.length > 0,
    stream: args.stream,
  };
}

function withMetrics(
  parsed: GeminiParsedResponse,
  metrics: LLMRequestMetrics,
): LLMResponse {
  return {
    content: parsed.content,
    toolCalls: [...parsed.toolCalls],
    usage: parsed.usage,
    model: parsed.model,
    requestMetrics: metrics,
    ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
    finishReason: parsed.finishReason,
  };
}

function mapProviderError(error: unknown): never {
  if (error instanceof ProviderHttpError) {
    throw new LLMProviderError("gemini", error.message, error.status);
  }
  if (error instanceof LLMProviderError) {
    throw error;
  }
  throw new LLMProviderError(
    "gemini",
    error instanceof Error ? error.message : String(error),
  );
}

interface GeminiSseEvent {
  readonly data: Record<string, unknown>;
}

async function* readGeminiSseEvents(
  response: ProviderHttpStreamResponse,
): AsyncGenerator<GeminiSseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response) {
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseSSEFrames(buffer, "gemini");
    buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (!frame.data || frame.data === "[DONE]") {
        if (frame.data === "[DONE]") return;
        continue;
      }
      try {
        const data = JSON.parse(frame.data) as unknown;
        if (isRecord(data)) yield { data };
      } catch {
        continue;
      }
    }
  }
  buffer += decoder.decode();
  const parsed = parseSSEFrames(buffer, "gemini");
  for (const frame of parsed.frames) {
    if (!frame.data || frame.data === "[DONE]") {
      if (frame.data === "[DONE]") return;
      continue;
    }
    try {
      const data = JSON.parse(frame.data) as unknown;
      if (isRecord(data)) yield { data };
    } catch {
      continue;
    }
  }
}

class GeminiStreamState {
  content = "";
  usage: LLMUsage = coerceUsage({});
  model: string;
  finishReason: LLMResponse["finishReason"] = "stop";
  readonly toolCalls: LLMToolCall[] = [];
  readonly thinking: GeminiThinkingBlock[] = [];
  private thinkingOpen = new Set<number>();

  constructor(model: string) {
    this.model = model;
  }

  consumeResponse(
    response: Record<string, unknown>,
    onChunk: StreamProgressCallback,
  ): void {
    if (response.usageMetadata) {
      this.usage = requestUsageFromGemini(response.usageMetadata);
    }
    const candidate = readFirstCandidate(response);
    const parts = readCandidateParts(response);
    for (const [index, part] of parts.entries()) {
      this.consumePart(part, index, onChunk);
    }
    this.finishReason = geminiFinishReason(
      candidate.finishReason,
      this.toolCalls,
    );
  }

  finalize(onChunk: StreamProgressCallback): LLMResponse {
    for (const index of Array.from(this.thinkingOpen)) {
      onChunk({ content: "", done: false, thinkingBlockStop: { index } });
      this.thinkingOpen.delete(index);
    }
    onChunk({
      content: "",
      done: true,
      ...(this.toolCalls.length > 0 ? { toolCalls: this.toolCalls } : {}),
    });
    return {
      content: this.content,
      toolCalls: this.toolCalls,
      usage: this.usage,
      model: this.model,
      ...(this.thinking.length > 0 ? { thinking: this.thinking } : {}),
      finishReason: this.finishReason,
    };
  }

  private consumePart(
    part: GeminiPart,
    index: number,
    onChunk: StreamProgressCallback,
  ): void {
    if (part.thought === true) {
      const delta = typeof part.text === "string" ? part.text : "";
      const signature =
        nonEmptyString(part.thoughtSignature) ??
        nonEmptyString(part.thought_signature);
      if (!this.thinkingOpen.has(index)) {
        this.thinkingOpen.add(index);
        onChunk({
          content: "",
          done: false,
          thinkingBlockStart: { index, redacted: delta.length === 0 },
        });
      }
      if (delta.length > 0) {
        onChunk({
          content: "",
          done: false,
          thinkingDelta: { index, delta },
        });
      }
      if (delta.length > 0 || signature) {
        this.thinking.push({
          text: delta,
          redacted: delta.length === 0,
          ...(signature ? { signature } : {}),
          kind: "thinking",
        });
      }
      return;
    }
    if (typeof part.text === "string" && part.text.length > 0) {
      this.content += part.text;
      onChunk({ content: part.text, done: false });
      return;
    }
    if (isRecord(part.functionCall)) {
      const toolCall = toolCallFromGeminiFunctionCall(
        part.functionCall,
        this.toolCalls.length,
      );
      this.toolCalls.push(toolCall);
      const startChunk: LLMStreamChunk = {
        content: "",
        done: false,
        toolInputBlockStart: {
          callId: toolCall.id,
          index: this.toolCalls.length - 1,
          contentBlock: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: parseJsonObjectText(toolCall.arguments) ?? {},
          },
        },
      };
      onChunk(startChunk);
      onChunk({
        content: "",
        done: false,
        toolInputDelta: {
          callId: toolCall.id,
          index: this.toolCalls.length - 1,
          partialJson: toolCall.arguments,
        },
      });
    }
  }
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";

  private readonly config: GeminiProviderConfig;
  private readonly client: ProviderHttpClient;

  constructor(config: GeminiProviderConfig) {
    this.config = {
      ...config,
      providerName: "gemini",
      apiKeyEnvLabel: "GEMINI_API_KEY",
      useResponsesApi: false,
      baseURL: normalizeGeminiBaseURL(config.baseURL),
    };
    this.client = new ProviderHttpClient({
      providerName: this.name,
      baseURL: this.config.baseURL ?? DEFAULT_GEMINI_BASE_URL,
      model: this.config.model,
      defaultHeaders: this.config.defaultHeaders,
      resolveAuthHeaders: () => resolveGeminiAuthHeaders(this.config),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.config.fetchImpl,
      providerFallback: this.config.providerFallback,
      emitWarning: this.config.emitWarning,
      onCapabilityDrift: this.config.onCapabilityDrift,
      supportsStreaming: true,
    });
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const model = options?.model?.trim() || this.config.model;
    const tools = options?.tools ? [...options.tools] : this.config.tools ?? [];
    const body = buildGeminiRequest({
      config: this.config,
      model,
      messages,
      tools,
      options,
    });
    const metrics = requestMetrics({ messages, tools, body, stream: false });

    try {
      const session = this.client.createTurnSession({ wireApi: "custom" });
      const response = await session.requestJson<Record<string, unknown>>({
        path: modelPath(this.config.baseURL, model, "generateContent"),
        method: "POST",
        body,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        providerFallback: this.config.providerFallback,
      });
      return withMetrics(parseGeminiResponse(model, response.data), metrics);
    } catch (error) {
      mapProviderError(error);
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const model = options?.model?.trim() || this.config.model;
    const tools = options?.tools ? [...options.tools] : this.config.tools ?? [];
    const body = buildGeminiRequest({
      config: this.config,
      model,
      messages,
      tools,
      options,
    });
    const metrics = requestMetrics({ messages, tools, body, stream: true });

    try {
      const session = this.client.createTurnSession({ wireApi: "custom" });
      const response = await session.requestStream({
        path: modelPath(this.config.baseURL, model, "streamGenerateContent"),
        method: "POST",
        headers: { accept: "text/event-stream" },
        query: { alt: "sse" },
        body,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        providerFallback: this.config.providerFallback,
        retryBudget: { maxRetries: 0 },
      });
      const state = new GeminiStreamState(model);
      for await (const event of readGeminiSseEvents(response)) {
        state.consumeResponse(event.data, onChunk);
      }
      return {
        ...state.finalize(onChunk),
        requestMetrics: metrics,
      };
    } catch (error) {
      mapProviderError(error);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const session = this.client.createTurnSession({ wireApi: "custom" });
      await session.requestJson<Record<string, unknown>>({
        path: modelsListPath(this.config.baseURL),
        method: "GET",
      });
      return true;
    } catch {
      return false;
    }
  }

  async getExecutionProfile() {
    return {
      provider: this.name,
      model: this.config.model,
      ...(this.config.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.config.contextWindowTokens }
        : {}),
      ...(this.config.contextWindowTokens !== undefined
        ? { contextWindowSource: "explicit_config" as const }
        : {}),
      ...(this.config.maxTokens !== undefined
        ? { maxOutputTokens: this.config.maxTokens }
        : {}),
    };
  }
}
