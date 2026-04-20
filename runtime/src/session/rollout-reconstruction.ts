/**
 * Rollout reconstruction — rebuild `SessionState` from a JSONL
 * rollout file.
 *
 * Hand-port of codex `core/src/session/rollout_reconstruction.rs`
 * (304 LOC). The algorithm is a two-pass scan:
 *
 *   1. **Reverse scan** (newest → oldest): walk segments bounded by
 *      `TurnStarted` markers. Capture:
 *        - the newest surviving `CompactedItem.replacementHistory`
 *          (used as the baseline history — older items become
 *          irrelevant once this is found)
 *        - the newest surviving user-turn's `TurnContextItem`
 *          (baseline for resume)
 *        - `previousTurnSettings` from that same user turn's
 *          `TurnContext` (so a mid-session model change is preserved)
 *        - pending-rollback count from any `ThreadRolledBack` events
 *      Stop as soon as all three metadata fields are populated.
 *
 *   2. **Forward replay** (suffix after reverse-scan's earliest
 *      surviving boundary): apply each ResponseItem, Compacted,
 *      ThreadRolledBack to rebuild the exact history.
 *
 * Invariants wired here:
 *   I-26 (forward-compat unknown variant skipped) — unknown item types
 *        are passed through unchanged to the reducer.
 *   I-48 (orphaned TurnStarted recovery) — on replay completion, if
 *        the latest TurnStarted has no matching TurnComplete or
 *        TurnAborted, synthesize a `TurnAborted{reason:'process_killed'}`
 *        and emit warning.
 *   I-25 (snapshot best-effort, rollout is truth) — reconstruction
 *        NEVER reads the index.json snapshot. Rollout is authoritative.
 *
 * @module
 */

import type {
  CompactedItem,
  ResponseItem,
  RolloutItem,
  TurnContextItem,
} from "./rollout-item.js";
import { reduce, type ReducedSessionState } from "./event-log-reducer.js";

// ─────────────────────────────────────────────────────────────────────
// Reconstruction types
// ─────────────────────────────────────────────────────────────────────

export interface PreviousTurnSettings {
  readonly model: string;
  readonly realtimeActive?: boolean;
}

export interface RolloutReconstruction {
  readonly history: ResponseItem[];
  readonly previousTurnSettings?: PreviousTurnSettings;
  readonly referenceContextItem?: TurnContextItem;
  /** Orphaned TurnStarted events that got synthetic TurnAborted. */
  readonly orphanedTurnIds: ReadonlyArray<string>;
  /** Any synthesized events (I-48). Callers emit these warnings. */
  readonly synthesizedEvents: ReadonlyArray<RolloutItem>;
  /** Final reduced state used downstream. */
  readonly state: ReducedSessionState;
  /** Count of rolled-back user turns observed. */
  readonly rolledBackTurnsConsumed: number;
}

/** Internal: reverse-scan segment accumulator. */
type TurnReferenceContextItem =
  | { readonly kind: "never_set" }
  | { readonly kind: "cleared" }
  | { readonly kind: "latest"; readonly item: TurnContextItem };

interface ActiveReplaySegment {
  turnId?: string;
  countsAsUserTurn: boolean;
  previousTurnSettings?: PreviousTurnSettings;
  referenceContextItem: TurnReferenceContextItem;
  baseReplacementHistory?: ReadonlyArray<ResponseItem>;
}

function emptySegment(): ActiveReplaySegment {
  return {
    countsAsUserTurn: false,
    referenceContextItem: { kind: "never_set" },
  };
}

function turnIdsCompatible(active?: string, item?: string): boolean {
  if (active === undefined) return true;
  if (item === undefined) return true;
  return active === item;
}

/**
 * Is this ResponseItem a user-turn boundary? Codex uses a helper
 * `is_user_turn_boundary` that checks role==user AND message isn't
 * a tool_result injection. For AgenC T6 we adopt the simpler rule:
 * role==user.
 */
function isUserTurnBoundary(item: ResponseItem): boolean {
  return item.role === "user";
}

// ─────────────────────────────────────────────────────────────────────
// Reverse-scan finalize
// ─────────────────────────────────────────────────────────────────────

function finalizeActiveSegment(
  active: ActiveReplaySegment,
  pending: {
    baseReplacementHistory?: ReadonlyArray<ResponseItem>;
    previousTurnSettings?: PreviousTurnSettings;
    referenceContextItem: TurnReferenceContextItem;
    pendingRollbackTurns: number;
  },
): void {
  // Rollback: drop the newest N user-turn segments.
  if (pending.pendingRollbackTurns > 0) {
    if (active.countsAsUserTurn) {
      pending.pendingRollbackTurns -= 1;
    }
    return;
  }

  if (
    pending.baseReplacementHistory === undefined &&
    active.baseReplacementHistory !== undefined
  ) {
    pending.baseReplacementHistory = active.baseReplacementHistory;
  }

  if (
    pending.previousTurnSettings === undefined &&
    active.countsAsUserTurn &&
    active.previousTurnSettings !== undefined
  ) {
    pending.previousTurnSettings = active.previousTurnSettings;
  }

  if (
    pending.referenceContextItem.kind === "never_set" &&
    (active.countsAsUserTurn || active.referenceContextItem.kind === "cleared")
  ) {
    pending.referenceContextItem = active.referenceContextItem;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main reconstruction
// ─────────────────────────────────────────────────────────────────────

export function reconstructFromRollout(
  rolloutItems: ReadonlyArray<RolloutItem>,
): RolloutReconstruction {
  const pending = {
    baseReplacementHistory: undefined as ReadonlyArray<ResponseItem> | undefined,
    previousTurnSettings: undefined as PreviousTurnSettings | undefined,
    referenceContextItem: { kind: "never_set" } as TurnReferenceContextItem,
    pendingRollbackTurns: 0,
  };
  let rolloutSuffix: ReadonlyArray<RolloutItem> = rolloutItems;
  let active: ActiveReplaySegment | null = null;

  // Track orphan turn ids for I-48. A TurnStarted with no matching
  // TurnComplete/TurnAborted is an orphan.
  const seenStarted = new Set<string>();
  const seenTerminated = new Set<string>();

  // Reverse scan.
  for (let idx = rolloutItems.length - 1; idx >= 0; idx -= 1) {
    const item = rolloutItems[idx]!;
    switch (item.type) {
      case "compacted": {
        if (!active) active = emptySegment();
        if (active.referenceContextItem.kind === "never_set") {
          active.referenceContextItem = { kind: "cleared" };
        }
        if (
          active.baseReplacementHistory === undefined &&
          item.payload.replacementHistory !== undefined
        ) {
          active.baseReplacementHistory = item.payload.replacementHistory;
          rolloutSuffix = rolloutItems.slice(idx + 1);
        }
        break;
      }

      case "turn_context": {
        if (!active) active = emptySegment();
        if (active.turnId === undefined) {
          active.turnId = item.payload.turnId;
        }
        if (turnIdsCompatible(active.turnId, item.payload.turnId)) {
          active.previousTurnSettings = { model: item.payload.model };
          if (active.referenceContextItem.kind === "never_set") {
            active.referenceContextItem = { kind: "latest", item: item.payload };
          }
        }
        break;
      }

      case "response_item": {
        if (!active) active = emptySegment();
        active.countsAsUserTurn =
          active.countsAsUserTurn || isUserTurnBoundary(item.payload);
        break;
      }

      case "event_msg": {
        const inner = item.payload.msg;
        const innerType = (inner as { type?: string }).type;
        switch (innerType) {
          case "thread_rolled_back": {
            const payload = (inner as unknown as { payload: { numTurns: number } }).payload;
            pending.pendingRollbackTurns += payload?.numTurns ?? 0;
            break;
          }
          case "turn_complete": {
            if (!active) active = emptySegment();
            const payload = (inner as unknown as { payload: { turnId: string } }).payload;
            if (active.turnId === undefined) active.turnId = payload.turnId;
            seenTerminated.add(payload.turnId);
            break;
          }
          case "turn_aborted": {
            if (!active) active = emptySegment();
            const payload = (inner as unknown as { payload: { turnId?: string } }).payload;
            if (active.turnId === undefined && payload.turnId) {
              active.turnId = payload.turnId;
            }
            if (payload.turnId) seenTerminated.add(payload.turnId);
            break;
          }
          case "user_message": {
            if (!active) active = emptySegment();
            active.countsAsUserTurn = true;
            break;
          }
          case "turn_started": {
            const payload = (inner as unknown as { payload: { turnId: string } }).payload;
            seenStarted.add(payload.turnId);
            if (
              active &&
              turnIdsCompatible(active.turnId, payload.turnId)
            ) {
              // Finalize the segment — TurnStarted is the oldest
              // boundary of this reverse-scan segment.
              finalizeActiveSegment(active, pending);
              active = null;
            }
            break;
          }
          default:
            break;
        }
        break;
      }

      case "session_meta":
      case "session_state":
        break;
    }

    // Early termination: all required metadata found.
    if (
      pending.baseReplacementHistory !== undefined &&
      pending.previousTurnSettings !== undefined &&
      pending.referenceContextItem.kind !== "never_set"
    ) {
      break;
    }
  }

  // Finalize any dangling segment.
  if (active !== null) {
    finalizeActiveSegment(active, pending);
  }

  // Forward replay over the suffix using the reducer.
  let state: ReducedSessionState = {
    history: pending.baseReplacementHistory
      ? [...pending.baseReplacementHistory]
      : [],
    rolledBackTurns: 0,
    lastSeq: 0,
  };

  for (const item of rolloutSuffix) {
    const step = reduce(state, item);
    state = step.state;
  }

  // Handle legacy compactions without replacementHistory. Codex's
  // full rebuild path lives in compact/build_compacted_history; in
  // AgenC we treat this as "preserve history as-is and drop the
  // reference context" (matches codex line 292-296).
  let sawLegacyCompactionWithoutReplacement = false;
  for (const item of rolloutSuffix) {
    if (
      item.type === "compacted" &&
      item.payload.replacementHistory === undefined
    ) {
      sawLegacyCompactionWithoutReplacement = true;
      break;
    }
  }

  // I-48: orphan-TurnStarted recovery. For each started-but-not-terminated
  // turn, synthesize a TurnAborted{reason:'process_killed'} event so
  // reducers downstream see a consistent turn lifecycle.
  const orphanedTurnIds: string[] = [];
  const synthesized: RolloutItem[] = [];
  for (const turnId of seenStarted) {
    if (!seenTerminated.has(turnId)) {
      orphanedTurnIds.push(turnId);
      synthesized.push({
        type: "event_msg",
        payload: {
          id: `orphan-recovery-${turnId}`,
          msg: {
            type: "turn_aborted",
            payload: {
              turnId,
              reason: "process_killed",
            },
          },
        },
      });
      synthesized.push({
        type: "event_msg",
        payload: {
          id: `orphan-recovery-${turnId}`,
          msg: {
            type: "warning",
            payload: {
              cause: "orphaned_turn_recovered",
              message: `turn ${turnId} started but never completed — synthesized process_killed abort (I-48)`,
            },
          },
        },
      });
    }
  }

  // Apply the synthetic events to the final state so the reducer's
  // view stays consistent.
  for (const synth of synthesized) {
    const step = reduce(state, synth);
    state = step.state;
  }

  // Resolve reference context: if legacy compaction without
  // replacement history occurred, codex clears the reference to avoid
  // out-of-distribution prompt shape.
  let referenceContextItem: TurnContextItem | undefined;
  if (pending.referenceContextItem.kind === "latest") {
    referenceContextItem = pending.referenceContextItem.item;
  }
  if (sawLegacyCompactionWithoutReplacement) {
    referenceContextItem = undefined;
  }

  const result: RolloutReconstruction = {
    history: state.history,
    orphanedTurnIds,
    synthesizedEvents: synthesized,
    state,
    rolledBackTurnsConsumed: state.rolledBackTurns,
  };

  if (pending.previousTurnSettings !== undefined) {
    (result as { previousTurnSettings?: PreviousTurnSettings }).previousTurnSettings =
      pending.previousTurnSettings;
  }
  if (referenceContextItem !== undefined) {
    (result as { referenceContextItem?: TurnContextItem }).referenceContextItem =
      referenceContextItem;
  }
  return result;
}

/**
 * Utility: apply a synthesized orphan-recovery event stream to the
 * live rollout file. Called by bin/agenc.ts during resume so the
 * on-disk log reflects the I-48 recovery permanently.
 */
export function synthesizedOrphanEvents(
  reconstruction: RolloutReconstruction,
): ReadonlyArray<RolloutItem> {
  return reconstruction.synthesizedEvents;
}

/** Extract the replaced compaction history for a compaction boundary. */
export function replacementHistoryFrom(
  compacted: CompactedItem,
): ReadonlyArray<ResponseItem> | undefined {
  return compacted.replacementHistory;
}
