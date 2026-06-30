/**
 * Amazon Bedrock runtime provider.
 *
 * Implements the Bedrock Runtime Converse API directly so AgenC can use AWS
 * SigV4 credentials without depending on the AWS SDK at runtime.
 *
 * @module
 */

import { createHash, createHmac } from "node:crypto";
import type {
  LLMChatOptions,
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  LLMProviderConfig,
  LLMRequestMetrics,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  LLMToolChoice,
  LLMUsage,
  StreamProgressCallback,
} from "../../types.js";
import { nonEmptyString as nonBlankText } from "../../../utils/stringUtils.js";

const DEFAULT_REGION = "us-east-1";
const BEDROCK_SERVICE = "bedrock";
const BEDROCK_RUNTIME_HOST_PREFIX = "bedrock-runtime";
const JSON_CONTENT_TYPE = "application/json";
const EMPTY_TEXT_PLACEHOLDER = "[empty message]";

export interface BedrockProviderConfig extends LLMProviderConfig {
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
  readonly region?: string;
  readonly baseURL?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

interface BedrockCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

type BedrockRole = "user" | "assistant";

type BedrockContentBlock =
  | { readonly text: string }
  | { readonly toolUse: BedrockToolUseBlock }
  | { readonly toolResult: BedrockToolResultBlock };

interface BedrockMessage {
  readonly role: BedrockRole;
  readonly content: readonly BedrockContentBlock[];
}

interface BedrockToolUseBlock {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface BedrockToolResultBlock {
  readonly toolUseId: string;
  readonly content: readonly ({ readonly json: unknown } | { readonly text: string })[];
  readonly status?: "success" | "error";
}

interface BedrockRequest {
  readonly messages: readonly BedrockMessage[];
  readonly system?: readonly { readonly text: string }[];
  readonly inferenceConfig?: {
    readonly maxTokens?: number;
    readonly temperature?: number;
  };
  readonly toolConfig?: {
    readonly tools: readonly {
      readonly toolSpec: {
        readonly name: string;
        readonly description?: string;
        readonly inputSchema: { readonly json: Record<string, unknown> };
      };
    }[];
    readonly toolChoice?: BedrockToolChoice;
  };
}

type BedrockToolChoice =
  | { readonly auto: Record<string, never> }
  | { readonly any: Record<string, never> }
  | { readonly tool: { readonly name: string } };

interface BedrockResponse {
  readonly output?: {
    readonly message?: {
      readonly role?: string;
      readonly content?: readonly BedrockContentBlock[];
    };
  };
  readonly stopReason?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
  };
}

type BedrockStreamToolBlock = {
  readonly id: string;
  readonly name: string;
  arguments: string;
};

interface SignedRequest {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function formatAmzDate(date: Date): { readonly dateStamp: string; readonly amzDate: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    dateStamp: iso.slice(0, 8),
    amzDate: iso,
  };
}

export function bedrockBaseURLForRegion(region: string): string {
  return `https://${BEDROCK_RUNTIME_HOST_PREFIX}.${region}.amazonaws.com`;
}

function normalizeRegion(region: string | undefined): string {
  return firstNonEmpty(region) ?? DEFAULT_REGION;
}

function normalizeBaseURL(baseURL: string | undefined, region: string): string {
  return firstNonEmpty(baseURL) ?? bedrockBaseURLForRegion(region);
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildCanonicalHeaders(
  headers: Readonly<Record<string, string>>,
): {
  readonly canonicalHeaders: string;
  readonly signedHeaders: string;
} {
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    canonicalHeaders: entries.map(([key, value]) => `${key}:${value}\n`).join(""),
    signedHeaders: entries.map(([key]) => key).join(";"),
  };
}

function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, BEDROCK_SERVICE);
  return hmac(serviceKey, "aws4_request");
}

function signRequest(params: {
  readonly baseURL: string;
  readonly region: string;
  readonly model: string;
  readonly body: string;
  readonly credentials: BedrockCredentials;
  readonly now: Date;
  readonly operation?: "converse" | "converse-stream";
}): SignedRequest {
  const operation = params.operation ?? "converse";
  const path = `/model/${encodeURIComponent(params.model)}/${operation}`;
  const url = new URL(path, params.baseURL);
  const payloadHash = sha256Hex(params.body);
  const { dateStamp, amzDate } = formatAmzDate(params.now);
  const headers: Record<string, string> = {
    "content-type": JSON_CONTENT_TYPE,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (params.credentials.sessionToken) {
    headers["x-amz-security-token"] = params.credentials.sessionToken;
  }

  const { canonicalHeaders, signedHeaders } = buildCanonicalHeaders(headers);
  const canonicalRequest = [
    "POST",
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${params.region}/${BEDROCK_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(
    signingKey(params.credentials.secretAccessKey, dateStamp, params.region),
    stringToSign,
  );

  return {
    url,
    body: params.body,
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function contentPartText(part: LLMContentPart): string | undefined {
  if (part.type === "text") return part.text;
  if (part.type === "document") return part.fallbackText;
  return undefined;
}

function messageText(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(contentPartText)
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function hasTextSerializableContent(message: LLMMessage): boolean {
  if (typeof message.content === "string") return true;
  return message.content.some((part) =>
    part.type === "text" ||
    (part.type === "document" && typeof part.fallbackText === "string")
  );
}

function parseToolArguments(toolCall: LLMToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Fall through to the provider-specific error below.
  }
  throw new Error(
    `amazon-bedrock provider cannot replay malformed tool call arguments for ${toolCall.name}`,
  );
}

function toolResultContentForMessage(
  message: LLMMessage,
): BedrockToolResultBlock["content"] {
  const text = nonBlankText(messageText(message));
  return text !== undefined ? [{ text }] : [{ json: null }];
}

function bedrockContentForMessage(message: LLMMessage): readonly BedrockContentBlock[] {
  if (message.role === "tool") {
    return [
      {
        toolResult: {
          toolUseId: message.toolCallId ?? message.toolName ?? "tool_result",
          content: toolResultContentForMessage(message),
          status: "success",
        },
      },
    ];
  }

  const content: BedrockContentBlock[] = [];
  const text = nonBlankText(messageText(message));
  if (text !== undefined) {
    content.push({ text });
  } else if (
    hasTextSerializableContent(message) &&
    (message.toolCalls?.length ?? 0) === 0
  ) {
    content.push({ text: EMPTY_TEXT_PLACEHOLDER });
  }
  for (const toolCall of message.toolCalls ?? []) {
    content.push({
      toolUse: {
        toolUseId: toolCall.id,
        name: toolCall.name,
        input: parseToolArguments(toolCall),
      },
    });
  }
  if (content.length === 0) {
    throw new Error(
      `amazon-bedrock provider cannot serialize unsupported ${message.role} message content`,
    );
  }
  return content;
}

function buildMessages(
  messages: readonly LLMMessage[],
): {
  readonly system: readonly { readonly text: string }[];
  readonly messages: readonly BedrockMessage[];
} {
  const system: Array<{ text: string }> = [];
  const bedrockMessages: BedrockMessage[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = nonBlankText(messageText(message));
      if (text !== undefined) system.push({ text });
      continue;
    }
    bedrockMessages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: bedrockContentForMessage(message),
    });
  }

  return { system, messages: bedrockMessages };
}

function filterTools(
  tools: readonly LLMTool[],
  allowedToolNames: readonly string[] | undefined,
): readonly LLMTool[] {
  if (!allowedToolNames) return tools;
  const allowed = new Set(allowedToolNames);
  return tools.filter((tool) => allowed.has(tool.function.name));
}

function toBedrockToolChoice(
  toolChoice: LLMToolChoice | undefined,
): BedrockToolChoice | undefined {
  if (toolChoice === undefined || toolChoice === "auto") return { auto: {} };
  if (toolChoice === "required") return { any: {} };
  if (toolChoice === "none") return undefined;
  return { tool: { name: toolChoice.name } };
}

function buildToolConfig(
  tools: readonly LLMTool[],
  toolChoice: LLMToolChoice | undefined,
): BedrockRequest["toolConfig"] | undefined {
  if (tools.length === 0 || toolChoice === "none") return undefined;
  if (
    typeof toolChoice === "object" &&
    !tools.some((tool) => tool.function.name === toolChoice.name)
  ) {
    throw new Error(
      `amazon-bedrock provider toolChoice references unavailable tool: ${toolChoice.name}`,
    );
  }
  const bedrockToolChoice = toBedrockToolChoice(toolChoice);
  const bedrockTools = tools.map((tool) => ({
    toolSpec: {
      name: tool.function.name,
      ...(tool.function.description.trim().length > 0
        ? { description: tool.function.description }
        : {}),
      inputSchema: { json: tool.function.parameters },
    },
  }));
  return {
    tools: bedrockTools,
    ...(bedrockToolChoice !== undefined ? { toolChoice: bedrockToolChoice } : {}),
  };
}

function requestTools(
  config: BedrockProviderConfig,
  options: LLMChatOptions | undefined,
): readonly LLMTool[] {
  return filterTools(
    options?.tools ?? config.tools ?? [],
    options?.toolRouting?.allowedToolNames,
  );
}

function buildRequest(
  config: BedrockProviderConfig,
  messages: readonly LLMMessage[],
  options: LLMChatOptions | undefined,
): BedrockRequest {
  const built = buildMessages(messages);
  const systemPrompt = firstNonEmpty(options?.systemPrompt, config.systemPrompt);
  const system = [
    ...(systemPrompt ? [{ text: systemPrompt }] : []),
    ...built.system,
  ];
  const maxTokens = positiveInteger(options?.maxOutputTokens) ??
    positiveInteger(config.maxTokens);
  const optionTemperature = typeof options?.temperature === "number" &&
      Number.isFinite(options.temperature)
    ? options.temperature
    : undefined;
  const configTemperature = typeof config.temperature === "number" &&
      Number.isFinite(config.temperature)
    ? config.temperature
    : undefined;
  const temperature = optionTemperature ?? configTemperature;
  const stopSequences = options?.stopSequences !== undefined &&
      options.stopSequences.length > 0
    ? [...options.stopSequences]
    : undefined;
  const tools = requestTools(config, options);
  const toolConfig = buildToolConfig(tools, options?.toolChoice);

  return {
    messages: built.messages,
    ...(system.length > 0 ? { system } : {}),
    ...(maxTokens !== undefined || temperature !== undefined || stopSequences !== undefined
      ? {
        inferenceConfig: {
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(stopSequences !== undefined ? { stopSequences } : {}),
        },
      }
      : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
  };
}

function requestMetrics(
  messages: readonly LLMMessage[],
  tools: readonly LLMTool[],
  serializedRequest: string,
  stream = false,
): LLMRequestMetrics {
  const contentLengths = messages.map((message) => messageText(message).length);
  const textParts = messages.reduce((count, message) => {
    if (typeof message.content === "string") {
      return count + (message.content.length > 0 ? 1 : 0);
    }
    return count + message.content.filter((part) => part.type === "text").length;
  }, 0);
  const imageParts = messages.reduce((count, message) => {
    if (typeof message.content === "string") return count;
    return count + message.content.filter((part) => part.type === "image_url").length;
  }, 0);
  const toolSchemaChars = tools.reduce(
    (total, tool) => total + JSON.stringify(tool.function.parameters).length,
    0,
  );
  return {
    messageCount: messages.length,
    systemMessages: messages.filter((message) => message.role === "system").length,
    userMessages: messages.filter((message) => message.role === "user").length,
    assistantMessages: messages.filter((message) => message.role === "assistant").length,
    toolMessages: messages.filter((message) => message.role === "tool").length,
    totalContentChars: contentLengths.reduce((total, length) => total + length, 0),
    maxMessageChars: Math.max(0, ...contentLengths),
    textParts,
    imageParts,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.function.name),
    toolSchemaChars,
    serializedChars: serializedRequest.length,
    stream,
  };
}

function usageFromResponse(response: BedrockResponse): LLMUsage {
  const usage = response.usage;
  const promptTokens = usage?.inputTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage?.totalTokens ?? promptTokens + completionTokens,
    ...(usage?.cacheReadInputTokens !== undefined
      ? { cachedInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage?.cacheWriteInputTokens !== undefined
      ? { cacheCreationInputTokens: usage.cacheWriteInputTokens }
      : {}),
  };
}

function finishReasonFromStopReason(stopReason: string | undefined): LLMResponse["finishReason"] {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "guardrail_intervened":
    case "content_filtered":
      return "content_filter";
    case "malformed_model_output":
    case "malformed_tool_use":
      return "error";
    default:
      return "stop";
  }
}

function parseResponse(
  model: string,
  response: BedrockResponse,
  metrics: LLMRequestMetrics,
): LLMResponse {
  const contentBlocks = response.output?.message?.content ?? [];
  const content: string[] = [];
  const toolCalls: LLMToolCall[] = [];

  for (const block of contentBlocks) {
    if ("text" in block && typeof block.text === "string") {
      content.push(block.text);
      continue;
    }
    if ("toolUse" in block && block.toolUse) {
      toolCalls.push({
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        arguments: JSON.stringify(block.toolUse.input ?? {}),
      });
    }
  }

  return {
    content: content.join(""),
    toolCalls,
    usage: usageFromResponse(response),
    model,
    requestMetrics: metrics,
    finishReason:
      toolCalls.length > 0
        ? "tool_calls"
        : finishReasonFromStopReason(response.stopReason),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numericField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function streamUsageFromRecord(
  value: unknown,
): BedrockResponse["usage"] | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(numericField(value, "inputTokens") !== undefined
      ? { inputTokens: numericField(value, "inputTokens") }
      : {}),
    ...(numericField(value, "outputTokens") !== undefined
      ? { outputTokens: numericField(value, "outputTokens") }
      : {}),
    ...(numericField(value, "totalTokens") !== undefined
      ? { totalTokens: numericField(value, "totalTokens") }
      : {}),
    ...(numericField(value, "cacheReadInputTokens") !== undefined
      ? { cacheReadInputTokens: numericField(value, "cacheReadInputTokens") }
      : {}),
    ...(numericField(value, "cacheWriteInputTokens") !== undefined
      ? { cacheWriteInputTokens: numericField(value, "cacheWriteInputTokens") }
      : {}),
  };
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

async function* responseByteChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array<ArrayBufferLike>> {
  if (body === null) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.length > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function readUint32(
  bytes: Uint8Array<ArrayBufferLike>,
  offset: number,
): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0, false);
}

function eventStreamPayload(
  message: Uint8Array<ArrayBufferLike>,
): Uint8Array {
  if (message.length < 16) {
    throw new Error("Amazon Bedrock stream emitted a truncated event frame");
  }
  const totalLength = readUint32(message, 0);
  const headersLength = readUint32(message, 4);
  const payloadStart = 12 + headersLength;
  const payloadEnd = totalLength - 4;
  if (
    totalLength !== message.length ||
    payloadStart > payloadEnd ||
    payloadEnd > message.length
  ) {
    throw new Error("Amazon Bedrock stream emitted an invalid event frame");
  }
  return message.slice(payloadStart, payloadEnd);
}

async function* bedrockEventStreamPayloads(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for await (const chunk of responseByteChunks(body)) {
    pending = concatBytes(pending, chunk);
    while (pending.length >= 12) {
      const totalLength = readUint32(pending, 0);
      if (totalLength < 16) {
        throw new Error("Amazon Bedrock stream emitted an invalid event length");
      }
      if (pending.length < totalLength) break;
      const frame = pending.slice(0, totalLength);
      pending = pending.slice(totalLength);
      const payload = eventStreamPayload(frame);
      if (payload.length === 0) {
        yield {};
        continue;
      }
      const text = decoder.decode(payload).trim();
      yield text.length === 0 ? {} : JSON.parse(text);
    }
  }
  if (pending.length > 0) {
    throw new Error("Amazon Bedrock stream ended with a partial event frame");
  }
}

function streamEventError(event: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(event)) {
    if (!key.endsWith("Exception")) continue;
    return errorMessageFromBody(value);
  }
  return null;
}

function parseCompletedToolCall(block: BedrockStreamToolBlock): LLMToolCall {
  const rawArguments = block.arguments.length > 0 ? block.arguments : "{}";
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("tool input is not an object");
    }
  } catch {
    throw new Error(
      `Amazon Bedrock stream emitted invalid tool_use JSON for ${block.name || block.id}`,
    );
  }
  return {
    id: block.id,
    name: block.name,
    arguments: rawArguments,
  };
}

async function parseStreamResponse(params: {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly model: string;
  readonly metrics: LLMRequestMetrics;
  readonly onChunk: StreamProgressCallback;
}): Promise<LLMResponse> {
  let content = "";
  let stopReason: string | undefined;
  let usage: BedrockResponse["usage"] | undefined;
  const toolBlocks = new Map<number, BedrockStreamToolBlock>();
  const toolCalls: LLMToolCall[] = [];

  for await (const rawEvent of bedrockEventStreamPayloads(params.body)) {
    if (!isRecord(rawEvent)) continue;
    const errorMessage = streamEventError(rawEvent);
    if (errorMessage !== null) {
      throw new Error(`Amazon Bedrock stream failed: ${errorMessage}`);
    }

    const startEvent = isRecord(rawEvent.contentBlockStart)
      ? rawEvent.contentBlockStart
      : null;
    if (startEvent !== null) {
      const index = numericField(startEvent, "contentBlockIndex") ?? -1;
      const start = isRecord(startEvent.start) ? startEvent.start : {};
      const toolUse = isRecord(start.toolUse) ? start.toolUse : null;
      if (index >= 0 && toolUse !== null) {
        const id = String(toolUse.toolUseId ?? "");
        const name = String(toolUse.name ?? "");
        toolBlocks.set(index, { id, name, arguments: "" });
        params.onChunk({
          content: "",
          done: false,
          toolInputBlockStart: {
            callId: id,
            index,
            contentBlock: {
              type: "tool_use",
              id,
              name,
              input: {},
            },
          },
        });
      }
      continue;
    }

    const deltaEvent = isRecord(rawEvent.contentBlockDelta)
      ? rawEvent.contentBlockDelta
      : null;
    if (deltaEvent !== null) {
      const index = numericField(deltaEvent, "contentBlockIndex") ?? -1;
      const delta = isRecord(deltaEvent.delta) ? deltaEvent.delta : {};
      if (typeof delta.text === "string" && delta.text.length > 0) {
        content += delta.text;
        params.onChunk({ content: delta.text, done: false });
        continue;
      }
      const toolUse = isRecord(delta.toolUse) ? delta.toolUse : null;
      if (index >= 0 && toolUse !== null && typeof toolUse.input === "string") {
        const block = toolBlocks.get(index);
        if (block !== undefined) {
          block.arguments += toolUse.input;
          params.onChunk({
            content: "",
            done: false,
            toolInputDelta: {
              callId: block.id,
              index,
              partialJson: toolUse.input,
            },
          });
        }
      }
      continue;
    }

    const stopEvent = isRecord(rawEvent.contentBlockStop)
      ? rawEvent.contentBlockStop
      : null;
    if (stopEvent !== null) {
      const index = numericField(stopEvent, "contentBlockIndex") ?? -1;
      const block = toolBlocks.get(index);
      if (block !== undefined) {
        const toolCall = parseCompletedToolCall(block);
        toolCalls.push(toolCall);
        params.onChunk({ content: "", done: false, toolCalls: [toolCall] });
        toolBlocks.delete(index);
      }
      continue;
    }

    const messageStop = isRecord(rawEvent.messageStop)
      ? rawEvent.messageStop
      : null;
    if (messageStop !== null) {
      stopReason =
        typeof messageStop.stopReason === "string"
          ? messageStop.stopReason
          : stopReason;
      continue;
    }

    const metadata = isRecord(rawEvent.metadata) ? rawEvent.metadata : null;
    if (metadata !== null) {
      usage = streamUsageFromRecord(metadata.usage) ?? usage;
    }
  }

  const response: LLMResponse = {
    content,
    toolCalls,
    usage: usageFromResponse({ usage }),
    model: params.model,
    requestMetrics: params.metrics,
    finishReason:
      toolCalls.length > 0 ? "tool_calls" : finishReasonFromStopReason(stopReason),
  };
  params.onChunk({
    content: "",
    done: true,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  });
  return response;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessageFromBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.Message === "string") return record.Message;
    if (typeof record.__type === "string") return record.__type;
  }
  return "request failed";
}

function resolveCredentials(config: BedrockProviderConfig): BedrockCredentials {
  const accessKeyId = firstNonEmpty(config.accessKeyId);
  const secretAccessKey = firstNonEmpty(config.secretAccessKey);
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "amazon-bedrock provider requires AWS credentials — set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY or pass accessKeyId/secretAccessKey",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(firstNonEmpty(config.sessionToken) !== undefined
      ? { sessionToken: firstNonEmpty(config.sessionToken) }
      : {}),
  };
}

function requestSignal(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { readonly signal?: AbortSignal; readonly cleanup: () => void } {
  if (!outerSignal && timeoutMs === undefined) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onAbort = () => abort(outerSignal?.reason);

  if (outerSignal) {
    if (outerSignal.aborted) abort(outerSignal.reason);
    else outerSignal.addEventListener("abort", onAbort, { once: true });
  }
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeout = setTimeout(() => {
      abort(new Error(`amazon-bedrock request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timeout.unref === "function") timeout.unref();
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout !== undefined) clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", onAbort);
    },
  };
}

export class BedrockProvider implements LLMProvider {
  readonly name = "amazon-bedrock";
  readonly config: BedrockProviderConfig;
  private readonly region: string;
  private readonly baseURL: string;

  constructor(config: BedrockProviderConfig) {
    this.region = normalizeRegion(config.region);
    this.baseURL = normalizeBaseURL(config.baseURL, this.region);
    this.config = {
      ...config,
      region: this.region,
      baseURL: this.baseURL,
    };
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const model = firstNonEmpty(options?.model, this.config.model);
    if (!model) {
      throw new Error("amazon-bedrock provider requires a model identifier");
    }
    const request = buildRequest(this.config, messages, options);
    const body = JSON.stringify(request);
    const metrics = requestMetrics(
      messages,
      requestTools(this.config, options),
      body,
    );
    const signed = signRequest({
      baseURL: this.baseURL,
      region: this.region,
      model,
      body,
      credentials: resolveCredentials(this.config),
      now: this.config.now?.() ?? new Date(),
    });
    const timeoutMs = positiveInteger(options?.timeoutMs) ??
      positiveInteger(this.config.timeoutMs);
    const signalState = requestSignal(options?.signal, timeoutMs);
    try {
      const response = await (this.config.fetchImpl ?? fetch)(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
        signal: signalState.signal,
      });
      const parsed = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(
          `Amazon Bedrock request failed (HTTP ${response.status}): ${errorMessageFromBody(parsed)}`,
        );
      }
      return parseResponse(model, parsed as BedrockResponse, metrics);
    } finally {
      signalState.cleanup();
    }
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const model = firstNonEmpty(options?.model, this.config.model);
    if (!model) {
      throw new Error("amazon-bedrock provider requires a model identifier");
    }
    const request = buildRequest(this.config, messages, options);
    const body = JSON.stringify(request);
    const metrics = requestMetrics(
      messages,
      requestTools(this.config, options),
      body,
      true,
    );
    const signed = signRequest({
      baseURL: this.baseURL,
      region: this.region,
      model,
      body,
      credentials: resolveCredentials(this.config),
      now: this.config.now?.() ?? new Date(),
      operation: "converse-stream",
    });
    const timeoutMs = positiveInteger(options?.timeoutMs) ??
      positiveInteger(this.config.timeoutMs);
    const signalState = requestSignal(options?.signal, timeoutMs);
    try {
      const response = await (this.config.fetchImpl ?? fetch)(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
        signal: signalState.signal,
      });
      if (!response.ok) {
        const parsed = await readJsonResponse(response);
        throw new Error(
          `Amazon Bedrock stream request failed (HTTP ${response.status}): ${errorMessageFromBody(parsed)}`,
        );
      }
      return await parseStreamResponse({
        body: response.body,
        model,
        metrics,
        onChunk,
      });
    } finally {
      signalState.cleanup();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      resolveCredentials(this.config);
      return Boolean(firstNonEmpty(this.config.model));
    } catch {
      return false;
    }
  }

  async getExecutionProfile() {
    return {
      provider: this.name,
      model: this.config.model,
      ...(positiveInteger(this.config.maxTokens) !== undefined
        ? { maxOutputTokens: positiveInteger(this.config.maxTokens) }
        : {}),
    };
  }
}
