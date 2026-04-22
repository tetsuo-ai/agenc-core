/**
 * Tombstone orphan assistant messages.
 *
 * Hand-port of openclaude `query.ts:747-774`. When a streaming
 * response partially succeeds (enough for `assistantMessages` to be
 * populated) but then trips the streaming-fallback path, the partial
 * messages carry invalid signatures (especially thinking blocks)
 * that would cause "thinking blocks cannot be modified" API errors
 * on the next round-trip.
 *
 * Rule: tombstone each partial message → convert it into a
 * user-role placeholder the next request can safely include in
 * history. Clear `assistantMessages`, `toolResults`, `toolUseBlocks`.
 * Discard + recreate the StreamingToolExecutor so in-flight tool
 * calls can't leak orphan tool_use_ids.
 *
 * Invariants covered here:
 *   I-7  (stream abort cascade) — the tombstone+discard pair is the
 *        cleanup step every abort-destination funnels through.
 *   I-41 (abort re-entrance guard) — respected by the caller that
 *        invokes executor.discard(); second discard is a no-op.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type {
  AssistantMessage,
  TurnState,
  UserMessage,
} from "../session/turn-state.js";
import type { StreamingToolExecutor } from "../tools/streaming-executor.js";
import {
  appendTerminalToolResults,
  terminalToolCauseFromAbortReason,
  type TerminalToolCause,
} from "./terminal-tool-result.js";

// ─────────────────────────────────────────────────────────────────────
// Tombstone message shape
// ─────────────────────────────────────────────────────────────────────

export interface TombstoneMessage {
  readonly type: "tombstone";
  readonly originalUuid: string;
  readonly reason: string;
  readonly text: string;
}

export function toTombstoneUserMessage(
  orig: AssistantMessage,
  reason: string,
): UserMessage {
  const originalText = orig.text ?? "";
  const preview = originalText.slice(0, 200);
  return {
    uuid: crypto.randomUUID(),
    role: "user",
    content: `[assistant message tombstoned: ${reason}${
      preview ? ` — preview: ${preview}` : ""
    }]`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// tombstoneOrphans — the core cleanup step
// ─────────────────────────────────────────────────────────────────────

export interface TombstoneOrphansOpts {
  readonly reason: string;
  readonly terminalToolCause?: TerminalToolCause;
  readonly terminalToolDetail?: string;
  /** Optional in-flight tool executor to discard + recreate. */
  readonly executor?: StreamingToolExecutor | null;
}

/**
 * Convert orphan assistant messages into tombstone user messages
 * (pushed into `state.messages` so the next round trip can see the
 * gap) and clear the per-iteration buffers.
 *
 * `executor.discard()` is idempotent — I-41 re-entrance guard means
 * a second discard from a cleanup handler's throw is a no-op.
 *
 * Returns the set of tombstone messages produced so callers can
 * also emit them into the event stream for replay / telemetry.
 */
export function tombstoneOrphans(
  state: TurnState,
  opts: TombstoneOrphansOpts,
): ReadonlyArray<TombstoneMessage> {
  if (opts.reason !== "model_fallback") {
    const cause =
      opts.terminalToolCause ??
      terminalToolCauseFromAbortReason(opts.reason) ??
      "aborted";
    const detail =
      opts.terminalToolDetail ??
      (cause === "aborted" ? `recovery cleanup: ${opts.reason}` : undefined);
    appendTerminalToolResults(
      state,
      cause,
      detail,
    );
  }

  const tombstones: TombstoneMessage[] = [];
  for (const msg of state.assistantMessages) {
    const tombstone: TombstoneMessage = {
      type: "tombstone",
      originalUuid: msg.uuid,
      reason: opts.reason,
      text:
        (msg.text ?? "").length > 200
          ? `${msg.text?.slice(0, 200)}…`
          : msg.text ?? "",
    };
    tombstones.push(tombstone);
    state.messages.push(toTombstoneUserMessage(msg, opts.reason) as LLMMessage);
  }
  state.assistantMessages = [];
  state.toolResults = [];
  state.toolUseBlocks = [];
  state.needsFollowUp = false;

  if (opts.executor) {
    try {
      opts.executor.discard(opts.reason);
    } catch {
      /* I-41: re-entrance guard absorbs second discard */
    }
  }
  state.streamingToolExecutor = null;
  return tombstones;
}
