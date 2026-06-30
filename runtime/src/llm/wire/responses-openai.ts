/**
 * Responses API wire shim.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMTool,
  LLMToolCall,
} from "../types.js";
import {
  buildStructuredOutputTextFormat,
  parseStructuredOutputText,
} from "../structured-output.js";
import {
  assistantTextFromContentBlocks,
  coerceUsage,
  collectRequestMetrics,
  hasOpaqueAudioReference,
  messageTextContent,
  normalizeFinishReason,
  normalizeToolCallsStrict,
  parseOpenAIToolChoice,
  prepareMessagesForWire,
  readAudioPayload,
  readDocumentPayload,
  toResponsesToolOutput,
  withEndpointMarkers,
  withSerializedMetrics,
} from "./shared.js";
import { toOpenAIResponsesTools } from "./tools.js";
import {
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
} from "./mcp-tool-naming.js";

export interface OpenAIResponsesRequestOptions {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
  readonly store?: boolean;
  readonly maxOutputTokens?: number;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeFunctionCallId(toolCallId: string | undefined): {
  readonly id: string;
  readonly callId: string;
} {
  const value = (toolCallId ?? "").trim();
  if (!value) {
    return {
      id: "fc_unknown",
      callId: "call_unknown",
    };
  }
  if (value.startsWith("call_")) {
    return {
      id: `fc_${value.slice("call_".length)}`,
      callId: value,
    };
  }
  if (value.startsWith("fc_")) {
    return {
      id: value,
      callId: `call_${value.slice("fc_".length)}`,
    };
  }
  return {
    id: `fc_${value}`,
    callId: value,
  };
}

function toResponsesMessageParts(
  content: LLMMessage["content"],
  role: "user" | "assistant",
): Array<Record<string, unknown>> {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: textType, text: content }] : [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    const record =
      part && typeof part === "object" && !Array.isArray(part)
        ? (part as Record<string, unknown>)
        : {};
    if (record.type === "text") {
      const text = String(record.text ?? "");
      if (text.length === 0) continue;
      parts.push({ type: textType, text });
      continue;
    }
    const audio = readAudioPayload(part);
    if (role !== "assistant" && audio) {
      parts.push({
        type: "input_audio",
        input_audio: {
          data: audio.data,
          format: audio.format,
        },
      });
      continue;
    }
    if (role !== "assistant" && hasOpaqueAudioReference(part)) {
      parts.push({ type: textType, text: "[audio]" });
      continue;
    }
    const document = readDocumentPayload(part);
    if (role !== "assistant" && document) {
      if (document.data.length > 0 || document.fileId || document.fileUrl) {
        parts.push({
          type: "input_file",
          ...(document.filename ?? document.title
            ? { filename: document.filename ?? document.title }
            : {}),
          ...(document.data.length > 0
            ? { file_data: toResponsesFileData(document) }
            : {}),
          ...(document.fileId ? { file_id: document.fileId } : {}),
          ...(document.fileUrl ? { file_url: document.fileUrl } : {}),
        });
      } else {
        parts.push({ type: textType, text: "[document]" });
      }
      continue;
    }
    if (role !== "assistant" && record.type === "document") {
      parts.push({ type: textType, text: "[document]" });
      continue;
    }
    if (role === "assistant") continue;
    parts.push({
      type: "input_image",
      image_url: String(
        (record.image_url as { url?: unknown } | undefined)?.url ?? "",
      ),
    });
  }
  return parts;
}

function toResponsesFileData(
  document: NonNullable<ReturnType<typeof readDocumentPayload>>,
): string {
  return document.data.startsWith("data:")
    ? document.data
    : `data:${document.mediaType};base64,${document.data}`;
}

function resolveResponsesFinishReason(
  response: Record<string, unknown>,
  toolCalls: readonly LLMToolCall[],
): LLMResponse["finishReason"] {
  if (toolCalls.length > 0) {
    return "tool_calls";
  }

  const status = String(response.status ?? "");
  if (status === "incomplete") {
    const details =
      response.incomplete_details &&
      typeof response.incomplete_details === "object"
        ? (response.incomplete_details as Record<string, unknown>)
        : {};
    const reason = String(details.reason ?? "");
    if (reason.includes("max_output_tokens") || reason.includes("max_tokens")) {
      return "length";
    }
    if (reason.includes("content_filter") || reason.includes("refusal")) {
      return "content_filter";
    }
    if (reason.includes("error")) {
      return "error";
    }
  }

  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  ) {
    return "error";
  }

  return normalizeFinishReason(status);
}

export function buildOpenAIResponsesRequest(
  input: OpenAIResponsesRequestOptions,
): Record<string, unknown> {
  const messages = prepareMessagesForWire(input.messages);
  const instructions = [
    input.options?.systemPrompt?.trim(),
    ...messages
      .filter((message) =>
        message.role === "system" || message.role === "developer"
      )
      .map((message) => messageTextContent(message.content))
      .map((text) => text.trim()),
  ]
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n\n");
  const responseInput: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;

    if (message.role === "assistant") {
      const content = toResponsesMessageParts(message.content, "assistant");
      if (content.length > 0) {
        responseInput.push({
          type: "message",
          role: "assistant",
          content,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        const normalizedId = normalizeFunctionCallId(toolCall.id);
        responseInput.push({
          type: "function_call",
          id: normalizedId.id,
          call_id: normalizedId.callId,
          // Internal `mcp.<server>.<tool>` form has dots; the
          // strict-regex `function_call.name` rejects them. Encode at
          // the wire boundary; the response parser decodes back.
          name: encodeMcpToolNameForWire(toolCall.name),
          arguments: toolCall.arguments,
        });
      }
      continue;
    }

    if (message.role === "tool") {
      responseInput.push({
        type: "function_call_output",
        call_id: normalizeFunctionCallId(message.toolCallId).callId,
        output: toResponsesToolOutput(message.content),
      });
      continue;
    }

    responseInput.push({
      type: "message",
      role: message.role,
      content: toResponsesMessageParts(message.content, "user"),
    });
  }

  if (responseInput.length === 0) {
    responseInput.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "" }],
    });
  }

  const body: Record<string, unknown> = {
    model: input.model,
    input: responseInput,
    stream: false,
    store: input.store ?? false,
  };

  if (instructions.length > 0) {
    body.instructions = instructions;
  }
  const tools = toOpenAIResponsesTools(input.tools);
  if (tools.length > 0) body.tools = tools;
  if (input.options?.toolChoice !== undefined) {
    body.tool_choice = parseOpenAIToolChoice(input.options.toolChoice);
  }
  if (input.options?.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = input.options.parallelToolCalls;
  }
  if (input.options?.promptCacheKey) {
    body.prompt_cache_key = input.options.promptCacheKey;
  }
  if (input.options?.serviceTier !== undefined) {
    body.service_tier = input.options.serviceTier;
  }
  if (input.options?.temperature !== undefined) {
    body.temperature = input.options.temperature;
  }
  const maxOutputTokens =
    positiveInteger(input.maxOutputTokens) ??
    positiveInteger(input.options?.maxOutputTokens);
  if (maxOutputTokens !== undefined) {
    body.max_output_tokens = maxOutputTokens;
  }
  if (input.options?.includeEncryptedReasoning) {
    body.include = ["reasoning.encrypted_content"];
  }
  if (input.options?.reasoningEffort !== undefined) {
    body.reasoning = {
      ...(body.reasoning && typeof body.reasoning === "object"
        ? (body.reasoning as Record<string, unknown>)
        : {}),
      effort: input.options.reasoningEffort,
    };
  }
  if (
    input.options?.reasoningSummary !== undefined &&
    input.options.reasoningSummary !== "none"
  ) {
    body.reasoning = {
      ...(body.reasoning && typeof body.reasoning === "object"
        ? (body.reasoning as Record<string, unknown>)
        : {}),
      summary: input.options.reasoningSummary,
    };
  }
  if (input.options?.modelVerbosity !== undefined) {
    body.text = {
      ...(body.text && typeof body.text === "object"
        ? (body.text as Record<string, unknown>)
        : {}),
      verbosity: input.options.modelVerbosity,
    };
  }
  const structuredFormat = buildStructuredOutputTextFormat(
    input.options?.structuredOutput,
  );
  if (structuredFormat) {
    body.text = {
      ...(body.text && typeof body.text === "object"
        ? (body.text as Record<string, unknown>)
        : {}),
      format: structuredFormat,
    };
  }
  return body;
}

export function parseOpenAIResponsesResponse(
  model: string,
  response: Record<string, unknown>,
  request: OpenAIResponsesRequestOptions,
): LLMResponse {
  const output = Array.isArray(response.output)
    ? (response.output as Array<Record<string, unknown>>)
    : [];
  const toolCalls = normalizeToolCallsStrict(
    output
      .filter((item) => item.type === "function_call")
      .map(
        (item): LLMToolCall => ({
          id: String(item.call_id ?? item.id ?? ""),
          // Decode the strict-regex wire name back to the
          // internal-registry form before dispatch.
          name: decodeMcpToolNameFromWire(String(item.name ?? "")),
          arguments: String(item.arguments ?? "{}"),
        }),
      ),
    // branding-scan: allow real OpenAI provider identifier
    "OpenAI Responses response emitted invalid function_call",
  );

  const content = output
    .filter((item) => item.type === "message")
    .map((item) => {
      const contentBlocks = Array.isArray(item.content)
        ? (item.content as readonly unknown[])
        : [];
      return assistantTextFromContentBlocks(contentBlocks);
    })
    .join("");

  const usageRecord =
    response.usage && typeof response.usage === "object"
      ? (response.usage as Record<string, unknown>)
      : {};
  const inputDetails =
    usageRecord.input_tokens_details &&
      typeof usageRecord.input_tokens_details === "object" &&
      !Array.isArray(usageRecord.input_tokens_details)
      ? (usageRecord.input_tokens_details as Record<string, unknown>)
      : {};
  const outputDetails =
    usageRecord.output_tokens_details &&
      typeof usageRecord.output_tokens_details === "object" &&
      !Array.isArray(usageRecord.output_tokens_details)
      ? (usageRecord.output_tokens_details as Record<string, unknown>)
      : {};
  const webSearchRequests = output.filter(
    (item) => item.type === "web_search_call",
  ).length;
  const preparedMessages = prepareMessagesForWire(request.messages);
  const requestMetrics = withSerializedMetrics(
    collectRequestMetrics(preparedMessages, request.tools),
    buildOpenAIResponsesRequest(request),
    request.options,
  );

  return {
    content,
    toolCalls,
    usage: coerceUsage({
      promptTokens: usageRecord.input_tokens,
      completionTokens: usageRecord.output_tokens,
      totalTokens: usageRecord.total_tokens,
      cachedInputTokens: inputDetails.cached_tokens,
      reasoningOutputTokens: outputDetails.reasoning_tokens,
      webSearchRequests: webSearchRequests > 0 ? webSearchRequests : undefined,
    }),
    model:
      typeof response.model === "string" ? response.model : model,
    finishReason: resolveResponsesFinishReason(response, toolCalls),
    requestMetrics: withEndpointMarkers(requestMetrics, "/responses", response),
    structuredOutput:
      request.options?.structuredOutput?.enabled === false ||
        !request.options?.structuredOutput?.schema ||
        content.trim().length === 0
        ? undefined
        : parseStructuredOutputText(
          content,
          request.options.structuredOutput.schema.name,
          request.options.structuredOutput.schema.schema,
        ),
  };
}
