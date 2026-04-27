/**
 * Phase 2 — Stream Model.
 *
 * Calls `LLMProvider.chatStream()` for one iteration, consuming chunks
 * as they arrive. Captures the assistant output into
 * `state.assistantMessages`, parses tool-use blocks into
 * `state.toolUseBlocks`, and updates `state.messages` with the new
 * assistant turn.
 *
 * Mirrors AgenC `query.ts:561-1082`.
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
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
} from "../llm/types.js";
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
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { AssistantMessage, ToolUseBlock, TurnState } from "../session/turn-state.js";

export interface StreamModelRequestContract {
  readonly input: ReadonlyArray<LLMMessage>;
  readonly tools: ReadonlyArray<LLMTool>;
  readonly parallelToolCalls: boolean;
  readonly baseInstructions: string;
}

interface AssistantDisplayState {
  parser: AssistantVisibleTextStreamParser;
  visibleText: string;
  emittedVisibleText: string;
  warnedMatches: Set<string>;
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
  const input = [...request.input];
  const baseInstructions = request.baseInstructions.trim();
  if (
    baseInstructions.length === 0 ||
    input[0]?.role === "system"
  ) {
    return input;
  }
  return [{ role: "system", content: baseInstructions }, ...input];
}

function buildProviderOptions(
  request: StreamModelRequestContract,
  ctx: TurnContext,
  signal: AbortSignal,
): LLMChatOptions {
  const allowedToolNames = request.tools.map((spec) => spec.function.name);
  const planMode = isPlanMode(ctx);
  return {
    signal,
    tools: request.tools,
    parallelToolCalls: request.parallelToolCalls,
    ...(planMode && request.tools.length > 0
      ? { toolChoice: "required" as const }
      : {}),
    toolRouting: { allowedToolNames },
    reasoningEffort:
      ctx.reasoningEffort && ctx.reasoningEffort !== "none"
        ? ctx.reasoningEffort
        : undefined,
    reasoningSummary: ctx.reasoningSummary,
    modelVerbosity: ctx.modelVerbosity,
    serviceTier:
      ctx.serviceTier === "fast" || ctx.serviceTier === "flex"
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

function emitSanitizedAssistantDelta(
  display: AssistantDisplayState,
  session: Session,
): void {
  const sanitized = sanitizeModelOutput(display.visibleText, { strict: true });
  if (sanitized.matches.length > 0) {
    emitSpoofWarnings(display, sanitized.matches, session);
  }
  if (!sanitized.text.startsWith(display.emittedVisibleText)) {
    display.emittedVisibleText = sanitized.text;
    return;
  }
  const delta = sanitized.text.slice(display.emittedVisibleText.length);
  display.emittedVisibleText = sanitized.text;
  if (delta.length === 0) return;
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "agent_message_delta",
      payload: { delta },
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
  // I-55: normalize tool_use blocks into canonical shape before the
  // validator sees them (provider-family quirks collapsed here).
  const normalizedToolCalls = normalizeToolCallsForProvider(
    providerName,
    response.toolCalls ?? [],
  );
  return {
    uuid: crypto.randomUUID(),
    role: "assistant",
    text: visible.text,
    toolCalls: normalizedToolCalls,
    apiError: response.finishReason === "error" ? "provider_error" : undefined,
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
): void {
  for (const failure of failures) {
    const id = extractToolUseId(failure.raw);
    if (!id) continue;
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
    throw new StreamModelError(
      new Error("aborted before provider call"),
    );
  }

  const planMode = isPlanMode(ctx);
  const messages = buildProviderMessages(request);

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
    emittedVisibleText: "",
    warnedMatches: new Set<string>(),
  };
  const providerName = session.services.provider.name;
  const streamedToolCalls = new Map<string, LLMToolCall>();
  const streamedToolBlocks = new Map<string, ToolUseBlock>();

  const onChunk = (chunk: LLMStreamChunk): void => {
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
      if (chunk.resetBuffer) {
        display.parser = new AssistantVisibleTextStreamParser(planMode);
        display.visibleText = display.parser.pushStr(chunk.content);
      } else {
        display.visibleText += display.parser.pushStr(chunk.content);
      }
      emitSanitizedAssistantDelta(display, session);
    }

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
        queueStreamingToolCall(executor, block, call, session);
      }
      state.toolUseBlocks = [...streamedToolBlocks.values()];
      state.needsFollowUp = state.toolUseBlocks.length > 0;
    }
  };

  let response: LLMResponse;
  try {
    response = await session.services.provider.chatStream(
      messages,
      onChunk,
      buildProviderOptions(request, ctx, scoped.signal),
    );
  } catch (error) {
    if (scoped.signal.aborted && watchdog.firedAt !== null) {
      throw new StreamModelError(
        new Error(`stream_idle: no data for ${watchdog.timeoutMs}ms`),
      );
    }
    throw new StreamModelError(error);
  } finally {
    watchdog.stop();
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  let assistant = assistantMessageFromResponse(
    response,
    planMode,
    providerName,
  );
  const mergedToolCalls = new Map(streamedToolCalls);
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
      );
    }
    assistant = {
      ...assistant,
      toolCalls: validatedMergedToolCalls.valid,
    };
  }
  state.assistantMessages = [assistant];
  const mergedToolBlocks = new Map(streamedToolBlocks);
  for (const block of parseToolUseBlocks([...assistant.toolCalls])) {
    mergedToolBlocks.set(block.id, block);
  }
  state.toolUseBlocks = [...mergedToolBlocks.values()];
  state.needsFollowUp = state.toolUseBlocks.length > 0;

  // Full final assistant_message event for renderers that batch on
  // completion rather than consuming per-chunk deltas.
  if (assistant.text && assistant.text.length > 0) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "agent_message",
        payload: { message: assistant.text },
      },
    });
  }

  // D1 fix: stash the provider-reported usage on TurnState so
  // `tryRunSamplingRequest` can thread it through SamplingRequestResult
  // instead of returning a hardcoded {0,0,0}. Downstream auto-compact
  // and the outer runTurn usage accumulator depend on real numbers.
  if (response.usage) {
    state.lastResponseUsage = {
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
    };
    // Cross-turn token accumulator — AgenC runtime
    // `Session::update_token_info_from_usage` (session/mod.rs:2739-2749)
    // plus `TokenUsageInfo::append_last_usage` (protocol.rs:2294-2297).
    // Runs under the session state lock so the mid-turn compact gate in
    // run-turn.ts sees a consistent read even when a concurrent
    // recovery path also touches state. Providers that don't surface
    // cache/reasoning fields contribute 0 to those slots, so missing
    // breakdowns don't leak as phantom tokens.
    const last = response.usage;
    const cached = (last as { cachedInputTokens?: number })
      .cachedInputTokens ?? 0;
    const reasoning = (last as { reasoningOutputTokens?: number })
      .reasoningOutputTokens ?? 0;
    await session.state.with((s) => {
      const prev = s.totalTokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
      };
      s.totalTokenUsage = {
        promptTokens: prev.promptTokens + last.promptTokens,
        completionTokens: prev.completionTokens + last.completionTokens,
        totalTokens: prev.totalTokens + last.totalTokens,
        cachedInputTokens: prev.cachedInputTokens + cached,
        reasoningOutputTokens: prev.reasoningOutputTokens + reasoning,
      };
    });
  }

  state.messages.push({
    role: "assistant",
    content: response.content,
    toolCalls:
      assistant.toolCalls.length > 0 ? [...assistant.toolCalls] : undefined,
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
      // legacy `kind/reason` union, so carry the upstream continuation
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
    const cached = (response.usage as { cachedInputTokens?: number })
      .cachedInputTokens;
    const reasoning = (response.usage as { reasoningOutputTokens?: number })
      .reasoningOutputTokens;
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "token_count",
        payload: {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
          ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
        },
      },
    });
  }

  if (response.error) {
    throw new StreamModelError(response.error, response);
  }
  return state;
}
