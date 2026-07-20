/**
 * Phase 2 — Stream Model.
 *
 * Calls `LLMProvider.chatStream()` for one iteration, consuming chunks
 * as they arrive. Captures the assistant output into
 * `state.assistantMessages`, parses tool-use blocks into
 * `state.toolUseBlocks`, and updates `state.messages` with the new
 * assistant turn.
 *
 * Mirrors agenc `query.ts:561-1082`.
 *
 * Invariants wired here:
 *   I-11 (stream idle watchdog, default-on) — installStreamWatchdog
 *        wraps the stream; `kick()` fires on every chunk. On idle
 *        expiry the watchdog aborts the underlying fetch via the
 *        scoped AbortController.
 *   I-22 (token budget mid-stream) — per-chunk
 *        `budgetTracker.addEmitted(..., "estimate") + sampleMidStream`
 *        keeps a coarse estimate during streaming, but the actual
 *        continuation decision is deferred to the boundary check using
 *        provider-reported completion tokens.
 *   I-77 (UI-spoof sanitization) — inline hidden tags stripped via
 *        the stream-parser before history injection.
 *
 * Tool calls dispatch through the shared StreamingToolExecutor as soon
 * as the provider streams them. Phase 5 still owns the final
 * close/drain path so conversation ordering stays
 * `assistant -> tool_result`.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
} from "../llm/types.js";
import { cloneLlmMessageSnapshot } from "../llm/content-conversion.js";
import {
  installStreamWatchdog,
  STREAM_IDLE_ABORT_REASON,
} from "../llm/stream-watchdog.js";
import {
  CitationStreamParser,
  ProposedPlanStreamParser,
  sanitizeModelOutput,
  stripCitations,
  stripProposedPlanBlocks,
} from "../llm/stream-parser.js";
import { normalizeToolCallsForProvider } from "../llm/tool-call-normalize.js";
import {
  ensureStreamingToolExecutor,
  queueStreamingToolCall,
  validateToolCallsForDispatch,
} from "./execute-tools.js";
import { isPlanMode } from "../session/plan-mode.js";
import { getInitialEffortSetting } from "../utils/effort.js";
import type { ReasoningEffort } from "../session/turn-context.js";

type WireReasoningEffort = NonNullable<LLMChatOptions["reasoningEffort"]>;

/**
 * Sessions created without an explicit reasoning effort — every
 * daemon-spawned interactive session today — must still honor the
 * persisted `effortLevel` from user settings. Without this fallback the
 * provider default applies and grok-4.5 burns ~16k hidden reasoning
 * tokens per trivial reply at xAI's HIGH default (measured: ~2m30s for
 * a 150-word answer, matching the user's "grok is fucking slow").
 * An explicit per-session "none" stays respected as an opt-out; values
 * outside the wire vocabulary ("max", "none") are dropped rather than
 * sent upstream to a provider that would reject them.
 */
function resolveSessionReasoningEffort(
  turnEffort: ReasoningEffort | undefined,
): WireReasoningEffort | undefined {
  if (turnEffort !== undefined) {
    return turnEffort === "none" ? undefined : turnEffort;
  }
  const settingsEffort = getInitialEffortSetting();
  switch (settingsEffort) {
    case "low":
    case "medium":
    case "high":
      return settingsEffort;
    default:
      return undefined;
  }
}

// Exported for unit tests; the wiring above is the single call site.
export { resolveSessionReasoningEffort };
import type { Session } from "../session/session.js";
import { disposeProviderStartupPrewarmHandle } from "../session/startup-prewarm.js";
import type { TurnContext } from "../session/turn-context.js";
import type {
  AssistantMessage,
  ToolUseBlock,
  TurnState,
} from "../session/turn-state.js";
import { runAdmittedModelCall } from "../budget/admitted-model-call.js";

export interface StreamModelRequestContract {
  readonly input: ReadonlyArray<LLMMessage>;
  readonly tools: ReadonlyArray<LLMTool>;
  readonly parallelToolCalls: boolean;
  readonly baseInstructions: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly skipCacheWrite?: boolean;
}

interface AssistantDisplayState {
  parser: AssistantVisibleTextStreamParser;
  visibleText: string;
  // gaphunt3 #43: incremental sanitizer replaces per-chunk full-buffer
  // re-sanitization. `emittedVisibleText` is no longer needed for diffing.
  sanitizer: IncrementalSpoofSanitizer;
  warnedMatches: Set<string>;
}

interface ThinkingDisplayState {
  raw: string;
  // gaphunt3 #43: incremental sanitizer replaces per-chunk full-buffer
  // re-sanitization of `raw`.
  sanitizer: IncrementalSpoofSanitizer;
  redacted: boolean;
  kind: "thinking" | "reasoning_summary";
  index: number;
  warnedMatches: Set<string>;
  closed: boolean;
}

class AssistantVisibleTextStreamParser {
  private readonly citations = new CitationStreamParser();
  private readonly plan?: ProposedPlanStreamParser;

  constructor(planMode: boolean) {
    this.plan = planMode ? new ProposedPlanStreamParser() : undefined;
  }

  pushStr(chunk: string): string {
    const citationChunk = this.citations.pushStr(chunk);
    return this.pushVisibleText(citationChunk.visibleText);
  }

  finish(): string {
    const citationChunk = this.citations.finish();
    let visibleText = this.pushVisibleText(citationChunk.visibleText);
    if (this.plan) {
      visibleText += this.plan.finish().visibleText;
    }
    return visibleText;
  }

  private pushVisibleText(text: string): string {
    if (!this.plan || text.length === 0) return text;
    return this.plan.pushStr(text).visibleText;
  }
}

function toVisibleAssistantText(
  rawText: string,
  planMode: boolean,
): { readonly text: string; readonly matches: ReadonlyArray<string> } {
  const citationsStripped = stripCitations(rawText).visibleText;
  const planVisibleText = planMode
    ? stripProposedPlanBlocks(citationsStripped)
    : citationsStripped;
  const sanitized = sanitizeModelOutput(planVisibleText, { strict: true });
  return {
    text: sanitized.text,
    matches: sanitized.matches,
  };
}

function buildProviderMessages(
  request: StreamModelRequestContract,
): LLMMessage[] {
  return request.input.map(cloneLlmMessageSnapshot);
}

function cloneProviderTools(tools: ReadonlyArray<LLMTool>): LLMTool[] {
  return tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      parameters: structuredClone(tool.function.parameters),
    },
  }));
}

function buildProviderOptions(
  request: StreamModelRequestContract,
  ctx: TurnContext,
  signal: AbortSignal,
): LLMChatOptions {
  const allowedToolNames = request.tools.map((spec) => spec.function.name);
  const planMode = isPlanMode(ctx);
  const systemPrompt = request.baseInstructions.trim();
  return {
    signal,
    tools: cloneProviderTools(request.tools),
    parallelToolCalls: request.parallelToolCalls,
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    ...(request.contextWindowTokens !== undefined
      ? { contextWindowTokens: request.contextWindowTokens }
      : {}),
    ...(request.maxOutputTokens !== undefined
      ? { maxOutputTokens: request.maxOutputTokens }
      : {}),
    ...(request.skipCacheWrite !== undefined
      ? { skipCacheWrite: request.skipCacheWrite }
      : {}),
    ...(planMode && request.tools.length > 0
      ? { toolChoice: "required" as const }
      : {}),
    toolRouting: { allowedToolNames },
    reasoningEffort: resolveSessionReasoningEffort(ctx.reasoningEffort),
    reasoningSummary: ctx.reasoningSummary,
    modelVerbosity: ctx.modelVerbosity,
    serviceTier:
      ctx.serviceTier === "fast" ||
      ctx.serviceTier === "priority" ||
      ctx.serviceTier === "flex"
        ? ctx.serviceTier
        : undefined,
  };
}

function emitSpoofWarnings(
  display: AssistantDisplayState,
  matches: ReadonlyArray<string>,
  session: Session,
): void {
  const unseen = matches.filter((label) => !display.warnedMatches.has(label));
  if (unseen.length === 0) return;
  for (const label of unseen) display.warnedMatches.add(label);
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause: "model_ui_spoof_pattern",
        message: `model output matched spoof pattern(s): ${unseen.join(", ")}`,
      },
    },
  });
}

function emitThinkingSpoofWarnings(
  state: ThinkingDisplayState,
  matches: ReadonlyArray<string>,
  session: Session,
): void {
  const unseen = matches.filter((label) => !state.warnedMatches.has(label));
  if (unseen.length === 0) return;
  for (const label of unseen) state.warnedMatches.add(label);
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause: "model_ui_spoof_pattern",
        message: `model thinking output matched spoof pattern(s): ${unseen.join(", ")}`,
      },
    },
  });
}

// gaphunt3 #43: incremental UI-spoof sanitization for the streaming hot
// path. The previous implementation re-ran `sanitizeModelOutput` over the
// ENTIRE accumulated buffer on every chunk, making total work O(n^2) in the
// message length. Instead, finalize and emit only the buffer prefix that is
// already "settled" (no in-progress spoof match can still alter it) and carry
// the unsettled tail forward. The concatenation of every emitted slice is
// byte-identical to a one-shot `sanitizeModelOutput(fullText, {strict:true})`.
//
// The matcher tables below mirror UI_SPOOF_PATTERNS in stream-parser.ts. They
// must be kept in lockstep with that source of truth: the SETTLED-prefix
// computation below is conservative (when in doubt it holds more text back, and
// the final flush always passes the remaining tail through sanitizeModelOutput),
// so a stale matcher can only cause cosmetic early/late delta splitting — never
// a sanitization escape, since the actual removal is always performed by
// sanitizeModelOutput on a contiguous settled segment.
//
// SPAN_* : `^...$` regexes matching a non-empty string that is a prefix of OR a
//          complete match of the pattern, consuming the whole input — i.e. a
//          match that could still GROW with future input ("open partial").
// FULL_* : `^...` regexes matching a complete occurrence at the current
//          position (used to skip past a finished, isolated match).
const SPOOF_SPAN_NONLINE: ReadonlyArray<RegExp> = [
  // [Approval Required]
  /^\[(?:A(?:p(?:p(?:r(?:o(?:v(?:a(?:l(?: (?:R(?:e(?:q(?:u(?:i(?:r(?:e(?:d(?:\])?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?$/i,
  // [Allow\s*/\s*Deny]
  /^\[(?:A(?:l(?:l(?:o(?:w(?:\s*(?:\/(?:\s*(?:D(?:e(?:n(?:y(?:\])?)?)?)?)?)?)?)?)?)?)?)?)?$/i,
  // [Yes\s*/\s*No](\s*:)?
  /^\[(?:Y(?:e(?:s(?:\s*(?:\/(?:\s*(?:N(?:o(?:\](?:\s*(?::)?)?)?)?)?)?)?)?)?)?)?$/i,
  // \x1B\[[0-9;]*[A-Za-z]
  // eslint-disable-next-line no-control-regex
  /^\x1B(?:\[[0-9;]*[A-Za-z]?)?$/,
];
const SPOOF_FULL_NONLINE: ReadonlyArray<RegExp> = [
  /^\[Approval Required\]/i,
  /^\[Allow\s*\/\s*Deny\]/i,
  /^\[Yes\s*\/\s*No\](\s*:)?/i,
  // eslint-disable-next-line no-control-regex
  /^\x1B\[[0-9;]*[A-Za-z]/,
];
// ^\s*agenc\s*[>:]\s is multiline-anchored, so it only starts at a line start.
// At the very buffer start the leading \s* may span newlines; after an internal
// `\n` the leading whitespace excludes newlines ([^\S\n]) because a newline
// there opens a fresh `^` anchor.
const SPOOF_SPAN_AGENC_START =
  /^\s*(?:a(?:g(?:e(?:n(?:c(?:\s*(?:[>:](?:\s)?)?)?)?)?)?)?)?$/i;
const SPOOF_SPAN_AGENC_NL =
  /^[^\S\n]*(?:a(?:g(?:e(?:n(?:c(?:\s*(?:[>:](?:\s)?)?)?)?)?)?)?)?$/i;
const SPOOF_FULL_AGENC_START = /^\s*agenc\s*[>:]\s/i;
const SPOOF_FULL_AGENC_NL = /^[^\S\n]*agenc\s*[>:]\s/i;

/**
 * gaphunt3 #43: length of the leading prefix of `buffer` that is "settled" —
 * fully resolvable now because no spoof match can still grow into or out of the
 * remaining tail. Everything in `[0, settledLen)` is safe to sanitize + emit;
 * `buffer.slice(settledLen)` is carried to the next chunk.
 *
 * Walks left-to-right: at each position it (a) holds if an OPEN partial begins
 * here (a match that could grow with future input), (b) skips a complete,
 * end-isolated match, or (c) treats the char as plain and advances one. For
 * plain text the walk advances every char and holds nothing, so the carry stays
 * empty and total work is O(n).
 */
function settledSpoofPrefixLen(
  buffer: string,
  pendingStartsLine: boolean,
  atBufferStart: boolean,
): number {
  let pos = 0;
  let lineStart = pendingStartsLine;
  let bufStart = atBufferStart;
  while (pos < buffer.length) {
    const slice = buffer.slice(pos);
    // (a) open partial that could still grow → unsettled from here.
    let open = false;
    for (const span of SPOOF_SPAN_NONLINE) {
      if (span.test(slice)) {
        open = true;
        break;
      }
    }
    if (!open && lineStart) {
      const span =
        pos === 0 && bufStart ? SPOOF_SPAN_AGENC_START : SPOOF_SPAN_AGENC_NL;
      if (span.test(slice)) open = true;
    }
    if (open) return pos;
    // (b) complete, end-isolated match (the open-partial check above already
    // caught any match that reaches the buffer end and could still grow).
    let matchLen = -1;
    if (lineStart) {
      const full =
        pos === 0 && bufStart ? SPOOF_FULL_AGENC_START : SPOOF_FULL_AGENC_NL;
      const r = full.exec(slice);
      if (r) matchLen = Math.max(matchLen, r[0].length);
    }
    for (const full of SPOOF_FULL_NONLINE) {
      const r = full.exec(slice);
      if (r) matchLen = Math.max(matchLen, r[0].length);
    }
    if (matchLen > 0) {
      // Removed text can expose a fresh line-start in the cleaned output, so
      // treat the next position as a line start.
      pos += matchLen;
      bufStart = false;
      lineStart = true;
      continue;
    }
    // (c) plain char.
    const ch = buffer[pos] as string;
    if (!/\s/.test(ch)) bufStart = false;
    lineStart = ch === "\n";
    pos += 1;
  }
  return buffer.length;
}

/**
 * gaphunt3 #43: stateful, incremental UI-spoof sanitizer. `push` consumes a new
 * delta and returns the newly-resolved sanitized text plus any spoof-pattern
 * labels seen for the first time; `flush` drains the carry buffer at
 * end-of-stream. The concatenation of every `push().text` followed by
 * `flush().text` equals `sanitizeModelOutput(fullText, {strict:true}).text`.
 */
export class IncrementalSpoofSanitizer {
  private carry = "";
  private readonly seenMatches = new Set<string>();
  // Does the carry begin at a line-start `^` anchor (buffer start, or the prior
  // emitted output ended with "\n")? And has any non-whitespace been emitted yet
  // (governs whether a buffer-start agenc match's leading \s* may span newlines)?
  private pendingStartsLine = true;
  private atBufferStart = true;

  push(delta: string): {
    readonly text: string;
    readonly newMatches: string[];
  } {
    if (delta.length === 0) return { text: "", newMatches: [] };
    this.carry += delta;
    const settledLen = settledSpoofPrefixLen(
      this.carry,
      this.pendingStartsLine,
      this.atBufferStart,
    );
    const finalized = this.carry.slice(0, settledLen);
    this.carry = this.carry.slice(settledLen);
    return this.sanitizeAndRecord(finalized);
  }

  flush(): { readonly text: string; readonly newMatches: string[] } {
    if (this.carry.length === 0) return { text: "", newMatches: [] };
    const remaining = this.carry;
    this.carry = "";
    return this.sanitizeAndRecord(remaining);
  }

  private sanitizeAndRecord(segment: string): {
    readonly text: string;
    readonly newMatches: string[];
  } {
    if (segment.length === 0) return { text: "", newMatches: [] };
    const startsLine = this.pendingStartsLine;
    // The agenc spoof pattern is multiline-anchored (`^\s*agenc...`). When this
    // segment is NOT at a real line start, sanitizing it in isolation would let
    // the regex's string-start `^` falsely treat a leading `agenc>` as a
    // line-start match. Prepend a non-whitespace sentinel so the leading `^\s*`
    // can't reach the `agenc`, then strip it back off. Sentinel is inert to
    // every spoof pattern and keeps internal `\n`-anchored agenc matches intact.
    const SENTINEL = "\u0000";
    const probe = startsLine ? segment : `${SENTINEL}${segment}`;
    const sanitized = sanitizeModelOutput(probe, { strict: true });
    const text =
      !startsLine && sanitized.text.startsWith(SENTINEL)
        ? sanitized.text.slice(SENTINEL.length)
        : sanitized.text;
    // Line-start / buffer-start state follows the SANITIZED output: removing a
    // bracket pattern can expose a fresh line-start agenc match in the cleaned
    // text. An empty output preserves the prior anchor state.
    if (text.length > 0) {
      this.pendingStartsLine = text.endsWith("\n");
      if (/\S/.test(text)) this.atBufferStart = false;
    }
    const newMatches: string[] = [];
    for (const label of sanitized.matches) {
      if (this.seenMatches.has(label)) continue;
      this.seenMatches.add(label);
      newMatches.push(label);
    }
    return { text, newMatches };
  }
}

function emitSanitizedThinkingDelta(
  state: ThinkingDisplayState,
  delta: string,
  index: number,
  session: Session,
): void {
  // redacted_thinking carries no displayable text; deltas should never reach
  // this path. Guard so a misbehaving provider can't accidentally surface
  // encrypted content as plaintext.
  if (state.redacted) return;
  // gaphunt3 #43: sanitize only the new delta (plus the carry window) instead
  // of re-scanning state.raw on every chunk.
  const sanitized = state.sanitizer.push(delta);
  if (sanitized.newMatches.length > 0) {
    emitThinkingSpoofWarnings(state, sanitized.newMatches, session);
  }
  if (sanitized.text.length === 0) return;
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "assistant_thinking_delta",
      payload: { delta: sanitized.text, index, kind: state.kind },
    },
  });
}

// gaphunt3 #43: drain the incremental sanitizer's carry buffer for a thinking
// block on close. A block may end with a held-back suffix (a possible
// cross-chunk spoof partial that never completed); the old full-buffer pass
// surfaced it on the last delta, so emit it here before the block_stop.
function flushSanitizedThinkingDelta(
  state: ThinkingDisplayState,
  session: Session,
): void {
  if (state.redacted) return;
  const flushed = state.sanitizer.flush();
  if (flushed.newMatches.length > 0) {
    emitThinkingSpoofWarnings(state, flushed.newMatches, session);
  }
  if (flushed.text.length === 0) return;
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "assistant_thinking_delta",
      payload: { delta: flushed.text, index: state.index, kind: state.kind },
    },
  });
}

function emitSanitizedAssistantDelta(
  display: AssistantDisplayState,
  delta: string,
  session: Session,
): void {
  // gaphunt3 #43: sanitize only the new delta (plus the carry window) instead
  // of re-scanning display.visibleText on every chunk.
  const sanitized = display.sanitizer.push(delta);
  if (sanitized.newMatches.length > 0) {
    emitSpoofWarnings(display, sanitized.newMatches, session);
  }
  if (sanitized.text.length === 0) return;
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "agent_message_delta",
      payload: { delta: sanitized.text },
    },
  });
}

function parseToolUseBlocks(toolCalls: LLMToolCall[]): ToolUseBlock[] {
  if (toolCalls.length === 0) return [];
  return toolCalls.map((c) => {
    let input: unknown = undefined;
    try {
      input = c.arguments ? JSON.parse(c.arguments) : undefined;
    } catch {
      input = c.arguments;
    }
    return {
      type: "tool_use" as const,
      id: c.id,
      name: c.name,
      input,
    };
  });
}

function assistantMessageFromResponse(
  response: LLMResponse,
  planMode: boolean,
  providerName: string,
): AssistantMessage {
  const visible = toVisibleAssistantText(response.content ?? "", planMode);
  // Task 28: `content_filter` is the normalized form of the provider
  // `refusal` stop reason (Claude Fable 5 safety classifiers return it on
  // HTTP 200, often with EMPTY content). Without an apiError mapping the
  // turn ended as a silent empty assistant message; surface it like the
  // other terminal stop reasons instead.
  const apiError =
    response.finishReason === "length"
      ? "max_output_tokens"
      : response.finishReason === "error"
        ? "provider_error"
        : response.finishReason === "content_filter"
          ? "refusal"
          : undefined;
  const allowToolCalls = response.finishReason !== "length";
  // I-55: normalize tool_use blocks into canonical shape before the
  // validator sees them (provider-family quirks collapsed here).
  const normalizedToolCalls = normalizeToolCallsForProvider(
    providerName,
    allowToolCalls ? (response.toolCalls ?? []) : [],
  );
  // A pre-output refusal carries no content at all; give the message a
  // clear user-visible body so the renderer doesn't show a blank turn.
  const text =
    apiError === "refusal" && visible.text.length === 0
      ? "The model declined to answer this request (stop reason: refusal). No content was returned — rephrase the request or try a different model."
      : visible.text;
  return {
    uuid: crypto.randomUUID(),
    role: "assistant",
    text,
    toolCalls: normalizedToolCalls,
    apiError,
  };
}

/**
 * Streaming-error class used to hoist provider errors into the commit
 * phase's terminal-decision logic without leaking Response types.
 */
export class StreamModelError extends Error {
  constructor(
    readonly cause: unknown,
    readonly response?: LLMResponse,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StreamModelError";
  }
}

/**
 * Translate the optional streaming-tool-use fields on an
 * {@link LLMStreamChunk} into AgenC session events that feed the TUI
 * bridge accumulator. Mirrors the upstream
 * content_block_start / input_json_delta handling at
 * `src/utils/messages.ts:3024-3079` — the chunk fields are
 * the AgenC-side equivalent of those upstream event payloads. Exported
 * so the row R6 parity test can drive it directly without booting a
 * full {@link streamModel} run.
 */
export function emitToolInputChunkEvents(
  chunk: LLMStreamChunk,
  session: Session,
): void {
  if (chunk.toolInputBlockStart) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_input_block_start",
        payload: chunk.toolInputBlockStart,
      },
    });
  }
  if (chunk.toolInputDelta) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_input_delta",
        payload: chunk.toolInputDelta,
      },
    });
  }
}

/**
 * Translate the optional thinking / reasoning_summary fields on an
 * {@link LLMStreamChunk} into AgenC `assistant_thinking_*` session events
 * that feed the TUI bridge accumulator. Mirrors the parallel
 * `emitToolInputChunkEvents` helper so the inline `onChunk` body in
 * {@link streamModel} stays focused on transport concerns. The
 * `displays` Map is mutable per-turn state shared across chunks — the
 * caller (streamModel) creates it once per stream and disposes it at
 * end-of-stream after flushing any unclosed blocks. Exported so the
 * thinking parity tests can drive it directly without booting a full
 * stream.
 */
export function emitThinkingChunkEvents(
  chunk: LLMStreamChunk,
  session: Session,
  displays: Map<string, ThinkingDisplayState>,
): void {
  if (chunk.thinkingBlockStart) {
    const { index, redacted } = chunk.thinkingBlockStart;
    const key = `thinking:${index}`;
    if (!displays.has(key)) {
      displays.set(key, {
        raw: "",
        sanitizer: new IncrementalSpoofSanitizer(),
        redacted,
        kind: "thinking",
        index,
        warnedMatches: new Set<string>(),
        closed: false,
      });
    }
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "assistant_thinking_block_start",
        payload: { index, redacted, kind: "thinking" },
      },
    });
  }
  if (chunk.thinkingDelta) {
    const { delta, index } = chunk.thinkingDelta;
    const key = `thinking:${index}`;
    let state = displays.get(key);
    if (!state) {
      state = {
        raw: "",
        sanitizer: new IncrementalSpoofSanitizer(),
        redacted: false,
        kind: "thinking",
        index,
        warnedMatches: new Set<string>(),
        closed: false,
      };
      displays.set(key, state);
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "assistant_thinking_block_start",
          payload: { index, redacted: false, kind: "thinking" },
        },
      });
    }
    if (delta.length > 0 && !state.redacted) {
      state.raw += delta;
      emitSanitizedThinkingDelta(state, delta, index, session);
    }
  }
  if (chunk.thinkingBlockStop) {
    const { index } = chunk.thinkingBlockStop;
    const key = `thinking:${index}`;
    const state = displays.get(key);
    if (state && !state.closed) {
      state.closed = true;
      // gaphunt3 #43: emit any carried-back tail before the block_stop.
      flushSanitizedThinkingDelta(state, session);
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "assistant_thinking_block_stop",
          payload: { index, kind: "thinking" },
        },
      });
    }
  }
  if (chunk.reasoningSummaryDelta) {
    const { delta, summaryIndex } = chunk.reasoningSummaryDelta;
    const key = `reasoning_summary:${summaryIndex}`;
    let state = displays.get(key);
    if (!state) {
      state = {
        raw: "",
        sanitizer: new IncrementalSpoofSanitizer(),
        redacted: false,
        kind: "reasoning_summary",
        index: summaryIndex,
        warnedMatches: new Set<string>(),
        closed: false,
      };
      displays.set(key, state);
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "assistant_thinking_block_start",
          payload: {
            index: summaryIndex,
            redacted: false,
            kind: "reasoning_summary",
          },
        },
      });
    }
    if (delta.length > 0) {
      state.raw += delta;
      emitSanitizedThinkingDelta(state, delta, summaryIndex, session);
    }
  }
}

export type { ThinkingDisplayState };

/**
 * Rough tokens-per-chunk estimator. Providers don't report per-chunk
 * token counts; we approximate with char-length / 4 (GPT's typical
 * English chars-per-token ratio). Good enough for I-22's sampling
 * gate which triggers every N tokens — overshoot by a few chunks
 * is acceptable.
 */
function estimateChunkTokens(chunk: LLMStreamChunk): number {
  let chars = chunk.content?.length ?? 0;
  if (chunk.toolCalls) {
    for (const tc of chunk.toolCalls) {
      chars += (tc.arguments?.length ?? 0) + (tc.name?.length ?? 0);
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * I-8 invariant — synthetic `tool_result` for malformed tool_use.
 *
 * When the provider streams a tool_use block that fails shape
 * validation (invalid json args, missing name, etc.) we can't
 * dispatch it, but the conversation invariant is every tool_use
 * paired to a tool_result. Emit a paired `tool_call_completed{isError}`
 * event for each dropped id so the history has a matching entry and
 * the next iteration doesn't stall.
 *
 * AgenC does the equivalent via `ensureToolResultPairing` in
 * `utils/messages.ts:5109`; AgenC's event stream is the direct
 * surface, so we emit here at the drop site.
 */
function emitMalformedToolCallSyntheticResults(
  session: Session,
  failures: ReadonlyArray<{ readonly raw: unknown; readonly cause: string }>,
  emittedCallIds: Set<string>,
): void {
  for (const failure of failures) {
    const id = extractToolUseId(failure.raw);
    if (!id) continue;
    if (emittedCallIds.has(id)) continue;
    emittedCallIds.add(id);
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: id,
          result: `<tool_use_error>malformed tool_use dropped (${failure.cause})</tool_use_error>`,
          isError: true,
        },
      },
    });
  }
}

function extractToolUseId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function streamModel(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  request: StreamModelRequestContract,
  signal?: AbortSignal,
): Promise<TurnState> {
  if (signal?.aborted) {
    throw new StreamModelError(new Error("aborted before provider call"));
  }

  const planMode = isPlanMode(ctx);

  // Scoped AbortController: aborted by either the external signal or
  // the watchdog, whichever fires first.
  const scoped = new AbortController();
  const onExternalAbort = () => {
    if (!scoped.signal.aborted) {
      scoped.abort((signal as AbortSignal & { reason?: unknown }).reason);
    }
  };
  if (signal) {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // I-11 watchdog installed BEFORE the stream begins so a stall at
  // first-byte also trips.
  const watchdog = installStreamWatchdog({
    abortController: scoped,
    onFired: (info) => {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "stream_error",
          payload: {
            cause: STREAM_IDLE_ABORT_REASON,
            message: `stream idle ${info.elapsedMs}ms (limit ${watchdog.timeoutMs}ms)`,
          },
        },
      });
    },
  });

  const display: AssistantDisplayState = {
    parser: new AssistantVisibleTextStreamParser(planMode),
    visibleText: "",
    sanitizer: new IncrementalSpoofSanitizer(),
    warnedMatches: new Set<string>(),
  };
  const thinkingDisplays = new Map<string, ThinkingDisplayState>();
  const providerName = session.services.provider.name;
  const streamedToolCalls = new Map<string, LLMToolCall>();
  const streamedToolBlocks = new Map<string, ToolUseBlock>();
  const malformedToolCompletionIds = new Set<string>();
  let receivedProviderChunk = false;

  const onChunk = (chunk: LLMStreamChunk): void => {
    receivedProviderChunk = true;
    // I-11: any chunk resets the idle timer.
    watchdog.kick();

    // I-22: per-chunk token accounting + sampling gate. The sampling
    // result is estimation-only; the continuation decision stays on
    // the boundary path so the final state uses provider-reported
    // completion tokens.
    if (session.budgetTracker) {
      session.budgetTracker.addEmitted(estimateChunkTokens(chunk), "estimate");
      session.budgetTracker.sampleMidStream();
    }

    // Incremental assistant_message_delta emission for renderers. The
    // visible text goes through the same hidden-tag stripping + UI-spoof
    // sanitization pipeline as the final assistant message so raw tags
    // never reach the UI.
    if (chunk.content && chunk.content.length > 0) {
      let visibleDelta: string;
      if (chunk.resetBuffer) {
        // gaphunt3 #43: a reset discards the prior buffer, so the
        // incremental sanitizer must reset too — the new visible text is a
        // fresh stream, not a continuation of the old carry/partial state.
        display.parser = new AssistantVisibleTextStreamParser(planMode);
        display.sanitizer = new IncrementalSpoofSanitizer();
        visibleDelta = display.parser.pushStr(chunk.content);
        display.visibleText = visibleDelta;
      } else {
        visibleDelta = display.parser.pushStr(chunk.content);
        display.visibleText += visibleDelta;
      }
      emitSanitizedAssistantDelta(display, visibleDelta, session);
    }

    // Incremental thinking emission. Messages-API providers emit
    // thinkingBlockStart / thinkingDelta / thinkingBlockStop for
    // extended-thinking content; Responses-API providers (xAI Grok
    // reasoning models, etc.) arrive as reasoningSummaryDelta. The helper
    // synthesises start/stop for the latter on first/last sight per index.
    emitThinkingChunkEvents(chunk, session, thinkingDisplays);

    emitToolInputChunkEvents(chunk, session);

    if (chunk.toolCalls && chunk.toolCalls.length > 0) {
      const normalizedToolCalls = normalizeToolCallsForProvider(
        providerName,
        chunk.toolCalls,
      );
      const validatedToolCalls = validateToolCallsForDispatch(
        normalizedToolCalls,
        session,
      );
      // I-8: a malformed tool_use chunk still has a provider-assigned
      // `id`, and the conversation invariant is every tool_use block
      // gets a paired tool_result. Emit a synthetic
      // `tool_call_completed{isError}` event paired to the dropped
      // id so the history has a matching entry — otherwise the next
      // iteration stalls on mismatched tool_use/tool_result pairing.
      if (validatedToolCalls.failures.length > 0) {
        emitMalformedToolCallSyntheticResults(
          session,
          validatedToolCalls.failures,
          malformedToolCompletionIds,
        );
      }
      if (validatedToolCalls.valid.length === 0) return;
      const executor = ensureStreamingToolExecutor(
        state,
        ctx,
        session,
        scoped.signal,
      );
      for (const call of validatedToolCalls.valid) {
        const block = parseToolUseBlocks([call])[0];
        if (!block) continue;
        streamedToolCalls.set(call.id, call);
        streamedToolBlocks.set(block.id, block);
        if (queueStreamingToolCall(executor, block, call, session)) {
          (
            executor as {
              dispatchPending?: (opts?: {
                readonly safeOnly?: boolean;
              }) => void;
            }
          ).dispatchPending?.({ safeOnly: true });
        }
      }
      state.toolUseBlocks = [...streamedToolBlocks.values()];
      state.needsFollowUp = state.toolUseBlocks.length > 0;
    }
  };

  let response: LLMResponse;
  const callProvider = async (
    provider: Pick<LLMProvider, "chatStream">,
    attempt: "primary" | "prewarm" | "prewarm_fallback",
  ): Promise<LLMResponse> => {
    const messages = buildProviderMessages(request);
    const options = buildProviderOptions(request, ctx, scoped.signal);
    const recoveryFallback = state.pendingAdmissionFallback;
    const clearRecoveryFallback = (): void => {
      // Do not clear a newer recovery decision installed while this attempt
      // was pending. The captured object identifies the decision handed to
      // the admission boundary below.
      if (state.pendingAdmissionFallback === recoveryFallback) {
        state.pendingAdmissionFallback = undefined;
      }
    };
    const model =
      recoveryFallback?.toModel ?? session.config?.model ?? ctx.config.model;
    const response = await runAdmittedModelCall({
      session,
      provider: session.services.provider,
      messages,
      options,
      stepId: `model:${ctx.subId}:${state.turnCount}:${state.recoveryReentryCount}:${attempt}`,
      sessionId: session.conversationId,
      model,
      providerName,
      signal: scoped.signal,
      ...(recoveryFallback !== undefined
        ? {
            fallback: {
              fromModel: recoveryFallback.fromModel,
              ...(recoveryFallback.fromProvider !== undefined
                ? { fromProvider: recoveryFallback.fromProvider }
                : {}),
              reason: recoveryFallback.reason,
            },
            onFallbackRecorded: clearRecoveryFallback,
          }
        : attempt === "prewarm_fallback"
        ? {
            fallback: {
              fromModel: model,
              fromProvider: providerName,
              reason: "startup_prewarm_failed_before_first_chunk",
            },
          }
        : {}),
      invoke: (admittedOptions) =>
        provider.chatStream(messages, onChunk, admittedOptions),
    });
    // Admission can be explicitly disabled for legacy callers. In that case
    // there is no durable evidence callback, but a completed wire call still
    // consumes the one-shot recovery decision.
    if (recoveryFallback !== undefined) {
      clearRecoveryFallback();
    }
    return response;
  };
  const startupPrewarmHandle =
    await session.services.startupPrewarm?.consumeProviderHandle({
      signal: scoped.signal,
    });
  let shouldDisposeStartupPrewarmHandle = startupPrewarmHandle !== undefined;
  try {
    response =
      startupPrewarmHandle !== undefined
        ? await callProvider(startupPrewarmHandle, "prewarm")
        : await callProvider(session.services.provider, "primary");
  } catch (error) {
    if (
      startupPrewarmHandle !== undefined &&
      !receivedProviderChunk &&
      !scoped.signal.aborted
    ) {
      try {
        await disposeProviderStartupPrewarmHandle(startupPrewarmHandle);
        shouldDisposeStartupPrewarmHandle = false;
      } catch {
        /* disposal is best-effort before direct provider fallback */
      }
      try {
        response = await callProvider(
          session.services.provider,
          "prewarm_fallback",
        );
      } catch (fallbackError) {
        throw new StreamModelError(fallbackError);
      }
    } else {
      if (scoped.signal.aborted && watchdog.firedAt !== null) {
        throw new StreamModelError(
          new Error(`stream_idle: no data for ${watchdog.timeoutMs}ms`),
        );
      }
      throw new StreamModelError(error);
    }
  } finally {
    if (
      startupPrewarmHandle !== undefined &&
      shouldDisposeStartupPrewarmHandle
    ) {
      try {
        await disposeProviderStartupPrewarmHandle(startupPrewarmHandle);
      } catch {
        /* provider prewarm handle disposal is best-effort */
      }
    }
    watchdog.stop();
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  // gaphunt3 #43: drain any carry the incremental sanitizer held back for a
  // possible cross-chunk spoof match (e.g. the buffer ended mid-`[Allow`). At
  // EOF that suffix can no longer complete into a match, so emit it now —
  // matching the old full-buffer pass which surfaced trailing text on the
  // final chunk.
  {
    const flushed = display.sanitizer.flush();
    if (flushed.newMatches.length > 0) {
      emitSpoofWarnings(display, flushed.newMatches, session);
    }
    if (flushed.text.length > 0) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "agent_message_delta",
          payload: { delta: flushed.text },
        },
      });
    }
  }

  let assistant = assistantMessageFromResponse(
    response,
    planMode,
    providerName,
  );
  const maxOutputTruncated = response.finishReason === "length";
  const mergedToolCalls = maxOutputTruncated
    ? new Map<string, LLMToolCall>()
    : new Map(streamedToolCalls);
  for (const call of assistant.toolCalls) {
    mergedToolCalls.set(call.id, call);
  }
  if (mergedToolCalls.size > 0) {
    const validatedMergedToolCalls = validateToolCallsForDispatch(
      [...mergedToolCalls.values()],
      session,
    );
    // I-8: same synthetic-tool_result invariant for the final merged
    // pass (covers providers that only surface tool_use blocks in the
    // final response envelope rather than per-chunk).
    if (validatedMergedToolCalls.failures.length > 0) {
      emitMalformedToolCallSyntheticResults(
        session,
        validatedMergedToolCalls.failures,
        malformedToolCompletionIds,
      );
    }
    assistant = {
      ...assistant,
      toolCalls: validatedMergedToolCalls.valid,
    };
  }
  state.assistantMessages = [assistant];
  if (maxOutputTruncated) {
    state.toolUseBlocks = [];
    state.needsFollowUp = false;
  } else {
    const mergedToolBlocks = new Map(streamedToolBlocks);
    for (const block of parseToolUseBlocks([...assistant.toolCalls])) {
      mergedToolBlocks.set(block.id, block);
    }
    state.toolUseBlocks = [...mergedToolBlocks.values()];
    state.needsFollowUp = state.toolUseBlocks.length > 0;
  }

  // Close any thinking displays the provider opened but never explicitly
  // closed (Responses-API reasoning_summary streams emit deltas without an
  // explicit block_stop event). Messages-API providers emit
  // content_block_stop so their blocks are already marked `closed: true`
  // by the chunk handler.
  for (const state of thinkingDisplays.values()) {
    if (state.closed) continue;
    state.closed = true;
    // gaphunt3 #43: drain the carry tail before the synthetic block_stop so a
    // reasoning_summary stream (no explicit block_stop) still surfaces its
    // final held-back text.
    flushSanitizedThinkingDelta(state, session);
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "assistant_thinking_block_stop",
        payload: { index: state.index, kind: state.kind },
      },
    });
  }

  // Full final assistant_message event for renderers that batch on
  // completion rather than consuming per-chunk deltas.
  if (!maxOutputTruncated && assistant.text && assistant.text.length > 0) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "agent_message",
        payload: { message: assistant.text },
      },
    });
  }

  // Final thinking persistence — emit one `agent_thinking` event per thinking
  // block on the response. The TUI bridge dedupes against `lastThinkingText`
  // so a streamed-then-flushed turn does not double-render. Skip on
  // truncated responses to match the existing `agent_message` guard.
  if (
    !maxOutputTruncated &&
    response.thinking &&
    response.thinking.length > 0
  ) {
    for (const block of response.thinking) {
      if (block.text.length === 0 && !block.redacted) continue;
      const sanitized = block.redacted
        ? { text: block.text, matches: [] as string[] }
        : sanitizeModelOutput(block.text, { strict: true });
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "agent_thinking",
          payload: {
            text: sanitized.text,
            ...(block.redacted ? { redacted: true } : {}),
            ...(block.kind !== undefined ? { kind: block.kind } : {}),
          },
        },
      });
    }
  }

  // D1 fix: stash the provider-reported usage on TurnState so
  // `tryRunSamplingRequest` can thread it through SamplingRequestResult
  // instead of returning a hardcoded {0,0,0}. Downstream auto-compact
  // and the outer runTurn usage accumulator depend on real numbers.
  if (response.usage) {
    const cached = response.usage.cachedInputTokens;
    const cacheCreation = response.usage.cacheCreationInputTokens;
    const reasoning = response.usage.reasoningOutputTokens;
    const webSearch = response.usage.webSearchRequests;
    const availability = response.usage.availability;
    const provenance = response.usage.provenance;
    state.lastResponseUsage = {
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
      ...(cacheCreation !== undefined
        ? { cacheCreationInputTokens: cacheCreation }
        : {}),
      ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
      ...(webSearch !== undefined ? { webSearchRequests: webSearch } : {}),
      ...(availability !== undefined ? { availability } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    };
    // Cross-turn token accumulator — agenc runtime
    // `Session::update_token_info_from_usage` (session/mod.rs:2739-2749)
    // plus `TokenUsageInfo::append_last_usage` (protocol.rs:2294-2297).
    // Runs under the session state lock so the mid-turn compact gate in
    // run-turn.ts sees a consistent read even when a concurrent
    // recovery path also touches state. Providers that don't surface
    // cache/reasoning fields contribute 0 to those slots, so missing
    // breakdowns don't leak as phantom tokens.
    const last = response.usage;
    const cachedForTotal = last.cachedInputTokens ?? 0;
    const reasoningForTotal = last.reasoningOutputTokens ?? 0;
    await session.state.with((s) => {
      const current = s.totalTokenUsage;
      const prev =
        typeof current === "number"
          ? {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: current,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
            }
          : (current ?? {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
            });
      s.totalTokenUsage = {
        promptTokens: prev.promptTokens + last.promptTokens,
        completionTokens: prev.completionTokens + last.completionTokens,
        totalTokens: prev.totalTokens + last.totalTokens,
        cachedInputTokens: prev.cachedInputTokens + cachedForTotal,
        reasoningOutputTokens: prev.reasoningOutputTokens + reasoningForTotal,
      };
    });
  }

  state.messages.push({
    role: "assistant",
    content: response.content,
    toolCalls:
      !maxOutputTruncated && assistant.toolCalls.length > 0
        ? [...assistant.toolCalls]
        : undefined,
  });

  // I-22: boundary check uses provider-reported completion tokens.
  // AgenC decides continuation from the finalized turn output,
  // not from an overshoot heuristic; the mid-stream sampler above is
  // only there to keep the local invariant's estimation path alive.
  if (session.budgetTracker) {
    const turnTokens = session.budgetTracker.resolveBoundaryTokens(
      response.usage?.completionTokens ?? 0,
    );
    const decision = session.budgetTracker.checkBoundary(turnTokens);
    if (decision.action === "continue") {
      // Local adaptation: `TurnState.pendingBudgetDecision` is still the
      // compatibility `kind/reason` union, so carry the upstream continuation
      // prompt in `reason` for post-sample-recovery to inject.
      state.pendingBudgetDecision = {
        kind: "stop",
        reason: decision.nudgeMessage,
      };
    } else {
      state.pendingBudgetDecision = undefined;
    }
  }

  // T6 gap #119: emit a `token_count` event with the provider-reported
  // LLMUsage so durable rollouts capture per-stream token accounting.
  // This stays AFTER the budget boundary check so any subscribed
  // CostSidecar updates do not feed the current iteration's
  // completion tokens back into the tracker before boundary truth is
  // resolved.
  if (response.usage) {
    const cached = response.usage.cachedInputTokens;
    const cacheCreation = response.usage.cacheCreationInputTokens;
    const reasoning = response.usage.reasoningOutputTokens;
    const webSearch = response.usage.webSearchRequests;
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "token_count",
        payload: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          model: response.model,
          provider: providerName,
          ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
          ...(cacheCreation !== undefined
            ? { cacheCreationInputTokens: cacheCreation }
            : {}),
          ...(reasoning !== undefined
            ? { reasoningOutputTokens: reasoning }
            : {}),
          ...(webSearch !== undefined ? { webSearchRequests: webSearch } : {}),
        },
      },
    });
  }

  if (response.error) {
    throw new StreamModelError(response.error, response);
  }
  return state;
}
