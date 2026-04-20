/**
 * I-10 recovery trigger priority — the explicit ordered array.
 *
 * When the last assistant message satisfies more than one recovery
 * condition (e.g. both prompt-too-long + media-too-large, or tool
 * error + streaming fallback), the ladder evaluates in a fixed
 * documented order:
 *
 *   1. isWithheld413         → prompt-too-long (collapse-drain / reactive-compact)
 *   2. isWithheldMedia       → media size error (reactive-compact skips collapse)
 *   3. isWithheldMaxOutputTokens → max-output-tokens escalate/continuation
 *   4. stopHookBlocking      → stop-hook inject + re-enter
 *   5. streamingFallbackOccured → streaming fallback tombstone + recreate
 *   6. FallbackTriggeredError → model fallback swap
 *
 * Hand-port of openclaude `query.ts:1101, 1115, 854, 1335, 928`
 * order. Codifying the list makes the order testable +
 * refactoring-safe (test asserts the array matches the documented
 * order so future edits can't silently reorder).
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type {
  AssistantMessage,
  TurnState,
} from "../session/turn-state.js";
import {
  isFallbackTriggeredError,
  isStopHookBlocking,
  isStreamingFallbackOccured,
  isWithheld413Message,
  isWithheldMaxOutputTokens,
  isMediaTooLargeMessage,
  type FallbackTriggeredError,
} from "./api-errors.js";

// ─────────────────────────────────────────────────────────────────────
// Trigger context + outcome
// ─────────────────────────────────────────────────────────────────────

export interface TriggerContext {
  readonly session: Session;
  readonly state: TurnState;
  readonly lastMessage: AssistantMessage | undefined;
  readonly streamError: unknown | undefined;
}

export type TriggerOutcome =
  | { readonly kind: "applied"; readonly reason: string }
  | { readonly kind: "surface"; readonly reason: string }
  | { readonly kind: "pass" };

export interface RecoveryTrigger {
  readonly name: string;
  /** True when the trigger condition is met. */
  match(ctx: TriggerContext): boolean;
  /** Perform the strategy's state mutations. Returns how the ladder
   *  should proceed after this trigger. */
  apply(ctx: TriggerContext): Promise<TriggerOutcome>;
}

// ─────────────────────────────────────────────────────────────────────
// Default trigger set — dependency-injected actions plug in here.
// ─────────────────────────────────────────────────────────────────────

export interface TriggerActions {
  /** PTL gate → collapse-drain vs reactive-compact routing. */
  on413(ctx: TriggerContext): Promise<TriggerOutcome>;
  /** Media-size gate → direct reactive-compact. */
  onMedia(ctx: TriggerContext): Promise<TriggerOutcome>;
  /** Max-output-tokens → escalate or continuation. */
  onMaxOutputTokens(ctx: TriggerContext): Promise<TriggerOutcome>;
  /** Stop-hook blocking → inject + re-enter. */
  onStopHookBlocking(ctx: TriggerContext): Promise<TriggerOutcome>;
  /** Streaming fallback → tombstone + recreate executor. */
  onStreamingFallback(ctx: TriggerContext): Promise<TriggerOutcome>;
  /** Model fallback → tombstone + swap model. */
  onFallbackError(
    ctx: TriggerContext,
    error: FallbackTriggeredError,
  ): Promise<TriggerOutcome>;
}

/**
 * Build the ordered trigger array. The order is the invariant I-10
 * spec — do not reorder.
 */
export function buildDefaultTriggerOrder(
  actions: TriggerActions,
): ReadonlyArray<RecoveryTrigger> {
  return [
    {
      name: "isWithheld413",
      match: (ctx) => !!ctx.lastMessage && isWithheld413Message(ctx.lastMessage),
      apply: (ctx) => actions.on413(ctx),
    },
    {
      name: "isWithheldMedia",
      match: (ctx) => !!ctx.lastMessage && isMediaTooLargeMessage(ctx.lastMessage),
      apply: (ctx) => actions.onMedia(ctx),
    },
    {
      name: "isWithheldMaxOutputTokens",
      match: (ctx) =>
        !!ctx.lastMessage && isWithheldMaxOutputTokens(ctx.lastMessage),
      apply: (ctx) => actions.onMaxOutputTokens(ctx),
    },
    {
      name: "stopHookBlocking",
      match: (ctx) => isStopHookBlocking(ctx.state),
      apply: (ctx) => actions.onStopHookBlocking(ctx),
    },
    {
      name: "streamingFallbackOccured",
      match: (ctx) => isStreamingFallbackOccured(ctx.state),
      apply: (ctx) => actions.onStreamingFallback(ctx),
    },
    {
      name: "FallbackTriggeredError",
      match: (ctx) => isFallbackTriggeredError(ctx.streamError),
      apply: (ctx) =>
        actions.onFallbackError(ctx, ctx.streamError as FallbackTriggeredError),
    },
  ];
}

/**
 * The name array that tests MUST assert against. Changes here = changes
 * to I-10 spec — keep the two in sync.
 */
export const I10_TRIGGER_ORDER: ReadonlyArray<string> = Object.freeze([
  "isWithheld413",
  "isWithheldMedia",
  "isWithheldMaxOutputTokens",
  "stopHookBlocking",
  "streamingFallbackOccured",
  "FallbackTriggeredError",
]);
