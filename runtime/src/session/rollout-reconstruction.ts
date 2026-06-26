/**
 * Rollout reconstruction — rebuild `SessionState` from a JSONL
 * rollout file.
 *
 * Hand-port of agenc runtime `core/src/session/rollout_reconstruction.rs`
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
} from "./_deps/tool-execution.js";
import {
  computePrefixHash,
  currentBuildId,
  findDanglingToolUses,
  type ResumableTurn,
} from "./durable-turns.js";
import type {
  TurnCheckpointEvent,
  TurnCheckpointSliceLine,
} from "./event-log.js";
import {
  startsWithRealtimeConversationOpenTag,
} from "../conversation/realtime/instructions/markers.js";
import {
  startsWithPersonalitySpecOpenTag,
  type Personality,
} from "../context/personality-spec-instructions.js";

/**
 * Verbatim port of agenc runtime `core/templates/compact/summary_prefix.md`
 * (referenced at `agenc-rs/core/src/compact.rs:43`). agenc runtime's
 * `is_summary_message` check (`compact.rs:410-412`) does
 * `message.starts_with(format!("{SUMMARY_PREFIX}\n"))` — we mirror that
 * exactly so a compatibility compaction summary re-entering replay is not
 * re-fed as a real user message on the next compaction pass.
 *
 * Keep this string byte-for-byte identical to agenc runtime's template. If
 * agenc runtime updates the prefix, update here and bump the rollout schema
 * version so older rollouts still match the old prefix via a fallback
 * list.
 */
const COMPACT_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

/**
 * agenc runtime `is_summary_message` (`compact.rs:410-412`): a user message
 * whose text begins with the rendered summary_prefix template + "\n"
 * is the compaction summary re-fed into history. Treat as non-user
 * so `collectUserMessages` does not recycle it into a new compaction
 * bundle on replay.
 */
function isSummaryMessage(text: string): boolean {
  return text.startsWith(`${COMPACT_SUMMARY_PREFIX}\n`);
}

// ─────────────────────────────────────────────────────────────────────
// Reconstruction types
// ─────────────────────────────────────────────────────────────────────

export interface PreviousTurnSettings {
  readonly model: string;
  readonly realtimeActive?: boolean;
  readonly personality?: Personality;
  readonly contextWindow?: number;
  readonly modelInfo?: {
    readonly contextWindow?: number;
    readonly effectiveContextWindowPercent?: number;
    readonly autoCompactTokenLimit?: number;
  };
}

export interface RolloutReconstruction {
  readonly history: ResponseItem[];
  readonly previousTurnSettings?: PreviousTurnSettings;
  readonly referenceContextItem?: TurnContextItem;
  /** Orphaned TurnStarted events that got synthetic TurnAborted. */
  readonly orphanedTurnIds: ReadonlyArray<string>;
  /**
   * GOAL #4b Stage 1 — durable resume descriptors. For each orphaned turn
   * that carried a durable `turn_checkpoint`, the highest-seq checkpoint
   * surfaced with its build-pin + prefix-hash validation results. The
   * resume path consumes these; an orphan with NO checkpoint produces NO
   * descriptor and falls back to EXACTLY today's process_killed + fresh
   * turn (backward compat). Always non-undefined (empty when none).
   */
  readonly resumableTurns: ReadonlyArray<ResumableTurn>;
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
 * Contextual user-message fragment definitions (port of agenc runtime
 * `instructions/src/fragment.rs` + `core/src/contextual_user_message.rs`).
 *
 * A contextual fragment is marked by a matching open and close tag pair
 * (agenc runtime `ContextualUserFragmentDefinition::matches_text` at
 * `instructions/src/fragment.rs:23-33`). A user message whose content
 * is *only* a contextual fragment is an injection, not a real
 * user-turn boundary.
 *
 * AGENC.md uses an AgenC-owned start marker
 * `"# AGENC.md instructions for "` and end marker `"</INSTRUCTIONS>"`.
 */
interface ContextualFragmentDef {
  readonly startMarker: string;
  readonly endMarker: string;
}

type ResponseContentPart = Extract<
  ResponseItem["content"],
  ReadonlyArray<unknown>
>[number];

const CONTEXTUAL_USER_FRAGMENTS: ReadonlyArray<ContextualFragmentDef> = [
  // AGENC.md instructions.
  {
    startMarker: "# AGENC.md instructions for ",
    endMarker: "</INSTRUCTIONS>",
  },
  // Imported instruction headers emitted by the current prompt path.
  {
    startMarker: "# AGENTS.md instructions for ", // branding-scan: allow live imported instruction marker
    endMarker: "</INSTRUCTIONS>",
  },
  // Environment context (agenc runtime ENVIRONMENT_CONTEXT_FRAGMENT).
  {
    startMarker: "<environment_context>",
    endMarker: "</environment_context>",
  },
  // Skill fragment (agenc runtime SKILL_FRAGMENT).
  { startMarker: "<skill>", endMarker: "</skill>" },
  // User shell command (agenc runtime USER_SHELL_COMMAND_FRAGMENT).
  {
    startMarker: "<user_shell_command>",
    endMarker: "</user_shell_command>",
  },
  // Turn aborted marker (agenc runtime TURN_ABORTED_FRAGMENT).
  { startMarker: "<turn_aborted>", endMarker: "</turn_aborted>" },
  // Subagent notification (agenc runtime SUBAGENT_NOTIFICATION_FRAGMENT).
  {
    startMarker: "<subagent_notification>",
    endMarker: "</subagent_notification>",
  },
  // Hook and editor context fragments emitted before the user prompt.
  {
    startMarker: "<session-start-hook>",
    endMarker: "</session-start-hook>",
  },
  {
    startMarker: "<user-prompt-submit-hook>",
    endMarker: "</user-prompt-submit-hook>",
  },
  {
    startMarker: "<ide_opened_file>",
    endMarker: "</ide_opened_file>",
  },
];

/**
 * Port of agenc runtime `ContextualUserFragmentDefinition::matches_text`
 * (`instructions/src/fragment.rs:23-33`). Requires BOTH the start
 * marker and the close marker to match (after trimming leading/
 * trailing whitespace). Case-insensitive per agenc runtime's
 * `eq_ignore_ascii_case`.
 */
function fragmentMatchesText(text: string, def: ContextualFragmentDef): boolean {
  const trimmedStart = text.trimStart();
  const startCandidate = trimmedStart.slice(0, def.startMarker.length);
  const startsWith =
    startCandidate.length >= def.startMarker.length &&
    startCandidate.toLowerCase() === def.startMarker.toLowerCase();
  if (!startsWith) return false;
  const trimmedEnd = trimmedStart.trimEnd();
  if (trimmedEnd.length < def.endMarker.length) return false;
  const endCandidate = trimmedEnd.slice(trimmedEnd.length - def.endMarker.length);
  return endCandidate.toLowerCase() === def.endMarker.toLowerCase();
}

function isContextualUserText(text: string): boolean {
  return CONTEXTUAL_USER_FRAGMENTS.some((def) => fragmentMatchesText(text, def));
}

/**
 * Exported alias so sibling modules (notably event-log-reducer.ts'
 * `trim_pre_turn_context_updates` equivalent) share the exact same
 * fragment-detection behavior we use for user-turn boundary
 * classification. Mirrors agenc runtime `is_contextual_user_message_content`
 * (event_mapping.rs:35).
 */
export function isContextualUserMessageContent(
  content: ResponseItem["content"],
): boolean {
  return isContextualUserContent(content);
}

/**
 * Does this message content count as a contextual injection rather
 * than a real user turn? Accepts both string and content-array
 * payloads so it matches the permissive `ResponseItem.content` shape.
 * Mirrors agenc runtime `is_contextual_user_message_content` (event_mapping.rs:35).
 */
function isContextualUserContent(
  content: ResponseItem["content"],
): boolean {
  if (typeof content === "string") {
    return isContextualUserText(content);
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  // agenc runtime: `message.iter().any(is_contextual_user_fragment)` — any
  // fragment being contextual is enough.
  return content.some((frag) => {
    const text = typeof frag.text === "string" ? frag.text : "";
    return (
      frag.type === "function_call_output" ||
      frag.type === "tool_use_result" ||
      frag.type === "tool_result" ||
      (typeof text === "string" && isContextualUserText(text))
    );
  });
}

function isContextualDeveloperText(text: string): boolean {
  return (
    startsWithRealtimeConversationOpenTag(text) ||
    startsWithPersonalitySpecOpenTag(text)
  );
}

function isTextLikeDeveloperFragment(
  fragment: ResponseContentPart,
): boolean {
  return (
    (fragment.type === "text" ||
      fragment.type === "input_text" ||
      fragment.type === "output_text") &&
    typeof fragment.text === "string"
  );
}

function isContextualDeveloperFragment(
  fragment: ResponseContentPart,
): boolean {
  return (
    isTextLikeDeveloperFragment(fragment) &&
    isContextualDeveloperText(fragment.text as string)
  );
}

export function isContextualDeveloperMessageContent(
  content: ResponseItem["content"],
): boolean {
  if (typeof content === "string") {
    return isContextualDeveloperText(content);
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some(isContextualDeveloperFragment);
}

export function hasNonContextualDeveloperMessageContent(
  content: ResponseItem["content"],
): boolean {
  if (typeof content === "string") {
    return !isContextualDeveloperText(content);
  }
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.some((fragment) => !isContextualDeveloperFragment(fragment));
}

/**
 * Port of agenc runtime `InterAgentCommunication::is_message_content`
 * (protocol.rs:753). An assistant message is an inter-agent instruction
 * if its content is a single text fragment that parses as a JSON
 * object with the inter-agent-communication shape (author, recipient,
 * content, triggerTurn, ...).
 */
function isInterAgentInstructionContent(
  content: ResponseItem["content"],
): boolean {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content) && content.length === 1) {
    const frag = content[0];
    if (!frag) return false;
    // agenc runtime matches `[InputText|OutputText]` single-fragment content
    // only — other fragment shapes disqualify.
    const ty = frag.type;
    if (ty !== "input_text" && ty !== "output_text") return false;
    text = typeof frag.text === "string" ? frag.text : "";
  } else {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as {
      author?: unknown;
      recipient?: unknown;
      content?: unknown;
    };
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "author" in parsed &&
      "recipient" in parsed &&
      typeof parsed.content === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Is this ResponseItem a user-turn boundary? Port of agenc runtime
 * `context_manager::is_user_turn_boundary` (history.rs:703-710). A
 * boundary is either:
 *   - a real (non-contextual) user-role message, OR
 *   - an assistant-role message whose content is an inter-agent
 *     instruction (structured JSON produced by
 *     `InterAgentCommunication::to_response_input_item`).
 *
 * Contextual user injections and tool-role messages never count.
 */
export function isUserTurnBoundary(item: ResponseItem): boolean {
  // Tool-role messages (function_call_output equivalents) never count.
  if (item.role === "tool") return false;
  if (item.toolCallId !== undefined || item.toolName !== undefined) {
    return false;
  }
  if (item.role === "user") {
    return !isContextualUserContent(item.content);
  }
  if (item.role === "assistant") {
    return isInterAgentInstructionContent(item.content);
  }
  return false;
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
          // agenc runtime threads `realtime_active` from the TurnContext event
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
            ...(item.payload.personality !== undefined
              ? { personality: item.payload.personality }
              : {}),
            ...(item.payload.rawModelContextWindow !== undefined ||
            item.payload.modelContextWindow !== undefined
              ? {
                  contextWindow:
                    item.payload.rawModelContextWindow ??
                    item.payload.modelContextWindow,
                  modelInfo: {
                    contextWindow:
                      item.payload.rawModelContextWindow ??
                      item.payload.modelContextWindow,
                    effectiveContextWindowPercent:
                      item.payload.modelEffectiveContextWindowPercent ?? 100,
                    ...(item.payload.autoCompactTokenLimit !== undefined
                      ? {
                          autoCompactTokenLimit:
                            item.payload.autoCompactTokenLimit,
                        }
                      : {}),
                  },
                }
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
  // extra agenc runtime-parity steps inline so forward replay reproduces the
  // runtime state the writer saw at that seq:
  //   (a) I-15-style truncation of oversized response_item text (agenc runtime
  //       `ContextManager::record_items(truncation_policy)`),
  //   (b) compatibility compaction rebuild via `buildCompactedHistory`
  //       (agenc runtime `compact::build_compacted_history`),
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
    // (b) Compatibility compaction: rebuild history in place via the inline
    // `buildCompactedHistory` helper instead of deferring to the
    // reducer (which would just clear the reference). This matches
    // agenc runtime `rollout_reconstruction.rs:252-274`.
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
    // memory. agenc runtime uses `truncation_policy.head` at this seam; the
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

  // GOAL #4b Stage 1 — collect per-turn build pin + highest-seq durable
  // checkpoint via a dedicated forward pass over ALL rollout items (the
  // reverse scan above early-terminates, so it is NOT a reliable place to
  // gather every checkpoint). A turn with NO checkpoint contributes nothing
  // here → it falls back to EXACTLY today's process_killed path below.
  const turnBuildIds = new Map<string, string | undefined>();
  const highestCheckpointByTurn = new Map<string, TurnCheckpointEvent>();
  for (const item of rolloutItems) {
    if (item.type !== "event_msg") continue;
    const inner = item.payload.msg as { type?: string; payload?: unknown };
    if (inner.type === "turn_started") {
      const p = inner.payload as { turnId?: string; buildId?: string };
      if (typeof p?.turnId === "string") {
        turnBuildIds.set(p.turnId, p.buildId);
      }
    } else if (inner.type === "turn_checkpoint") {
      const p = inner.payload as TurnCheckpointEvent | undefined;
      if (p === undefined || typeof p.turnId !== "string") continue;
      const prev = highestCheckpointByTurn.get(p.turnId);
      if (prev === undefined || p.checkpointSeq > prev.checkpointSeq) {
        highestCheckpointByTurn.set(p.turnId, p);
      }
    }
  }

  // I-48: orphan-TurnStarted recovery. For each started-but-not-terminated
  // turn, synthesize a TurnAborted{reason:'process_killed'} event so
  // reducers downstream see a consistent turn lifecycle.
  const orphanedTurnIds: string[] = [];
  const resumableTurns: ResumableTurn[] = [];
  const expectedBuildId = currentBuildId();
  const synthesized: RolloutItem[] = [];
  for (const turnId of seenStarted) {
    if (!seenTerminated.has(turnId)) {
      orphanedTurnIds.push(turnId);

      // GOAL #4b Stage 1 — surface a resume descriptor when this orphan
      // carried a durable checkpoint. Validate the build pin (§3.6) and the
      // content prefix hash (§5) against the reconstructed history. The
      // descriptor is ALWAYS additive — the process_killed synthesis below
      // is still emitted, so an orphan with no checkpoint (or a failing
      // gate) is byte-identical to today; only the resume CONSUMER acts on
      // a descriptor whose gates pass.
      const checkpoint = highestCheckpointByTurn.get(turnId);
      if (checkpoint !== undefined) {
        const buildId = turnBuildIds.get(turnId);
        const buildMatches = buildId === expectedBuildId;
        const reconstructedPrefix = state.history.slice(
          0,
          checkpoint.persistedMessageCount,
        );
        const historyPrefixValid =
          reconstructedPrefix.length === checkpoint.persistedMessageCount &&
          computePrefixHash(
            reconstructedPrefix,
            checkpoint.persistedMessageCount,
          ) === checkpoint.prefixHash;
        resumableTurns.push({
          turnId,
          ...(buildId !== undefined ? { buildId } : {}),
          buildMatches,
          historyPrefixValid,
          lastCheckpoint: {
            iterationIndex: checkpoint.iterationIndex,
            checkpointSeq: checkpoint.checkpointSeq,
            persistedMessageCount: checkpoint.persistedMessageCount,
            prefixHash: checkpoint.prefixHash,
            resumableState:
              checkpoint.resumableState as TurnCheckpointSliceLine,
          },
          danglingToolUses: findDanglingToolUses(reconstructedPrefix),
        });
      }
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

  // Resolve reference context: if compatibility compaction without
  // replacement history occurred, agenc runtime clears the reference to avoid
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
    resumableTurns,
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
// Forward-replay helpers: truncation + compatibility compaction rebuild
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
 * (string vs content-array). For content arrays we collapse the
 * fragment list into a single text-carrying fragment so the truncation
 * marker applies to the whole payload (agenc runtime
 * `ContextManager::process_item` → `truncate_function_output_payload`
 * replaces the body wholesale; we mirror that here rather than
 * rewriting only fragment 0, which would leave later fragments
 * holding untruncated untrustworthy leftovers).
 */
function withResponseItemText(
  item: ResponseItem,
  newText: string,
): ResponseItem {
  if (typeof item.content === "string") {
    return { ...item, content: newText };
  }
  if (!Array.isArray(item.content)) return item;
  const firstFrag = item.content[0];
  const preservedType =
    firstFrag && typeof firstFrag.type === "string"
      ? firstFrag.type
      : "input_text";
  return {
    ...item,
    content: [{ type: preservedType, text: newText }],
  };
}

/**
 * Is this a tool-output response item (the only kind agenc runtime truncates
 * on replay)? Port of agenc runtime `ContextManager::process_item` branch
 * selection at `history.rs:375-409`: ONLY `FunctionCallOutput` and
 * `CustomToolCallOutput` are truncated — `Message`, `Reasoning`,
 * `FunctionCall`, `LocalShellCall`, and the other variants pass
 * through unchanged.
 *
 * In AgenC's flattened `ResponseItem` shape, tool outputs surface as
 * `role: "tool"` or a message carrying `toolCallId`/`toolName`, plus
 * inline `function_call_output` / `tool_result` content fragments.
 */
function isToolOutputItem(item: ResponseItem): boolean {
  if (item.role === "tool") return true;
  if (item.toolCallId !== undefined || item.toolName !== undefined) {
    return true;
  }
  if (Array.isArray(item.content)) {
    return item.content.some(
      (frag) =>
        frag.type === "function_call_output" ||
        frag.type === "tool_use_result" ||
        frag.type === "tool_result",
    );
  }
  return false;
}

/**
 * Forward-replay truncation (agenc runtime `ContextManager::process_item` at
 * `history.rs:375-409`). agenc runtime only truncates `FunctionCallOutput` /
 * `CustomToolCallOutput` payloads on replay — every other
 * `ResponseItem` variant (including plain `Message`) is returned
 * as-is. This port mirrors that branch exactly.
 *
 * The truncation cap here is AgenC's byte-based `DEFAULT_MAX_TOOL_RESULT_BYTES`
 * (400 KB). agenc runtime's equivalent uses the token-based
 * `COMPACT_USER_MESSAGE_MAX_TOKENS` (20 000 tokens at `compact.rs:44`)
 * for compacted-history rebuild — see the note on `buildCompactedHistory`
 * below for the token-vs-byte divergence. When AgenC wires an
 * approximate token counter we can reconcile that axis; for
 * tool-output replay the byte cap matches the runtime's live I-15
 * ceiling and is the correct input here.
 */
function applyReplayTruncation(item: ResponseItem): ResponseItem {
  if (!isToolOutputItem(item)) return item;
  const text = responseItemText(item);
  if (!text) return item;
  const cap = capToolResult(text, DEFAULT_MAX_TOOL_RESULT_BYTES);
  if (!cap.truncated) return item;
  return withResponseItemText(item, cap.capped);
}

/**
 * agenc runtime `collect_user_messages(history)` analogue. Extracts real
 * user-turn text (non-contextual, non-summary). Contextual and
 * tool-role items are skipped so compatibility compaction rebuild sees only
 * human input.
 *
 * agenc runtime's collector filters on role=="user" only; the inter-agent
 * assistant branch is not relevant here because compaction rebuild
 * replays literal user prompts. We mirror that by restricting to
 * user-role (the isUserTurnBoundary assistant branch is intentionally
 * NOT hit because we also check role directly first).
 */
function collectUserMessages(
  history: ReadonlyArray<ResponseItem>,
): string[] {
  const out: string[] = [];
  for (const item of history) {
    if (item.role !== "user") continue;
    if (!isUserTurnBoundary(item)) continue;
    const text = responseItemText(item);
    if (!text) continue;
    // Skip compaction-summary messages so we don't re-feed an old
    // summary into a new compaction (agenc runtime `is_summary_message`,
    // compact.rs:410-412).
    if (isSummaryMessage(text)) continue;
    out.push(text);
  }
  return out;
}

/**
 * agenc runtime `compact::build_compacted_history` minimal port
 * (`compact.rs:465-531`). Rebuilds a compacted history from scratch
 * when the compatibility `Compacted` item had no inline `replacementHistory`.
 * Structure:
 *   - replay prior real user messages,
 *   - append the compaction summary as a final user-role message.
 *
 * Inlined rather than importing from a `compact/` subsystem because
 * rollout reconstruction must stay free of the compact subsystem's
 * runtime dependencies.
 *
 * **Divergence from agenc runtime (documented per invariant policy).** agenc runtime
 * bounds the packed user-message slice with
 * `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` (compact.rs:44) using
 * `approx_token_count`. AgenC does not have a synchronous tokenizer
 * wired here, so we bound with `DEFAULT_MAX_TOOL_RESULT_BYTES`
 * (400 KB) instead. Both caps target the same safety property — a
 * single oversized user prompt cannot blow replay — but the byte cap
 * is looser for short high-token-density text (CJK, dense code) and
 * tighter for long ASCII prose. When AgenC lands a shared token
 * estimator (see feature matrix token-budget items), swap in an
 * equivalent 20k-token cap here and update the feature matrix note.
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
