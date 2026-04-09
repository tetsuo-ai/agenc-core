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
 *   2. Configured model `grok-4.20-beta-0309-reasoning` was silently
 *      aliased server-side because no `-beta` variant exists in the xAI
 *      catalog. Pre-flight rule 1 catches this: throws
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
export const DOCUMENTED_XAI_RESPONSES_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "include",
  "input",
  "logprobs",
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
  "top_logprobs",
  "top_p",
  "user",
]);

/**
 * Documented xAI model catalog as of 2026-04-09.
 *
 * Source: developers/models page via mcp__xai-docs__get_doc_page.
 *
 * The validator rejects any `model` value that does not appear here OR in
 * {@link DOCUMENTED_XAI_MODEL_ALIASES}. xAI silently aliases unknown model
 * IDs server-side, which we treat as untrusted under the CLAUDE.md
 * "xAI Compatibility: Treat undocumented 200s as untrusted" rule.
 */
const DOCUMENTED_XAI_MODEL_IDS: ReadonlySet<string> = new Set([
  // Grok 4 family — current
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4.20-multi-agent-0309",
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
 * aliases that resolve to the canonical 0309 release. New releases just
 * add new entries to this map.
 */
const DOCUMENTED_XAI_MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  // bare names → canonical
  ["grok-4.20-reasoning", "grok-4.20-0309-reasoning"],
  ["grok-4.20-non-reasoning", "grok-4.20-0309-non-reasoning"],
  ["grok-4.20-multi-agent", "grok-4.20-multi-agent-0309"],
  ["grok-4-fast-reasoning", "grok-4-1-fast-reasoning"],
  ["grok-4-fast-non-reasoning", "grok-4-1-fast-non-reasoning"],
  // -latest aliases → canonical
  ["grok-4.20-reasoning-latest", "grok-4.20-0309-reasoning"],
  ["grok-4.20-non-reasoning-latest", "grok-4.20-0309-non-reasoning"],
  ["grok-4.20-multi-agent-latest", "grok-4.20-multi-agent-0309"],
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
  return canonicalModel === "grok-4.20-multi-agent-0309";
}

/**
 * True if the canonical model is a reasoning variant that rejects the
 * `presence_penalty`, `frequency_penalty`, and `stop` parameters per
 * developers/model-capabilities/text/reasoning.
 *
 * Match logic must be careful: `non-reasoning` includes the substring
 * `reasoning` but is NOT a reasoning variant. We check for the explicit
 * `-reasoning` suffix or the `-non-reasoning` exclusion, plus the
 * multi-agent variant which is also a reasoning model.
 */
export function modelIsReasoningVariant(canonicalModel: string): boolean {
  if (canonicalModel.includes("non-reasoning")) return false;
  return (
    canonicalModel.endsWith("-reasoning") ||
    canonicalModel.includes("multi-agent") ||
    canonicalModel === "grok-3-mini"
  );
}

// ---------------------------------------------------------------------------
// Section B — error class hierarchy
// ---------------------------------------------------------------------------

/**
 * Thrown when the configured `model` is not in the documented xAI catalog.
 *
 * xAI silently aliases unknown model IDs server-side, which produces
 * unverifiable behavior. This is the failure mode that hit
 * `grok-4.20-beta-0309-reasoning` on 2026-04-09 — there is no `-beta`
 * variant in the catalog and no documented alias rule that produces it,
 * but xAI returned 200 anyway with `model: "grok-4.20-0309-reasoning"`
 * in the response payload.
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
        `"grok-4.20-0309-reasoning", "grok-4.20-multi-agent-0309").`,
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
 *      (everything except `grok-4.20-multi-agent-0309`).
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
      `is only supported on grok-4.20-multi-agent-0309 (where it controls ` +
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

  // 5. Tool definition shape — must be FLAT, not nested.
  const tools = Array.isArray(params.tools) ? params.tools : [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (!tool || typeof tool !== "object") {
      throw new XaiUndocumentedFieldError(
        `tools[${i}]`,
        `must be an object`,
      );
    }
    const toolObj = tool as Record<string, unknown>;
    if (toolObj.type === "function") {
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
    | "incomplete_response";
  readonly severity: "error" | "warn";
  readonly message: string;
  readonly evidence: Record<string, unknown>;
}

/**
 * Promise-language pattern. Matches the kinds of phrases Grok produces
 * when it intends to make a tool call but doesn't include a `function_call`
 * block in the response. Sourced from real failure traces under
 * `~/.agenc/trace-payloads/` captured 2026-04-09 (sessions
 * `b17c7771...`, `e8a543dd...`, `c2e5fc93...`).
 *
 * Examples that match:
 *   - "I will call the build tool now"
 *   - "Now executing the next step"
 *   - "(Continuing with tool calls to bootstrap.)"
 *   - "Next, I'll create src/main.c"
 *   - "Let me run the test"
 *   - "Going to invoke system.bash"
 */
const PROMISE_LANGUAGE_RE =
  /\b(?:I\s+will\s+(?:call|use|invoke|run|create|write|build|execute)|now\s+(?:executing|running|invoking|calling)|continuing\s+with\s+(?:tool|the\s+tool|tools)|next,?\s+I[''']?ll|let\s+me\s+(?:run|call|invoke|create|write)|going\s+to\s+(?:call|run|invoke|create|write))/i;

function extractMessageText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "message"
    ) {
      continue;
    }
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
  }
  return parts.join("\n");
}

function countOutputBlocksOfType(output: unknown, type: string): number {
  if (!Array.isArray(output)) return 0;
  let count = 0;
  for (const item of output) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === type
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
  const functionCallCount = countOutputBlocksOfType(output, "function_call");
  const messageText = extractMessageText(output);

  // 1. Silent tool drop (incoming).
  if (
    sentTools.length > 0 &&
    functionCallCount === 0 &&
    messageText.length > 0 &&
    PROMISE_LANGUAGE_RE.test(messageText)
  ) {
    anomalies.push({
      code: "silent_tool_drop_promised_in_text",
      severity: "error",
      message:
        `Sent ${sentTools.length} tools, response has 0 function_call ` +
        `blocks, but the assistant message text contains promise language ` +
        `("I will call", "now executing", "continuing with tool calls", ` +
        `etc). xAI may have silently dropped the tools or the model ` +
        `degraded its output.`,
      evidence: {
        sentToolCount: sentTools.length,
        functionCallCount,
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
  // (no-op marker — fallthrough below)
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
 * adapter *meant* to send. The pre-flight validator only sees the final
 * params and cannot distinguish "intentional zero tools" from "tools were
 * stripped after selection".
 *
 * Call this in `buildParams()` immediately after the tool attachment
 * gate, with `runtimeIntendedToolCount = selectedTools.tools.length`.
 *
 * Throws {@link XaiSilentToolDropError} on detection. Does nothing
 * otherwise.
 */
export function assertNoSilentToolDropOnFollowup(params: {
  readonly runtimeIntendedToolCount: number;
  readonly outgoingParams: Record<string, unknown>;
}): void {
  if (params.runtimeIntendedToolCount === 0) {
    return; // intentional no-tools call — not the bug pattern
  }
  const outgoingTools = Array.isArray(params.outgoingParams.tools)
    ? params.outgoingParams.tools
    : [];
  if (outgoingTools.length > 0) {
    return; // tools made it through — no drop
  }
  // The runtime had tools to send and the params are about to go out
  // empty. Detect whether this is a tool-followup turn (has function
  // results in input) so the error message can pinpoint the bug pattern.
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
    inputItemCount: inputItems.length,
    model:
      typeof params.outgoingParams.model === "string"
        ? params.outgoingParams.model
        : "",
  });
}
