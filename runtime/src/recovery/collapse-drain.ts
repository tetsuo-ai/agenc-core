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
 * I-2 (docs/plan/invariants.md:39-76): collapse-drain mutates the
 * model-visible history, so post-compact cleanup MUST clear
 * `previous_response_id` on the active provider. We pass a
 * session-backed cleanup context to `runPostCompactCleanup` and
 * also emit `context_compacted` via `session.emit()` so the
 * session-level listener (session.ts:1218-1223) fires and clears
 * the live `ProviderHttpClient.responsesContinuationState`.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import { runPostCompactCleanup } from "../llm/compact/post-compact-cleanup.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import type { CompactRuntimeContext } from "../session/compact-runtime-context.js";

type CollapseDrainTrackedState = TurnState & {
  collapseDrainAttempted?: boolean;
};

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

type SessionWithRecoveryServices = Session & {
  readonly services?: {
    readonly querySource?: string;
    readonly contextCollapse?: {
      readonly isContextCollapseEnabled?: () => boolean;
      readonly isEnabled?: () => boolean;
      readonly recoverFromOverflow?: (
        messages: ReadonlyArray<LLMMessage>,
        querySource?: string,
        ctx?: { readonly session: Session; readonly state: TurnState },
      ) =>
        | CollapseDrainResult
        | Promise<CollapseDrainResult>;
    };
  };
};

type SessionWithEmit = Session & {
  readonly emit?: (event: {
    readonly id: string;
    readonly msg: {
      readonly type: string;
      readonly payload?: Record<string, unknown>;
    };
  }) => void;
  readonly clearProviderResponseId?: () => void;
};

function readRecoveryQuerySource(session: Session): string | undefined {
  return (session as SessionWithRecoveryServices).services?.querySource;
}

function buildCleanupContext(
  session: Session,
): Pick<CompactRuntimeContext, "clearProviderResponseId"> {
  const s = session as SessionWithEmit;
  return {
    clearProviderResponseId: () => {
      if (typeof s.clearProviderResponseId === "function") {
        s.clearProviderResponseId();
      }
    },
  };
}

function tryEmitContextCompacted(session: Session, committed: number): void {
  const s = session as SessionWithEmit;
  if (typeof s.emit !== "function") {
    // Stub session (no session-level listener). The explicit cleanup
    // context passed to runPostCompactCleanup already cleared the
    // active ProviderHttpClient state; nothing more to do.
    return;
  }
  try {
    s.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "context_compacted",
        payload: {
          summary: `collapse drain committed ${committed} stage${committed === 1 ? "" : "s"}`,
        },
      },
    });
  } catch {
    // Best-effort: deterministic I-2 guarantee comes from the
    // runPostCompactCleanup call above, not from the event.
  }
}

function resolveCollapseDrainDriver(
  session: Session,
  explicitDriver?: CollapseDrainDriver,
): CollapseDrainDriver {
  if (explicitDriver) {
    return explicitDriver;
  }
  const collapse = (session as SessionWithRecoveryServices).services?.contextCollapse;
  if (!collapse || typeof collapse.recoverFromOverflow !== "function") {
    return NOOP_COLLAPSE_DRIVER;
  }
  return {
    isEnabled: () => {
      if (typeof collapse.isContextCollapseEnabled === "function") {
        return collapse.isContextCollapseEnabled();
      }
      if (typeof collapse.isEnabled === "function") {
        return collapse.isEnabled();
      }
      return true;
    },
    async recoverFromOverflow(
      messages: ReadonlyArray<LLMMessage>,
      ctx: { readonly session: Session; readonly state: TurnState },
    ): Promise<CollapseDrainResult> {
      const result = await collapse.recoverFromOverflow!(
        messages,
        readRecoveryQuerySource(ctx.session),
        ctx,
      );
      if (!result) {
        return { committed: 0, messages };
      }
      return result;
    },
  };
}

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

export function hasAttemptedCollapseDrain(state: TurnState): boolean {
  return (state as CollapseDrainTrackedState).collapseDrainAttempted === true;
}

export function resetCollapseDrainAttempted(state: TurnState): void {
  delete (state as CollapseDrainTrackedState).collapseDrainAttempted;
}

/**
 * Perform the one-shot drain. Returns `skipped_guard` when the state
 * shows we already drained this recovery pass (openclaude
 * `query.ts:1123` one-shot guard).
 *
 * On success: mutates `state.messages` / `state.messagesForQuery`
 * with the drained view, sets `state.transition = { reason:
 * 'collapse_drain_retry' }` so the run-turn loop re-enters
 * PrepareContext.
 *
 * I-2: before the new messages become visible to the retry path,
 * runs `runPostCompactCleanup` with a session-backed context that
 * carries `clearProviderResponseId` + emits `context_compacted`
 * via `session.emit()` so the session-level listener also clears
 * the live `ProviderHttpClient.responsesContinuationState`.
 */
export async function runCollapseDrain(
  state: TurnState,
  opts: CollapseDrainOpts,
): Promise<CollapseDrainOutcome> {
  // I-42: one-shot guard — openclaude query.ts:1123.
  if (hasAttemptedCollapseDrain(state)) {
    return { kind: "skipped_guard", committed: 0 };
  }
  const driver = resolveCollapseDrainDriver(opts.session, opts.driver);
  if (!driver.isEnabled()) {
    return { kind: "noop", committed: 0 };
  }
  const result = await driver.recoverFromOverflow(state.messagesForQuery, {
    session: opts.session,
    state,
  });
  if (result.committed > 0) {
    const drainedMessages = [...result.messages];
    // I-2: collapse-drain mutates the model-visible history, so it
    // must clear previous_response_id synchronously before retrying.
    // Pass a cleanup context so `ProviderHttpClient.responsesContinuationState`
    // is cleared, not just the grok IncrementalTracker registry.
    runPostCompactCleanup(
      readRecoveryQuerySource(opts.session),
      buildCleanupContext(opts.session),
    );
    state.messages = drainedMessages;
    state.messagesForQuery = [...drainedMessages];
    (state as CollapseDrainTrackedState).collapseDrainAttempted = true;
    state.transition = { reason: "collapse_drain_retry" };

    // I-2 belt-and-braces: emit `context_compacted` via session.emit
    // so the session-level listener (session.ts:1218-1223) also clears
    // the active provider response id. Matches manual-compact's
    // `applyCompactedHistory` pattern.
    tryEmitContextCompacted(opts.session, result.committed);

    return { kind: "drained", committed: result.committed };
  }
  return { kind: "noop", committed: 0 };
}
