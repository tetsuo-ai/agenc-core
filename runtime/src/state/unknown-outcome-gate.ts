/**
 * Unknown-outcome mutation gate (M4, frozen contract run-contracts.ts:
 * "`unknown_outcome` is terminal-but-unresolved: dependent mutations stop,
 * review is required, and no automatic replay may occur").
 *
 * A `poisoned` in-flight tool call is a side effect whose outcome the daemon
 * cannot prove (the acknowledgement was lost in a crash window). Until a
 * reviewer explicitly resolves it, recording a NEW side-effecting tool call
 * in the same session is refused — the runtime must not stack possibly-
 * duplicate mutations on top of an unproven one. Idempotent and interactive
 * calls are not gated: replays are safe by contract and interactive calls
 * carry their own human in the loop.
 *
 * Enforcement points:
 *   - `recordInFlightToolCallStart` (the durable commit point) enforces the
 *     gate by default and throws {@link UnknownOutcomeMutationBlockedError}.
 *   - The daemon's snapshot observer records already-dispatched calls with
 *     `unknownOutcomeGate: "flag"` — it cannot un-dispatch a running tool,
 *     so the violation is recorded into the session snapshot instead of
 *     silently bypassed.
 *   - `checkUnknownOutcomeMutationGate` is the check the M3 admission
 *     kernel consults BEFORE dispatching (pre-dispatch integration is M3
 *     scope; this module is its ready-made dependency).
 *
 * Resolution is explicit review, never automatic:
 * `resolveUnknownOutcomeEffect` (surfaced as
 * `agenc state resolve-tool-call <session-id> <tool-call-id>`) marks the
 * effect `unknown_resolved` — terminal, no longer re-surfaced by recovery,
 * and the gate lifts.
 */

import type { StateSqliteDriver } from "./sqlite-driver.js";
import type { ToolRecoveryCategory } from "../tools/types.js";

/** Terminal status written by explicit review of an unknown-outcome effect. */
export const UNKNOWN_RESOLVED_TOOL_CALL_STATUS = "unknown_resolved" as const;

export interface UnresolvedUnknownOutcomeEffect {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
}

export type UnknownOutcomeGateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly blocking: readonly UnresolvedUnknownOutcomeEffect[];
    };

export class UnknownOutcomeMutationBlockedError extends Error {
  readonly code = "UNKNOWN_OUTCOME_MUTATION_BLOCKED" as const;
  readonly sessionId: string;
  readonly blocking: readonly UnresolvedUnknownOutcomeEffect[];

  constructor(
    sessionId: string,
    blocking: readonly UnresolvedUnknownOutcomeEffect[],
  ) {
    const summary = blocking
      .map((effect) => `${effect.toolCallId} (${effect.toolName})`)
      .join(", ");
    super(
      `session ${sessionId} has ${blocking.length} unresolved unknown-outcome ` +
        `effect(s) [${summary}]; new side-effecting tool calls are blocked ` +
        `until each is reviewed and resolved with ` +
        `\`agenc state resolve-tool-call ${sessionId} <tool-call-id>\``,
    );
    this.name = "UnknownOutcomeMutationBlockedError";
    this.sessionId = sessionId;
    this.blocking = blocking;
  }
}

/** Unresolved (poisoned) unknown-outcome effects recorded for a session. */
export function listUnresolvedUnknownOutcomeEffects(
  driver: StateSqliteDriver,
  sessionId: string,
): readonly UnresolvedUnknownOutcomeEffect[] {
  return driver
    .prepareState<
      [string],
      {
        session_id?: string;
        tool_call_id?: string;
        tool_name?: string;
        started_at?: string;
      }
    >(
      `SELECT session_id, tool_call_id, tool_name, started_at
       FROM in_flight_tool_calls
       WHERE session_id = ? AND status = 'poisoned'
       ORDER BY started_at ASC, tool_call_id ASC`,
    )
    .all(sessionId)
    .map((row) => ({
      sessionId: row.session_id ?? sessionId,
      toolCallId: row.tool_call_id ?? "",
      toolName: row.tool_name ?? "",
      startedAt: row.started_at ?? "",
    }));
}

/**
 * Decide whether a new tool call of `recoveryCategory` may be recorded /
 * dispatched for `sessionId`. Only side-effecting mutations are gated.
 * The category must already be normalized (callers use
 * `normalizeToolRecoveryCategory`); this module deliberately does not
 * import the normalizer to keep the dependency one-directional.
 */
export function checkUnknownOutcomeMutationGate(
  driver: StateSqliteDriver,
  options: {
    readonly sessionId: string;
    readonly recoveryCategory: ToolRecoveryCategory;
  },
): UnknownOutcomeGateDecision {
  if (options.recoveryCategory !== "side-effecting") return { allowed: true };
  const blocking = listUnresolvedUnknownOutcomeEffects(
    driver,
    options.sessionId,
  );
  if (blocking.length === 0) return { allowed: true };
  return { allowed: false, blocking };
}

/**
 * Explicit review resolution: mark one poisoned effect `unknown_resolved`.
 * Returns true when a poisoned row was resolved; false when no such
 * unresolved effect exists (already resolved, unknown id, or not poisoned).
 * Never touches rows in any other status — resolution applies only to
 * effects that are actually awaiting review.
 */
export function resolveUnknownOutcomeEffect(
  driver: StateSqliteDriver,
  options: { readonly sessionId: string; readonly toolCallId: string },
): boolean {
  const result = driver
    .prepareState<[string, string, string]>(
      `UPDATE in_flight_tool_calls
       SET status = ?
       WHERE session_id = ? AND tool_call_id = ? AND status = 'poisoned'`,
    )
    .run(
      UNKNOWN_RESOLVED_TOOL_CALL_STATUS,
      options.sessionId,
      options.toolCallId,
    );
  return result.changes > 0;
}
