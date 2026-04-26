/**
 * Per-session attachment-tracking state.
 *
 * Hand-port of openclaude `bootstrap/state.ts:1622-1626 + :1333-1346`,
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
  /** Hash of the agent listing last announced. */
  lastAgentListingHash?: string;
  /** Hash of the MCP server instructions last announced. */
  lastMcpInstructionsHash?: string;
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
    };
    sessionAttachmentState.set(sessionKey, state);
  }
  return state;
}

/** Clears all tracking state for a session. Test-only. */
export function _resetAttachmentTrackingStateForTest(sessionKey: object): void {
  sessionAttachmentState.delete(sessionKey);
}
