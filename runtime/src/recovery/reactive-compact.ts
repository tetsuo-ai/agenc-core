/**
 * Reactive compaction — the second-level PTL recovery step.
 *
 * Hand-port of openclaude's reactive compact caller surface
 * caller surface (the module itself is feature-gated behind
 * `REACTIVE_COMPACT`; T8 ships the caller contract). When collapse-
 * drain can't release enough context (or isn't enabled), reactive-
 * compact summarizes older messages in-place and retries the request.
 *
 * The post-sample-recovery phase calls into this module after the
 * withhold-cascading gate routes the PTL message here. On success,
 * the state's `messagesForQuery` is replaced + the run-turn loop
 * transitions to `reactive_compact_retry`.
 *
 * Invariants covered:
 *   I-18 (compaction shrink assertion) — delegated to the underlying
 *        compact pipeline (compact.ts throws `CompactionShrinkRatioError`;
 *        the circuit breaker increments in autoCompactIfNeeded).
 *   I-40 (reactive-compact throw guard) — `tryReactiveCompact` can
 *        throw; we wrap in try/catch, emit `warning:'reactive_compact_threw'`,
 *        treat as failed outcome, increment circuit-breaker.
 *
 * Critical subtlety: `hasAttemptedReactiveCompact` is **preserved**
 * on stop-hook-blocking transitions (openclaude query.ts:1332 —
 * "Resetting caused infinite loop"). It's reset only on
 * token-budget-continuation (1369).
 *
 * @module
 */

import { emitWarning } from "../session/event-log.js";
import type { LLMMessage } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { AssistantMessage, TurnState } from "../session/turn-state.js";
import { runPostCompactCleanup } from "../llm/compact/post-compact-cleanup.js";
import { isMediaTooLargeMessage, isPromptTooLongMessage } from "./api-errors.js";

// ─────────────────────────────────────────────────────────────────────
// Driver surface — openclaude reactiveCompact.js or a future port
// ─────────────────────────────────────────────────────────────────────

export interface ReactiveCompactResult {
  readonly compactedMessages: ReadonlyArray<LLMMessage>;
  /** Summary of what was compacted (rollout stamping). */
  readonly summary?: string;
  /** Token count before / after — for I-18 shrink assertion. */
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
}

export interface ReactiveCompactDriver {
  isReactiveCompactEnabled(): boolean;
  isWithheldPromptTooLong(msg: AssistantMessage): boolean;
  isWithheldMediaSizeError(msg: AssistantMessage): boolean;
  tryReactiveCompact(input: {
    readonly hasAttempted: boolean;
    readonly messages: ReadonlyArray<LLMMessage>;
    readonly lastMessage: AssistantMessage;
    readonly session: Session;
    readonly state: TurnState;
  }): Promise<ReactiveCompactResult | null>;
}

/**
 * Minimum history length required to trigger inline reactive
 * compaction. Under this size the collapse would leave the tail
 * unchanged and cannot guarantee I-18 shrink, so the driver reports
 * nothing to compact.
 */
export const MIN_COMPACTABLE_TURNS = 6;

/**
 * Number of trailing user/assistant/tool messages the inline
 * compactor preserves verbatim. Older messages between the system
 * prompt and this tail are collapsed into one synthetic summary.
 */
export const KEEP_LAST_TURNS = 3;

/**
 * Collapse history into `[system?] + summary + tail`. Returns the
 * new message array and the number of dropped messages, or null
 * when input is too short. Enforces I-18 shrink: the output MUST
 * have fewer messages than the input, otherwise throws so the I-40
 * guard in `runReactiveCompact` records a circuit-breaker failure.
 */
export function inlineCollapseMessages(
  messages: ReadonlyArray<LLMMessage>,
): { compacted: LLMMessage[]; droppedCount: number } | null {
  if (messages.length < MIN_COMPACTABLE_TURNS) {
    return null;
  }
  const hasSystem = messages[0]?.role === "system";
  const systemPrefix: LLMMessage[] = hasSystem ? [messages[0]!] : [];
  const tailStart = Math.max(systemPrefix.length, messages.length - KEEP_LAST_TURNS);
  const middle = messages.slice(systemPrefix.length, tailStart);
  const tail = messages.slice(tailStart);
  if (middle.length === 0) {
    return null;
  }
  const summary: LLMMessage = {
    role: "user",
    content: `[summary of ${middle.length} earlier messages, elided for context pressure]`,
  };
  const compacted: LLMMessage[] = [...systemPrefix, summary, ...tail];
  if (compacted.length >= messages.length) {
    // I-18: shrink assertion. Must never produce a no-shrink result.
    throw new Error(
      `I-18 shrink assertion failed: input=${messages.length} output=${compacted.length}`,
    );
  }
  return { compacted, droppedCount: middle.length };
}

/**
 * Default driver: inline deterministic compactor. Preserves the
 * system prompt (if present) and the last `KEEP_LAST_TURNS`
 * messages, collapsing everything in between into a single
 * synthetic summary user message. Returns null when the history
 * is below `MIN_COMPACTABLE_TURNS`. This is the bounded fallback
 * that lets I-10 + I-40 fire in production until the full
 * openclaude compaction port lands.
 */
export const DEFAULT_REACTIVE_COMPACT_DRIVER: ReactiveCompactDriver = Object.freeze({
  isReactiveCompactEnabled: () => true,
  isWithheldPromptTooLong: (msg: AssistantMessage) => isPromptTooLongMessage(msg),
  isWithheldMediaSizeError: (msg: AssistantMessage) => isMediaTooLargeMessage(msg),
  async tryReactiveCompact(input: {
    readonly hasAttempted: boolean;
    readonly messages: ReadonlyArray<LLMMessage>;
  }): Promise<ReactiveCompactResult | null> {
    const collapsed = inlineCollapseMessages(input.messages);
    if (!collapsed) {
      return null;
    }
    return {
      compactedMessages: collapsed.compacted,
      summary: `Collapsed ${collapsed.droppedCount} earlier messages into a single summary.`,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────
// runReactiveCompact — orchestrator with I-40 throw guard
// ─────────────────────────────────────────────────────────────────────

export type ReactiveCompactOutcome =
  | { readonly kind: "compacted"; readonly result: ReactiveCompactResult }
  | { readonly kind: "noop"; readonly reason: string }
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "disabled" };

export interface RunReactiveCompactOpts {
  readonly session: Session;
  readonly state: TurnState;
  readonly lastMessage: AssistantMessage;
  readonly driver?: ReactiveCompactDriver;
}

/**
 * Run the reactive-compact step. I-40: wraps `tryReactiveCompact`
 * in try/catch; on throw emits `warning:'reactive_compact_threw'`,
 * increments the compaction circuit-breaker counter on state, and
 * returns `threw`. On success, mutates `state.messages` /
 * `state.messagesForQuery` + sets transition =
 * 'reactive_compact_retry'.
 */
export async function runReactiveCompact(
  opts: RunReactiveCompactOpts,
): Promise<ReactiveCompactOutcome> {
  const driver = opts.driver ?? DEFAULT_REACTIVE_COMPACT_DRIVER;
  if (!driver.isReactiveCompactEnabled()) {
    return { kind: "disabled" };
  }
  const supportsLastMessage =
    driver.isWithheldPromptTooLong(opts.lastMessage) ||
    driver.isWithheldMediaSizeError(opts.lastMessage);
  if (!supportsLastMessage) {
    return { kind: "noop", reason: "unsupported_last_message" };
  }

  // Skip when we've already tried + the flag is still set.
  // The flag is reset only by token-budget-continuation, preserved
  // across stop-hook-blocking (I-40 subtlety).
  if (state_hasAttemptedReactiveCompact(opts.state)) {
    return { kind: "noop", reason: "already_attempted_this_turn" };
  }

  let result: ReactiveCompactResult | null;
  try {
    result = await driver.tryReactiveCompact({
      hasAttempted: opts.state.hasAttemptedReactiveCompact,
      messages: opts.state.messagesForQuery,
      lastMessage: opts.lastMessage,
      session: opts.session,
      state: opts.state,
    });
    if (
      result &&
      result.compactedMessages.length >= opts.state.messagesForQuery.length
    ) {
      throw new Error(
        `I-18 shrink assertion failed: input=${opts.state.messagesForQuery.length} output=${result.compactedMessages.length}`,
      );
    }
  } catch (err) {
    // I-40: throw guard. Emit warning, increment circuit-breaker
    // on the turn's autoCompactTracking, return `threw` outcome.
    emitWarning(
      opts.session.eventLog,
      opts.session.nextInternalSubId(),
      "reactive_compact_threw",
      err instanceof Error ? err.message : String(err),
    );
    opts.state.hasAttemptedReactiveCompact = true;
    const tracking = opts.state.autoCompactTracking;
    if (tracking) {
      opts.state.autoCompactTracking = {
        ...tracking,
        consecutiveFailures: (tracking.consecutiveFailures ?? 0) + 1,
      };
    }
    return { kind: "threw", error: err };
  }

  if (!result || result.compactedMessages.length === 0) {
    opts.state.hasAttemptedReactiveCompact = true;
    return { kind: "noop", reason: "driver_returned_null" };
  }

  // Success path — rewire the state and signal the run-turn loop.
  const preCompactCount = opts.state.messagesForQuery.length;
  const postCompactCount = result.compactedMessages.length;
  // I-2: clear provider response ids before exposing the compacted
  // state back to the recovery ladder / phase machine.
  runPostCompactCleanup();
  const compactedMessages = [...result.compactedMessages];
  opts.state.messages = compactedMessages;
  opts.state.messagesForQuery = [...compactedMessages];
  opts.state.hasAttemptedReactiveCompact = true;
  opts.state.transition = { reason: "reactive_compact_retry" };

  // T6 gap #119: emit `thread_rolled_back` here — reactive-compact
  // swaps `messagesForQuery` with a shorter history, which is the
  // closest live semantic to "thread rollback" in the current runtime.
  // T13/T-recovery will add the true rollback-ladder path; when that
  // lands it should emit here too rather than inventing a new variant.
  // Emitting through `session.eventLog` (same pattern used by
  // `emitWarning` a few lines above) keeps the existing `mkSession`
  // fixtures working — they don't need to mock `session.emit`.
  const numTurns = Math.max(0, preCompactCount - postCompactCount);
  opts.session.eventLog.emit({
    id: opts.session.nextInternalSubId(),
    msg: {
      type: "thread_rolled_back",
      payload: {
        numTurns,
        reason: "reactive_compact",
      },
    },
  });
  return { kind: "compacted", result };
}

// ─────────────────────────────────────────────────────────────────────
// hasAttemptedReactiveCompact accessors with preserve/reset semantics
// ─────────────────────────────────────────────────────────────────────

function state_hasAttemptedReactiveCompact(state: TurnState): boolean {
  return state.hasAttemptedReactiveCompact === true;
}

/**
 * Reset helper — openclaude query.ts:1369 token-budget-continuation
 * path. Only this entry clears the flag; stop-hook-blocking
 * (query.ts:1332) must PRESERVE it.
 */
export function resetHasAttemptedReactiveCompact(state: TurnState): void {
  state.hasAttemptedReactiveCompact = false;
}
