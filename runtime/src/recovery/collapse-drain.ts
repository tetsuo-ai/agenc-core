/**
 * Collapse-drain recovery strategy.
 *
 * Hand-port of openclaude `services/contextCollapse/index.js` +
 * `query.ts:1116-1149`. Context-collapse is a feature-gated
 * compaction layer: stage collapses are projected as a read-time
 * view over the full history. When a streaming response returns
 * PTL, the drain path applies all staged collapses to the actual
 * message array (consumed + committed), freeing context.
 *
 * Openclaude's real implementation calls `recoverFromOverflow()`
 * which lives behind the `CONTEXT_COLLAPSE` feature flag. AgenC
 * ships the **caller-side shape** (`recoverFromOverflow()` with a
 * pluggable `driver` parameter). The driver is the real collapse
 * store; when the feature is off (T8 default) the driver is a
 * no-op that returns `{committed: 0, messages}` unchanged. T7 +
 * T10 are already wired to produce the staged-collapse data; T8
 * just consumes it.
 *
 * Critical subtlety (openclaude `query.ts:1123`): the drain is
 * one-shot per recovery pass — guarded by checking
 * `state.transition?.reason !== 'collapse_drain_retry'` at the
 * entry gate. Violating this spirals.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";

// ─────────────────────────────────────────────────────────────────────
// Driver surface — T10 context-collapse plugs in here
// ─────────────────────────────────────────────────────────────────────

export interface CollapseDrainResult {
  /** Number of staged collapses actually committed. */
  readonly committed: number;
  /** Messages after the drain. */
  readonly messages: ReadonlyArray<LLMMessage>;
}

export interface CollapseDrainDriver {
  /** True when the feature flag is on + there's staged data to drain. */
  isEnabled(): boolean;
  /** Perform the drain. When disabled, must return a zero-committed result. */
  recoverFromOverflow(
    messages: ReadonlyArray<LLMMessage>,
    ctx: { readonly session: Session; readonly state: TurnState },
  ): Promise<CollapseDrainResult>;
}

/** Default no-op driver — CONTEXT_COLLAPSE feature flag off. */
export const NOOP_COLLAPSE_DRIVER: CollapseDrainDriver = Object.freeze({
  isEnabled: () => false,
  async recoverFromOverflow(messages: ReadonlyArray<LLMMessage>) {
    return { committed: 0, messages };
  },
});

// ─────────────────────────────────────────────────────────────────────
// Drain orchestration
// ─────────────────────────────────────────────────────────────────────

export interface CollapseDrainOpts {
  readonly driver?: CollapseDrainDriver;
  readonly session: Session;
}

export interface CollapseDrainOutcome {
  readonly kind: "drained" | "noop" | "skipped_guard";
  readonly committed: number;
}

/**
 * Perform the one-shot drain. Returns `skipped_guard` when the state
 * shows we already drained this recovery pass (openclaude
 * `query.ts:1123` one-shot guard).
 *
 * On success: mutates `state.messagesForQuery` with the drained view,
 * sets `state.transition = { reason: 'collapse_drain_retry' }` so
 * the run-turn loop re-enters PrepareContext.
 */
export async function runCollapseDrain(
  state: TurnState,
  opts: CollapseDrainOpts,
): Promise<CollapseDrainOutcome> {
  // I-42: one-shot guard — openclaude query.ts:1123.
  if (state.transition?.reason === "collapse_drain_retry") {
    return { kind: "skipped_guard", committed: 0 };
  }
  const driver = opts.driver ?? NOOP_COLLAPSE_DRIVER;
  if (!driver.isEnabled()) {
    return { kind: "noop", committed: 0 };
  }
  const result = await driver.recoverFromOverflow(state.messagesForQuery, {
    session: opts.session,
    state,
  });
  if (result.committed > 0) {
    state.messagesForQuery = [...result.messages];
    state.transition = { reason: "collapse_drain_retry" };
    return { kind: "drained", committed: result.committed };
  }
  return { kind: "noop", committed: 0 };
}
