/**
 * Legacy-callback bridge for the Phase D streaming event vocabulary.
 *
 * Phase D defines a set of events that the Phase C async generator
 * `executeChat()` will yield. Phase E migrates 10 production
 * callers to consume the generator via `for await`. Between those
 * phases, and inside Phase E PRs that haven't yet flipped their
 * caller, the bridge in this module lets code:
 *
 *   1. Drain an `executeChat()` generator into the legacy
 *      `StreamProgressCallback` + `ChatExecutorResult` shape.
 *   2. Build a `ChatExecutorResult` from an event list + a
 *      `Terminal` + a caller-supplied scaffold with the fields
 *      that can't be reconstructed from events alone (provider,
 *      model, turnExecutionContract, planner/economics summaries,
 *      etc.).
 *
 * The bridge does NOT know how to produce events — that's the
 * generator's job in Phase C. It is a one-way adapter: events
 * (generator world) → legacy result shape (class-era world).
 *
 * @module
 */

import type { StreamProgressCallback } from "./types.js";
import type {
  ChatExecutorResult,
  ToolCallRecord,
} from "./chat-executor-types.js";
import type {
  ExecuteChatYield,
  StreamEvent,
  AssistantMessage,
  ToolResultMessage,
  Terminal,
} from "./streaming-events.js";
import type { LLMUsage } from "./types.js";

/**
 * Fields on `ChatExecutorResult` that cannot be reconstructed from
 * the event stream alone. Callers provide these when draining the
 * generator. Required fields are enforced by the type — callers
 * must build them during their migration PR rather than hoping the
 * bridge invents sensible defaults.
 */
export interface ChatExecutorResultSeed {
  readonly provider: string;
  readonly model?: string;
  readonly usedFallback: boolean;
  readonly callUsage: ChatExecutorResult["callUsage"];
  readonly turnExecutionContract: ChatExecutorResult["turnExecutionContract"];
  readonly completionState: ChatExecutorResult["completionState"];
  readonly stopReason: ChatExecutorResult["stopReason"];
  readonly providerEvidence?: ChatExecutorResult["providerEvidence"];
  readonly statefulSummary?: ChatExecutorResult["statefulSummary"];
  readonly toolRoutingSummary?: ChatExecutorResult["toolRoutingSummary"];
  readonly plannerSummary?: ChatExecutorResult["plannerSummary"];
  readonly economicsSummary?: ChatExecutorResult["economicsSummary"];
  readonly completionProgress?: ChatExecutorResult["completionProgress"];
  readonly activeTaskContext?: ChatExecutorResult["activeTaskContext"];
  readonly stopReasonDetail?: string;
  readonly validationCode?: ChatExecutorResult["validationCode"];
}

/**
 * Collected state accumulated as events drain.
 */
interface DrainAccumulator {
  finalContent: string;
  toolCalls: ToolCallRecord[];
  tokenUsage: LLMUsage;
  compacted: boolean;
  events: ExecuteChatYield[];
}

function createAccumulator(): DrainAccumulator {
  return {
    finalContent: "",
    toolCalls: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    compacted: false,
    events: [],
  };
}

function addUsage(target: LLMUsage, delta: LLMUsage | undefined): LLMUsage {
  if (!delta) return target;
  return {
    promptTokens: target.promptTokens + (delta.promptTokens ?? 0),
    completionTokens:
      target.completionTokens + (delta.completionTokens ?? 0),
    totalTokens: target.totalTokens + (delta.totalTokens ?? 0),
  };
}

function extractAssistantText(event: AssistantMessage): string {
  if (typeof event.content === "string") return event.content;
  // Content parts: concatenate `text` parts and drop non-text.
  const parts = event.content as readonly unknown[];
  let text = "";
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const partObj = part as { type?: unknown; text?: unknown };
    if (partObj.type === "text" && typeof partObj.text === "string") {
      text += partObj.text;
    }
  }
  return text;
}

function applyEvent(
  acc: DrainAccumulator,
  event: ExecuteChatYield,
): void {
  acc.events.push(event);
  switch (event.type) {
    case "stream_chunk":
      // No state to accumulate — the caller's stream callback (if
      // any) already saw the chunk.
      break;
    case "assistant": {
      const text = extractAssistantText(event);
      if (text.length > 0) acc.finalContent = text;
      acc.tokenUsage = addUsage(acc.tokenUsage, event.usage);
      break;
    }
    case "tool_result":
      acc.toolCalls.push(toolResultToRecord(event));
      break;
    case "tombstone":
      acc.compacted = true;
      break;
    case "request_start":
    case "tool_use_summary":
      break;
  }
}

function toolResultToRecord(event: ToolResultMessage): ToolCallRecord {
  return {
    name: event.toolName,
    args: {},
    result: event.content,
    isError: event.isError,
    durationMs: event.durationMs,
  };
}

/**
 * Drain an `executeChat()`-shape async generator. Fires the
 * caller-supplied `StreamProgressCallback` for every `stream_chunk`
 * event (preserving the existing callback contract). Returns the
 * terminal plus the accumulated event-derived fields so the caller
 * can assemble them into a legacy `ChatExecutorResult` via
 * `buildChatExecutorResultFromEvents`.
 */
export async function drainToLegacyCallbacks(
  generator: AsyncGenerator<ExecuteChatYield, Terminal, void>,
  callbacks: {
    readonly onStreamChunk?: StreamProgressCallback;
  } = {},
): Promise<{ terminal: Terminal; accumulated: DrainAccumulator }> {
  const acc = createAccumulator();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await generator.next();
    if (done) {
      return { terminal: value, accumulated: acc };
    }
    applyEvent(acc, value);
    if (value.type === "stream_chunk" && callbacks.onStreamChunk) {
      const chunk: StreamEvent = value;
      callbacks.onStreamChunk({
        content: chunk.content,
        done: chunk.done,
        toolCalls: chunk.toolCalls ? [...chunk.toolCalls] : undefined,
      });
    }
  }
}

/**
 * Build a legacy `ChatExecutorResult` from a drained generator's
 * accumulator + terminal + a caller-supplied seed scaffold. The
 * seed carries the fields that cannot be reconstructed from events
 * alone (provider name, model, turn execution contract, planner
 * summaries, etc.).
 *
 * The bridge prefers the terminal's finalContent over the last
 * assistant message so Phase I's reactive compaction path (which
 * may synthesize a terminal with an explicit reason) can override
 * the event stream.
 */
export function buildChatExecutorResultFromEvents(
  params: {
    readonly terminal: Terminal;
    readonly accumulated: DrainAccumulator;
    readonly seed: ChatExecutorResultSeed;
  },
): ChatExecutorResult {
  const { terminal, accumulated, seed } = params;
  const finalContent =
    terminal.finalContent.length > 0
      ? terminal.finalContent
      : accumulated.finalContent;
  // Terminal carries the authoritative tool call ledger post-Phase C.
  // Prefer it when populated; fall back to the accumulator's view.
  const toolCalls =
    terminal.toolCalls.length > 0
      ? terminal.toolCalls
      : accumulated.toolCalls;
  // Terminal's tokenUsage is the authoritative per-request sum. The
  // accumulator view is only used when the terminal reports zeros,
  // which happens for abort paths that never saw a usage report.
  const tokenUsage =
    terminal.tokenUsage.totalTokens > 0
      ? terminal.tokenUsage
      : accumulated.tokenUsage;
  return {
    content: finalContent,
    provider: seed.provider,
    model: seed.model,
    usedFallback: seed.usedFallback,
    toolCalls,
    providerEvidence: seed.providerEvidence,
    tokenUsage,
    callUsage: seed.callUsage,
    durationMs: terminal.durationMs,
    compacted: accumulated.compacted,
    statefulSummary: seed.statefulSummary,
    toolRoutingSummary: seed.toolRoutingSummary,
    plannerSummary: seed.plannerSummary,
    economicsSummary: seed.economicsSummary,
    stopReason: seed.stopReason,
    completionState: seed.completionState,
    completionProgress: seed.completionProgress,
    turnExecutionContract: seed.turnExecutionContract,
    activeTaskContext: seed.activeTaskContext,
    stopReasonDetail: seed.stopReasonDetail,
    validationCode: seed.validationCode,
  };
}

/**
 * Test helper and debugging utility: expose the internal
 * accumulator shape through the bridge boundary so unit tests can
 * seed state directly instead of constructing an async generator.
 */
export { createAccumulator, applyEvent, type DrainAccumulator };
