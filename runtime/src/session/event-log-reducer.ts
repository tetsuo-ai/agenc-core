/**
 * Event-log reducer — pure `(state, event) → state` for deterministic
 * replay.
 *
 * Feeds the rollout reconstruction path: given the full RolloutItem
 * stream from a session's JSONL file, fold over them to rebuild
 * `SessionState` (history, active agent task, context compactions,
 * rollback counters).
 *
 * Invariants wired here:
 *   I-26 (forward-compat unknown event variant skipped, not panicked)
 *        — unknown variants emit a `{type:'unknown'}` shim + warning
 *        flag; reducer continues.
 *   I-27 (FIFO + monotonic seq) — reducer asserts `prevSeq + 1 === currSeq`
 *        on each event and raises `seqGap` in the report on violation.
 *
 * @module
 */

import type {
  EventLog,
  EventSeq,
  TurnContextItem,
} from "./event-log.js";
import { emitError, emitWarning } from "./event-log.js";
import type {
  CompactedItem,
  ResponseItem,
  RolloutItem,
} from "./rollout-item.js";
import { isKnownRolloutType } from "./rollout-item.js";
import {
  isUserTurnBoundary,
  isContextualUserMessageContent,
} from "./rollout-reconstruction.js";

// ─────────────────────────────────────────────────────────────────────
// Reducer state shape
// ─────────────────────────────────────────────────────────────────────

/**
 * The state the reducer builds up. Mirrors the subset of agenc runtime
 * `SessionState` that rollout replay is responsible for. Full
 * SessionState (session.ts) is a superset — other fields are wired
 * outside replay (e.g. services DI, mailbox state).
 */
export interface ReducedSessionState {
  /** Ordered response history reconstructed from rollout. */
  history: ResponseItem[];
  /** Most-recent TurnContextItem emitted (turn baseline). */
  lastTurnContext?: TurnContextItem;
  /** Cached agent task from the most recent session_state update. */
  agentTask?: unknown;
  /** Most-recent compaction boundary metadata. */
  lastCompaction?: CompactedItem;
  /** Running count of thread rollbacks observed. */
  rolledBackTurns: number;
  /** Seq of the most recent event consumed. Used for I-27 assertion. */
  lastSeq: EventSeq;
  /** Session meta from the rollout header (latest wins). */
  sessionMeta?: unknown;
}

export function emptyReducedState(): ReducedSessionState {
  return {
    history: [],
    rolledBackTurns: 0,
    lastSeq: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Reduction report — diagnostics surfaced post-replay.
// ─────────────────────────────────────────────────────────────────────

export interface ReductionReport {
  /** Count of unknown rollout-type variants encountered (I-26). */
  readonly unknownVariantCount: number;
  /** Unknown-variant samples for telemetry (max 5). */
  readonly unknownVariantSamples: ReadonlyArray<string>;
  /** Count of seq-gap violations (I-27). */
  readonly seqGapCount: number;
  /** First seq-gap encountered (useful for reporting). */
  readonly firstSeqGap?: { readonly expected: EventSeq; readonly actual: EventSeq };
  /** Lines that failed to parse and were skipped. */
  readonly malformedLineCount: number;
  /** Total rollout items successfully processed. */
  readonly processed: number;
}

function emptyReport(): ReductionReport {
  return {
    unknownVariantCount: 0,
    unknownVariantSamples: [],
    seqGapCount: 0,
    malformedLineCount: 0,
    processed: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Single-step reducer — returns new state + (optional) warning.
// ─────────────────────────────────────────────────────────────────────

/**
 * Pure single-step reducer. Returns a new `ReducedSessionState` plus
 * a report delta. Does NOT mutate inputs.
 *
 * Unknown event types inside `event_msg` items are captured in the
 * report's `unknownVariantCount` without changing state.
 */
export function reduce(
  state: ReducedSessionState,
  item: RolloutItem,
): { state: ReducedSessionState; report: Partial<ReductionReport> } {
  // I-26: forward-compat shim. If the type itself is unknown (newer
  // AgenC version wrote a variant we don't recognise), tag + skip.
  // Note: parseRolloutLine already wraps unknown types in the
  // `unknown` shim, but this branch handles in-memory items coming
  // from other producers (e.g. tests constructing mock items).
  if (!isKnownRolloutType((item as { type: string }).type)) {
    return {
      state,
      report: {
        unknownVariantCount: 1,
        unknownVariantSamples: [(item as { type: string }).type],
      },
    };
  }

  switch (item.type) {
    case "unknown": {
      // I-26: unknown-variant shim. Skip + report.
      return {
        state,
        report: {
          unknownVariantCount: 1,
          unknownVariantSamples: [item.payload.originalType],
        },
      };
    }

    case "session_meta":
      return {
        state: { ...state, sessionMeta: item.payload },
        report: {},
      };

    case "session_state":
      return {
        state: { ...state, agentTask: item.payload.agentTask },
        report: {},
      };

    case "response_item":
      return {
        state: { ...state, history: [...state.history, item.payload] },
        report: {},
      };

    case "compacted": {
      // AgenC semantics: if replacement_history is present, use it as
      // the new history base. Otherwise keep history and record the
      // compaction message for any downstream rebuild logic.
      const next =
        item.payload.replacementHistory !== undefined
          ? { ...state, history: [...item.payload.replacementHistory], lastCompaction: item.payload }
          : { ...state, lastCompaction: item.payload };
      return { state: next, report: {} };
    }

    case "turn_context":
      return {
        state: { ...state, lastTurnContext: item.payload },
        report: {},
      };

    case "event_msg": {
      const event = item.payload;
      const inner = event.msg;

      // I-27: seq monotonicity. event.seq may be undefined for very
      // old rollouts written before the seq field existed — skip the
      // check in that case.
      let seqGapReport: Partial<ReductionReport> = {};
      if (event.seq !== undefined) {
        const expected = state.lastSeq + 1;
        if (state.lastSeq !== 0 && event.seq !== expected) {
          seqGapReport = {
            seqGapCount: 1,
            firstSeqGap: { expected, actual: event.seq },
          };
        }
      }

      const nextState: ReducedSessionState = { ...state };
      if (event.seq !== undefined) nextState.lastSeq = event.seq;

      // I-26: unknown event-msg inner types — log but don't throw.
      const innerType = (inner as { type?: string }).type;
      if (!innerType) {
        return {
          state: nextState,
          report: {
            ...seqGapReport,
            unknownVariantCount: 1,
            unknownVariantSamples: ["event_msg:<missing-type>"],
          },
        };
      }

      // Handle structural events that affect the reduced state.
      switch (innerType) {
        case "turn_context":
          nextState.lastTurnContext = (inner as unknown as { payload: TurnContextItem }).payload;
          break;
        case "context_compacted": {
          const payload = (inner as unknown as { payload: { summary?: string } }).payload;
          if (payload?.summary) {
            nextState.lastCompaction = { message: payload.summary };
          }
          break;
        }
        case "thread_rolled_back": {
          const payload = (inner as unknown as { payload: { numTurns: number } }).payload;
          nextState.rolledBackTurns += payload?.numTurns ?? 0;
          // Drop the last N user-turn boundaries from history.
          nextState.history = dropLastNUserTurns(nextState.history, payload?.numTurns ?? 0);
          break;
        }
        default:
          // Other event types are telemetry/transient; reducer ignores.
          break;
      }

      return { state: nextState, report: seqGapReport };
    }

    default: {
      // Exhaustive check for future variant additions.
      const _exhaustive: never = item;
      void _exhaustive;
      return { state, report: {} };
    }
  }
}

/**
 * Port of agenc runtime `History::drop_last_n_user_turns`
 * (`context_manager/history.rs:240-263`) + companion
 * `trim_pre_turn_context_updates` (`history.rs:428-456`).
 *
 * AgenC semantics:
 *   - a "user-turn boundary" is defined by `is_user_turn_boundary`
 *     (role==="user" with non-contextual content, OR role==="assistant"
 *     carrying an inter-agent-instruction payload). We delegate to the
 *     shared helper in `rollout-reconstruction.ts` so forward replay
 *     and compaction rebuild agree on what counts as a boundary.
 *   - after choosing the cut index, walk backward from the cut while
 *     the preceding item is a contextual pre-turn update (a
 *     user-role Message whose content is purely contextual fragments).
 *     These items sit above the rolled-back turn as prompt scaffolding
 *     that belongs with the discarded turn, so agenc runtime trims them too.
 *     We conservatively skip agenc runtime's "developer-role contextual
 *     message" branch because AgenC does not yet emit developer-role
 *     message items in rollout history (see feature matrix I-33 / I-82).
 */
function dropLastNUserTurns(
  history: ReadonlyArray<ResponseItem>,
  n: number,
): ResponseItem[] {
  if (n <= 0) return [...history];

  // Collect user-turn boundary indices (agenc runtime `user_message_positions`).
  const userPositions: number[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const item = history[i];
    if (item && isUserTurnBoundary(item)) userPositions.push(i);
  }
  if (userPositions.length === 0) return [...history];

  const firstInstructionTurnIdx = userPositions[0]!;
  let cutIndex: number;
  if (n >= userPositions.length) {
    cutIndex = firstInstructionTurnIdx;
  } else {
    cutIndex = userPositions[userPositions.length - n]!;
  }

  // agenc runtime `trim_pre_turn_context_updates`: walk backward from the
  // cut, stripping contiguous contextual user-message injections
  // above the boundary. We stop at the first non-contextual item and
  // never cross `firstInstructionTurnIdx`.
  while (cutIndex > firstInstructionTurnIdx) {
    const prev = history[cutIndex - 1];
    if (!prev) break;
    if (prev.role !== "user") break;
    if (!isContextualUserMessageContent(prev.content)) break;
    cutIndex -= 1;
  }

  return history.slice(0, cutIndex);
}

// ─────────────────────────────────────────────────────────────────────
// Fold over a stream of rollout items.
// ─────────────────────────────────────────────────────────────────────

/**
 * Fold a full rollout sequence into a final `ReducedSessionState`
 * plus diagnostic `ReductionReport`. Pure function.
 */
export function reduceAll(
  items: ReadonlyArray<RolloutItem>,
): { state: ReducedSessionState; report: ReductionReport } {
  let state = emptyReducedState();
  let report = emptyReport();
  for (const item of items) {
    const step = reduce(state, item);
    state = step.state;
    report = mergeReports(report, step.report);
  }
  report = { ...report, processed: items.length };
  return { state, report };
}

/**
 * Same as `reduceAll` but also emits typed events into the supplied
 * `EventLog` when the rule-based invariants surface violations:
 *
 *   - I-26 (unknown event variant): emits `warning:'unknown_event_variant'`
 *     for every skipped item (originalType in message).
 *   - I-27 (seq monotonicity): emits `error:'event_reordering_detected'`
 *     on each gap with expected/actual seq in the payload.
 *
 * Call this from `rollout-reconstruction.ts` + any runtime replay
 * path. Test-only `reduceAll` stays pure so reducers can be unit-
 * tested without an EventLog.
 */
export function reduceAllWithEmit(
  items: ReadonlyArray<RolloutItem>,
  log: EventLog,
  opts: { readonly subId?: string } = {},
): { state: ReducedSessionState; report: ReductionReport } {
  const subId = opts.subId ?? "reducer";
  let state = emptyReducedState();
  let report = emptyReport();

  for (const item of items) {
    const step = reduce(state, item);

    // I-26 — emit warning per unknown variant.
    if (step.report.unknownVariantCount) {
      for (const sample of step.report.unknownVariantSamples ?? []) {
        emitWarning(
          log,
          subId,
          "unknown_event_variant",
          `skipped unknown rollout variant "${sample}" during replay (I-26)`,
        );
      }
    }
    // I-27 — emit error on seq-gap violation.
    if (step.report.seqGapCount && step.report.firstSeqGap) {
      emitError(log, subId, {
        cause: "event_reordering_detected",
        message: `rollout seq gap: expected ${step.report.firstSeqGap.expected}, got ${step.report.firstSeqGap.actual} (I-27)`,
      });
    }

    state = step.state;
    report = mergeReports(report, step.report);
  }
  report = { ...report, processed: items.length };
  return { state, report };
}

function mergeReports(
  a: ReductionReport,
  b: Partial<ReductionReport>,
): ReductionReport {
  return {
    unknownVariantCount: a.unknownVariantCount + (b.unknownVariantCount ?? 0),
    unknownVariantSamples:
      b.unknownVariantSamples && b.unknownVariantSamples.length > 0
        ? [...a.unknownVariantSamples, ...b.unknownVariantSamples].slice(0, 5)
        : a.unknownVariantSamples,
    seqGapCount: a.seqGapCount + (b.seqGapCount ?? 0),
    firstSeqGap: a.firstSeqGap ?? b.firstSeqGap,
    malformedLineCount: a.malformedLineCount + (b.malformedLineCount ?? 0),
    processed: a.processed + (b.processed ?? 0),
  };
}
