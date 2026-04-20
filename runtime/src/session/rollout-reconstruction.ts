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
import {
  reduce,
  type ReducedSessionState,
  type ReductionReport,
} from "./event-log-reducer.js";
import type { IndexSnapshot } from "./session-store.js";
import {
  capToolResult,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
} from "../tools/execution.js";

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
  /** Any synthesized events (I-48, I-25 snapshot-mismatch). Callers
   *  emit these warnings into the live event log. */
  readonly synthesizedEvents: ReadonlyArray<RolloutItem>;
  /** Final reduced state used downstream. */
  readonly state: ReducedSessionState;
  /** Count of rolled-back user turns observed. */
  readonly rolledBackTurnsConsumed: number;
  /** I-25: when true, an index.json snapshot existed but its seq was
   *  behind the rollout; callers emit warning:'snapshot_behind_rollout'. */
  readonly snapshotBehindRollout: boolean;
  /** I-25: the snapshot actually consumed (if any). Metadata only. */
  readonly consumedSnapshot?: IndexSnapshot;
  /** Reducer diagnostics aggregated over the forward replay. Includes
   *  seq-gap counts (I-27) and unknown-variant samples (I-26). */
  readonly reductionReport?: ReductionReport;
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
 * Contextual user-message open tags (codex `contextual_user_message.rs`).
 * A user message whose content is *only* one of these fragments is an
 * injection, not a real user-turn boundary — excluding them matches
 * codex `is_contextual_user_message_content` semantics.
 */
const CONTEXTUAL_USER_OPEN_TAGS: ReadonlyArray<string> = [
  "<environment_context>",
  "<user_shell_command>",
  "<turn_aborted>",
  "<subagent_notification>",
  "<agents_md>",
  "<skill>",
  "<hook_prompt>",
];

function isContextualUserText(text: string): boolean {
  const trimmed = text.trimStart().toLowerCase();
  return CONTEXTUAL_USER_OPEN_TAGS.some((tag) => trimmed.startsWith(tag));
}

/**
 * Does this message content count as a contextual injection rather
 * than a real user turn? Accepts both string and content-array
 * payloads so it matches the permissive `ResponseItem.content` shape.
 */
function isContextualUserContent(
  content: ResponseItem["content"],
): boolean {
  if (typeof content === "string") {
    return isContextualUserText(content);
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  // Any fragment being contextual is enough (matches codex `.any`).
  return content.some((frag) => {
    const text = typeof frag.text === "string" ? frag.text : "";
    return (
      frag.type === "function_call_output" ||
      frag.type === "tool_use_result" ||
      frag.type === "tool_result" ||
      (frag.type === "input_text" && isContextualUserText(text)) ||
      (typeof text === "string" && isContextualUserText(text))
    );
  });
}

/**
 * Is this ResponseItem a user-turn boundary? Port of codex
 * `context_manager::is_user_turn_boundary`. A user-role item is a
 * boundary only when its content is a *real* user message — not a
 * contextual injection (tool_result, function_call_output,
 * `<environment_context>...</environment_context>`, etc.).
 */
function isUserTurnBoundary(item: ResponseItem): boolean {
  if (item.role !== "user") return false;
  // Tool-role messages (function_call_output equivalents) never count.
  if (item.toolCallId !== undefined || item.toolName !== undefined) {
    return false;
  }
  return !isContextualUserContent(item.content);
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
  opts: { readonly indexSnapshot?: IndexSnapshot } = {},
): RolloutReconstruction {
  // I-25: consult the optional index.json snapshot. The reconstruction
  // itself still walks the rollout (rollout is truth per I-25), but a
  // snapshot with a matching seq lets us surface metadata instantly
  // + enables fast-seek callers. A snapshot with a stale seq routes
  // to warning:'snapshot_behind_rollout' via the synthesized event.
  const snapshotBehindRollout = opts.indexSnapshot
    ? computeSnapshotStale(rolloutItems, opts.indexSnapshot)
    : false;
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
          // Codex threads `realtime_active` from the TurnContext event
          // into PreviousTurnSettings so resume can rehydrate a
          // realtime turn. The rollout writer (`toTurnContextItem`)
          // and the TurnContextItem declaration in event-log.ts both
          // carry the field directly now, so read it without a typed
          // cast.
          const next: PreviousTurnSettings = {
            model: item.payload.model,
            ...(item.payload.realtimeActive !== undefined
              ? { realtimeActive: item.payload.realtimeActive }
              : {}),
          };
          active.previousTurnSettings = next;
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

  // Forward replay over the suffix using the reducer. We apply three
  // extra codex-parity steps inline so forward replay reproduces the
  // runtime state the writer saw at that seq:
  //   (a) I-15-style truncation of oversized response_item text (codex
  //       `ContextManager::record_items(truncation_policy)`),
  //   (b) legacy compaction rebuild via `buildCompactedHistory`
  //       (codex `compact::build_compacted_history`),
  //   (c) aggregate `ReductionReport` so callers can surface seq-gap
  //       / unknown-variant telemetry from replay.
  let state: ReducedSessionState = {
    history: pending.baseReplacementHistory
      ? [...pending.baseReplacementHistory]
      : [],
    rolledBackTurns: 0,
    lastSeq: 0,
  };
  let reductionReport: ReductionReport = {
    unknownVariantCount: 0,
    unknownVariantSamples: [],
    seqGapCount: 0,
    malformedLineCount: 0,
    processed: 0,
  };
  let sawLegacyCompactionWithoutReplacement = false;

  for (const item of rolloutSuffix) {
    // (b) Legacy compaction: rebuild history in place via the inline
    // `buildCompactedHistory` helper instead of deferring to the
    // reducer (which would just clear the reference). This matches
    // codex `rollout_reconstruction.rs:252-274`.
    if (
      item.type === "compacted" &&
      item.payload.replacementHistory === undefined
    ) {
      sawLegacyCompactionWithoutReplacement = true;
      const userMessages = collectUserMessages(state.history);
      const rebuilt = buildCompactedHistory(userMessages, item.payload.message);
      state = { ...state, history: rebuilt, lastCompaction: item.payload };
      reductionReport = mergeReport(reductionReport, { processed: 1 });
      continue;
    }

    // (a) Truncation policy: apply I-15 cap to response_item text
    // payloads on replay so a single oversized message can't blow
    // memory. Codex uses `truncation_policy.head` at this seam; the
    // AgenC simplification keeps the full ResponseItem but truncates
    // the text body with the same marker format.
    const toReduce =
      item.type === "response_item"
        ? { ...item, payload: applyReplayTruncation(item.payload) }
        : item;

    const step = reduce(state, toReduce);
    state = step.state;
    reductionReport = mergeReport(reductionReport, step.report);
  }
  reductionReport = {
    ...reductionReport,
    processed: rolloutSuffix.length,
  };

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

  // I-25: synth a warning for snapshot-behind-rollout so the caller
  // surfaces it in the live event log.
  if (snapshotBehindRollout) {
    synthesized.push({
      type: "event_msg",
      payload: {
        id: "snapshot-behind-rollout",
        msg: {
          type: "warning",
          payload: {
            cause: "snapshot_behind_rollout",
            message: `index.json snapshot seq=${opts.indexSnapshot?.snapshotSequenceNumber ?? "?"} is behind rollout — ignoring snapshot (I-25)`,
          },
        },
      },
    });
  }

  const result: RolloutReconstruction = {
    history: state.history,
    orphanedTurnIds,
    synthesizedEvents: synthesized,
    state,
    rolledBackTurnsConsumed: state.rolledBackTurns,
    snapshotBehindRollout,
    reductionReport,
    ...(opts.indexSnapshot && !snapshotBehindRollout
      ? { consumedSnapshot: opts.indexSnapshot }
      : {}),
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

// ─────────────────────────────────────────────────────────────────────
// Forward-replay helpers: truncation + legacy compaction rebuild
// ─────────────────────────────────────────────────────────────────────

/**
 * Extract raw text from a `ResponseItem`. Supports both the string
 * shorthand and the content-array shape.
 */
function responseItemText(item: ResponseItem): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  let total = "";
  for (const frag of item.content) {
    if (typeof frag.text === "string") total += frag.text;
  }
  return total;
}

/**
 * Replace text within a `ResponseItem`. Preserves the original shape
 * (string vs content-array); for content arrays we place the new
 * text into the first text-carrying fragment.
 */
function withResponseItemText(
  item: ResponseItem,
  newText: string,
): ResponseItem {
  if (typeof item.content === "string") {
    return { ...item, content: newText };
  }
  if (!Array.isArray(item.content)) return item;
  const cloned = item.content.map((frag, i) =>
    i === 0 ? { ...frag, text: newText } : frag,
  );
  return { ...item, content: cloned };
}

/**
 * Forward-replay truncation (codex `ContextManager::record_items`).
 * If the response_item's text payload exceeds the I-15 cap, rewrite
 * it with the truncation marker. Kept simpler than codex's
 * TruncationPolicy (head/middle/off): AgenC uses head-truncation via
 * the shared `capToolResult` helper so every tool-result-sized payload
 * on replay gets the same 400KB ceiling.
 */
function applyReplayTruncation(item: ResponseItem): ResponseItem {
  const text = responseItemText(item);
  if (!text) return item;
  const cap = capToolResult(text, DEFAULT_MAX_TOOL_RESULT_BYTES);
  if (!cap.truncated) return item;
  return withResponseItemText(item, cap.capped);
}

/**
 * Codex `collect_user_messages(history)` analogue. Extracts real
 * user-turn text (non-contextual, non-summary). Contextual and
 * tool-role items are skipped so legacy compaction rebuild sees only
 * human input.
 */
function collectUserMessages(
  history: ReadonlyArray<ResponseItem>,
): string[] {
  const out: string[] = [];
  for (const item of history) {
    if (!isUserTurnBoundary(item)) continue;
    const text = responseItemText(item);
    if (!text) continue;
    // Skip compaction-summary messages so we don't re-feed an old
    // summary into a new compaction (codex `is_summary_message`).
    if (text.startsWith("# Session Summary\n")) continue;
    out.push(text);
  }
  return out;
}

/**
 * Codex `compact::build_compacted_history` minimal port. Rebuilds a
 * compacted history from scratch when the legacy `Compacted` item
 * had no inline `replacementHistory`. Structure:
 *   - replay prior real user messages (bounded by a rough token cap
 *     equal to 400KB chars to stay within I-15 limits),
 *   - append the compaction summary as a final user-role message.
 *
 * Inlined rather than importing from a `compact/` subsystem because
 * rollout reconstruction must stay free of the compact subsystem's
 * runtime dependencies.
 */
export function buildCompactedHistory(
  userMessages: ReadonlyArray<string>,
  summaryText: string,
): ResponseItem[] {
  const out: ResponseItem[] = [];
  let remaining = DEFAULT_MAX_TOOL_RESULT_BYTES;
  const selected: string[] = [];
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    const msg = userMessages[i]!;
    const size = Buffer.byteLength(msg, "utf8");
    if (size <= remaining) {
      selected.push(msg);
      remaining -= size;
    } else if (remaining > 0) {
      const cap = capToolResult(msg, remaining);
      selected.push(cap.capped);
      remaining = 0;
      break;
    } else {
      break;
    }
  }
  selected.reverse();
  for (const msg of selected) {
    out.push({ role: "user", content: msg });
  }
  const summary = summaryText.length > 0 ? summaryText : "(no summary available)";
  out.push({ role: "user", content: summary });
  return out;
}

/** Tiny reducer-report merger used during forward replay. */
function mergeReport(
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

/**
 * I-25 helper: decide whether the supplied `IndexSnapshot` is
 * behind the rollout. "Behind" means the snapshot's recorded
 * `snapshotSequenceNumber` is strictly less than the highest seq
 * observed in the rollout items.
 */
function computeSnapshotStale(
  rolloutItems: ReadonlyArray<RolloutItem>,
  snapshot: IndexSnapshot,
): boolean {
  let rolloutLastSeq = 0;
  for (const item of rolloutItems) {
    if (
      item.type === "event_msg" &&
      item.payload.seq !== undefined &&
      item.payload.seq > rolloutLastSeq
    ) {
      rolloutLastSeq = item.payload.seq;
    }
  }
  return snapshot.snapshotSequenceNumber < rolloutLastSeq;
}
