/**
 * Stream retry classification and interrupted-stream cleanup for the
 * sampling request reconnect ladder. Retries discard unexecuted attempts;
 * dispatched tool work is retained for explicit user continuation.
 *
 * @module
 */

import {
  classifyLLMFailure,
  LLMAuthenticationError,
  LLMFundsError,
  LLMContextWindowExceededError,
  LLMMessageValidationError,
  LLMRateLimitError,
  LLMRequestRebuiltError,
  LLMServerError,
  LLMStreamTruncatedError,
  LLMStreamRetryDeniedError,
  LLMTimeoutError,
} from "../llm/errors.js";
import type { LLMToolCall } from "../llm/types.js";
import { StreamProgressError } from "../llm/stream-progress.js";
import { StreamModelError } from "../phases/stream-model.js";
import { isPartialProviderResponseError } from "../recovery/api-errors.js";
import {
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  serverDirectedRetryAfter,
} from "../recovery/reconnection.js";
import type { Session } from "./session.js";
import { emitError } from "./event-log.js";
import type { TurnState } from "./turn-state.js";

function streamRetryErrorCause(error: unknown): unknown {
  return error instanceof StreamModelError ? error.cause : error;
}

/** Controlled runtime stops, never provider prose containing these words. */
export function isStreamProgressStop(error: unknown): boolean {
  const cause = streamRetryErrorCause(error);
  return cause instanceof StreamProgressError ||
    (cause instanceof Error && cause.message.startsWith("stream_idle:"));
}

function streamRetryErrorStatus(error: unknown): number | undefined {
  const cause = streamRetryErrorCause(error);
  if (!cause || typeof cause !== "object") return undefined;
  const record = cause as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  const status = record.status ?? record.statusCode;
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
}

function streamRetryErrorMessage(error: unknown): string {
  const cause = streamRetryErrorCause(error);
  return cause instanceof Error ? cause.message : String(cause);
}

const TRANSIENT_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
]);

function streamRetryFailureLabel(cause: unknown): string {
  if (cause instanceof StreamProgressError) {
    if (cause.reason === "stream_degenerate") return "degenerate model output";
    return cause.reason === "stream_loop" ? "repetitive reasoning" : "no model progress";
  }
  if (cause instanceof Error && cause.message.startsWith("stream_idle")) {
    return "stream idle";
  }
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
    return `connection lost (${code})`;
  }
  switch (classifyLLMFailure(cause)) {
    case "rate_limited":
      return "rate limited";
    case "timeout":
      return "request timed out";
    case "provider_error": {
      const status = streamRetryErrorStatus(cause);
      return status !== undefined
        ? `provider error (HTTP ${status})`
        : "provider error";
    }
    default:
      return "stream interruption";
  }
}

function formatRetrySeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

/**
 * User-facing notice for one transient stream retry. Names the failure class
 * and the delay the reconnect ladder will honour: the server's Retry-After
 * when it sent one, otherwise the jittered exponential cap for this attempt
 * (`calculateReconnectDelay` draws the real delay from `[0, cap]`). Before
 * this every class, including a plain 429, was reported as "stream
 * interruption" with no delay.
 *
 * `attempt` is the number of provider calls made so far; the notice counts
 * the upcoming call against `maxAttempts`.
 *
 * @internal exported for unit tests.
 */
export function streamRetryNoticeMessage(
  error: unknown,
  attempt: number,
  maxAttempts: number,
): string {
  const label = streamRetryFailureLabel(streamRetryErrorCause(error));
  const directive = serverDirectedRetryAfter(error);
  let delay: string;
  if (directive.classification === "valid") {
    delay = `retrying in ${formatRetrySeconds(directive.floorMs)}`;
  } else if (directive.classification === "over_policy") {
    delay = `server asked to wait ${formatRetrySeconds(directive.floorMs)}, above the retry policy`;
  } else {
    const capMs = Math.min(
      RECONNECT_INITIAL_MS * 2 ** Math.max(0, attempt - 1),
      RECONNECT_MAX_MS,
    );
    delay = `retrying in up to ${formatRetrySeconds(capMs)}`;
  }
  return `${label}, ${delay} (${attempt + 1}/${maxAttempts}): ${streamRetryErrorMessage(error)}`;
}

function streamInterruptedToolResult(
  block: { readonly id: string; readonly name: string },
  error: unknown,
): string {
  const detail = streamRetryErrorMessage(error);
  return JSON.stringify({
    tool_use_id: block.id,
    is_error: true,
    content: `<tool_use_error>stream disconnected before ${block.name} completed: ${detail}</tool_use_error>`,
  });
}

function cleanupInterruptedStreamAttempt(
  state: TurnState,
  session: Session,
  error: unknown,
): void {
  const completedToolCallIds = new Set<string>();
  for (const result of state.toolResults) {
    if (
      "toolCallId" in result &&
      typeof result.toolCallId === "string" &&
      result.toolCallId.length > 0
    ) {
      completedToolCallIds.add(result.toolCallId);
    }
  }
  for (const block of state.toolUseBlocks) {
    if (completedToolCallIds.has(block.id)) continue;
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: block.id,
          result: streamInterruptedToolResult(block, error),
          isError: true,
          metadata: { cause: "stream_disconnected" },
        },
      },
    });
  }
  const executor = state.streamingToolExecutor as {
    abort?: (reason?: string) => void;
    discard?: (reason?: string) => void;
  } | null;
  try {
    if (typeof executor?.discard === "function") {
      executor.discard("connection_lost");
    } else if (typeof executor?.abort === "function") {
      executor.abort("connection_lost");
    }
  } catch {
    // I-41: cleanup paths must remain idempotent if the executor is already aborting.
  }
  state.assistantMessages = [];
  state.toolUseBlocks = [];
  state.toolResults = [];
  state.needsFollowUp = false;
  state.streamingToolExecutor = null;
  // A durable boundary lets live and replayed transcripts drop unfinished
  // text/input buffers instead of appending the next attempt to them.
  emitError(session, session.nextInternalSubId(), {
    cause: "stream_attempt_discarded",
    message: "Discarded interrupted model output before retry.",
    streamError: true,
  });
}

type InterruptedStreamHistoryState = TurnState & {
  suppressInterruptedStreamToolHistory?: boolean;
  interruptedStartedStreamToolCalls?: ReadonlyMap<string, LLMToolCall>;
};

function snapshotStartedInterruptedTools(state: TurnState): void {
  const executor = state.streamingToolExecutor as {
    getToolStates?: () => ReadonlyArray<{
      readonly id: string;
      readonly hasDispatched?: boolean;
      readonly toolCall?: LLMToolCall;
    }>;
  } | null;
  const started = new Map<string, LLMToolCall>();
  for (const tool of executor?.getToolStates?.() ?? []) {
    if (tool.hasDispatched !== true || tool.toolCall === undefined) continue;
    started.set(tool.id, { ...tool.toolCall });
  }
  if (started.size > 0) {
    (state as InterruptedStreamHistoryState).interruptedStartedStreamToolCalls =
      started;
  }
}

function interruptedStreamRetryBlockReason(
  state: TurnState,
  error?: unknown,
): string | null {
  const cause = streamRetryErrorCause(error);
  // A degenerate sample must never replay even a read-only tool. Block as
  // soon as a call is registered, before dispatch certainty is available.
  if (cause instanceof StreamProgressError && cause.reason === "stream_degenerate") {
    const executor = state.streamingToolExecutor as {
      getToolStates?: () => readonly unknown[];
    } | null;
    if (state.toolUseBlocks.length > 0 || (executor?.getToolStates?.().length ?? 0) > 0 || state.toolResults.length > 0) {
      return "not retrying degenerate output after streamed tool work; retry manually";
    }
  }
  const executor = state.streamingToolExecutor as {
    getToolStates?: () => ReadonlyArray<{
      readonly id: string;
      readonly status: string;
      readonly toolName: string;
      readonly hasDispatched?: boolean;
    }>;
  } | null;
  const toolStates = new Map(
    executor?.getToolStates?.().map((tool) => [tool.id, tool]) ?? [],
  );
  // The caller cancels queued work before this snapshot and before awaiting
  // admission. A read-only label is not permission to replay dispatched work.
  for (const tool of toolStates.values()) {
    if (tool.hasDispatched === false) continue;
    return `streamed tool ${tool.toolName} (${tool.id}) reached ${tool.status} and may have executed`;
  }
  for (const block of state.toolUseBlocks) {
    if (toolStates.get(block.id)?.hasDispatched === false) continue;
    return `the dispatch state of streamed tool ${block.name} (${block.id}) is unknown`;
  }
  return null;
}

function cancelQueuedInterruptedTools(state: TurnState): void {
  const executor = state.streamingToolExecutor as {
    cancelQueued?: (reason?: "connection_lost") => void;
  } | null;
  executor?.cancelQueued?.("connection_lost");
}

function suppressInterruptedStreamToolHistory(state: TurnState): void {
  snapshotStartedInterruptedTools(state);
  (
    state as InterruptedStreamHistoryState
  ).suppressInterruptedStreamToolHistory = true;
}

/**
 * Retryability classification via typed
 * error discrimination on the underlying cause rather than substring
 * matching against `error.message`, which is fragile: a
 * `LLMContextWindowExceededError` whose provider message happens to
 * contain "504" in metadata would previously false-match.
 *
 * Retryable causes:
 *   - stream_idle watchdog abort (thrown from stream-model with a
 *     plain `Error` whose message begins `stream_idle:` — the only
 *     remaining message-based check, since it carries no type).
 *   - `LLMServerError`   (HTTP 5xx from the provider envelope)
 *   - `LLMTimeoutError`  (request timed out / abort)
 *   - `LLMRateLimitError` (429 + retry-after)
 *   - transient node networking: error `code` in
 *     {ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, EAI_AGAIN}
 *
 * Non-retryable (explicit):
 *   - `LLMContextWindowExceededError` (413 — reactive compact owns it)
 *   - `LLMAuthenticationError`
 *   - `LLMMessageValidationError`
 *
 * T8 wires the full classification (reactive compact recovery, etc.).
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof StreamModelError)) return false;
  if (isPartialProviderResponseError(error)) return false;
  const cause = error.cause;
  if (cause instanceof LLMStreamRetryDeniedError) return false;
  if (cause instanceof StreamProgressError) return true;

  // Explicitly non-retryable typed causes — fail closed before any
  // generic branch so a provider message containing "504" can't
  // accidentally retry a context-window or auth failure.
  if (cause instanceof LLMContextWindowExceededError) return false;
  if (cause instanceof LLMFundsError) return false;
  if (cause instanceof LLMAuthenticationError) return false;
  if (cause instanceof LLMMessageValidationError) return false;

  // Typed retryable causes.
  if (cause instanceof LLMServerError) return true;
  if (cause instanceof LLMTimeoutError) return true;
  if (cause instanceof LLMRateLimitError) return true;
  // A stream that ended before its terminal event: nothing definitive came
  // back, so the request is re-sent through the same ladder as stream_idle.
  if (cause instanceof LLMStreamTruncatedError) return true;
  // The adapter already rebuilt its plan (xAI store refusal under an admitted
  // single wire attempt): nothing was sampled, the next attempt carries it.
  if (cause instanceof LLMRequestRebuiltError) return true;

  // Transient node networking via error `code`.
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "EAI_AGAIN"
    ) {
      return true;
    }
  }

  // stream_idle watchdog path throws a plain `Error` whose message is
  // `stream_idle: no data for Nms`. That's the sole remaining
  // message-based check and it's a controlled runtime string, not a
  // provider payload that could contain user-supplied substrings.
  if (cause instanceof Error && cause.message?.startsWith("stream_idle")) {
    return true;
  }

  return false;
}

// Shared with run-turn.ts and its sibling modules.
export {
  streamRetryErrorStatus,
  cleanupInterruptedStreamAttempt,
  interruptedStreamRetryBlockReason,
  cancelQueuedInterruptedTools,
  suppressInterruptedStreamToolHistory,
};
export type {
  InterruptedStreamHistoryState,
};
