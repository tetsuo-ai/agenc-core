/**
 * Per-provider capability gating for chat-completions wire fields.
 *
 * Some chat-completions request fields (`reasoning_effort`,
 * `service_tier`, `stream_options.include_usage`) are documented
 * cleanly only for one upstream provider, but the openai-compatible
 * base adapter is shared by every openai-compat provider in the
 * registry (lmstudio, ollama, openrouter, deepseek, groq, mistral,
 * nvidia-nim, github, minimax, …). Sending an unsupported field has
 * three failure modes:
 *
 *   1. Strict provider returns a 400 on unknown fields.
 *   2. Permissive provider silently ignores the field — no error,
 *      but the request is misshapen and behavior is undocumented.
 *   3. Some local servers (older Ollama versions, custom proxies)
 *      reject `stream_options` specifically and tear down the stream.
 *
 * This module centralizes the per-provider capability matrix so each
 * adapter doesn't have to spell out its own set of overrides. The
 * matrix keys on the canonical provider identity from the base
 * adapter; subclasses don't need to override anything as long as they
 * pass a recognizable slug.
 */

import { resolveReasoningEffort } from "../reasoning-effort.js";
import { normalizeProviderIdentity } from "../../provider-identity.js";
import { BRIEF_TOOL_NAME } from "../../tools/BriefTool/prompt.js";
import {
  resolveModelCapabilityHints,
} from "../registry/model-catalog.js";
import type { ProviderReasoningProvenance } from "../types.js";
import { isQwenFlashNextModel } from "../registry/qwen-flash-next.js";
import { isQwenCoder30BModel } from "../registry/qwen-coder-30b.js";
import { isAgenCDeepSeekModel, AGENC_DEEPSEEK_V41_MODEL } from "../registry/agenc-deepseek.js";
import { isNativeDeepSeekModel } from "../registry/deepseek-models.js";

export interface ChatCompletionsCapabilityHints {
  /**
   * If `false`, `reasoning_effort` is stripped from the request body
   * even when the caller's options specify a value. If `true` or
   * `undefined`, current behavior is preserved (caller-controlled).
   */
  readonly acceptsReasoningEffort?: boolean;
  /**
   * When set, `reasoning_effort` is forwarded only if the caller's
   * value is in this set; anything else is stripped so the model runs
   * at its documented default. Providers that accept the field
   * per-model publish per-model enums (NVIDIA NIM's hosted schemas
   * disagree with each other on the allowed values), so a boolean
   * accept flag alone would forward values the destination rejects.
   */
  readonly reasoningEffortAllowedValues?: ReadonlySet<string>;
  /**
   * Restricts provider-specific explicit tool-choice values. `auto_only`
   * downgrades `required` and named functions while preserving `none` by
   * omitting tools. `no_required` and `no_named` downgrade only the named
   * unsupported mode while keeping the other explicit choices intact.
   */
  readonly toolChoicePolicy?: "auto_only" | "no_required" | "no_named";
  /** Omit the field entirely for APIs whose thinking mode rejects it. */
  readonly acceptsToolChoice?: boolean;
  /** Omit tool-selection controls when no tool definitions are attached. */
  readonly omitsToolControlsWithoutTools?: boolean;
  /** Whether the selected model accepts `parallel_tool_calls`. */
  readonly acceptsParallelToolCalls?: boolean;
  /** Enforce API-v2 adjacent, complete, unique tool-call/result groups. */
  readonly requiresStrictToolResultSequence?: boolean;
  /** Apply Cerebras' strict base64 PNG/JPEG image payload contract. */
  readonly imageInputContract?: "cerebras_v2" | "zai_flash" | "kimi_global";
  /** Whether the selected model accepts direct user image input. */
  readonly acceptsDirectImageInput?: boolean;
  /** Apply Cerebras API v2's supported strict JSON-Schema subset. */
  readonly structuredOutputContract?: "cerebras_v2" | "zai_json_object";
  /**
   * Some OpenAI-compatible endpoints accept multimodal content on user
   * messages but require tool-result `content` to remain a string. When this
   * policy is enabled, image parts are removed from the tool message. Vision
   * models receive them immediately after the complete tool-result group as a
   * user image message; text-only models discard them. Text remains attached
   * to the original tool call.
   */
  readonly toolResultImagePolicy?: "relay_as_user" | "strip";
  /** Keep runtime context after a tool result inside that tool continuation. */
  readonly runtimeContextInToolResults?: boolean;
  /** Explain encoded function aliases when instructions use canonical names. */
  readonly includeToolNameAliases?: boolean;
  /**
   * Replay the provider-owned reasoning_content field on assistant messages.
   * Qwen's thinking-mode function calling requires this value to be echoed
   * unchanged before the corresponding tool results are submitted.
   */
  readonly replaysReasoningContent?: boolean;
  /** Provider-specific assistant reasoning field used for parse and replay. */
  readonly reasoningContentField?: "reasoning_content" | "reasoning";
  /** Older compatible runtimes may emit the legacy name while replay uses canonical. */
  readonly reasoningContentFallbackField?: "reasoning_content" | "reasoning";
  /**
   * MiniMax inlines thinking in `content` behind think markers unless
   * `reasoning_split` is set; with it the thinking arrives in
   * `reasoning_content`, where the tool turn can replay it.
   */
  readonly reasoningSplit?: boolean;
  /** vLLM receives Jinja thinking controls inside chat_template_kwargs. */
  readonly usesVllmThinkingTemplate?: boolean;
  /**
   * Replay provider-owned reasoning only for the complete assistant-tool/result
   * group immediately preceding this request. Z.AI requires that state for a
   * tool continuation, but stale history must be cleared after compaction or a
   * later user turn.
   */
  readonly replaysReasoningContentOnlyForAdjacentToolContinuation?: boolean;
  /** Replay all matching historical reasoning only if normalization changed none of the history. */
  readonly replaysReasoningContentOnlyForIntactHistory?: boolean;
  /** Canonical destination required for opaque reasoning replay. */
  readonly reasoningContentProvenance?: ProviderReasoningProvenance;
  /**
   * Provider-native nested thinking configuration. `enabled` is the always-on
   * form (DeepSeek, Z.AI, Kimi). `adaptive` is MiniMax-M3's two-position
   * switch: the wire sends `disabled` for a `low` effort, `adaptive` otherwise.
   */
  readonly thinkingConfig?: {
    readonly type: "enabled" | "adaptive";
    readonly clearThinking?: boolean;
    readonly keep?: "all";
  };
  /** Enable provider-native incremental function argument streaming. */
  readonly streamsToolCalls?: boolean;
  /**
   * Qwen 3.6/3.7 default `preserve_thinking` to false. Their thinking-mode
   * tool loop only consumes replayed `reasoning_content` when this request
   * switch is explicitly enabled. Qwen 3.8 defaults it to true and uses the
   * separate `reasoning_effort` control, so it intentionally does not opt in
   * here.
   */
  readonly preservesThinkingHistory?: boolean;
  /** Forced Qwen tool choices require hybrid thinking to be disabled. */
  readonly disablesThinkingForForcedToolChoice?: boolean;
  /**
   * If `false`, caller-supplied stop sequences are omitted. Some compatible
   * APIs reject the otherwise-standard `stop` request field.
   */
  readonly acceptsStopSequences?: boolean;
  /** Provider limit for stop sequences; excess values are omitted. */
  readonly maxStopSequences?: number;
  /** Provider limit for advertised function definitions. */
  readonly maxToolDefinitions?: number;
  /** Treat Z.AI's context-window terminal reason as overflow, not truncation. */
  readonly rejectsContextWindowExceededFinishReason?: boolean;
  /** Never dispatch tool calls unless the provider finalized with tool_calls. */
  readonly requiresToolCallsFinishReason?: boolean;
  /** Reject truncated/error terminal responses that contain partial tool calls. */
  readonly rejectsPartialToolCalls?: boolean;
  /** Provider-documented terminal finish reasons for final response frames. */
  readonly allowedFinishReasons?: ReadonlySet<string>;
  /** Reject EOF/[DONE] unless a documented terminal finish reason was seen. */
  readonly requiresExplicitFinishReason?: boolean;
  /** Whether caller-supplied temperature is accepted by this wire contract. */
  readonly acceptsTemperature?: boolean;
  /**
   * If `false`, `service_tier` is stripped. The field is recognized
   * only on an explicit provider allowlist; non-matching providers
   * either reject it or silently ignore it.
   */
  readonly acceptsServiceTier?: boolean;
  /**
   * If `false`, `stream_options.include_usage` is omitted from
   * streaming requests. Some local openai-compat servers reject the
   * field and tear down the stream on encounter.
   */
  readonly acceptsStreamUsage?: boolean;
  /**
   * If `true`, tool JSON schemas are rewritten to the subset
   * llama.cpp's json-schema-to-grammar compiles. Grammar-constrained
   * servers (LM Studio, llama.cpp server, some custom proxies) build
   * a GBNF grammar from the request's tool schemas and answer 400
   * "failed to parse grammar" on anything richer — the turn dies
   * before the model ever runs.
   */
  readonly requiresGrammarSafeToolSchemas?: boolean;
  /**
   * Upper bound for the request's max-output-tokens field. Local
   * llama.cpp-family servers run reasoning models (qwen3 and kin)
   * whose thinking freely eats whatever budget the caller sends; the
   * runtime's frontier default (tens of thousands) turns one turn
   * into minutes of silent generation on consumer hardware. Undefined
   * = caller-controlled.
   */
  readonly outputTokensCeiling?: number;
  /**
   * Soft switch appended to the system prompt to suppress the model's
   * think-trace. Qwen3-family models honor a literal /no_think line;
   * without it a local reasoning model spends its whole (already
   * capped) output budget thinking. Empirically: 16-24s turns drop to
   * 1-3s on the same hardware. Undefined = no suffix.
   */
  readonly reasoningSoftSwitchSuffix?: string;
}

// Providers that document `service_tier` on chat-completions.
const SERVICE_TIER_PROVIDERS = new Set([
  "openai",
  "azure-openai",
  "cerebras",
]);

const ZAI_FINISH_REASONS = new Set([
  "stop",
  "tool_calls",
  "length",
  "sensitive",
  "model_context_window_exceeded",
  "network_error",
]);

const KIMI_FINISH_REASONS = new Set(["stop", "length", "tool_calls"]);

// Providers explicitly known to reject `stream_options.include_usage`.
// Currently empty by design: the default is "include" because losing
// usage tracking on every streamed response is a significant
// regression. Only add a provider here when we have a reproducible
// failure case from a real installation. Override per-instance via
// the `providerCapabilityHints.acceptsStreamUsage` opt for one-off
// servers that misbehave.
const STREAM_USAGE_INCOMPATIBLE_PROVIDERS = new Set<string>();

// Providers whose tool calling is grammar-constrained (llama.cpp
// based): tool schemas must stay within the subset its
// json-schema-to-grammar converter accepts, or the request 400s with
// "failed to parse grammar". The generic compatible slot is included
// because llama.cpp-family servers are its most common target; richer
// servers only lose optional constraint keywords, never validity.
const GRAMMAR_CONSTRAINED_TOOL_PROVIDERS = new Set([
  "lmstudio",
  "openai-compatible",
]);

// Providers that serve small local models and therefore get the
// reduced tool catalog (see LOCAL_PROFILE_TOOL_NAMES). This is a
// separate axis from the grammar constraint above: a server can need
// a smaller catalog without compiling tool schemas into a GBNF
// grammar. Ollama is the common case — it accepts the full JSON
// Schema dialect, so it must not inherit the grammar-safe rewrite or
// the /no_think prompt suffix, but its models are the same 7-32B
// class that the frontier catalog drowns.
const LOCAL_TOOL_PROFILE_PROVIDERS = new Set([
  "lmstudio",
  "openai-compatible",
  "ollama",
]);

/**
 * Tools a small local model can actually drive. The frontier catalog
 * (~20 tools with team/task orchestration) overwhelms 7-32B models —
 * observed as zero tool calls emitted across whole sessions. The
 * subset keeps the core loop: shell, files, search, planning, user
 * interaction and progress messages. Names must match the registry's
 * advertised tool names.
 */
const LOCAL_PROFILE_TOOL_NAMES = new Set([
  "exec_command",
  "write_stdin",
  "kill_process",
  "list_processes",
  "FileRead",
  "Edit",
  "MultiEdit",
  "Write",
  "Glob",
  "Grep",
  "Orient",
  "AskUserQuestion",
  "TodoWrite",
  "EnterPlanMode",
  "ExitPlanMode",
  "system.searchTools",
  BRIEF_TOOL_NAME,
  "StructuredOutput",
]);

/**
 * Whether the provider gets the reduced local tool catalog. Keyed on
 * its own provider set, not on the grammar constraints: the catalog
 * size and the wire-schema dialect are independent properties of a
 * local server.
 */
export function usesLocalToolProfile(
  providerName: string | undefined,
): boolean {
  return LOCAL_TOOL_PROFILE_PROVIDERS.has(
    normalizeProviderIdentity(providerName, "local tool profile") ?? "",
  );
}

/** Filter an advertised tool list down to the local profile. */
export function filterToolsForLocalProfile<
  T extends { readonly function: { readonly name: string } },
>(tools: readonly T[]): readonly T[] {
  return tools.filter((tool) =>
    LOCAL_PROFILE_TOOL_NAMES.has(tool.function.name),
  );
}

/**
 * Resolve the capability hints for a given provider slug + model.
 * Each adapter calls this when building a chat-completions request so
 * the wire layer can strip fields the destination provider rejects.
 */
export function chatCompletionsCapabilityHintsForProvider(
  providerName: string | undefined,
  model: string | undefined,
  options: { readonly managedGateway?: boolean } = {},
): ChatCompletionsCapabilityHints {
  const slug = normalizeProviderIdentity(providerName, "capability gate") ?? "";
  const isManagedDeepSeek = options.managedGateway === true &&
    slug === "openrouter" && isAgenCDeepSeekModel(model);
  const isNativeDeepSeek = slug === "deepseek" && isNativeDeepSeekModel(model);
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  const reasoningContentProvenance =
    slug.length > 0 && normalizedModel.length > 0
      ? Object.freeze({ provider: slug, model: normalizedModel })
      : undefined;
  const acceptsToolResultImages =
    resolveModelCapabilityHints({ provider: slug, model })
      ?.supportsImageInput === true;
  const isZai = slug === "zai" || slug === "zai-coding-plan";
  const isKimi = slug === "kimi";
  const isMinimax = slug === "minimax";
  const isMinimaxM3 =
    isMinimax && /(?:^|[/:])minimax-m3(?:$|[-_.:])/i.test(model ?? "");
  const isKimiK3 = isKimi && normalizedModel === "kimi-k3";
  const isKimiK27 =
    isKimi && /^kimi-k2\.7-code(?:-highspeed)?$/u.test(normalizedModel);
  const isKimiK26 = isKimi && normalizedModel === "kimi-k2.6";
  const isKnownKimiModel = isKimiK3 || isKimiK27 || isKimiK26;
  const supportsZaiToolStreaming =
    isZai &&
    /(?:^|[/:])glm-(?:5(?:\.(?:1|2|3))?|4\.(?:6|7))(?:$|[-_.:])/i.test(
      model ?? "",
    );
  const isQwenCloud = (slug === "qwen" || slug === "qwen-token-plan") &&
    !isQwenCoder30BModel(model);
  const isQwenFlashNext = slug === "qwen" && isQwenFlashNextModel(model);
  const preservesThinkingHistory =
    (slug === "qwen" &&
      /(?:^|[/:])qwen3\.(?:7-(?:max|plus|flash)|6-(?:max-preview|plus|flash))(?:$|[-_.:])/i.test(
        model ?? "",
      )) ||
    (slug === "qwen-token-plan" &&
      /(?:^|[/:])qwen3\.(?:7-(?:max|plus)|6-flash)(?:$|[-_.:])/i.test(
        model ?? "",
      ));

  const effort = resolveReasoningEffort({ provider: slug, model, managedGateway: options.managedGateway });
  const acceptsReasoningEffort = effort.acceptsChatEffort;
  const reasoningEffortAllowedValues = effort.chatLevels;

  // service_tier: recognized only by documented providers. Strip
  // everywhere else — most servers ignore it silently, but at least
  // one custom proxy in the wild rejects unknown fields.
  const acceptsServiceTier = SERVICE_TIER_PROVIDERS.has(slug);

  // stream_options: accepted by most openai-compat providers. Strip
  // only for providers known to reject it. The runtime emits a
  // warning out-of-band when a streamed response carries no usage,
  // so dropping the field is a usability regression on the providers
  // that DO support it — keep the default permissive.
  const acceptsStreamUsage = !STREAM_USAGE_INCOMPATIBLE_PROVIDERS.has(slug);

  const requiresGrammarSafeToolSchemas =
    GRAMMAR_CONSTRAINED_TOOL_PROVIDERS.has(slug);

  // Qwen3's hybrid thinking honors a soft /no_think switch in the
  // prompt. LM Studio ignores chat_template_kwargs.enable_thinking
  // (verified empirically), so the prompt-level switch is the only
  // wire-side control that works everywhere llama.cpp serves qwen.
  const reasoningSoftSwitchSuffix =
    requiresGrammarSafeToolSchemas &&
      /(^|[/:])qwen-?3/i.test((model ?? "").trim())
      ? "/no_think"
      : undefined;

  // Local servers get a sane output ceiling: enough for a long answer
  // or a batch of tool calls, small enough that a runaway think-trace
  // cannot burn minutes per turn on consumer hardware.
  // 8192, not lower: 4096 clipped legitimate long generations (code,
  // multi-file answers) and the executor discarded the withheld output
  // as max_output_tokens — the user saw an empty turn. This still caps
  // the minutes-long runaway think-traces the ceiling exists for.
  const outputTokensCeiling = requiresGrammarSafeToolSchemas
    ? 8192
    : undefined;

  return {
    acceptsReasoningEffort,
    ...(slug === "ollama-cloud" ? {
      acceptsDirectImageInput: acceptsToolResultImages,
      toolResultImagePolicy: acceptsToolResultImages ? "relay_as_user" as const : "strip" as const,
      replaysReasoningContent: true,
      reasoningContentField: "reasoning" as const,
      reasoningContentFallbackField: "reasoning_content" as const,
      acceptsParallelToolCalls: false,
      omitsToolControlsWithoutTools: true,
      includeToolNameAliases: true,
    } : {}),
    ...(isNativeDeepSeek ? {
      acceptsToolChoice: false,
      acceptsParallelToolCalls: false,
      acceptsDirectImageInput: acceptsToolResultImages,
      toolResultImagePolicy: acceptsToolResultImages ? "relay_as_user" as const : "strip" as const,
      toolChoicePolicy: "auto_only" as const,
      acceptsTemperature: false,
      thinkingConfig: { type: "enabled" as const },
      replaysReasoningContent: true,
      reasoningContentField: "reasoning_content" as const,
    } : {}),
    ...(isManagedDeepSeek ? {
      // The reviewed V4.1 route supports automatic tool selection, not forced
      // or named choices. All tools remain available to the agent.
      ...(model === AGENC_DEEPSEEK_V41_MODEL ? {
        acceptsToolChoice: false,
        toolChoicePolicy: "auto_only" as const,
      } : {}),
      acceptsParallelToolCalls: false,
      acceptsDirectImageInput: model === AGENC_DEEPSEEK_V41_MODEL,
      toolResultImagePolicy: model === AGENC_DEEPSEEK_V41_MODEL ? "relay_as_user" as const : "strip" as const,
      runtimeContextInToolResults: true,
      includeToolNameAliases: true,
      replaysReasoningContent: true,
      reasoningContentField: "reasoning" as const,
      reasoningContentFallbackField: "reasoning_content" as const,
      // Runtime reminders may follow tool results as user-role messages.
      // Preserve same-route reasoning across those boundaries and later turns;
      // the wire builder still checks the original provider/model provenance.
      maxToolDefinitions: 100,
    } : {}),
    // DeepSeek and Meta document a terminal chunk carrying finish_reason.
    // Tool-call arguments received before that signal are not finalized.
    ...(slug === "deepseek" || slug === "meta"
      ? {
          requiresToolCallsFinishReason: true,
          rejectsPartialToolCalls: true,
          requiresExplicitFinishReason: true,
        }
      : {}),
    ...(reasoningEffortAllowedValues !== undefined
      ? { reasoningEffortAllowedValues }
      : {}),
    ...(slug === "meta" || isZai
      ? { toolChoicePolicy: "auto_only" as const }
      : {}),
    ...(isKimi
      ? {
          toolChoicePolicy: isKimiK3
            ? ("no_named" as const)
            : ("auto_only" as const),
        }
      : {}),
    ...(isZai
      ? {
          acceptsDirectImageInput: acceptsToolResultImages,
          omitsToolControlsWithoutTools: true,
          acceptsParallelToolCalls: false,
          maxStopSequences: 1,
          maxToolDefinitions: 128,
          rejectsContextWindowExceededFinishReason: true,
          requiresToolCallsFinishReason: true,
          requiresExplicitFinishReason: true,
          allowedFinishReasons: ZAI_FINISH_REASONS,
        }
      : {}),
    ...(supportsZaiToolStreaming ? { streamsToolCalls: true } : {}),
    ...(isKnownKimiModel
      ? {
          acceptsDirectImageInput: true,
          acceptsParallelToolCalls: false,
          maxToolDefinitions: 128,
          ...(isKimiK3 ? { outputTokensCeiling: 1_048_576 } : {}),
          requiresToolCallsFinishReason: true,
          rejectsPartialToolCalls: true,
          requiresExplicitFinishReason: true,
          allowedFinishReasons: KIMI_FINISH_REASONS,
          acceptsTemperature: false,
          replaysReasoningContent: true,
          replaysReasoningContentOnlyForIntactHistory: true,
          reasoningContentField: "reasoning_content" as const,
          imageInputContract: "kimi_global" as const,
          ...(isKimiK26
            ? {
                thinkingConfig: {
                  type: "enabled" as const,
                  keep: "all" as const,
                },
              }
            : {}),
        }
      : {}),
    ...(slug === "meta" ||
    slug === "qwen" ||
    slug === "qwen-token-plan" ||
    slug === "cerebras" ||
    isZai ||
    isMinimax
      ? {
          toolResultImagePolicy: acceptsToolResultImages
            ? ("relay_as_user" as const)
            : ("strip" as const),
        }
      : {}),
    ...(isQwenCloud
      ? {
          replaysReasoningContent: true,
          ...(preservesThinkingHistory
            ? { preservesThinkingHistory: true }
            : {}),
          disablesThinkingForForcedToolChoice: true,
        }
      : {}),
    ...(isQwenFlashNext
      ? {
          reasoningContentField: "reasoning" as const,
          reasoningContentFallbackField: "reasoning_content" as const,
          usesVllmThinkingTemplate: true,
        }
      : {}),
    ...(slug === "cerebras"
      ? {
          replaysReasoningContent:
            /(?:^|[/:])(?:gpt-oss-120b|qwen-3\.8-27b|gemma-4-31b)$/i.test(
              model ?? "",
            ),
          reasoningContentField: "reasoning" as const,
          omitsToolControlsWithoutTools: true,
          acceptsParallelToolCalls:
            /(?:^|[/:])(?:qwen-3\.8-27b|gemma-4-31b)$/i.test(model ?? ""),
          requiresStrictToolResultSequence: true,
          imageInputContract: "cerebras_v2" as const,
          acceptsDirectImageInput: acceptsToolResultImages,
          structuredOutputContract: "cerebras_v2" as const,
        }
      : {}),
    ...(isZai &&
    /(?:^|[/:])glm-5\.3(?:-flash)?$/i.test(model ?? "")
      ? {
          replaysReasoningContent: true,
          replaysReasoningContentOnlyForAdjacentToolContinuation: true,
          reasoningContentField: "reasoning_content" as const,
          thinkingConfig: {
            type: "enabled" as const,
            clearThinking: true,
          },
          structuredOutputContract: "zai_json_object" as const,
          ...(acceptsToolResultImages
            ? { imageInputContract: "zai_flash" as const }
            : {}),
        }
      : {}),
    ...(isMinimax
      ? {
          // MiniMax inlines thinking in `content` behind think markers by
          // default. reasoning_split moves it to reasoning_content, and the
          // docs want thinking preserved unchanged in later turns, above all
          // in tool-use conversations, so every same-route turn replays it
          // (the Qwen and Kimi shape, not Z.AI's adjacent-only rule: a
          // runtime reminder after a tool result must not drop the chain).
          reasoningSplit: true,
          replaysReasoningContent: true,
          reasoningContentField: "reasoning_content" as const,
          // Only M3 has the thinking switch; M2.x always think.
          ...(isMinimaxM3
            ? { thinkingConfig: { type: "adaptive" as const } }
            : {}),
        }
      : {}),
    ...(reasoningContentProvenance !== undefined
      ? { reasoningContentProvenance }
      : {}),
    acceptsStopSequences: slug !== "meta",
    acceptsServiceTier,
    acceptsStreamUsage: isZai ? false : acceptsStreamUsage,
    requiresGrammarSafeToolSchemas,
    ...(outputTokensCeiling !== undefined ? { outputTokensCeiling } : {}),
    ...(reasoningSoftSwitchSuffix !== undefined
      ? { reasoningSoftSwitchSuffix }
      : {}),
  };
}
