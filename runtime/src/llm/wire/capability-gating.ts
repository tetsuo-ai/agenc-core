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

import { normalizeProviderIdentity } from "../../provider-identity.js";
import { BRIEF_TOOL_NAME } from "../../tools/BriefTool/prompt.js";
import { supportsXaiReasoningEffortParam } from "../structured-output.js";

export interface ChatCompletionsCapabilityHints {
  /**
   * If `false`, `reasoning_effort` is stripped from the request body
   * even when the caller's options specify a value. If `true` or
   * `undefined`, current behavior is preserved (caller-controlled).
   */
  readonly acceptsReasoningEffort?: boolean;
  /**
   * If `false`, `service_tier` is stripped. The field is recognized
   * only on a single upstream provider; non-matching providers
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
// branding-scan: allow real provider identifiers in capability matrix
const SERVICE_TIER_PROVIDERS = new Set(["openai", "azure-openai"]);

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

/**
 * Lightweight test for the upstream-provider reasoning model family.
 * Mirrors the regex in `capabilities.ts:isOpenAIReasoningModel` so we
 * don't have to widen that file's exports for this single use site.
 */
function isUpstreamReasoningModel(model: string | undefined): boolean {
  if (model === undefined) return false;
  // branding-scan: allow real model-family identifiers in regex
  return /(?:^|[/:])(?:gpt-5|o1|o3|o4|codex|chatgpt-5)(?:$|[-_.:])/i.test(
    model.trim(),
  );
}

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
 * the same set as the grammar constraints: these are the providers
 * that serve small local models.
 */
export function usesLocalToolProfile(
  providerName: string | undefined,
): boolean {
  return GRAMMAR_CONSTRAINED_TOOL_PROVIDERS.has(
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
): ChatCompletionsCapabilityHints {
  const slug = normalizeProviderIdentity(providerName, "capability gate") ?? "";

  // reasoning_effort: documented for the upstream-provider reasoning
  // model family and for documented xAI Grok reasoning variants. Every
  // other provider/model combination either rejects it or silently
  // ignores it. Default to the safe "strip" for anything
  // unrecognized.
  // branding-scan: allow factual reference to real provider in routing comment
  let acceptsReasoningEffort = false;
  if (slug === "openai") {
    acceptsReasoningEffort = isUpstreamReasoningModel(model);
  } else if (slug === "grok") {
    acceptsReasoningEffort = supportsXaiReasoningEffortParam(model);
  }

  // service_tier: recognized by a single upstream provider. Strip
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
    acceptsServiceTier,
    acceptsStreamUsage,
    requiresGrammarSafeToolSchemas,
    ...(outputTokensCeiling !== undefined ? { outputTokensCeiling } : {}),
    ...(reasoningSoftSwitchSuffix !== undefined
      ? { reasoningSoftSwitchSuffix }
      : {}),
  };
}
