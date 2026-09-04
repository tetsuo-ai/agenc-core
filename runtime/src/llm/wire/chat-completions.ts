/**
 * Chat Completions wire shim.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  ProviderReasoningProvenance,
} from "../types.js";
import { estimateUtf8TokenUnits } from "../token-accounting.js";
import {
  buildStructuredOutputTextFormat,
  parseStructuredOutputText,
} from "../structured-output.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../openai-compatible-token-limits.js";
import {
  assistantTextFromContentBlocks,
  applyToolResultImagePolicyForWire,
  coerceUsage,
  collectRequestMetrics,
  messageTextContent,
  normalizeFinishReason,
  normalizeToolCallsStrict,
  parseOpenAIToolChoice,
  prepareMessagesForWire,
  serializeProviderToolArguments,
  toOpenAIMessageContent,
  toOpenAIToolMessageContent,
  withEndpointMarkers,
  withSerializedMetrics,
} from "./shared.js";
import { toChatCompletionsTools } from "./tools.js";
import {
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
} from "./mcp-tool-naming.js";
import type { ChatCompletionsCapabilityHints } from "./capability-gating.js";
import {
  applyCerebrasImageInputContract,
  assertCerebrasRequestPayloadSize,
  buildCerebrasStructuredOutputTextFormat,
} from "./cerebras-contract.js";
import { splitLeadingThinkBlock } from "./think-tags.js";
import { applyZaiImageInputContract } from "./zai-contract.js";
import {
  applyKimiImageInputContract,
  assertKimiRequestPayloadSize,
} from "./kimi-contract.js";
import {
  LLMContextWindowExceededError,
  LLMInvalidResponseError,
} from "../errors.js";

export interface ChatCompletionsRequestOptions {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
  readonly maxTokens?: number;
  readonly maxTokenField?: ChatCompletionsMaxTokenField;
  /**
   * Per-provider capability hints. Adapters populate this so the
   * wire builder can strip fields the destination provider rejects.
   * For example `service_tier` is recognized only by explicit
   * provider contracts, and `reasoning_effort` only applies to a
   * handful of model families. Backward-compatible: when undefined,
   * current behavior is preserved (all caller-supplied fields are
   * sent).
   */
  readonly providerCapabilityHints?: ChatCompletionsCapabilityHints;
}

export type ChatCompletionsMaxTokenField =
  | "max_tokens"
  | "max_completion_tokens";

export interface ChatCompletionsRequestMetadata {
  readonly model: string;
  readonly messageCount: number;
  readonly roleSequence: readonly string[];
  readonly estimatedPromptTokens: number;
  readonly maxTokens?: number;
  readonly maxTokenField?: ChatCompletionsMaxTokenField;
  readonly toolsAttached: boolean;
  readonly toolCount: number;
}

const DEFAULT_CHAT_COMPLETIONS_MAX_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function assertToolDefinitionLimit(
  count: number,
  limit: number | undefined,
): void {
  if (limit === undefined || count <= limit) return;
  throw new RangeError(
    `Chat-completions provider accepts at most ${limit} tools; received ${count}. ` +
      "Reduce the active tool set or use deferred tool discovery.",
  );
}

function systemPromptParts(
  messages: readonly LLMMessage[],
  options: LLMChatOptions | undefined,
): readonly string[] {
  const parts: string[] = [];
  const optionPrompt = options?.systemPrompt?.trim();
  if (optionPrompt) parts.push(optionPrompt);
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue;
    const text = messageTextContent(message.content).trim();
    if (text.length > 0) parts.push(text);
  }
  return parts;
}

interface ReasoningToolContinuationGroup {
  readonly assistant: LLMMessage;
  readonly reasoningContent: string;
  readonly toolCallIds: readonly string[];
}

interface ReasoningToolContinuation {
  readonly groups: readonly ReasoningToolContinuationGroup[];
}

function reasoningToolContinuation(
  messages: readonly LLMMessage[],
  provenance: ProviderReasoningProvenance | undefined,
): ReasoningToolContinuation | undefined {
  if (provenance === undefined || messages.length < 2) return undefined;
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0 || userIndex === messages.length - 1) return undefined;

  const groups: ReasoningToolContinuationGroup[] = [];
  const seenToolCallIds = new Set<string>();
  let index = userIndex + 1;
  while (index < messages.length) {
    const assistant = messages[index];
    if (
      assistant?.role !== "assistant" ||
      !assistant.toolCalls?.length ||
      !assistant.providerReasoningContent ||
      assistant.providerReasoningProvenance === undefined
    ) {
      return undefined;
    }
    const source = assistant.providerReasoningProvenance;
    if (
      source.provider.trim().toLowerCase() !==
        provenance.provider.trim().toLowerCase() ||
      source.model.trim().toLowerCase() !==
        provenance.model.trim().toLowerCase()
    ) {
      return undefined;
    }

    const toolCallIds = assistant.toolCalls.map((call) => call.id.trim());
    if (
      toolCallIds.some((id) => id.length === 0 || seenToolCallIds.has(id)) ||
      new Set(toolCallIds).size !== toolCallIds.length
    ) {
      return undefined;
    }
    index += 1;
    for (const toolCallId of toolCallIds) {
      const result = messages[index];
      if (
        result?.role !== "tool" ||
        result.toolCallId?.trim() !== toolCallId
      ) {
        return undefined;
      }
      seenToolCallIds.add(toolCallId);
      index += 1;
    }
    groups.push({
      assistant,
      reasoningContent: assistant.providerReasoningContent,
      toolCallIds,
    });
  }
  return groups.length > 0 ? { groups } : undefined;
}

function sameReasoningToolContinuation(
  left: ReasoningToolContinuation | undefined,
  right: ReasoningToolContinuation | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return left.groups.length === right.groups.length &&
    left.groups.every((group, index) => {
      const other = right.groups[index];
      return other !== undefined &&
        group.reasoningContent === other.reasoningContent &&
        group.toolCallIds.length === other.toolCallIds.length &&
        group.toolCallIds.every((id, toolIndex) =>
          id === other.toolCallIds[toolIndex]
        );
    });
}

function reasoningHistoryFingerprint(
  messages: readonly LLMMessage[],
  mergeConsecutiveUserText = false,
): string {
  const comparable: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const tail = comparable[comparable.length - 1];
    if (
      mergeConsecutiveUserText &&
      tail?.role === "user" &&
      message.role === "user" &&
      tail.mergeBoundary !== true &&
      message.runtimeOnly?.mergeBoundary === undefined &&
      typeof tail.content === "string" &&
      typeof message.content === "string"
    ) {
      tail.content = `${tail.content}\n\n${message.content}`;
      continue;
    }
    comparable.push({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      providerReasoningContent: message.providerReasoningContent,
      providerReasoningProvenance: message.providerReasoningProvenance,
      mergeBoundary: message.runtimeOnly?.mergeBoundary !== undefined,
    });
  }
  return JSON.stringify(comparable);
}

function toChatCompletionsMessages(
  messages: readonly LLMMessage[],
  options: LLMChatOptions | undefined,
  systemSuffix?: string,
  toolResultImagePolicy?: "relay_as_user" | "strip",
  replaysReasoningContent = false,
  reasoningContentField: "reasoning_content" | "reasoning" =
    "reasoning_content",
  reasoningContentProvenance?: ProviderReasoningProvenance,
  replayOnlyAdjacentToolContinuation = false,
  reasoningContinuation?: ReasoningToolContinuation,
  allowsFullReasoningHistoryReplay = true,
  requiresStrictToolResultSequence = false,
  imageInputContract?: "cerebras_v2" | "zai_flash" | "kimi_global",
  acceptsDirectImageInput?: boolean,
): Array<Record<string, unknown>> {
  // The caller passes the exact normalized sequence used to derive the
  // reasoning replay plan. Keeping a single projection prevents boundary or
  // orphan-message normalization from disagreeing with `clear_thinking`.
  const normalized = messages;
  if (requiresStrictToolResultSequence) {
    assertStrictToolResultSequence(normalized);
  }
  let imageSafeMessages: readonly LLMMessage[] = normalized;
  if (imageInputContract === "cerebras_v2") {
    imageSafeMessages = applyCerebrasImageInputContract(
      normalized,
      acceptsDirectImageInput === true,
    );
  } else if (imageInputContract === "zai_flash") {
    imageSafeMessages = applyZaiImageInputContract(normalized);
  } else if (imageInputContract === "kimi_global") {
    imageSafeMessages = applyKimiImageInputContract(normalized);
  } else if (acceptsDirectImageInput === false) {
    imageSafeMessages = assertNoDirectImageInput(normalized);
  }
  const prepared = applyToolResultImagePolicyForWire(
    imageSafeMessages,
    toolResultImagePolicy,
  );
  let systemPrompt = systemPromptParts(prepared, options).join("\n\n");
  if (systemSuffix !== undefined && systemSuffix.length > 0) {
    systemPrompt =
      systemPrompt.length > 0 ? `${systemPrompt}\n${systemSuffix}` : systemSuffix;
  }
  const wireMessages: Array<Record<string, unknown>> = [];
  if (systemPrompt.length > 0) {
    wireMessages.push({ role: "system", content: systemPrompt });
  }
  const replayReasoningContent = (
    message: LLMMessage,
  ): string | undefined => {
    if (
      !replaysReasoningContent ||
      !allowsFullReasoningHistoryReplay ||
      !message.providerReasoningContent ||
      reasoningContentProvenance === undefined ||
      message.providerReasoningProvenance === undefined
    ) {
      return undefined;
    }
    if (replayOnlyAdjacentToolContinuation) {
      // `prepared` retains assistant object identity through image/tool-result
      // projection. Match the exact normalized chain position rather than a
      // content fingerprint, which could collide with an older turn.
      const matchesIntactGroup = reasoningContinuation?.groups.some(
        (group) => group.assistant === message,
      ) === true;
      if (!matchesIntactGroup) {
        return undefined;
      }
    }
    const source = message.providerReasoningProvenance;
    return typeof source.provider === "string" &&
      typeof source.model === "string" &&
      source.provider.trim().toLowerCase() ===
        reasoningContentProvenance.provider.trim().toLowerCase() &&
      source.model.trim().toLowerCase() ===
        reasoningContentProvenance.model.trim().toLowerCase()
      ? message.providerReasoningContent
      : undefined;
  };
  for (const message of prepared) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "tool") {
      wireMessages.push({
        role: "tool",
        content: toOpenAIToolMessageContent(message.content),
        tool_call_id: message.toolCallId,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const providerReasoningContent = replayReasoningContent(message);
      wireMessages.push({
        role: "assistant",
        content: messageTextContent(message.content),
        ...(providerReasoningContent !== undefined
          ? { [reasoningContentField]: providerReasoningContent }
          : {}),
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            // The internal registry uses `mcp.<server>.<tool>`; the
            // wire format requires a strict-regex-safe name. Encode
            // here so the model sees a name it can echo back without
            // hitting the provider's name-validator.
            name: encodeMcpToolNameForWire(toolCall.name),
            arguments: toolCall.arguments,
          },
        })),
      });
      continue;
    }
    const providerReasoningContent = replayReasoningContent(message);
    wireMessages.push({
      role: message.role,
      content: toOpenAIMessageContent(message.content),
      ...(message.role === "assistant" &&
      providerReasoningContent !== undefined
        ? { [reasoningContentField]: providerReasoningContent }
        : {}),
    });
  }
  return wireMessages;
}

function assertNoDirectImageInput(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  for (const message of messages) {
    if (message.role === "tool" || !Array.isArray(message.content)) continue;
    if (message.content.some((part) => part.type === "image_url")) {
      throw new TypeError(
        "The selected provider model does not support image input",
      );
    }
  }
  return messages;
}

function assertStrictToolResultSequence(
  messages: readonly LLMMessage[],
): void {
  const seenToolCallIds = new Set<string>();
  let pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (pendingToolCallIds.size > 0) {
      if (message.role !== "tool") {
        throw new TypeError(
          "Cerebras API v2 requires each assistant tool call to be followed immediately by its tool result",
        );
      }
      const resultId = message.toolCallId?.trim() ?? "";
      if (!pendingToolCallIds.delete(resultId)) {
        throw new TypeError(
          "Cerebras API v2 received a duplicate or mismatched tool result id",
        );
      }
      continue;
    }

    if (message.role === "tool") {
      throw new TypeError(
        "Cerebras API v2 does not accept orphan tool result messages",
      );
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    pendingToolCallIds = new Set<string>();
    for (const toolCall of message.toolCalls) {
      const toolCallId = toolCall.id.trim();
      if (toolCallId.length === 0 || seenToolCallIds.has(toolCallId)) {
        throw new TypeError(
          "Cerebras API v2 requires every tool call id to be non-empty and unique",
        );
      }
      seenToolCallIds.add(toolCallId);
      pendingToolCallIds.add(toolCallId);
    }
  }

  if (pendingToolCallIds.size > 0) {
    throw new TypeError(
      "Cerebras API v2 requires a tool result for every assistant tool call",
    );
  }
}

export function buildChatCompletionsRequest(
  input: ChatCompletionsRequestOptions,
): Record<string, unknown> {
  const maxTokenField = input.maxTokenField ?? "max_tokens";
  const requestedMaxTokens =
    positiveInteger(input.maxTokens) ??
    positiveInteger(input.options?.maxOutputTokens) ??
    DEFAULT_CHAT_COMPLETIONS_MAX_TOKENS;
  const ceiling = positiveInteger(
    input.providerCapabilityHints?.outputTokensCeiling,
  );
  const maxTokens =
    ceiling !== undefined ? Math.min(requestedMaxTokens, ceiling) : requestedMaxTokens;
  const structuredOutput = input.options?.structuredOutput;
  const usesZaiJsonObject =
    input.providerCapabilityHints?.structuredOutputContract ===
      "zai_json_object" &&
    structuredOutput?.enabled !== false &&
    structuredOutput?.schema !== undefined;
  const zaiJsonSchemaInstruction =
    usesZaiJsonObject && structuredOutput?.schema !== undefined
    ? "Return only one JSON object matching this JSON Schema:\n" +
      JSON.stringify(structuredOutput.schema.schema)
    : undefined;
  const systemSuffix = [
    input.providerCapabilityHints?.reasoningSoftSwitchSuffix,
    zaiJsonSchemaInstruction,
  ].filter((value): value is string => value !== undefined).join("\n");
  const normalizedMessages = prepareMessagesForWire(
    input.messages,
    input.options,
  );
  const replayOnlyAdjacentToolContinuation =
    input.providerCapabilityHints
      ?.replaysReasoningContentOnlyForAdjacentToolContinuation === true;
  const rawReasoningContinuation = replayOnlyAdjacentToolContinuation
    ? reasoningToolContinuation(
        input.messages,
        input.providerCapabilityHints?.reasoningContentProvenance,
      )
    : undefined;
  const normalizedReasoningContinuation = replayOnlyAdjacentToolContinuation
    ? reasoningToolContinuation(
        normalizedMessages,
        input.providerCapabilityHints?.reasoningContentProvenance,
      )
    : undefined;
  // A normalization boundary or orphan result invalidates provider-owned
  // reasoning as a unit. Durable compaction markers are runtime scaffolding:
  // the projected post-compaction history is already authoritative, and the
  // marker must not disable fresh reasoning replay for the rest of a session.
  const reasoningContinuation = sameReasoningToolContinuation(
      rawReasoningContinuation,
      normalizedReasoningContinuation,
    )
    ? normalizedReasoningContinuation
    : undefined;
  const requiresIntactReasoningHistory =
    input.providerCapabilityHints
      ?.replaysReasoningContentOnlyForIntactHistory === true;
  const allowsFullReasoningHistoryReplay =
    !requiresIntactReasoningHistory ||
    reasoningHistoryFingerprint(input.messages, true) ===
      reasoningHistoryFingerprint(normalizedMessages);
  const body: Record<string, unknown> = {
    model: input.model,
    stream: false,
    messages: toChatCompletionsMessages(
      normalizedMessages,
      input.options,
      systemSuffix,
      input.providerCapabilityHints?.toolResultImagePolicy,
      input.providerCapabilityHints?.replaysReasoningContent === true,
      input.providerCapabilityHints?.reasoningContentField,
      input.providerCapabilityHints?.reasoningContentProvenance,
      replayOnlyAdjacentToolContinuation,
      reasoningContinuation,
      allowsFullReasoningHistoryReplay,
      input.providerCapabilityHints?.requiresStrictToolResultSequence === true,
      input.providerCapabilityHints?.imageInputContract,
      input.providerCapabilityHints?.acceptsDirectImageInput,
    ),
    [maxTokenField]: maxTokens,
  };

  const requestedToolChoice = input.options?.toolChoice;
  const disablesThinkingForForcedToolChoice =
    input.providerCapabilityHints?.disablesThinkingForForcedToolChoice === true &&
    requestedToolChoice !== undefined &&
    requestedToolChoice !== "auto" &&
    requestedToolChoice !== "none";
  const toolChoicePolicy = input.providerCapabilityHints?.toolChoicePolicy;
  const autoOnlyToolChoice = toolChoicePolicy === "auto_only";
  const disallowsRequiredToolChoice = toolChoicePolicy === "no_required";
  const disallowsNamedToolChoice = toolChoicePolicy === "no_named";
  const omitToolsForChoice =
    autoOnlyToolChoice && requestedToolChoice === "none";
  const maxToolDefinitions = positiveInteger(
    input.providerCapabilityHints?.maxToolDefinitions,
  );
  assertToolDefinitionLimit(
    omitToolsForChoice ? 0 : input.tools.length,
    maxToolDefinitions,
  );
  const requestedTools = omitToolsForChoice
    ? []
    : input.tools;
  const tools = toChatCompletionsTools(requestedTools, {
    grammarSafe:
      input.providerCapabilityHints?.requiresGrammarSafeToolSchemas === true,
  });
  if (tools.length > 0) body.tools = tools;
  const omitToolControlsWithoutTools =
    input.providerCapabilityHints?.omitsToolControlsWithoutTools === true &&
    tools.length === 0;
  if (
    requestedToolChoice !== undefined &&
    !omitToolsForChoice &&
    !omitToolControlsWithoutTools
  ) {
    body.tool_choice = autoOnlyToolChoice ||
        (disallowsRequiredToolChoice && requestedToolChoice === "required") ||
        (disallowsNamedToolChoice && typeof requestedToolChoice === "object")
      ? "auto"
      : parseOpenAIToolChoice(requestedToolChoice);
  }
  if (disablesThinkingForForcedToolChoice) {
    body.enable_thinking = false;
  } else if (
    input.providerCapabilityHints?.preservesThinkingHistory === true
  ) {
    // Qwen 3.6/3.7 ignore replayed reasoning_content by default. Explicitly
    // preserve it so a thinking-mode tool call can continue after its tool
    // result. Forced choices take the branch above because Qwen rejects them
    // while thinking is enabled.
    body.preserve_thinking = true;
  }
  if (input.providerCapabilityHints?.thinkingConfig !== undefined) {
    const keepsAdjacentToolReasoning = reasoningContinuation !== undefined;
    body.thinking = {
      type: input.providerCapabilityHints.thinkingConfig.type,
      ...(input.providerCapabilityHints.thinkingConfig.keep !== undefined
        ? { keep: input.providerCapabilityHints.thinkingConfig.keep }
        : {}),
      ...(input.providerCapabilityHints.thinkingConfig.clearThinking !==
          undefined
        ? {
            clear_thinking:
              keepsAdjacentToolReasoning
                ? false
                : input.providerCapabilityHints.thinkingConfig.clearThinking,
          }
        : {}),
    };
  }
  if (
    input.options?.parallelToolCalls !== undefined &&
    !(autoOnlyToolChoice && tools.length === 0) &&
    !omitToolControlsWithoutTools &&
    input.providerCapabilityHints?.acceptsParallelToolCalls !== false
  ) {
    body.parallel_tool_calls = input.options.parallelToolCalls;
  }
  if (
    input.options?.temperature !== undefined &&
    input.providerCapabilityHints?.acceptsTemperature !== false
  ) {
    body.temperature = input.options.temperature;
  }
  if (
    input.options?.stopSequences !== undefined &&
    input.options.stopSequences.length > 0 &&
    input.providerCapabilityHints?.acceptsStopSequences !== false
  ) {
    const maxStopSequences = positiveInteger(
      input.providerCapabilityHints?.maxStopSequences,
    );
    body.stop = maxStopSequences === undefined
      ? [...input.options.stopSequences]
      : input.options.stopSequences.slice(0, maxStopSequences);
  }
  // Strip fields the destination provider rejects. Hints are
  // adapter-populated; an undefined `acceptsX` flag preserves the
  // pre-hint behavior of "include if caller supplied a value", so
  // unmigrated callers don't regress.
  if (
    input.options?.reasoningEffort !== undefined &&
    !disablesThinkingForForcedToolChoice &&
    input.providerCapabilityHints?.acceptsReasoningEffort !== false &&
    // Providers with per-model effort enums (NVIDIA NIM) reject or
    // silently ignore out-of-enum values; stripping lets the model run
    // at its documented default instead of guessing a translation.
    (input.providerCapabilityHints?.reasoningEffortAllowedValues ===
      undefined ||
      input.providerCapabilityHints.reasoningEffortAllowedValues.has(
        input.options.reasoningEffort,
      ))
  ) {
    body.reasoning_effort = input.options.reasoningEffort;
  }
  if (
    input.options?.serviceTier !== undefined &&
    input.providerCapabilityHints?.acceptsServiceTier !== false
  ) {
    body.service_tier = input.options.serviceTier;
  }
  if (usesZaiJsonObject) {
    body.response_format = { type: "json_object" };
  } else {
    const structuredFormat =
      input.providerCapabilityHints?.structuredOutputContract === "cerebras_v2"
        ? buildCerebrasStructuredOutputTextFormat(structuredOutput)
        : buildStructuredOutputTextFormat(structuredOutput);
    if (structuredFormat) {
      const { type: _formatType, ...jsonSchema } = structuredFormat;
      body.response_format = {
        type: "json_schema",
        json_schema: jsonSchema,
      };
    }
  }
  if (input.providerCapabilityHints?.imageInputContract === "cerebras_v2") {
    assertCerebrasRequestPayloadSize(body);
  } else if (
    input.providerCapabilityHints?.imageInputContract === "kimi_global"
  ) {
    assertKimiRequestPayloadSize(body);
  }
  return body;
}

export function collectChatCompletionsRequestMetadata(
  request: Record<string, unknown>,
): ChatCompletionsRequestMetadata {
  const messages = Array.isArray(request.messages)
    ? (request.messages as Array<Record<string, unknown>>)
    : [];
  const tools = Array.isArray(request.tools)
    ? (request.tools as Array<Record<string, unknown>>)
    : [];
  const roleSequence = messages.map((message) =>
    typeof message.role === "string" ? message.role : "unknown",
  );
  const serializedPrompt = JSON.stringify({
    messages: request.messages ?? [],
    tools: request.tools ?? [],
  });
  const maxTokens =
    positiveInteger(request.max_tokens as number | undefined) ??
    positiveInteger(request.max_completion_tokens as number | undefined);
  const maxTokenField =
    positiveInteger(request.max_tokens as number | undefined) !== undefined
      ? "max_tokens"
      : positiveInteger(request.max_completion_tokens as number | undefined) !== undefined
        ? "max_completion_tokens"
        : undefined;
  return {
    model: typeof request.model === "string" ? request.model : "",
    messageCount: messages.length,
    roleSequence,
    // Admission-grade calls replace this diagnostic wire estimate with the
    // complete TokenAccountingService result. Direct adapter callers still
    // get a UTF-8-aware conservative byte ceiling rather than UTF-16 chars/4.
    estimatedPromptTokens: estimateUtf8TokenUnits(serializedPrompt, 1),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxTokenField !== undefined ? { maxTokenField } : {}),
    toolsAttached: tools.length > 0,
    toolCount: tools.length,
  };
}

export function parseChatCompletionsResponse(
  model: string,
  response: Record<string, unknown>,
  request: ChatCompletionsRequestOptions,
): LLMResponse {
  // Keep hashed aliases request-scoped. Meta's auto-only compatibility
  // contract strips the complete tool catalog when callers select `none`;
  // using the unfiltered input catalog here would let an unadvertised hashed
  // name resolve anyway if a malformed or hostile response echoed one.
  const requestedAdvertisedToolNames =
    request.providerCapabilityHints?.toolChoicePolicy === "auto_only" &&
      request.options?.toolChoice === "none"
      ? []
      : request.tools.map((tool) => tool.function.name);
  const maxToolDefinitions = positiveInteger(
    request.providerCapabilityHints?.maxToolDefinitions,
  );
  assertToolDefinitionLimit(
    requestedAdvertisedToolNames.length,
    maxToolDefinitions,
  );
  const advertisedToolNames = requestedAdvertisedToolNames;
  const enforcesAdvertisedToolCatalog = maxToolDefinitions !== undefined;
  const choices = Array.isArray(response.choices)
    ? (response.choices as Array<Record<string, unknown>>)
    : [];
  const choice = choices[0] ?? {};
  const message =
    choice.message && typeof choice.message === "object"
      ? (choice.message as Record<string, unknown>)
      : {};
  const allowedFinishReasons =
    request.providerCapabilityHints?.allowedFinishReasons;
  if (
    request.providerCapabilityHints
      ?.rejectsContextWindowExceededFinishReason === true &&
    choice.finish_reason === "model_context_window_exceeded"
  ) {
    throw new LLMContextWindowExceededError(
      request.providerCapabilityHints?.reasoningContentProvenance?.provider ??
        "zai",
      "The model reported model_context_window_exceeded",
    );
  }
  const finishReason = normalizeFinishReason(choice.finish_reason);
  if (
    request.providerCapabilityHints?.requiresToolCallsFinishReason === true &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0 &&
    (request.providerCapabilityHints.rejectsPartialToolCalls === true ||
      finishReason === "stop" ||
      finishReason === "tool_calls") &&
    choice.finish_reason !== "tool_calls"
  ) {
    throw new LLMInvalidResponseError(
      request.providerCapabilityHints?.reasoningContentProvenance?.provider ??
        "zai",
      "Tool calls arrived without finish_reason=tool_calls",
    );
  }
  if (
    allowedFinishReasons !== undefined &&
    (typeof choice.finish_reason !== "string" ||
      !allowedFinishReasons.has(choice.finish_reason))
  ) {
    throw new LLMInvalidResponseError(
      request.providerCapabilityHints?.reasoningContentProvenance?.provider ??
        "zai",
      `Missing or unsupported finish_reason ${JSON.stringify(choice.finish_reason)}`,
    );
  }
  const acceptsToolCalls =
    finishReason === "stop" || finishReason === "tool_calls";
  const toolCalls = acceptsToolCalls && Array.isArray(message.tool_calls)
    ? normalizeToolCallsStrict(
      (message.tool_calls as Array<Record<string, unknown>>).map(
        (toolCall): LLMToolCall => {
          // Decode the strict-regex wire name back to the
          // internal-registry form (`mcp.<server>.<tool>`) before
          // the dispatcher tries to look up the tool. Non-MCP names
          // pass through unchanged.
          const name = decodeMcpToolNameFromWire(
            String(
              (
                (toolCall.function as Record<string, unknown> | undefined) ?? {}
              ).name ?? "",
            ),
            advertisedToolNames,
          );
          if (
            enforcesAdvertisedToolCatalog &&
            !advertisedToolNames.includes(name)
          ) {
            throw new Error(
              `Provider returned unadvertised tool name ${JSON.stringify(name)}`,
            );
          }
          return {
            id: String(toolCall.id ?? ""),
            name,
            arguments: serializeProviderToolArguments(
              (
                (toolCall.function as Record<string, unknown> | undefined) ?? {}
              ).arguments,
            ),
          };
        },
      ),
      // branding-scan: allow real OpenAI provider identifier
      "OpenAI chat-completions response emitted invalid tool_call",
    )
    : [];
  const reasoningContentField =
    request.providerCapabilityHints?.reasoningContentField ??
    "reasoning_content";
  const rawProviderReasoningContent = message[reasoningContentField];
  const providerReasoningContent =
    typeof rawProviderReasoningContent === "string" &&
      rawProviderReasoningContent.length > 0
      ? rawProviderReasoningContent
      : undefined;
  const rawContent =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? assistantTextFromContentBlocks(message.content)
        // DeepSeek's non-streaming compatibility contract historically uses
        // reasoning_content as its last-resort answer. Other providers (most
        // notably Qwen) treat that field as opaque replay state, not UI text.
        : /(?:^|[/:])deepseek(?:$|[-_.:])/iu.test(model)
          ? providerReasoningContent ?? ""
          : "";
  // Models whose template inlines chain-of-thought in `content`
  // (MiniMax M3, Qwen3, R1 distills, Kimi K2) would otherwise print
  // literal think markers in the transcript. A leading block moves to
  // the thinking channel; `content` stays visible text only.
  const { text: content, reasoning: inlineThinking } =
    splitLeadingThinkBlock(rawContent);
  const usageRecord =
    response.usage && typeof response.usage === "object"
      ? (response.usage as Record<string, unknown>)
      : {};
  const promptDetails =
    usageRecord.prompt_tokens_details &&
      typeof usageRecord.prompt_tokens_details === "object" &&
      !Array.isArray(usageRecord.prompt_tokens_details)
      ? (usageRecord.prompt_tokens_details as Record<string, unknown>)
      : {};
  const completionDetails =
    usageRecord.completion_tokens_details &&
      typeof usageRecord.completion_tokens_details === "object" &&
      !Array.isArray(usageRecord.completion_tokens_details)
      ? (usageRecord.completion_tokens_details as Record<string, unknown>)
      : {};
  const isKimiResponse =
    request.providerCapabilityHints?.reasoningContentProvenance?.provider ===
      "kimi";
  const preparedMessages = prepareMessagesForWire(request.messages);
  const requestMetrics = withSerializedMetrics(
    collectRequestMetrics(preparedMessages, request.tools),
    buildChatCompletionsRequest(request),
    request.options,
  );

  // gaphunt3 #20: a truncated/incomplete generation (finishReason 'length',
  // 'error', or 'content_filter') leaves partial JSON in `content`, which
  // parseStructuredOutputText would JSON.parse and throw on, failing the
  // whole turn instead of surfacing the recoverable truncation. Only attempt
  // structured-output parsing when the generation completed normally.
  const generationCompleted = finishReason === "stop";

  return {
    content,
    ...(providerReasoningContent !== undefined || inlineThinking.length > 0
      ? {
          thinking: Object.freeze([
            Object.freeze({
              text: [providerReasoningContent, inlineThinking]
                .filter((value): value is string => Boolean(value))
                .join("\n"),
              redacted: false,
              kind: "reasoning_summary" as const,
            }),
          ]),
        }
      : {}),
    ...(providerReasoningContent !== undefined
      ? {
          providerReasoningContent,
          ...(request.providerCapabilityHints?.reasoningContentProvenance !==
          undefined
            ? {
                providerReasoningProvenance:
                  request.providerCapabilityHints.reasoningContentProvenance,
              }
            : {}),
        }
      : {}),
    toolCalls,
    usage: coerceUsage({
      promptTokens: usageRecord.prompt_tokens,
      completionTokens: usageRecord.completion_tokens,
      totalTokens: usageRecord.total_tokens,
      cachedInputTokens:
        promptDetails.cached_tokens ??
        (isKimiResponse ? usageRecord.cached_tokens : undefined),
      reasoningOutputTokens: completionDetails.reasoning_tokens,
    }),
    model:
      typeof response.model === "string" ? response.model : model,
    finishReason,
    requestMetrics: withEndpointMarkers(
      requestMetrics,
      "/chat/completions",
      response,
    ),
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
