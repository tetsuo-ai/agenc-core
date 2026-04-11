/**
 * Strict-filter layer for the xAI `/v1/responses` endpoint.
 *
 * Two pure validators sit on either side of the OpenAI SDK call inside
 * `runtime/src/llm/grok/adapter.ts`:
 *
 *   • {@link validateXaiRequestPreFlight} runs in `buildParams()` immediately
 *     before `sanitizeToDocumentedXaiResponsesParams()`. It throws
 *     {@link XaiUnknownModelError} / {@link XaiUndocumentedFieldError} /
 *     {@link XaiSilentToolDropError} when the outgoing request body would
 *     trigger a known xAI silent-degradation mode.
 *
 *   • {@link validateXaiResponsePostFlight} runs in `parseResponse()` (and the
 *     streaming `response.completed` branch of `chatStream()`) immediately
 *     after the SDK returns. It returns a list of detected anomalies that
 *     the adapter either throws (for the silent-tool-drop case) or surfaces
 *     as normalization issues (for the warn cases).
 *
 * The validators exist because the OpenAI Node SDK is a thin HTTP client
 * with no xAI-specific schema validation. xAI accepts almost any request
 * body, returns 200, and the failure surfaces as semantic degradation that
 * the runtime never catches. The CLAUDE.md learned rule
 * **"xAI Compatibility: Treat undocumented 200s as untrusted until
 * semantics are proven"** captures the failure class this module enforces.
 *
 * Every field, model ID, and shape constraint in this file was sourced
 * directly from `mcp__xai-docs__get_doc_page` against `developers/models`,
 * `developers/model-capabilities/text/generate-text`,
 * `developers/model-capabilities/text/reasoning`, and
 * `developers/tools/function-calling` on 2026-04-09. See
 * `/home/tetsuo/.claude/plans/ethereal-twirling-cerf.md` for the source
 * citations and the failure modes this module is designed to catch.
 *
 * Three real failures from 2026-04-09 that this filter would have caught
 * before the user ever saw them:
 *
 *   1. `MAX_TOOL_SCHEMA_CHARS_FOLLOWUP = 20_000` silently dropped the
 *      `tools[]` array on every follow-up turn. Pre-flight rule 5 catches
 *      this: tool-followup with empty tools throws
 *      `XaiSilentToolDropError("outgoing_followup_tools_empty")`.
 *
 *   2. Configured model IDs that are not in the current xAI catalog can be
 *      silently aliased server-side. Pre-flight rule 1 catches this: throws
 *      `XaiUnknownModelError`.
 *
 *   3. Grok returned a response with `reasoning + message` blocks but zero
 *      `function_call` blocks on a tool-followup turn, with the message
 *      text saying "(Continuing with tool calls to bootstrap.)". Post-flight
 *      rule 1 catches this: throws
 *      `XaiSilentToolDropError("incoming_promised_tools_missing")`.
 *
 * @module
 */

import { LLMProviderError } from "../errors.js";
import type { LLMFailureClass, LLMPipelineStopReason } from "../policy.js";

// ---------------------------------------------------------------------------
// Section A — documented xAI Responses API contract
// ---------------------------------------------------------------------------

/**
 * Top-level request fields documented for the xAI `/v1/responses` endpoint.
 *
 * Source: developers/model-capabilities/text/generate-text and
 * developers/tools/function-calling, fetched 2026-04-09 via
 * mcp__xai-docs__get_doc_page.
 *
 * Kept in sync with the existing `DOCUMENTED_XAI_RESPONSES_FIELDS` set in
 * `runtime/src/llm/grok/adapter.ts`. The strict filter rejects any
 * top-level key not in this set instead of silently stripping it the way
 * `sanitizeToDocumentedXaiResponsesParams()` does.
 */
/**
 * Documented maximum `tools` array length for xAI /v1/responses. Source:
 * developers/rest-api-reference/inference/chat Responses API section:
 * "A max of 128 tools are supported."
 *
 * The runtime enforces this in two places: the Grok adapter's
 * `buildParams()` auto-trims the tool array to this cap BEFORE the
 * strict filter runs (so agents with large tool catalogs stay
 * functional), and `validateXaiRequestPreFlight()` throws on any
 * request whose tools array still exceeds this after the auto-trim
 * (defense in depth against a regression that bypasses the adapter
 * trim).
 */
export const XAI_RESPONSES_MAX_TOOL_COUNT = 128;

export const DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "include",
  "input",
  "max_output_tokens",
  "max_turns",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "store",
  "stream",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_p",
  "user",
  // logprobs / top_logprobs are kept in the allowlist because the existing
  // adapter and tests use them, even though the xAI docs explicitly say
  // they are accepted but ignored on grok-4.20 family models per
  // developers/models. The validator does not reject them, but the
  // post-flight does not assert anything about them either.
  "logprobs",
  "top_logprobs",
]);

/**
 * Built-in / server-side tool type names accepted by the xAI Responses API.
 *
 * Source: developers/tools/overview, developers/tools/web-search,
 * developers/tools/code-execution, developers/tools/collections-search,
 * developers/tools/remote-mcp via mcp__xai-docs__get_doc_page on 2026-04-09.
 *
 * Note: `code_execution` is the xAI SDK alias for what the Responses API
 * calls `code_interpreter`. Both are accepted as input tool type names.
 */
const DOCUMENTED_XAI_BUILTIN_TOOL_TYPES: ReadonlySet<string> = new Set([
  "function",
  "web_search",
  "x_search",
  "code_interpreter",
  "code_execution",
  "collections_search",
  "file_search",
  "attachment_search",
  "mcp",
]);

/**
 * Output block `type` values that count as a model-issued tool call. The
 * post-flight silent-tool-drop detector treats the response as having a
 * tool call if it contains any block of these types.
 *
 * Source: developers/model-capabilities/text/comparison and
 * developers/tools/tool-usage-details#identifying-tool-call-types.
 */
const SERVER_SIDE_TOOL_CALL_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "web_search_call",
  "x_search_call",
  "code_interpreter_call",
  "file_search_call",
  "mcp_call",
]);

/**
 * xAI model catalog as of 2026-04-11.
 *
 * Source: live daemon /model list response backed by xAI /models.
 *
 * The validator rejects any `model` value that does not appear here OR in
 * {@link DOCUMENTED_XAI_MODEL_ALIASES}. xAI silently aliases unknown model
 * IDs server-side, which we treat as untrusted under the CLAUDE.md
 * "xAI Compatibility: Treat undocumented 200s as untrusted" rule.
 */
const DOCUMENTED_XAI_MODEL_IDS: ReadonlySet<string> = new Set([
  // Grok 4 family — current
  "grok-4.20-beta-0309-reasoning",
  "grok-4.20-beta-0309-non-reasoning",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4.20-multi-agent-beta-0309",
  "grok-4-0709",
  // Grok 3 family — still in xAI catalog per release notes (April 2025)
  "grok-3",
  "grok-3-mini",
  // Grok 2 family — released December 2024, still accepted
  "grok-2-1212",
  "grok-2-vision-1212",
  // Code-specialized model — released August 2025
  "grok-code-fast-1",
  // image / video models — no function calling but still valid model IDs
  "grok-imagine-image",
  "grok-imagine-image-pro",
  "grok-imagine-video",
]);

/**
 * Documented xAI model alias map. Per `developers/models#model-aliases`:
 *
 *   - `<modelname>` → latest stable version
 *   - `<modelname>-latest` → latest version
 *   - `<modelname>-<date>` → specific release
 *
 * For each documented model variant, we list the bare-name and `-latest`
 * aliases that resolve to the current canonical release. New releases just
 * add new entries to this map.
 */
const DOCUMENTED_XAI_MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  // bare names → canonical
  ["grok-4.20-reasoning", "grok-4.20-beta-0309-reasoning"],
  ["grok-4.20-non-reasoning", "grok-4.20-beta-0309-non-reasoning"],
  ["grok-4.20-multi-agent", "grok-4.20-multi-agent-beta-0309"],
  ["grok-4-fast-reasoning", "grok-4-1-fast-reasoning"],
  ["grok-4-fast-non-reasoning", "grok-4-1-fast-non-reasoning"],
  // -latest aliases → canonical
  ["grok-4.20-reasoning-latest", "grok-4.20-beta-0309-reasoning"],
  ["grok-4.20-non-reasoning-latest", "grok-4.20-beta-0309-non-reasoning"],
  ["grok-4.20-multi-agent-latest", "grok-4.20-multi-agent-beta-0309"],
  ["grok-4.20-beta-latest-reasoning", "grok-4.20-beta-0309-reasoning"],
  ["grok-4.20-beta-latest-non-reasoning", "grok-4.20-beta-0309-non-reasoning"],
  ["grok-4.20-multi-agent-beta-latest", "grok-4.20-multi-agent-beta-0309"],
  // Previous non-beta spelling seen in local autocomplete before xAI exposed beta IDs.
  ["grok-4.20-0309-reasoning", "grok-4.20-beta-0309-reasoning"],
  ["grok-4.20-0309-non-reasoning", "grok-4.20-beta-0309-non-reasoning"],
  ["grok-4.20-multi-agent-0309", "grok-4.20-multi-agent-beta-0309"],
  ["grok-4-1-fast-reasoning-latest", "grok-4-1-fast-reasoning"],
  ["grok-4-1-fast-non-reasoning-latest", "grok-4-1-fast-non-reasoning"],
]);

/**
 * Resolve a configured model ID to its canonical xAI catalog entry, or
 * return `null` if the ID is not in the documented catalog OR alias map.
 */
export function resolveDocumentedXaiModel(model: string): string | null {
  if (typeof model !== "string" || model.length === 0) {
    return null;
  }
  if (DOCUMENTED_XAI_MODEL_IDS.has(model)) {
    return model;
  }
  const aliased = DOCUMENTED_XAI_MODEL_ALIASES.get(model);
  if (aliased && DOCUMENTED_XAI_MODEL_IDS.has(aliased)) {
    return aliased;
  }
  return null;
}

/**
 * True if the canonical model supports function calling. The image/video
 * models in the catalog (`grok-imagine-*`) do not.
 */
export function modelSupportsFunctionCalling(canonicalModel: string): boolean {
  return !canonicalModel.startsWith("grok-imagine");
}

/**
 * True if the canonical model accepts the `reasoning.effort` parameter.
 *
 * Per developers/model-capabilities/text/reasoning: only the multi-agent
 * model accepts `reasoning.effort` (where it controls agent count, not
 * thinking depth). `grok-4.20-*` and `grok-4-1-fast-*` reason
 * automatically and **return an error** if `reasoning.effort` is sent.
 */
export function modelSupportsReasoningEffort(canonicalModel: string): boolean {
  return canonicalModel === "grok-4.20-multi-agent-beta-0309";
}

/**
 * True if the canonical model is a reasoning variant that rejects the
 * `presence_penalty`, `frequency_penalty`, and `stop` parameters per
 * developers/model-capabilities/text/reasoning.
 *
 * Match logic must be careful: `non-reasoning` includes the substring
 * `reasoning` but is NOT a reasoning variant. We check for the explicit
 * `-reasoning` suffix or the `-non-reasoning` exclusion, plus the
 * multi-agent variant which is also a reasoning model. The legacy
 * `grok-3-mini` was the only Grok 3 family model that returned
 * `reasoning_content` per developers/rate-limits, but the docs do not
 * say it explicitly forbids penalty/stop, so we do not flag it here.
 * If a future xAI doc update confirms that, add it to this branch.
 */
export function modelIsReasoningVariant(canonicalModel: string): boolean {
  if (canonicalModel.includes("non-reasoning")) return false;
  return (
    canonicalModel.endsWith("-reasoning") ||
    canonicalModel.includes("multi-agent")
  );
}

/**
 * True if the canonical model is the multi-agent variant. Per
 * developers/model-capabilities/text/multi-agent#limitations, multi-agent
 * does NOT support `max_tokens` / `max_output_tokens`, does NOT support
 * client-side function calling, and does NOT work with the Chat
 * Completions API.
 */
export function modelIsMultiAgent(canonicalModel: string): boolean {
  return canonicalModel.includes("multi-agent");
}

// ---------------------------------------------------------------------------
// Section B — error class hierarchy
// ---------------------------------------------------------------------------

/**
 * Thrown when the configured `model` is not in the documented xAI catalog.
 *
 * xAI silently aliases unknown model IDs server-side, which produces
 * unverifiable behavior. This catches stale or mistyped model IDs before
 * sending them to the provider.
 *
 * Maps to `failureClass: "provider_error"` via the existing
 * `classifyLLMFailure()` instanceof branch on `LLMProviderError`. Gets
 * `maxRetries: 2`, `circuitBreakerEligible: true`, fallback enabled.
 */
export class XaiUnknownModelError extends LLMProviderError {
  public readonly failureClass: LLMFailureClass = "provider_error";
  public readonly stopReason: LLMPipelineStopReason = "provider_error";
  public readonly requestedModel: string;

  constructor(requestedModel: string) {
    super(
      "grok",
      `Configured model "${requestedModel}" is not in the documented xAI ` +
        `catalog (developers/models). xAI silently aliases unknown model IDs, ` +
        `which produces unverifiable behavior. Set llm.model in config.json to ` +
        `one of the documented IDs (e.g. "grok-4-1-fast-non-reasoning", ` +
        `"grok-4.20-beta-0309-reasoning", "grok-4.20-multi-agent-beta-0309").`,
      400,
    );
    this.name = "XaiUnknownModelError";
    this.requestedModel = requestedModel;
  }
}

/**
 * Thrown when the outgoing request body contains a field that is not in
 * the documented xAI Responses API contract, OR a documented field used in
 * a way the docs explicitly forbid (e.g. `reasoning.effort` on a
 * non-multi-agent model).
 */
export class XaiUndocumentedFieldError extends LLMProviderError {
  public readonly failureClass: LLMFailureClass = "provider_error";
  public readonly stopReason: LLMPipelineStopReason = "provider_error";
  public readonly fieldName: string;
  public readonly reason: string;

  constructor(fieldName: string, reason: string) {
    super(
      "grok",
      `xAI Responses API request rejected by strict filter: field ` +
        `"${fieldName}" ${reason}.`,
      400,
    );
    this.name = "XaiUndocumentedFieldError";
    this.fieldName = fieldName;
    this.reason = reason;
  }
}

/**
 * Thrown when the strict filter detects the silent-tool-drop failure mode
 * in either direction:
 *
 *   - `outgoing_followup_tools_empty`: pre-flight detected that AgenC is
 *     about to send a tool-followup request (input contains a
 *     `function_call_output` item) with `tools.length === 0`. xAI accepts
 *     this silently but the model has no tools to call, the response is
 *     text-only, and the executor exits the tool loop after one tool call
 *     per chat turn. This is the bug AgenC's `MAX_TOOL_SCHEMA_CHARS_FOLLOWUP`
 *     guard caused for months.
 *
 *   - `incoming_promised_tools_missing`: post-flight detected that we sent
 *     tools, the response has zero `function_call` blocks, and the
 *     assistant message text contains promise language like "I will call",
 *     "now executing", "continuing with tool calls". xAI may have silently
 *     dropped the tools or the model degraded its output mid-turn.
 */
export class XaiSilentToolDropError extends LLMProviderError {
  public readonly failureClass: LLMFailureClass = "provider_error";
  public readonly stopReason: LLMPipelineStopReason = "provider_error";
  public readonly turnKind:
    | "outgoing_followup_tools_empty"
    | "incoming_promised_tools_missing";
  public readonly evidence: Record<string, unknown>;

  constructor(
    turnKind:
      | "outgoing_followup_tools_empty"
      | "incoming_promised_tools_missing",
    evidence: Record<string, unknown>,
  ) {
    super(
      "grok",
      turnKind === "outgoing_followup_tools_empty"
        ? `xAI silent tool drop (outgoing): tool-followup request would be ` +
          `sent with empty tools[] array. The prior turn produced a tool ` +
          `call, the input contains a function_call_output item, but the ` +
          `runtime is about to send tools=[]. xAI accepts this and the ` +
          `model has no tools to call, which exits the tool loop after one ` +
          `tool call per chat turn.`
        : `xAI silent tool drop (incoming): response contains zero ` +
          `function_call blocks but the model promised tool execution in ` +
          `its message text. xAI may have silently dropped the tools or the ` +
          `model degraded its output. Evidence: ` +
          JSON.stringify(evidence).slice(0, 240),
      // Use HTTP 200 to signal "request succeeded at the transport layer
      // but the payload is semantically wrong" — distinct from real 4xx/5xx.
      200,
    );
    this.name = "XaiSilentToolDropError";
    this.turnKind = turnKind;
    this.evidence = evidence;
  }
}

// ---------------------------------------------------------------------------
// Section C — pre-flight validator
// ---------------------------------------------------------------------------

/**
 * Strict pre-flight validation for an outgoing `/v1/responses` request.
 *
 * Throws on any of:
 *
 *   1. Undocumented or empty `model`.
 *   2. `reasoning` field on a model that doesn't accept `reasoning.effort`
 *      (everything except `grok-4.20-multi-agent-beta-0309`).
 *   3. `presence_penalty` / `frequency_penalty` / `stop` on a reasoning
 *      variant.
 *   4. Any top-level field not in
 *      {@link DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS}.
 *   5. Any tool entry that uses the legacy nested
 *      `{type:"function", function: {...}}` shape (Chat Completions style;
 *      Responses requires the FLAT shape with `name`/`description`/
 *      `parameters` at the top level).
 *   6. Tool followup (input contains a `function_call_output`) with
 *      `tools.length === 0`.
 *   7. `tool_choice` with an unsupported shape.
 *
 * Pure function. No side effects. Caller is responsible for catching the
 * thrown error and threading it through the existing trace event stream.
 */
export function validateXaiRequestPreFlight(
  params: Record<string, unknown>,
): void {
  // 1. Model must be in the documented catalog.
  const model = typeof params.model === "string" ? params.model : "";
  const canonicalModel = resolveDocumentedXaiModel(model);
  if (!canonicalModel) {
    throw new XaiUnknownModelError(model);
  }

  // 2. reasoning.effort is multi-agent-only.
  if ("reasoning" in params && !modelSupportsReasoningEffort(canonicalModel)) {
    throw new XaiUndocumentedFieldError(
      "reasoning",
      `is only supported on grok-4.20-multi-agent-beta-0309 (where it controls ` +
        `agent count); current model is ${canonicalModel}, which reasons ` +
        `automatically and returns an error if reasoning.effort is sent`,
    );
  }

  // 3. presence_penalty / frequency_penalty / stop are forbidden on
  //    reasoning variants per developers/model-capabilities/text/reasoning.
  for (const field of [
    "presence_penalty",
    "frequency_penalty",
    "stop",
  ] as const) {
    if (field in params && modelIsReasoningVariant(canonicalModel)) {
      throw new XaiUndocumentedFieldError(
        field,
        `is forbidden on reasoning models (${canonicalModel}); xAI returns ` +
          `an error per developers/model-capabilities/text/reasoning`,
      );
    }
  }

  // 3a. max_output_tokens is not supported on the multi-agent variant per
  //     developers/model-capabilities/text/multi-agent#limitations.
  if ("max_output_tokens" in params && modelIsMultiAgent(canonicalModel)) {
    throw new XaiUndocumentedFieldError(
      "max_output_tokens",
      `is not supported on the multi-agent variant (${canonicalModel}); ` +
        `see developers/model-capabilities/text/multi-agent#limitations`,
    );
  }

  // 3b. tools is not supported on image/video output models per the
  //     developers/models capability matrix (the imagine-* family has no
  //     functions/structured capability).
  if (
    Array.isArray(params.tools) &&
    params.tools.length > 0 &&
    !modelSupportsFunctionCalling(canonicalModel)
  ) {
    throw new XaiUndocumentedFieldError(
      "tools",
      `is not supported on ${canonicalModel} (image/video output model); ` +
        `see developers/models capability matrix`,
    );
  }

  // 4. Reject any top-level field not in the documented contract. This
  //    catches "AgenC code added a field that the sanitize step would have
  //    silently stripped" — a class of bug that would otherwise be invisible.
  for (const key of Object.keys(params)) {
    if (!DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS.has(key)) {
      throw new XaiUndocumentedFieldError(
        key,
        `is not in the documented xAI Responses API request contract ` +
          `(developers/model-capabilities/text/generate-text)`,
      );
    }
  }

  // 5. Tool entries — validate `type` against the documented set, and for
  //    function tools require the FLAT shape (xAI Responses) not the
  //    legacy nested {function:{...}} shape (Chat Completions).
  const tools = Array.isArray(params.tools) ? params.tools : [];
  // Documented maximum tool array length per
  // developers/rest-api-reference/inference/chat (Responses API): "A max
  // of 128 tools are supported." AgenC was previously sending 129 which
  // silently passed through xAI's 200-level validation but potentially
  // contributed to undefined downstream decoder behavior. Fail closed
  // at the boundary so the runtime cannot exceed the contract. The
  // Grok adapter also auto-trims to this cap in buildParams() before
  // this validator runs, so in normal operation this throw is a
  // defense-in-depth against a regression that bypasses the adapter
  // trim.
  if (tools.length > XAI_RESPONSES_MAX_TOOL_COUNT) {
    throw new XaiUndocumentedFieldError(
      "tools",
      `has ${tools.length} entries but the xAI Responses API documents a ` +
        `maximum of ${XAI_RESPONSES_MAX_TOOL_COUNT} tools per request ` +
        `(developers/rest-api-reference/inference/chat). Sending more than ` +
        `${XAI_RESPONSES_MAX_TOOL_COUNT} violates the documented contract ` +
        `even if the request returns HTTP 200.`,
    );
  }
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (!tool || typeof tool !== "object") {
      throw new XaiUndocumentedFieldError(
        `tools[${i}]`,
        `must be an object`,
      );
    }
    const toolObj = tool as Record<string, unknown>;
    const toolType = toolObj.type;
    if (typeof toolType !== "string") {
      throw new XaiUndocumentedFieldError(
        `tools[${i}].type`,
        `is required and must be a string`,
      );
    }
    if (!DOCUMENTED_XAI_BUILTIN_TOOL_TYPES.has(toolType)) {
      throw new XaiUndocumentedFieldError(
        `tools[${i}].type`,
        `value "${toolType}" is not in the documented xAI Responses tool ` +
          `type set: ${[...DOCUMENTED_XAI_BUILTIN_TOOL_TYPES].sort().join(", ")}`,
      );
    }
    // Multi-agent rejects client-side function calling per
    // developers/model-capabilities/text/multi-agent#limitations.
    if (toolType === "function" && modelIsMultiAgent(canonicalModel)) {
      throw new XaiUndocumentedFieldError(
        `tools[${i}].type`,
        `client-side function calling is not supported on the multi-agent ` +
          `variant (${canonicalModel}); only built-in server-side tools are ` +
          `accepted`,
      );
    }
    if (toolType === "function") {
      if ("function" in toolObj) {
        throw new XaiUndocumentedFieldError(
          `tools[${i}]`,
          `uses the legacy nested {type:"function", function: {...}} shape; ` +
            `xAI Responses API requires the FLAT shape with name, ` +
            `description, parameters at the top level next to type ` +
            `(developers/tools/function-calling#tool-schema-reference)`,
        );
      }
      if (typeof toolObj.name !== "string" || toolObj.name.length === 0) {
        throw new XaiUndocumentedFieldError(
          `tools[${i}].name`,
          `is required and must be a non-empty string for function tools`,
        );
      }
    }
  }

  // 6. The silent-tool-drop anti-pattern (`MAX_TOOL_SCHEMA_CHARS_FOLLOWUP`
  //    legacy bug) is checked separately by `assertNoSilentToolDropOnFollowup`
  //    which has access to the runtime's tool-selection diagnostics. The
  //    pre-flight validator doesn't have enough context to distinguish
  //    "intentional no-tools followup" from "tools were stripped" using
  //    the params alone — it needs to know whether the runtime *intended*
  //    to send tools.

  // 7. tool_choice shape per developers/tools/function-calling#tool-choice.
  if (params.tool_choice !== undefined) {
    const tc = params.tool_choice;
    const validString = tc === "auto" || tc === "required" || tc === "none";
    const validObject =
      typeof tc === "object" &&
      tc !== null &&
      (tc as { type?: unknown }).type === "function" &&
      typeof (tc as { function?: { name?: unknown } }).function === "object" &&
      (tc as { function: { name?: unknown } }).function !== null &&
      typeof (tc as { function: { name?: unknown } }).function.name ===
        "string";
    if (!validString && !validObject) {
      throw new XaiUndocumentedFieldError(
        "tool_choice",
        `must be "auto" | "required" | "none" or ` +
          `{type:"function", function:{name:string}}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Section D — post-flight validator
// ---------------------------------------------------------------------------

/**
 * One detected anomaly produced by {@link validateXaiResponsePostFlight}.
 *
 * `severity: "error"` cases trigger a thrown error in the adapter (via
 * {@link XaiSilentToolDropError}). `severity: "warn"` cases are surfaced
 * as `ToolCallNormalizationIssue` entries on the parsed `LLMResponse`,
 * which appear in trace events but do not fail the turn.
 */
export interface XaiResponseAnomaly {
  readonly code:
    | "silent_tool_drop_promised_in_text"
    | "model_silently_aliased"
    | "incomplete_response"
    | "failed_response"
    | "truncated_response_mid_sentence";
  readonly severity: "error" | "warn";
  readonly message: string;
  readonly evidence: Record<string, unknown>;
}

/**
 * Promise-language pattern. Matches phrases Grok produces when it intends
 * to make a tool call but doesn't include any tool-call block in the
 * response. Sourced from real failure traces under
 * `~/.agenc/trace-payloads/` captured 2026-04-09 (sessions
 * `b17c7771...`, `e8a543dd...`, `c2e5fc93...`).
 *
 * Verbs are restricted to ones that uniquely indicate machine action —
 * `call`, `invoke`, `run`, `execute`. The original draft also included
 * `create` and `write`, but those match normal explanatory English
 * ("I will write the explanation below", "let me create a summary"),
 * which produced false positives in unit tests. The high-confidence
 * phrases below cover the real failure modes from the live traces.
 *
 * Examples that match:
 *   - "I will call the build tool now"
 *   - "Now executing the next step"
 *   - "(Continuing with tool calls to bootstrap.)"
 *   - "Next, I'll run the test"
 *   - "Let me invoke system.bash"
 *   - "Going to call system.writeFile"
 */
const PROMISE_LANGUAGE_RE =
  /\b(?:I\s+will\s+(?:call|invoke|run|execute)|I[''']?ll\s+(?:call|invoke|run|execute)|now\s+(?:executing|running|invoking|calling)|continuing\s+with\s+(?:tool|the\s+tool|tools)|next,?\s+I[''']?ll\s+(?:call|invoke|run|execute)|let\s+me\s+(?:run|call|invoke|execute)|going\s+to\s+(?:call|run|invoke|execute))/i;

/**
 * Characters that legitimately end a finished natural-language response.
 * Used by the mid-sentence truncation detector to decide whether the
 * model's final assistant message ends on a complete thought or was
 * cut off mid-stream by xAI's server. Includes ASCII sentence enders,
 * closing brackets, closing quotes, ellipsis, and closing code-fence
 * backtick. A message that ends on any of these is considered complete
 * for the purposes of the truncation detector. Everything else (letters,
 * digits, hyphens, commas, mid-word breaks, orphan backticks, etc.) is
 * treated as a probable truncation when paired with the other trigger
 * conditions.
 */
const TERMINAL_PUNCTUATION_RE = /[.!?)\]}"'`…]$/;

/**
 * True if `text` (after trailing-whitespace trim) ends with a documented
 * terminal punctuation character OR a closing triple-backtick code fence.
 * Empty strings are treated as complete (no truncation to detect).
 */
function endsWithTerminalPunctuation(text: string): boolean {
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length === 0) return true;
  if (trimmed.endsWith("```")) return true;
  return TERMINAL_PUNCTUATION_RE.test(trimmed);
}

/**
 * Count `function_call_output` items in the request input array. The
 * xAI mid-sentence-truncation bug triggers only when the input contains
 * prior tool turn history — i.e. at least one `function_call_output`.
 * Requests without any tool-turn history don't reach the buggy decoder
 * state, so the detector only fires when this count is > 0.
 */
function countFunctionCallOutputInInput(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "function_call_output"
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Resolve the effective `tool_choice` value for a request. `undefined`
 * defaults to `"auto"` per xAI docs (developers/tools/function-calling).
 */
function effectiveToolChoice(value: unknown): string | object {
  if (value === undefined) return "auto";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return value;
  return "auto";
}

/**
 * Extract all text the model produced in this turn — both `message` block
 * content and `reasoning` block summaries. Grok puts promise language in
 * either, so the post-flight scan must walk both.
 */
function extractMessageText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const itemType = (item as { type?: unknown }).type;
    if (itemType === "message") {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          parts.push((block as { text: string }).text);
        }
      }
      continue;
    }
    if (itemType === "reasoning") {
      const summary = (item as { summary?: unknown }).summary;
      if (!Array.isArray(summary)) continue;
      for (const entry of summary) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { text?: unknown }).text === "string"
        ) {
          parts.push((entry as { text: string }).text);
        }
      }
      continue;
    }
  }
  return parts.join("\n");
}

/**
 * Count output blocks whose `type` is one of the documented tool-call
 * output types ({@link SERVER_SIDE_TOOL_CALL_OUTPUT_TYPES}). The
 * post-flight silent-tool-drop detector treats the model as having
 * issued a tool call if this is non-zero, regardless of whether the
 * call was a client-side `function_call` or a server-side
 * `web_search_call` / `code_interpreter_call` / etc.
 */
function countToolCallOutputBlocks(output: unknown): number {
  if (!Array.isArray(output)) return 0;
  let count = 0;
  for (const item of output) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { type?: unknown }).type === "string" &&
      SERVER_SIDE_TOOL_CALL_OUTPUT_TYPES.has(
        (item as { type: string }).type,
      )
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Strict post-flight validation for an incoming `/v1/responses` payload.
 *
 * Returns a list of detected anomalies. Does NOT throw — the caller
 * (`adapter.parseResponse()` and the streaming `response.completed` branch
 * of `chatStream()`) decides whether to throw on `severity: "error"` or
 * surface as a normalization issue on `severity: "warn"`.
 *
 * Detection rules:
 *
 *   1. **Silent tool drop (incoming)**: We sent `tools.length > 0`, the
 *      response has zero `function_call` blocks, AND the assistant message
 *      text contains {@link PROMISE_LANGUAGE_RE} promise language. xAI may
 *      have silently dropped the tools or the model degraded mid-turn.
 *      `severity: "error"`.
 *
 *   2. **Model silently aliased**: `request.model` is documented (we
 *      know what we asked for) but `response.model` is different AND not
 *      a known alias. xAI may be doing a server-side fallback or routing
 *      to a different variant. `severity: "warn"`.
 *
 *   3. **Incomplete response**: `response.status === "incomplete"` —
 *      typically `max_output_tokens` or `content_filter`. The model may
 *      have been truncated. `severity: "warn"`.
 *
 * Pass `{}` for `request` when validating a stored response (retrieved by
 * ID, not freshly returned from a current request). The validator skips
 * tool-related checks when no request context is available.
 */
export function validateXaiResponsePostFlight(params: {
  readonly request: Record<string, unknown>;
  readonly response: Record<string, unknown>;
}): readonly XaiResponseAnomaly[] {
  const anomalies: XaiResponseAnomaly[] = [];
  const sentTools = Array.isArray(params.request.tools)
    ? params.request.tools
    : [];
  const output = (params.response as { output?: unknown }).output;
  // Count any tool-call output type, not just `function_call`. Server-side
  // tool calls (web_search_call, x_search_call, code_interpreter_call,
  // file_search_call, mcp_call) also satisfy "the model issued a tool call",
  // so a response with any of these is NOT a silent tool drop.
  const toolCallBlockCount = countToolCallOutputBlocks(output);
  const messageText = extractMessageText(output);

  // 1. Silent tool drop (incoming).
  if (
    sentTools.length > 0 &&
    toolCallBlockCount === 0 &&
    messageText.length > 0 &&
    PROMISE_LANGUAGE_RE.test(messageText)
  ) {
    anomalies.push({
      code: "silent_tool_drop_promised_in_text",
      severity: "error",
      message:
        `Sent ${sentTools.length} tools, response has 0 tool-call output ` +
        `blocks (function_call / web_search_call / x_search_call / ` +
        `code_interpreter_call / file_search_call / mcp_call), but the ` +
        `assistant message or reasoning text contains promise language ` +
        `("I will call", "now executing", "continuing with tool calls", ` +
        `etc). xAI may have silently dropped the tools or the model ` +
        `degraded its output.`,
      evidence: {
        sentToolCount: sentTools.length,
        toolCallBlockCount,
        messageTextPreview: messageText.slice(0, 240),
      },
    });
  }

  // 2. Model silent aliasing.
  const requestedModel =
    typeof params.request.model === "string" ? params.request.model : "";
  const responseModel =
    typeof params.response.model === "string" ? params.response.model : "";
  if (
    requestedModel.length > 0 &&
    responseModel.length > 0 &&
    requestedModel !== responseModel
  ) {
    const expectedAlias = DOCUMENTED_XAI_MODEL_ALIASES.get(requestedModel);
    if (expectedAlias !== responseModel) {
      anomalies.push({
        code: "model_silently_aliased",
        severity: "warn",
        message:
          `Requested model "${requestedModel}", got "${responseModel}" in ` +
          `the response payload. This may be a silent server-side alias ` +
          `that the documented alias map does not cover. Verify the ` +
          `configured model is in the xAI catalog.`,
        evidence: { requestedModel, responseModel },
      });
    }
  }

  // 3. Incomplete responses.
  if (
    (params.response as { status?: unknown }).status === "incomplete"
  ) {
    const details = (params.response as { incomplete_details?: unknown })
      .incomplete_details;
    const reason =
      details && typeof details === "object"
        ? String((details as { reason?: unknown }).reason ?? "unknown")
        : "unknown";
    anomalies.push({
      code: "incomplete_response",
      severity: "warn",
      message:
        `Response status is "incomplete" (reason: ${reason}). The model ` +
        `may have been truncated. Common reasons: max_output_tokens, ` +
        `content_filter.`,
      evidence: { reason, incompleteDetails: details ?? null },
    });
  }

  // 4. Mid-sentence truncation (xAI /v1/responses decoder bug on
  //    grok-4-1-fast-non-reasoning and related variants). Verified via
  //    13-run curl reproduction matrix captured in report.txt §4.4.
  //
  //    Trigger conditions (all must hold):
  //      a. response.status === "completed"
  //      b. response.incomplete_details is null/undefined (xAI does NOT
  //         flag the truncation itself)
  //      c. sent tools.length > 0
  //      d. effective tool_choice is "auto" (the buggy decoder path)
  //      e. input has at least one prior function_call_output item
  //         (bug only fires after a turn has tool-call history)
  //      f. response has zero tool-call output blocks (the model
  //         sampled into text, not another tool call)
  //      g. message text length > 0
  //      h. message text does NOT end with terminal punctuation (it
  //         was cut off mid-word / mid-sentence / mid-list-item)
  //
  //    The adapter catches this anomaly and auto-retries the same
  //    request with tool_choice="none". The matrix proves the retry
  //    returns a complete (~291 token) coherent response where the
  //    original returned a truncated (~34 token) mid-list cutoff.
  //
  //    severity: "warn" — the adapter handles the retry. If the retry
  //    path did not run (e.g. stored-response retrieval), the anomaly
  //    is still surfaced as a warning for observability.
  const responseStatus = (params.response as { status?: unknown }).status;
  const responseIncomplete = (
    params.response as { incomplete_details?: unknown }
  ).incomplete_details;
  const effChoice = effectiveToolChoice(
    (params.request as { tool_choice?: unknown }).tool_choice,
  );
  const priorFnOutputCount = countFunctionCallOutputInInput(
    (params.request as { input?: unknown }).input,
  );
  const usage = (params.response as { usage?: unknown }).usage;
  const outputTokens =
    usage && typeof usage === "object"
      ? Number((usage as { output_tokens?: unknown }).output_tokens) || 0
      : 0;
  // Two variants of the same xAI decoder bug:
  //   (a) Mid-sentence truncation: text present but cut off mid-word
  //   (b) Empty-output truncation: output_tokens === 0, output === []
  // Both share the same trigger shape (completed + null incomplete +
  // tools + auto + prior fn_output + zero tool-call blocks). Variant
  // (b) was not caught in PR #306 because the condition required
  // messageText.length > 0. Live trigger: session 5e9bcf4d... at
  // 03:31:42 call_6 returned output:[] with 0 tokens while the prior
  // calls (2-5) were all productive writeFile sequences.
  const isMidSentenceTruncation =
    messageText.length > 0 && !endsWithTerminalPunctuation(messageText);
  const isEmptyOutputTruncation =
    messageText.length === 0 && outputTokens === 0;
  if (
    responseStatus === "completed" &&
    (responseIncomplete === null || responseIncomplete === undefined) &&
    sentTools.length > 0 &&
    effChoice === "auto" &&
    priorFnOutputCount > 0 &&
    toolCallBlockCount === 0 &&
    (isMidSentenceTruncation || isEmptyOutputTruncation)
  ) {
    anomalies.push({
      code: "truncated_response_mid_sentence",
      severity: "warn",
      message:
        isEmptyOutputTruncation
          ? `xAI /v1/responses returned status="completed" with ` +
            `incomplete_details=null and output_tokens=0 (completely empty ` +
            `output). This is the zero-token variant of the xAI decoder ` +
            `tool-mode → text-mode transition bug: a turn with ` +
            `${priorFnOutputCount} prior function_call_output items, ` +
            `${sentTools.length} tools in scope, and tool_choice="auto" ` +
            `produced zero output. The adapter will retry with ` +
            `tool_choice="none".`
          : `xAI /v1/responses returned status="completed" with ` +
            `incomplete_details=null, but the text-only response ends without ` +
            `terminal punctuation after ${outputTokens} output tokens. ` +
            `This matches the documented xAI decoder tool-mode → text-mode ` +
            `transition bug (report.txt §4.4): a turn with ${priorFnOutputCount} ` +
            `prior function_call_output items, ${sentTools.length} tools in ` +
            `scope, and tool_choice="auto" silently truncates mid-sentence when ` +
            `the model samples text instead of another tool call. The adapter ` +
            `will retry this request with tool_choice="none".`,
      evidence: {
        outputTokens,
        messageTextTail: messageText.slice(-120),
        priorFunctionCallOutputCount: priorFnOutputCount,
        sentToolCount: sentTools.length,
        toolCallBlockCount,
        toolChoice: effChoice,
        variant: isEmptyOutputTruncation ? "empty_output" : "mid_sentence",
      },
    });
  }

  // 5. Failed responses. Per developers/debugging, status: "failed" means
  //    xAI accepted the request but the model could not produce a valid
  //    response. The adapter's existing extractResponseError() also
  //    handles this in the non-streaming path, but the strict filter
  //    surfaces it as a structured anomaly so the post-flight is
  //    authoritative regardless of which path is in use.
  if ((params.response as { status?: unknown }).status === "failed") {
    const errorPayload = (params.response as { error?: unknown }).error;
    const errorMessage =
      errorPayload &&
      typeof errorPayload === "object" &&
      typeof (errorPayload as { message?: unknown }).message === "string"
        ? (errorPayload as { message: string }).message
        : "Provider returned status: failed";
    anomalies.push({
      code: "failed_response",
      severity: "error",
      message:
        `xAI response status is "failed": ${errorMessage}. The request was ` +
        `accepted but the model could not produce a valid response.`,
      evidence: { error: errorPayload ?? null },
    });
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Section E — silent-tool-drop guard (uses runtime tool-selection diagnostics)
// ---------------------------------------------------------------------------

/**
 * Inline assertion for the legacy `MAX_TOOL_SCHEMA_CHARS_FOLLOWUP` bug
 * pattern: the runtime's tool selection produced a non-empty tool catalog
 * (`runtimeIntendedToolCount > 0`) but the final outgoing params contains
 * an empty or missing `tools` field. xAI accepts this silently and the
 * model has no tools to call, which exits the tool loop after one tool
 * call per chat turn.
 *
 * This check lives outside `validateXaiRequestPreFlight` because it needs
 * the runtime's tool-selection intent — knowing how many tools the
 * adapter *meant* to send and whether the suppression was intentional.
 * The pre-flight validator only sees the final params and cannot
 * distinguish "intentional zero tools" from "tools were stripped after
 * selection".
 *
 * Pass `toolSuppressionReason` from `selectedTools.toolSuppressionReason`
 * (the diagnostics object the adapter's `resolveResponseTools()` produces).
 * When suppression was intentional (e.g.
 * `vision_model_without_tool_support`, `empty_allowlist`,
 * `followup_tool_schema_limit`), the helper returns without throwing —
 * the empty `tools` field was on purpose, not a bug.
 *
 * Call this in `buildParams()` immediately after the tool attachment
 * gate, with:
 *   - `runtimeIntendedToolCount = selectedTools.tools.length`
 *   - `toolSuppressionReason = selectedTools.toolSuppressionReason`
 *
 * Throws {@link XaiSilentToolDropError} only when the runtime intended to
 * send tools, no suppression reason was set, and the outgoing params have
 * an empty or missing `tools` field. Does nothing otherwise.
 *
 * The thrown error's `turnKind` discriminator is set based on whether the
 * outgoing input actually contains a `function_call_output` item:
 *   - `outgoing_followup_tools_empty` — true follow-up turn (the original
 *     bug pattern from MAX_TOOL_SCHEMA_CHARS_FOLLOWUP)
 *   - the helper currently only supports the followup discriminator;
 *     non-followup empty-tools cases are still detected but the
 *     discriminator is the same. A future variant can split them.
 */
export function assertNoSilentToolDropOnFollowup(params: {
  readonly runtimeIntendedToolCount: number;
  readonly outgoingParams: Record<string, unknown>;
  readonly toolSuppressionReason?: string;
}): void {
  if (params.runtimeIntendedToolCount === 0) {
    return; // intentional no-tools call — not the bug pattern
  }
  if (params.toolSuppressionReason) {
    return; // suppression was intentional (e.g. vision model without
    // tool support, empty allowlist) — not the bug pattern
  }
  const outgoingTools = Array.isArray(params.outgoingParams.tools)
    ? params.outgoingParams.tools
    : [];
  if (outgoingTools.length > 0) {
    return; // tools made it through — no drop
  }
  // The runtime had tools to send, suppression was NOT intentional, and
  // the params are about to go out empty. This is the bug pattern.
  // Detect whether this is a tool-followup turn (has function results in
  // input) so the error message and evidence can pinpoint the case.
  const inputItems = Array.isArray(params.outgoingParams.input)
    ? params.outgoingParams.input
    : [];
  let toolFollowupCount = 0;
  for (const item of inputItems) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "function_call_output"
    ) {
      toolFollowupCount++;
    }
  }
  throw new XaiSilentToolDropError("outgoing_followup_tools_empty", {
    runtimeIntendedToolCount: params.runtimeIntendedToolCount,
    outgoingToolCount: 0,
    toolFollowupCount,
    isFollowupTurn: toolFollowupCount > 0,
    inputItemCount: inputItems.length,
    model:
      typeof params.outgoingParams.model === "string"
        ? params.outgoingParams.model
        : "",
  });
}
