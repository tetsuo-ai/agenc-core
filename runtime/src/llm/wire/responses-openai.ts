/**
 * Responses API wire shim.
 *
 * @module
 */

import { normalizePromptCacheKey } from "../prompt-cache-key.js";
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
  openAiServedSpeed,
  prepareMessagesForWire,
  readAudioPayload,
  readDocumentPayload,
  splitSystemPromptOnDynamicBoundary,
  toResponsesToolOutput,
  withEndpointMarkers,
  withSerializedMetrics,
} from "./shared.js";
import { toOpenAIResponsesTools } from "./tools.js";
import { getResponseDetailSection, withResponseDetailSystemPrompt } from "../../prompts/response-detail.js";
import {
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
} from "./mcp-tool-naming.js";
import {
  openAiAcceptsSamplingTemperature,
  openAiModelDefaultsToNoReasoning,
  openAiModelScopesPromptCacheByKey,
} from "../registry/openai-reasoning-models.js";
import { resolveRegisteredModelCatalogEntry } from "../registry/model-catalog.js";

export interface OpenAIResponsesRequestOptions {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
  readonly store?: boolean;
  readonly maxOutputTokens?: number;
  /**
   * The ChatGPT subscription backend rejects `max_output_tokens`
   * outright ("Unsupported parameter"), and being stateless it needs the
   * encrypted reasoning carried in the request to survive across turns.
   */
  readonly chatgptBackend?: boolean;
  /**
   * Provider that encrypted reasoning is kept for and replayed to (default
   * on for OpenAI reasoning calls; `AGENC_OPENAI_REASONING_REPLAY=0` opts out).
   * Each reasoning output item of a
   * response is kept with the assistant message it preceded, and a later
   * request to the same provider and `model` sends it back. Stateless
   * requests only: a stored response keeps its reasoning server side.
   */
  readonly reasoningReplayProvider?: string;
  /**
   * The item id the provider issued for a call id (see
   * `responses-function-call-ids.ts`). A `function_call` history item carries
   * the id this returns and no id when it returns none; the wire never
   * invents one.
   */
  readonly functionCallItemId?: (callId: string) => string | undefined;
  /**
   * `auto_only`: the destination accepts no tool choice but `auto` (Meta
   * Model API). `required` and named choices go out as `auto`, and `none`
   * goes out as a request without tools.
   */
  readonly toolChoicePolicy?: "auto_only";
  /**
   * Tag the text of an assistant turn that also called tools with
   * `phase: "commentary"`. Meta's Responses guide requires the tag on
   * intermediate text replayed before a function call and says a dropped
   * phase can degrade quality.
   */
  readonly assistantCommentaryPhase?: boolean;
  /** Reasoning effort values the destination accepts; others are omitted. */
  readonly reasoningEffortAllowedValues?: ReadonlySet<string>;
}

/**
 * Whether a `tool_choice: "none"` request goes out without its tools, which
 * is how an `auto_only` destination is asked not to call one.
 */
function omitsToolsForChoice(request: OpenAIResponsesRequestOptions): boolean {
  return request.toolChoicePolicy === "auto_only" &&
    request.options?.toolChoice === "none";
}

/**
 * The canonical tool names a request advertised. Returned calls decode only
 * against these, so a call to a tool the request left out does not resolve.
 */
export function advertisedResponsesToolNames(
  request: OpenAIResponsesRequestOptions,
): string[] {
  return omitsToolsForChoice(request)
    ? []
    : request.tools.map((tool) => tool.function.name);
}

/** The requested effort when the destination accepts it. */
function acceptedReasoningEffort(
  request: OpenAIResponsesRequestOptions,
): LLMChatOptions["reasoningEffort"] {
  const effort = request.options?.reasoningEffort;
  return effort !== undefined &&
    request.reasoningEffortAllowedValues !== undefined &&
    !request.reasoningEffortAllowedValues.has(effort)
    ? undefined
    : effort;
}

// A type alias rather than an interface so an item is a plain wire record.
type ReplayableReasoningItem = {
  readonly type: "reasoning";
  readonly id: string;
  readonly summary: ReadonlyArray<{
    readonly type: "summary_text";
    readonly text: string;
  }>;
  readonly encrypted_content: string;
};

function reasoningReplayProvider(
  request: OpenAIResponsesRequestOptions,
): string | undefined {
  return request.store === true ? undefined : request.reasoningReplayProvider;
}

/**
 * What a stateless request needs to hand a reasoning item back: its id, its
 * summary and the encrypted reasoning. An item without encrypted content
 * cannot be replayed without storage, and nothing else the item carried
 * (status, plaintext content) is kept.
 */
function toReplayableReasoningItem(
  item: unknown,
): ReplayableReasoningItem | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  if (
    record.type !== "reasoning" ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.encrypted_content !== "string" ||
    record.encrypted_content.length === 0
  ) {
    return undefined;
  }
  const summary = Array.isArray(record.summary)
    ? record.summary.flatMap((part: unknown) => {
      const entry =
        part !== null && typeof part === "object"
          ? (part as Record<string, unknown>)
          : undefined;
      return entry?.type === "summary_text" && typeof entry.text === "string"
        ? [{ type: "summary_text" as const, text: entry.text }]
        : [];
    })
    : [];
  return {
    type: "reasoning",
    id: record.id,
    summary,
    encrypted_content: record.encrypted_content,
  };
}

/**
 * Keep the encrypted reasoning items of one Responses call for replay,
 * bound to the provider and request model that produced them.
 */
export function extractOpenAIReasoningReplay(
  output: unknown,
  request: OpenAIResponsesRequestOptions,
): Pick<LLMResponse, "providerReasoningContent" | "providerReasoningProvenance"> {
  const provider = reasoningReplayProvider(request);
  if (provider === undefined || !Array.isArray(output)) return {};
  const items = output.flatMap((item) => toReplayableReasoningItem(item) ?? []);
  return items.length === 0
    ? {}
    : {
      providerReasoningContent: JSON.stringify(items),
      providerReasoningProvenance: { provider, model: request.model },
    };
}

/**
 * The reasoning items to replay for one assistant message. Only the provider
 * and model that produced them get them back, compared the way durable
 * history normalizes them; a replay without provenance, or one that no
 * longer parses as reasoning items, is dropped whole.
 */
function replayedReasoningItems(
  message: LLMMessage,
  provider: string,
  model: string,
): ReplayableReasoningItem[] {
  const source = message.providerReasoningProvenance;
  if (
    !message.providerReasoningContent ||
    source === undefined ||
    source.provider.trim().toLowerCase() !== provider.trim().toLowerCase() ||
    source.model.trim().toLowerCase() !== model.trim().toLowerCase()
  ) {
    return [];
  }
  let stored: unknown;
  try {
    stored = JSON.parse(message.providerReasoningContent);
  } catch {
    return [];
  }
  if (!Array.isArray(stored) || stored.length === 0) return [];
  const items = stored.map(toReplayableReasoningItem);
  return items.every((item): item is ReplayableReasoningItem => item !== undefined)
    ? items
    : [];
}

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

/**
 * The `call_id` a history item answers. A tool call id that is itself an
 * item id (`fc_...`, kept when a provider omitted `call_id`) maps to the call
 * id derived from it, as before.
 */
function normalizeFunctionCallCallId(toolCallId: string | undefined): string {
  const value = (toolCallId ?? "").trim();
  if (!value) return "call_unknown";
  if (value.startsWith("fc_")) return `call_${value.slice("fc_".length)}`;
  return value;
}

/**
 * The item id a `function_call` history item carries: one the provider
 * issued, or none. It is never derived from the call id, because such an id
 * names an item the provider did not issue (see
 * `responses-function-call-ids.ts` for what that costs).
 */
function issuedFunctionCallItemId(
  input: OpenAIResponsesRequestOptions,
  toolCallId: string | undefined,
): string | undefined {
  const value = (toolCallId ?? "").trim();
  // Prefixes are not provenance. Restored or foreign calls may also use fc_.
  const id = input.functionCallItemId?.(value);
  return typeof id === "string" && id.length > 0 ? id : undefined;
}


/**
 * An interrupted turn can leave a `function_call` in history with no
 * `function_call_output` ever recorded. The Responses backends treat
 * that as unresolved session state — requests either fail or the model
 * refuses to continue, citing the dangling call id. Every unmatched
 * call gets a synthetic output right after it so history always pairs.
 */
export function closeDanglingFunctionCalls(
  responseInput: Array<Record<string, unknown>>,
): void {
  const answered = new Set<string>();
  for (const item of responseInput) {
    if (item.type === "function_call_output" && typeof item.call_id === "string") {
      answered.add(item.call_id);
    }
  }
  for (let index = responseInput.length - 1; index >= 0; index -= 1) {
    const item = responseInput[index]!;
    if (item.type !== "function_call") continue;
    const callId = item.call_id;
    if (typeof callId !== "string" || answered.has(callId)) continue;
    responseInput.splice(index + 1, 0, {
      type: "function_call_output",
      call_id: callId,
      output:
        "[interrupted: this call produced no result. Do not wait on it; proceed fresh.]",
    });
  }
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
    return "error";
  }

  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  ) {
    return "error";
  }

  return toolCalls.length > 0 ? "tool_calls" : normalizeFinishReason(status);
}

/**
 * The `prompt_cache_key` a request carries. GPT-5.6 and later on the platform
 * API get the user's cache scope, so a session reads what the previous
 * session of the same user wrote; every other route (older models, the
 * ChatGPT subscription backend, other Responses destinations) keeps the
 * conversation key.
 */
function responsesPromptCacheKey(
  input: OpenAIResponsesRequestOptions,
): string | undefined {
  const scope = input.options?.promptCacheScopeKey?.trim();
  if (
    scope !== undefined && scope.length > 0 &&
    input.chatgptBackend !== true &&
    openAiModelScopesPromptCacheByKey(input.model)
  ) {
    return scope;
  }
  const key = input.options?.promptCacheKey;
  return key ? key : undefined;
}

/**
 * Platform API models that keep their own reasoning summary default under
 * replay instead of being asked for `summary: "auto"` (see the summary note
 * in `buildOpenAIResponsesRequest`).
 */
const MODELS_KEEPING_SUMMARY_DEFAULT: ReadonlySet<string> = new Set([
  "gpt-6-luna",
  "gpt-6.1-terra",
]);

export function buildOpenAIResponsesRequest(
  input: OpenAIResponsesRequestOptions,
): Record<string, unknown> {
  const messages = prepareMessagesForWire(input.messages);
  const catalogEntry = resolveRegisteredModelCatalogEntry({ provider: "openai", model: input.model });
  const nativeVerbosity = input.chatgptBackend !== true &&
    catalogEntry?.model.toLowerCase() === input.model.trim().toLowerCase() &&
    catalogEntry.supportsVerbosity;
  const fallbackVerbosity = !nativeVerbosity ? input.options?.modelVerbosity : undefined;
  // Prefix-cache split: the static head of the system prompt goes into
  // `instructions`; the session tail (workspace, memory directories,
  // permission section) becomes the FIRST input item below. Both are the same
  // on every request of a session, so each request extends the previous one
  // byte for byte and the provider reads all of it from cache.
  const {
    staticPrefix: staticSystemPrompt,
    sessionSuffix: sessionSystemPrompt,
    dynamicSuffix: dynamicSystemPrompt,
  } = splitSystemPromptOnDynamicBoundary(
    input.chatgptBackend !== true && fallbackVerbosity !== undefined
      ? withResponseDetailSystemPrompt(input.options?.systemPrompt, fallbackVerbosity)
      : input.options?.systemPrompt,
  );
  const instructions = [
    staticSystemPrompt,
    // Fixed for the session, so it stays in the cached instructions.
    sessionSystemPrompt,
    ...messages
      .filter((message) =>
        message.role === "system" || message.role === "developer"
      )
      .map((message) => messageTextContent(message.content))
      .map((text) => text.trim()),
    // The ChatGPT subscription backend rejects system-role input items.
    // Its existing volatile prompt tail stays in instructions; response
    // detail is appended separately as an accepted user input item below.
    ...(input.chatgptBackend === true && dynamicSystemPrompt !== undefined
      ? [dynamicSystemPrompt]
      : []),
  ]
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n\n");
  const replayProvider = reasoningReplayProvider(input);
  const responseInput: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;

    if (message.role === "assistant") {
      const content = toResponsesMessageParts(message.content, "assistant");
      const toolCalls = message.toolCalls ?? [];
      // A reasoning item goes back right before the output it led to: the
      // turn's function calls, or its text when it called none. A message
      // with neither has nothing to follow it, so it replays none.
      const reasoning =
        replayProvider !== undefined &&
          (toolCalls.length > 0 || content.length > 0)
          ? replayedReasoningItems(message, replayProvider, input.model)
          : [];
      if (toolCalls.length === 0) responseInput.push(...reasoning);
      if (content.length > 0) {
        responseInput.push({
          type: "message",
          role: "assistant",
          ...(input.assistantCommentaryPhase === true && toolCalls.length > 0
            ? { phase: "commentary" }
            : {}),
          content,
        });
      }
      if (toolCalls.length > 0) responseInput.push(...reasoning);
      for (const toolCall of toolCalls) {
        const callId = normalizeFunctionCallCallId(toolCall.id);
        const itemId = issuedFunctionCallItemId(input, toolCall.id);
        responseInput.push({
          type: "function_call",
          ...(itemId !== undefined ? { id: itemId } : {}),
          call_id: callId,
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
        call_id: normalizeFunctionCallCallId(message.toolCallId),
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

  closeDanglingFunctionCalls(responseInput);

  if (responseInput.length === 0) {
    responseInput.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "" }],
    });
  }

  if (dynamicSystemPrompt !== undefined && input.chatgptBackend !== true) {
    // The tail leads the input instead of trailing it. As the last item it
    // moved behind the new history on every request, so the provider never
    // cached it (GPT-5.6 and later write the cache up to the last user
    // message or tool output, never through a trailing system item): 283
    // uncached tokens on every Light call of the oa Luna race. First, it is
    // part of the cached prefix from the first request on, and the end of a
    // leading system item is a cache boundary, where the next session of the
    // same workspace and permission mode starts reading. A changed tail
    // (another permission mode, reloaded project instructions) changes this
    // first item, so that one request is written to the cache again.
    responseInput.unshift({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: dynamicSystemPrompt }],
    });
  }
  if (input.chatgptBackend === true && fallbackVerbosity !== undefined) {
    responseInput.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: getResponseDetailSection(fallbackVerbosity) }],
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
  const omitTools = omitsToolsForChoice(input);
  const tools = toOpenAIResponsesTools(omitTools ? [] : input.tools);
  if (tools.length > 0) body.tools = tools;
  if (input.options?.toolChoice !== undefined && !omitTools) {
    // Responses uses a flat named choice; Chat Completions nests function.name.
    // https://developers.openai.com/api/docs/guides/function-calling#tool-choice
    const choice = input.options.toolChoice;
    body.tool_choice = input.toolChoicePolicy === "auto_only"
      ? "auto"
      : typeof choice === "string" ? choice : {
        type: "function",
        name: encodeMcpToolNameForWire(choice.name),
      };
  }
  if (input.options?.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = input.options.parallelToolCalls;
  }
  const promptCacheKey = responsesPromptCacheKey(input);
  if (promptCacheKey !== undefined) {
    body.prompt_cache_key = normalizePromptCacheKey(promptCacheKey);
  }
  if (input.options?.serviceTier !== undefined) {
    body.service_tier = input.options.serviceTier;
  }
  if (
    input.options?.temperature !== undefined &&
    openAiAcceptsSamplingTemperature(input.model, input.options.reasoningEffort)
  ) {
    body.temperature = input.options.temperature;
  }
  const maxOutputTokens =
    positiveInteger(input.maxOutputTokens) ??
    positiveInteger(input.options?.maxOutputTokens);
  if (maxOutputTokens !== undefined && input.chatgptBackend !== true) {
    body.max_output_tokens = maxOutputTokens;
  }
  if (
    input.options?.includeEncryptedReasoning ||
    input.chatgptBackend === true ||
    replayProvider !== undefined
  ) {
    body.include = ["reasoning.encrypted_content"];
  }
  const reasoningEffort = acceptedReasoningEffort(input);
  if (reasoningEffort !== undefined) {
    body.reasoning = {
      ...(body.reasoning && typeof body.reasoning === "object"
        ? (body.reasoning as Record<string, unknown>)
        : {}),
      effort: reasoningEffort,
    };
  }
  // Luna's and Terra's APIs spend additional time producing automatic
  // summaries even for short tool turns. On Terra (2026-10-28) the first
  // visible output came 0.59 s later with `summary: "auto"` (median of 8 paired
  // requests), and Light tasks ran 2.4 s and 6 percent cheaper without it.
  // Their encrypted reasoning replays with an empty summary, so keep the
  // model's summary default instead of forcing `auto`. Explicit summary
  // choices, other models and ChatGPT keep their behavior.
  const preserveSummaryDefault = replayProvider === "openai" &&
    input.chatgptBackend !== true &&
    MODELS_KEEPING_SUMMARY_DEFAULT.has(input.model.trim().toLowerCase());
  // An omitted effort can still run reasoning at the model's default tier.
  const useReplaySummaryDefault = !preserveSummaryDefault &&
    replayProvider !== undefined &&
    reasoningEffort !== "none" &&
    (reasoningEffort !== undefined ||
      !openAiModelDefaultsToNoReasoning(input.model)) &&
    (input.options?.reasoningSummary === undefined ||
      input.options.reasoningSummaryIsDefault === true);
  const reasoningSummary = useReplaySummaryDefault ? "auto" : input.options?.reasoningSummary;
  if (reasoningSummary !== undefined && reasoningSummary !== "none") {
    body.reasoning = {
      ...(body.reasoning && typeof body.reasoning === "object"
        ? (body.reasoning as Record<string, unknown>)
        : {}),
      summary: reasoningSummary,
    };
  }
  if (nativeVerbosity && input.options?.modelVerbosity !== undefined) {
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

/** Read authoritative billing independently of output validation. */
export function parseOpenAIResponsesUsage(response: Record<string, unknown>): LLMResponse["usage"] {
  const output = Array.isArray(response.output)
    ? response.output.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
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
  return coerceUsage({
      promptTokens: usageRecord.input_tokens,
      completionTokens: usageRecord.output_tokens,
      totalTokens: usageRecord.total_tokens,
      cachedInputTokens: inputDetails.cached_tokens,
      // GPT-5.6 and later bill cache writes at 1.25x input; like cached
      // tokens they are a subset of input_tokens (prompt-caching guide).
      cacheCreationInputTokens: inputDetails.cache_write_tokens,
      reasoningOutputTokens: outputDetails.reasoning_tokens,
      webSearchRequests: webSearchRequests > 0 ? webSearchRequests : undefined,
      speed: openAiServedSpeed(response.service_tier),
    });
}

export function parseOpenAIResponsesResponse(
  model: string,
  response: Record<string, unknown>,
  request: OpenAIResponsesRequestOptions,
): LLMResponse {
  const output = Array.isArray(response.output)
    ? (response.output as Array<Record<string, unknown>>)
    : [];
  const functionCalls = output.filter((item) => item.type === "function_call");
  const initialFinishReason = resolveResponsesFinishReason(response, []);
  const acceptsToolCalls = initialFinishReason === "stop" || initialFinishReason === "tool_calls";
  // Output limits can cut off even a done item's JSON. Keep only identities
  // for the turn's bounded recovery; never repair or execute partial calls.
  const incompleteToolCalls = initialFinishReason === "length"
    ? functionCalls.flatMap((item, index) => {
      const name = decodeMcpToolNameFromWire(String(item.name ?? "").trim(),
        advertisedResponsesToolNames(request));
      if (!name || name.length > 256) return [];
      const id = String(item.call_id ?? item.id ?? "").trim() || `incomplete-${index}`;
      return [{ id, name }];
    }) : [];
  const toolCalls = acceptsToolCalls ? normalizeToolCallsStrict(
    functionCalls.map((item): LLMToolCall => ({
      id: String(item.call_id ?? item.id ?? ""),
      // Decode the strict-regex wire name before dispatch.
      name: decodeMcpToolNameFromWire(String(item.name ?? ""),
        advertisedResponsesToolNames(request)),
      arguments: String(item.arguments ?? "{}"),
    })),
    "OpenAI Responses response emitted invalid function_call",
  ) : [];

  const content = output
    .filter((item) => item.type === "message")
    .map((item) => {
      const contentBlocks = Array.isArray(item.content)
        ? (item.content as readonly unknown[])
        : [];
      return assistantTextFromContentBlocks(contentBlocks);
    })
    .join("");

  const preparedMessages = prepareMessagesForWire(request.messages);
  const requestMetrics = withSerializedMetrics(
    collectRequestMetrics(preparedMessages, request.tools),
    buildOpenAIResponsesRequest(request),
    request.options,
  );

  const finishReason = resolveResponsesFinishReason(response, toolCalls);
  // A truncated/incomplete generation (finishReason 'length', 'error', or
  // 'content_filter') leaves partial JSON in `content`, which
  // parseStructuredOutputText would JSON.parse and throw on — failing the whole
  // turn instead of surfacing the recoverable truncation. Only parse structured
  // output when the generation completed normally, mirroring the chat-completions
  // path (chat-completions.ts, gaphunt3 #20).
  const generationCompleted =
    finishReason === "stop" || finishReason === "tool_calls";

  return {
    content,
    toolCalls,
    ...(incompleteToolCalls.length > 0 ? { incompleteToolCalls } : {}),
    ...extractOpenAIReasoningReplay(output, request),
    usage: parseOpenAIResponsesUsage(response),
    model:
      typeof response.model === "string" ? response.model : model,
    finishReason,
    requestMetrics: withEndpointMarkers(requestMetrics, "/responses", response),
    structuredOutput:
      !generationCompleted ||
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
