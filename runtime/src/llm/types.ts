/**
 * LLM provider types for @tetsuo-ai/runtime
 *
 * Defines the core interfaces for LLM adapters that bridge
 * language model providers to the AgenC task execution system.
 *
 * @module
 */

import type { ProviderFallbackLadderOptions } from "./api/fallback-ladder.js";
import { isRecord } from "../utils/record.js";

/**
 * Message role in a conversation
 */
export type MessageRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

/**
 * Local assistant message phase for long-running/tool-heavy flows.
 *
 * Preserved in AgenC history so the runtime can distinguish working
 * commentary from the completed answer without assuming provider support.
 */
type LLMAssistantPhase = "commentary" | "final_answer";

/**
 * A content part for multimodal messages in provider-compatible format.
 */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
      };
      title?: string;
      filename?: string;
      fallbackText?: string;
      fallbackTextTruncated?: boolean;
      fallbackTextError?: string;
    };

/**
 * A single message in an LLM conversation.
 *
 * `content` may be a plain string or an array of content parts for multimodal
 * messages (e.g. text + images). Providers that don't support multimodal should
 * extract the text parts and ignore image parts.
 */
export interface LLMMessage {
  role: MessageRole;
  content: string | LLMContentPart[];
  /** Optional local phase metadata for runtime-side replay and completion logic. */
  phase?: LLMAssistantPhase;
  /**
   * Runtime-only metadata used to preserve prompt-envelope semantics before
   * provider serialization. This must be stripped before adapter payloads.
   */
  runtimeOnly?: {
    readonly mergeBoundary?: "user_context";
    readonly excludeFromDurableHistory?: true;
    /**
     * When `true`, this message is preserved across compaction
     * boundaries. Compaction extracts anchor-marked messages from
     * the segment being summarized and retains them alongside the
     * kept tail — matches upstream's `messagesToKeep` compaction pattern.
     * Reserved for messages the
     * runtime depends on for trigger anchoring (e.g. injected
     * reminders whose re-emission gates scan for prior-injection
     * headers in history). Use sparingly; anchor messages that
     * accumulate indefinitely inflate post-compact history.
     */
    readonly anchorPreserve?: boolean;
    readonly recoverableToolFailure?: {
      readonly hiddenFromTranscript: true;
      readonly kind:
        | "input_validation"
        | "mcp_tool_not_shell_command"
        | "shell_workspace_write_policy";
    };
  };
  /** For assistant messages that request tool execution */
  toolCalls?: LLMToolCall[];
  /** For tool result messages — the ID of the tool call being responded to */
  toolCallId?: string;
  /** For tool result messages — the name of the tool */
  toolName?: string;
}

/**
 * Tool definition in provider-compatible format.
 */
export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A tool call requested by the LLM
 */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type LLMStreamingToolUseCaller =
  | { readonly type: "direct" }
  | {
      readonly type: "code_execution_20250825" | "code_execution_20260120";
      readonly tool_id: string;
    };

export interface LLMStreamingToolUseContentBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly caller?: LLMStreamingToolUseCaller;
}

export interface StreamingToolUse {
  readonly index: number;
  readonly contentBlock: LLMStreamingToolUseContentBlock;
  readonly unparsedToolInput: string;
}

export interface ToolCallValidationFailure {
  readonly code:
    | "invalid_shape"
    | "missing_id"
    | "missing_name"
    | "non_string_arguments"
    | "invalid_json"
    | "non_object_arguments";
  readonly message: string;
}

interface ToolCallValidationResult {
  readonly toolCall: LLMToolCall | null;
  readonly failure?: ToolCallValidationFailure;
}

const STRING_ARGUMENT_TOOL_FIELDS: Readonly<Record<string, string>> = {
  exec_command: "cmd",
  "system.bash": "command",
  FileRead: "file_path",
  Write: "file_path",
  Edit: "file_path",
  "system.listDir": "path",
  "system.stat": "path",
  "system.mkdir": "path",
  "system.delete": "path",
  Glob: "pattern",
  Grep: "pattern",
  exec: "code",
};

function isBlankString(value: string): boolean {
  return value.trim().length === 0;
}

function isLikelyStructuredObjectLiteral(value: string): boolean {
  return /^\s*\{\s*['"]?\w+['"]?\s*:/.test(value);
}

function shouldTreatMalformedArgumentsAsStructuredLiteral(
  toolName: string,
  value: string,
): boolean {
  if (isLikelyStructuredObjectLiteral(value)) {
    return true;
  }
  // AgenC preserves Bash's plain-string command mode even when the
  // command starts with bracket syntax (`[ -f foo ] && pwd`, `{ pwd; }`).
  // File/path tools do not have that escape hatch: if their arguments start
  // with JSON-like delimiters but failed to parse, keep them as malformed
  // structured input instead of converting the entire blob into a fake path.
  if (toolName === "system.bash" || toolName === "exec_command") {
    return false;
  }
  return /^\s*[\[{]/.test(value);
}

function wrapPlainStringToolArguments(
  toolName: string,
  value: string,
): Record<string, string> | null {
  const field = STRING_ARGUMENT_TOOL_FIELDS[toolName];
  if (!field) return null;
  return { [field]: value };
}

/**
 * Token usage statistics
 */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  webSearchRequests?: number;
}

/**
 * Provider-specific request-shape diagnostics for one LLM call.
 *
 * These values are intended for observability/debugging (not billing).
 */
export interface LLMRequestMetrics {
  messageCount: number;
  systemMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
  totalContentChars: number;
  maxMessageChars: number;
  textParts: number;
  imageParts: number;
  toolCount: number;
  toolNames: readonly string[];
  requestedToolNames?: readonly string[];
  missingRequestedToolNames?: readonly string[];
  toolResolution?: string;
  providerCatalogToolCount?: number;
  toolsAttached?: boolean;
  toolSuppressionReason?: string;
  toolChoice?: string;
  toolSchemaChars: number;
  structuredOutputEnabled?: boolean;
  structuredOutputName?: string;
  structuredOutputStrict?: boolean;
  serializedChars: number;
  store?: boolean;
  parallelToolCalls?: boolean;
  stream?: boolean;
}

/**
 * Provider-native compaction fallback reasons when an opaque server-side
 * compaction mode cannot stay enabled for a request.
 */
export type LLMCompactionFallbackReason =
  | "unsupported"
  | "request_rejected";

/**
 * Opaque provider-managed state item metadata.
 *
 * The runtime stores only identifiers/digests needed for tracing and replay;
 * the payload itself stays provider-owned and out-of-band.
 */
export interface LLMCompactionItemRef {
  /** Provider-emitted state item type. */
  readonly type: string;
  /** Provider-emitted item identifier when available. */
  readonly id?: string;
  /** Stable digest over the opaque item for replay/debug correlation. */
  readonly digest: string;
}

/** Per-call diagnostics for provider-managed continuation state. */
export interface LLMCompactionDiagnostics {
  /** True when provider-managed continuation state is enabled in config for this call. */
  readonly enabled: boolean;
  /** True when the initial request attempted provider-managed continuation state. */
  readonly requested: boolean;
  /** True when the final request sent to the provider still included that state feature. */
  readonly active: boolean;
  /** Provider-specific state mode used for the call. */
  readonly mode: "provider_managed_state";
  /** Configured threshold associated with the state feature. */
  readonly threshold: number;
  /** Number of opaque state items observed in the provider response. */
  readonly observedItemCount: number;
  /** Latest opaque provider state item returned by the provider, if any. */
  readonly latestItem?: LLMCompactionItemRef;
  /** Fallback reason when the state feature had to be disabled for the call. */
  readonly fallbackReason?: LLMCompactionFallbackReason;
}



export type LLMContextWindowSource =
  | "explicit_config"
  | "grok_model_catalog"
  | "grok_model_heuristic"
  | "ollama_request_num_ctx"
  | "ollama_running_context_length"
  | "ollama_model_info"
  | "ollama_model_parameters"
  | "ollama_default";

export interface LLMProviderExecutionProfile {
  /** Provider name exposed by the adapter. */
  readonly provider: string;
  /** Effective model identifier used for calls when known. */
  readonly model?: string;
  /** Effective input context window used for prompt budgeting. */
  readonly contextWindowTokens?: number;
  /** How the effective context window was resolved. */
  readonly contextWindowSource?: LLMContextWindowSource;
  /** Effective max output tokens configured for the provider, if any. */
  readonly maxOutputTokens?: number;
}


/**
 * Optional turn-time tool routing hints passed to provider calls.
 */
interface LLMChatToolRoutingOptions {
  /**
   * Restrict provider-advertised tools for this call to this allowlist.
   * Unknown tool names are ignored by providers.
   */
  readonly allowedToolNames?: readonly string[];
}

type LLMReasoningEffort = "low" | "medium" | "high" | "xhigh";
type LLMReasoningSummary = "auto" | "concise" | "detailed" | "none";
type LLMModelVerbosity = "low" | "medium" | "high";
type LLMServiceTier = "fast" | "priority" | "flex";

export type LLMProviderNativeServerToolType =
  | "web_search"
  | "x_search"
  | "code_interpreter"
  | "file_search"
  | "mcp"
  | "view_image"
  | "view_x_video";

type LLMProviderNativeServerToolCallType =
  | "web_search_call"
  | "x_search_call"
  | "code_interpreter_call"
  | "file_search_call"
  | "mcp_call";

export interface LLMProviderNativeServerToolCall {
  /** Provider-emitted output item type such as `web_search_call`. */
  readonly type: LLMProviderNativeServerToolCallType;
  /** Logical server-side tool family for routing, tracing, and billing. */
  readonly toolType: LLMProviderNativeServerToolType;
  /** Provider-emitted call identifier when present. */
  readonly id?: string;
  /** Provider-emitted function/tool name when present. */
  readonly functionName?: string;
  /** Provider-emitted arguments payload when present. */
  readonly arguments?: string;
  /** Provider-emitted status string when present. */
  readonly status?: string;
  /** Sanitized raw provider payload for future adapter-specific enrichment. */
  readonly raw?: Record<string, unknown>;
}

export interface LLMProviderServerSideToolUsageEntry {
  /** Provider usage category, e.g. `SERVER_SIDE_TOOL_WEB_SEARCH`. */
  readonly category: string;
  /** AgenC-normalized tool family when it can be inferred. */
  readonly toolType?: LLMProviderNativeServerToolType;
  /** Successful invocation count reported by the provider. */
  readonly count: number;
}

export interface LLMStructuredOutputSchema {
  /** Structured output mode documented by the provider surface. */
  readonly type: "json_schema";
  /** Stable schema name sent to the provider. */
  readonly name: string;
  /** JSON Schema payload. */
  readonly schema: Record<string, unknown>;
  /** Enforce strict schema adherence when supported. */
  readonly strict?: boolean;
}

export interface LLMStructuredOutputRequest {
  /** Provider/runtime enable switch for structured output mode. */
  readonly enabled?: boolean;
  /** Optional schema payload for request-scoped structured output. */
  readonly schema?: LLMStructuredOutputSchema;
}

export interface LLMStructuredOutputResult {
  /** Structured output mode returned by the provider/runtime. */
  readonly type: "json_schema";
  /** Schema name associated with the response when available. */
  readonly name?: string;
  /** Parsed structured payload when AgenC or the provider validated it. */
  readonly parsed?: unknown;
  /** Raw JSON string content when the provider returned structured text only. */
  readonly rawText?: string;
}

interface LLMEncryptedReasoningDiagnostics {
  /** True when the request explicitly asked for encrypted reasoning content. */
  readonly requested: boolean;
  /** True when encrypted reasoning content was present in the provider response. */
  readonly available: boolean;
}

export interface LLMCollectionsSearchConfig {
  /** Enable the provider-native collections/file search tool. */
  readonly enabled?: boolean;
  /** Collection/vector store identifiers for compatible providers. */
  readonly vectorStoreIds?: readonly string[];
  /** Optional server-side retrieval limit. */
  readonly maxNumResults?: number;
}

export interface LLMWebSearchConfig {
  /** Restrict web search/browsing to these domains only. */
  readonly allowedDomains?: readonly string[];
  /** Exclude these domains from web search/browsing. */
  readonly excludedDomains?: readonly string[];
  /** Enable server-side image understanding during web search. */
  readonly enableImageUnderstanding?: boolean;
}

export interface LLMXSearchConfig {
  /** Restrict X search to posts from these handles only. */
  readonly allowedXHandles?: readonly string[];
  /** Exclude posts from these handles. */
  readonly excludedXHandles?: readonly string[];
  /** Inclusive ISO8601 start date for X search. */
  readonly fromDate?: string;
  /** Inclusive ISO8601 end date for X search. */
  readonly toDate?: string;
  /** Enable image understanding on discovered X posts. */
  readonly enableImageUnderstanding?: boolean;
  /** Enable video understanding on discovered X posts. */
  readonly enableVideoUnderstanding?: boolean;
}

export interface LLMRemoteMcpServerConfig {
  /** Remote MCP server URL for compatible providers. */
  readonly serverUrl: string;
  /** Stable label used for tool prefixing and trace readability. */
  readonly serverLabel: string;
  /** Optional provider-facing description of the MCP server. */
  readonly serverDescription?: string;
  /** Restrict server-exposed tool names when supported. */
  readonly allowedTools?: readonly string[];
  /** Authorization token forwarded to the MCP server when configured. */
  readonly authorization?: string;
  /** Additional static headers forwarded to the MCP server. */
  readonly headers?: Readonly<Record<string, string>>;
}

interface LLMRemoteMcpConfig {
  /** Enable provider-managed remote MCP tool injection. */
  readonly enabled?: boolean;
  /** Configured remote MCP servers exposed to the provider. */
  readonly servers?: readonly LLMRemoteMcpServerConfig[];
}

interface LLMStructuredOutputsConfig {
  /** Enable provider-level structured output support. */
  readonly enabled?: boolean;
  /** Default strictness applied when building provider schema requests. */
  readonly strict?: boolean;
}

export interface LLMXaiCapabilitySurface {
  /** Enable provider-native web search tool routing. */
  readonly webSearch?: boolean;
  /** Provider-native web search routing preference. */
  readonly searchMode?: "auto" | "on" | "off";
  /** Provider-native web search filters/capabilities. */
  readonly webSearchOptions?: LLMWebSearchConfig;
  /** Enable provider-native X search tools. */
  readonly xSearch?: boolean;
  /** Provider-native X search filters/capabilities. */
  readonly xSearchOptions?: LLMXSearchConfig;
  /** Enable provider-native code execution / code interpreter. */
  readonly codeExecution?: boolean;
  /** Collections / file search configuration. */
  readonly collectionsSearch?: LLMCollectionsSearchConfig;
  /** Remote MCP server configuration. */
  readonly remoteMcp?: LLMRemoteMcpConfig;
  /** Structured output capability defaults. */
  readonly structuredOutputs?: LLMStructuredOutputsConfig;
  /** Request encrypted reasoning content when supported. */
  readonly includeEncryptedReasoning?: boolean;
  /** Maximum assistant/tool turns allowed in one provider-managed loop. */
  readonly maxTurns?: number;
  /** Provider-native reasoning depth control. */
  readonly reasoningEffort?: LLMReasoningEffort;
}

export interface LLMProviderTraceEvent {
  readonly kind: "request" | "response" | "error" | "stream_event";
  readonly transport: "chat" | "chat_stream";
  readonly provider: string;
  readonly model?: string;
  readonly callIndex?: number;
  readonly callPhase?:
    | "compaction"
    | "initial"
    | "planner"
    | "planner_verifier"
    | "planner_synthesis"
    | "tool_followup"
    | "evaluator"
    | "evaluator_retry";
  readonly payload: Record<string, unknown>;
  readonly context?: Record<string, unknown>;
}

interface LLMChatTraceOptions {
  /** Emit raw provider request/response/error/stream-event payloads through the trace callback. */
  readonly includeProviderPayloads?: boolean;
  /** Callback invoked with provider-native request/response/error/stream-event payloads. */
  readonly onProviderTraceEvent?: (event: LLMProviderTraceEvent) => void;
}

/**
 * Provider-agnostic tool-choice directive for one model call.
 */
export type LLMToolChoice =
  | "auto"
  | "required"
  | "none"
  | {
    readonly type: "function";
    readonly name: string;
  };

/**
 * Optional provider call options.
 */
export interface LLMChatOptions {
  /**
   * Request-scoped model override. Providers default to their constructor
   * model, but delegated turns such as reviewer/guardian sessions must be
   * able to run a different model without rebuilding the whole parent
   * session.
   */
  readonly model?: string;
  /**
   * Stable request instructions kept out of the conversation transcript.
   * Provider adapters serialize this through their native system/instructions
   * field instead of injecting a mid-conversation system message.
   */
  readonly systemPrompt?: string;
  /** Effective input context window for this request. */
  readonly contextWindowTokens?: number;
  /** Positive output-token budget for this request. */
  readonly maxOutputTokens?: number;
  /**
   * Optional stable session key passed to providers that expose a
   * prompt-cache routing hint (xAI `prompt_cache_key`, etc.). Pure
   * optimization — has no effect on correctness. No server-side
   * conversation state is implied.
  */
  readonly promptCacheKey?: string;
  /**
   * For fire-and-forget fork turns, avoid writing the fork's tail into
   * provider prompt cache while preserving cache reads from the shared prefix.
   */
  readonly skipCacheWrite?: boolean;
  readonly toolRouting?: LLMChatToolRoutingOptions;
  /** Request-scoped tool catalog. Providers should prefer this over
   * constructor-time tools so late MCP/dynamic tools can appear after
   * session startup. */
  readonly tools?: ReadonlyArray<LLMTool>;
  readonly toolChoice?: LLMToolChoice;
  /** Optional request-scoped structured output contract. */
  readonly structuredOutput?: LLMStructuredOutputRequest;
  /** Request encrypted reasoning content from providers that support it. */
  readonly includeEncryptedReasoning?: boolean;
  /** Provider-native max-turns cap for server-side tool loops. */
  readonly maxTurns?: number;
  /** Provider-native reasoning depth override. */
  readonly reasoningEffort?: LLMReasoningEffort;
  /** Provider-facing reasoning-summary hint for APIs that expose it. */
  readonly reasoningSummary?: LLMReasoningSummary;
  /** Provider-facing output verbosity hint for APIs that expose it. */
  readonly modelVerbosity?: LLMModelVerbosity;
  /** Provider-facing service-tier hint for APIs that expose it. */
  readonly serviceTier?: LLMServiceTier;
  readonly trace?: LLMChatTraceOptions;
  /** Upper bound for this individual provider call. */
  readonly timeoutMs?: number;
  /** Abort signal propagated from the runtime when the request is cancelled. */
  readonly signal?: AbortSignal;
  /**
   * Disable provider-side parallel tool calls for this request. Used by the
   * meta-planner and other goal-only flows that intentionally do not want the
   * model to fan out into multiple concurrent tool invocations on a single
   * planning turn. Honored by providers that expose the
   * `parallel_tool_calls` request flag.
   */
  readonly parallelToolCalls?: boolean;
}

export interface LLMProviderEvidence {
  readonly citations?: readonly string[];
  /** Server-side tool calls attempted by the provider during the request. */
  readonly serverSideToolCalls?: readonly LLMProviderNativeServerToolCall[];
  /** Successful/billable server-side tool usage summary from the provider. */
  readonly serverSideToolUsage?: readonly LLMProviderServerSideToolUsageEntry[];
}

export interface LLMStoredResponse {
  /** Provider-emitted response identifier. */
  readonly id: string;
  /** Provider name backing the stored response. */
  readonly provider: string;
  /** Provider-emitted model identifier when available. */
  readonly model?: string;
  /** Provider-emitted lifecycle status when available. */
  readonly status?: string;
  /** Parsed assistant text content derived from the stored response output. */
  readonly content: string;
  /** Parsed client-side function calls preserved in the stored response. */
  readonly toolCalls: readonly LLMToolCall[];
  /** Provider usage block when available. */
  readonly usage?: LLMUsage;
  /** Provider-side tool/citation evidence derived from stored output. */
  readonly providerEvidence?: LLMProviderEvidence;
  /** Structured output parsing result when present in the stored response. */
  readonly structuredOutput?: LLMStructuredOutputResult;
  /** Encrypted reasoning request/availability diagnostics for the stored response. */
  readonly encryptedReasoning?: LLMEncryptedReasoningDiagnostics;
  /** Raw provider output array, cloned for debugging/replay inspection. */
  readonly output?: readonly Record<string, unknown>[];
  /** Sanitized raw provider response object for debugging/replay inspection. */
  readonly raw?: Record<string, unknown>;
}

export interface LLMStoredResponseDeleteResult {
  /** Deleted response identifier. */
  readonly id: string;
  /** Provider name backing the deletion request. */
  readonly provider: string;
  /** Whether the provider confirmed the response was deleted. */
  readonly deleted: boolean;
  /** Sanitized raw provider delete response for debugging/auditing. */
  readonly raw?: Record<string, unknown>;
}

/**
 * Response from an LLM provider
 */
export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  usage: LLMUsage;
  model: string;
  /** Provider-computed request diagnostics for this call. */
  requestMetrics?: LLMRequestMetrics;
  /** Provider-native compaction diagnostics, when supported by the provider. */
  compaction?: LLMCompactionDiagnostics;
  /** Provider-side evidence from built-in/server-side tools. */
  providerEvidence?: LLMProviderEvidence;
  /** Structured-output schema result metadata when requested/returned. */
  structuredOutput?: LLMStructuredOutputResult;
  /** Encrypted reasoning availability for this provider response. */
  encryptedReasoning?: LLMEncryptedReasoningDiagnostics;
  /**
   * Extended-thinking blocks captured from the final response (messages-API
   * thinking / redacted_thinking content blocks, or Responses-API reasoning
   * summaries normalised into the same shape). Distinct from `content` —
   * `content` is visible assistant text only, `thinking` is the model's
   * reasoning channel. Used by the runtime to emit `agent_thinking` for
   * transcript persistence after the streaming pass completes.
   */
  thinking?: ReadonlyArray<{
    readonly text: string;
    readonly signature?: string;
    readonly redacted: boolean;
    readonly kind?: "thinking" | "reasoning_summary";
  }>;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  /** Underlying error when finishReason is "error". */
  error?: Error;
  /** True if partial content was received before an error. */
  partial?: boolean;
}

/**
 * A chunk from a streaming LLM response
 */
export interface LLMStreamChunk {
  content: string;
  done: boolean;
  toolCalls?: LLMToolCall[];
  /**
   * When true, `content` is the full-so-far snapshot of the assistant
   * reply rather than an incremental delta. Downstream consumers MUST
   * replace any previously-accumulated streaming buffer with this
   * content instead of appending to it. Only set by adapter paths that
   * emit corrected/rewritten snapshots mid-stream (e.g. Grok's
   * mitigation path at grok/adapter.ts when a partial reply gets
   * repaired). The normal delta path leaves this undefined.
   */
  resetBuffer?: boolean;
  /**
   * Provider-emitted signal that a tool_use content block has begun
   * streaming its arguments. Mirrors provider content_block_start
   * with content_block.type === 'tool_use'. Consumed downstream by
   * runtime/src/phases/stream-model.ts (which translates it into a
   * `tool_input_block_start` session event) so the TUI bridge can
   * seed an entry in transcript.streamingToolUses. Other providers
   * that do not emit streaming tool inputs leave this undefined.
   */
  toolInputBlockStart?: {
    callId: string;
    index: number;
    contentBlock: {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
  };
  /**
   * Provider-emitted signal carrying one input_json_delta payload for
   * a streaming tool_use block. Mirrors provider
   * content_block_delta with delta.type === 'input_json_delta'.
   * Translated downstream into a `tool_input_delta` session event;
   * the TUI bridge appends `partialJson` to the matching slot in
   * streamingToolUses. Independent of the existing toolCalls field
   * (which is only set at content_block_stop with the completed,
   * fully-parsed tool call).
   */
  toolInputDelta?: {
    callId: string;
    index: number;
    partialJson: string;
  };
  /**
   * Provider-emitted signal that an extended-thinking (or redacted-thinking)
   * content block has begun streaming. Mirrors provider content_block_start
   * with content_block.type === 'thinking' | 'redacted_thinking'. Translated
   * downstream into an `assistant_thinking_block_start` session event so the
   * TUI bridge seeds an entry in transcript.streamingThinking. Providers that
   * do not surface extended thinking leave this undefined.
   */
  thinkingBlockStart?: {
    index: number;
    redacted: boolean;
  };
  /**
   * Provider-emitted incremental delta for an open thinking block. Mirrors
   * provider content_block_delta with delta.type === 'thinking_delta'. The
   * delta payload is plain assistant chain-of-thought text (sanitised
   * downstream the same way visible text is). The runtime translates this
   * into an `assistant_thinking_delta` session event; the TUI bridge appends
   * to the matching streamingThinking accumulator.
   */
  thinkingDelta?: {
    delta: string;
    index: number;
  };
  /**
   * Provider-emitted close for a thinking block. Translated into an
   * `assistant_thinking_block_stop` session event so the TUI flips the
   * accumulator to `isStreaming: false` (preserving the post-stream
   * visibility window) and marks the block ready for transcript persistence.
   */
  thinkingBlockStop?: {
    index: number;
  };
  /**
   * Provider-emitted reasoning-summary delta for Responses-API style
   * providers (xAI Grok reasoning models, GPT-style reasoning models) that
   * surface a human-readable summary of the model's reasoning channel
   * separate from the visible response. Forwarded downstream through the
   * same `assistant_thinking_*` events as messages-API thinking blocks but
   * tagged with `kind: "reasoning_summary"` so the TUI can label it
   * accordingly.
   */
  reasoningSummaryDelta?: {
    delta: string;
    summaryIndex: number;
  };
}

/**
 * Callback for streaming progress updates
 */
export type StreamProgressCallback = (chunk: LLMStreamChunk) => void;

/**
 * Handler for tool calls — maps tool name + arguments to a string result
 */
export type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

export interface LLMProviderStartupPrewarmParams {
  readonly conversationId: string;
  readonly threadId: string;
}

export interface LLMProviderStartupPrewarmHandle {
  chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse>;
  dispose?(): Promise<void> | void;
}

/**
 * Core LLM provider interface that all adapters implement
 */
export interface LLMProvider {
  readonly name: string;
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMResponse>;
  chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse>;
  healthCheck(): Promise<boolean>;
  /** Report the effective model/context profile used for prompt budgeting. */
  getExecutionProfile?(): Promise<LLMProviderExecutionProfile>;
  /** Optional startup hook for providers with session/socket prewarm support. */
  prewarmStartup?(
    params: LLMProviderStartupPrewarmParams,
  ):
    | Promise<LLMProviderStartupPrewarmHandle | void>
    | LLMProviderStartupPrewarmHandle
    | void;
  /** Optional debug/replay hook for fetching a stored provider response by ID. */
  retrieveStoredResponse?(responseId: string): Promise<LLMStoredResponse>;
  /** Optional debug/replay hook for deleting a stored provider response by ID. */
  deleteStoredResponse?(
    responseId: string,
  ): Promise<LLMStoredResponseDeleteResult>;
}

/**
 * Shared configuration for all LLM providers
 */
export interface LLMProviderConfig {
  /** Model identifier (e.g. 'grok-3', 'grok-4', 'llama3') */
  model: string;
  /** System prompt prepended to conversations */
  systemPrompt?: string;
  /** Sampling temperature (0.0 - 2.0) */
  temperature?: number;
  /** Maximum tokens in the response */
  maxTokens?: number;
  /** Tools available to the model */
  tools?: LLMTool[];
  /** Handler called when the model invokes a tool */
  toolHandler?: ToolHandler;
  /** Maximum tool call rounds before forcing a text response (default: 10) */
  maxToolRounds?: number;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Maximum automatic retries on transient failures */
  maxRetries?: number;
  /** Base delay between retries in milliseconds */
  retryDelayMs?: number;
  /** Ordered model/provider fallback ladder for repeated overload failures. */
  providerFallback?: ProviderFallbackLadderOptions;
  /** Best-effort warning sink for provider/transport contract events. */
  emitWarning?: (warning: { cause: string; message: string }) => void;
  /** Internal diagnostic sink for debug/replay metadata that must not surface as a warning. */
  emitDiagnostic?: (diagnostic: { cause: string; message: string }) => void;
  /** Capability-drift hook fired when the provider rejects a claimed feature. */
  onCapabilityDrift?: (warning: { message: string; status?: number }) => void;
}

/**
 * Decode HTML entities that some LLMs (e.g. Grok) emit in tool call arguments.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function decodeHtmlEntitiesDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return decodeHtmlEntities(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decodeHtmlEntitiesDeep(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      decodeHtmlEntitiesDeep(entry),
    ]),
  );
}

function normalizeToolArguments(
  toolName: string,
  argumentsRaw: string,
): { value: unknown } | null {
  const finalizeParsed = (value: unknown): { value: unknown } => {
    if (isRecord(value)) {
      return { value };
    }
    if (typeof value === "string" && !isBlankString(value)) {
      return {
        value: wrapPlainStringToolArguments(toolName, value) ?? value,
      };
    }
    return { value };
  };
  try {
    return finalizeParsed(JSON.parse(argumentsRaw) as unknown);
  } catch {
    try {
      return finalizeParsed(JSON.parse(decodeHtmlEntities(argumentsRaw)) as unknown);
    } catch {
      const decoded = decodeHtmlEntities(argumentsRaw);
      if (
        isBlankString(decoded) ||
        shouldTreatMalformedArgumentsAsStructuredLiteral(toolName, decoded)
      ) {
        return { value: {} };
      }
      const wrapped = wrapPlainStringToolArguments(toolName, decoded);
      if (wrapped) {
        return { value: wrapped };
      }
      return null;
    }
  }
}

/**
 * Validate/sanitize a raw tool call payload.
 *
 * Ensures `id` and `name` are non-empty strings, and `arguments` is a JSON string.
 * Preserves valid JSON structure first, then decodes HTML entities inside
 * parsed string values. Falls back to decoding the raw JSON text only when the
 * original argument string is not valid JSON.
 */
export function validateToolCallDetailed(
  raw: unknown,
): ToolCallValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return {
      toolCall: null,
      failure: {
        code: "invalid_shape",
        message: "Tool call payload must be an object.",
      },
    };
  }

  const candidate = raw as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const argumentsRaw = candidate.arguments;

  if (!id) {
    return {
      toolCall: null,
      failure: {
        code: "missing_id",
        message: "Tool call payload is missing a non-empty id.",
      },
    };
  }
  if (!name) {
    return {
      toolCall: null,
      failure: {
        code: "missing_name",
        message: "Tool call payload is missing a non-empty name.",
      },
    };
  }
  if (typeof argumentsRaw !== "string") {
    return {
      toolCall: null,
      failure: {
        code: "non_string_arguments",
        message: "Tool call arguments must be a JSON string.",
      },
    };
  }

  const parsedResult = normalizeToolArguments(name, argumentsRaw);
  if (!parsedResult) {
    return {
      toolCall: null,
      failure: {
        code: "invalid_json",
        message: "Tool call arguments are not valid JSON.",
      },
    };
  }

  const parsed = parsedResult.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      toolCall: null,
      failure: {
        code: "non_object_arguments",
        message: "Tool call arguments must decode to a JSON object.",
      },
    };
  }

  const normalizedArguments = JSON.stringify(
    decodeHtmlEntitiesDeep(parsed) as Record<string, unknown>,
  );

  return {
    toolCall: {
      id,
      name,
      arguments: normalizedArguments,
    },
  };
}

export function validateToolCall(raw: unknown): LLMToolCall | null {
  return validateToolCallDetailed(raw).toolCall;
}
