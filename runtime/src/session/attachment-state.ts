/**
 * Per-session attachment-tracking state.
 *
 * Hand-port of agenc `bootstrap/state.ts:1622-1626 + :1333-1346`,
 * scoped to the AgenC session via WeakMap. Matches the existing AgenC
 * pattern in `runtime/src/prompts/memory/attachments.ts:47` (sessionBudgets)
 * and `runtime/src/prompts/memory/auto-save.ts:114`.
 *
 * Producers in `runtime/src/prompts/attachments/` read and update this
 * state across turns:
 *
 *   - `lastEmittedDate` — gates `date-change.ts` (one-shot per local day)
 *   - `lastDeferredToolsHash` — gates `deferred-tools-delta.ts`
 *   - `lastAgentListingHash` — gates `agent-listing-delta.ts`
 *   - `lastMcpInstructionsHash` — gates `mcp-delta.ts`
 *   - `pendingCriticalReminder` — one-shot, set by external producer,
 *     cleared by `critical-reminder.ts` on emission
 *   - `needsPlanModeExitAttachment` / `needsAutoModeExitAttachment` —
 *     raised by mode-transition handlers in `permissions/mode.ts`,
 *     cleared by the corresponding exit producer
 *   - `hasExitedPlanModeInSession` / `hasExitedAutoModeInSession` —
 *     persistent flags used by re-entry detection (drives
 *     `plan_mode_reentry` vs `plan_mode` variant choice)
 *
 * @module
 */

/**
 * Tracking fields owned by the per-turn attachments orchestrator.
 *
 * All fields are mutable because state mutates as attachments fire across
 * turns. The map is keyed by an opaque session identity (any object) and
 * is held weakly so sessions that go out of scope are garbage-collected
 * along with their tracking state.
 */
export interface AttachmentTrackingState {
  /** Last local-calendar-date the date_change attachment fired for. */
  lastEmittedDate?: string;
  /** Hash of the deferred-tools set last announced. */
  lastDeferredToolsHash?: string;
  /**
   * Full set of deferred-tool names last announced. Stored alongside the
   * hash so the producer can compute added/removed deltas without
   * rescanning the message history (AgenC reconstructs prior state
   * from prior `deferred_tools_delta` attachments in the transcript;
   * AgenC tracks it directly here).
   */
  lastDeferredToolsSet?: ReadonlySet<string>;
  /** Hash of the agent listing last announced. */
  lastAgentListingHash?: string;
  /**
   * Map of agent type → rendered description line last announced. Same
   * rationale as `lastDeferredToolsSet`: kept for direct delta computation
   * across turns instead of replaying message history.
   */
  lastAgentListingSet?: ReadonlyMap<string, string>;
  /** Hash of the MCP server instructions last announced. */
  lastMcpInstructionsHash?: string;
  /** Hash of the skill listing last announced to the model. */
  lastSkillListingHash?: string;
  /**
   * Map of MCP server name → instruction block last announced. Same
   * rationale as `lastDeferredToolsSet`. MCP instructions are immutable
   * for the lifetime of a connection (set once at handshake), so the
   * diff key is the server name.
   */
  lastMcpInstructionsMap?: ReadonlyMap<string, string>;
  /**
   * One-shot reminder content set by external runtime producers. Cleared
   * by `critical-reminder.ts` on emission. When populated, the next
   * `getAttachments()` call emits a `critical_system_reminder` attachment.
   */
  pendingCriticalReminder?: string;
  /**
   * Set by `permissions/mode.ts` when the session transitions out of plan
   * mode. Cleared by `plan-mode.ts` after the `plan_mode_exit` attachment
   * fires.
   */
  needsPlanModeExitAttachment: boolean;
  /**
   * Set by `permissions/mode.ts` when the session transitions out of auto
   * mode. Cleared by `auto-mode.ts` after the `auto_mode_exit` attachment
   * fires.
   */
  needsAutoModeExitAttachment: boolean;
  /**
   * Persistent: flips true on the first plan-mode exit in this session.
   * Drives the plan_mode_reentry vs plan_mode variant choice on later
   * re-entries.
   */
  hasExitedPlanModeInSession: boolean;
  /**
   * Persistent: flips true on the first auto-mode exit in this session.
   */
  hasExitedAutoModeInSession: boolean;
  /**
   * File paths whose surrounding instruction context should be checked by
   * the next nested-memory producer run. Populated by file tools, IDE
   * integrations, and @path mention extraction. Cleared after the
   * producer consumes it.
   */
  nestedMemoryAttachmentTriggers: Set<string>;
  /**
   * Non-evicting dedupe set for nested instruction/rule files already
   * injected into this session. Kept separate from FileRead's read cache
   * because the read cache can be cleared by compaction or local history
   * limits, while nested instructions should not be re-injected just
   * because an implementation cache was trimmed.
   */
  loadedNestedMemoryPaths: Set<string>;
  /**
   * Flips true on the first `relevant_memories` producer run of the
   * session. Gates the one-shot session-start recall path (project/CWD-
   * keyed memory injection when turn 0 carries no substantive query).
   */
  sessionStartMemoryRecallChecked: boolean;
  /**
   * Paths of learned memory files surfaced by `relevant_memories` in this
   * session. Relevant-memory recall is allowed to reset after compaction
   * in future, but a stable set prevents rapid same-session repeats today.
   */
  surfacedRelevantMemoryPaths: Set<string>;
  /**
   * Approximate bytes of learned memory content surfaced by
   * `relevant_memories` in this session. Bounds cumulative recall context
   * even when many distinct memory files match a long conversation.
   */
  surfacedRelevantMemoryBytes: number;
  /**
   * Memory mode for this thread/session. `disabled` blocks memory recall
   * and writes; `polluted` blocks writes/consolidation but still permits
   * recall from already-trusted memory.
   */
  memoryMode: "enabled" | "disabled" | "polluted";
  /**
   * Citation metadata for memory files surfaced this session. This is
   * intentionally metadata-only; renderers decide whether/how to expose it.
   */
  memoryCitations: Array<{
    readonly path: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly note: string;
    readonly rolloutIds: readonly string[];
  }>;
}

const sessionAttachmentState = new WeakMap<object, AttachmentTrackingState>();

/**
 * Returns the tracking state for the given session identity, lazily
 * initializing on first access. The returned object is mutable — callers
 * write fields directly to mutate cross-turn state.
 */
export function getAttachmentTrackingState(
  sessionKey: object,
): AttachmentTrackingState {
  let state = sessionAttachmentState.get(sessionKey);
  if (state === undefined) {
    state = {
      needsPlanModeExitAttachment: false,
      needsAutoModeExitAttachment: false,
      hasExitedPlanModeInSession: false,
      hasExitedAutoModeInSession: false,
      nestedMemoryAttachmentTriggers: new Set(),
      loadedNestedMemoryPaths: new Set(),
      sessionStartMemoryRecallChecked: false,
      surfacedRelevantMemoryPaths: new Set(),
      surfacedRelevantMemoryBytes: 0,
      memoryMode: "enabled",
      memoryCitations: [],
    };
    sessionAttachmentState.set(sessionKey, state);
  }
  return state;
}

/** Clears all tracking state for a session. Test-only. */
export function _resetAttachmentTrackingStateForTest(sessionKey: object): void {
  sessionAttachmentState.delete(sessionKey);
}
