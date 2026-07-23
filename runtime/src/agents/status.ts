/**
 * AgentStatus — subagent lifecycle FSM.
 *
 * Hand-port of reference runtime `core/src/agent/status.rs` (27 LOC). Tracks the
 * state transitions of a spawned subagent from creation through
 * terminal states.
 *
 * Final states for wait/list semantics: `completed`, `errored`, `shutdown`,
 * `not_found`.
 * Non-final: `pending_init`, `running`, `idle`, `interrupted`.
 *
 * `idle` is a keep-alive worker between turns: alive and reusable, but not
 * actively working. `assign_task` admits work only in this state and moves the
 * worker back to `running`; `completed` remains terminal and is not reusable.
 *
 * Shutdown, errored, and not_found remain irreversible.
 *
 * `interrupted` is intentionally non-final (matches reference runtime
 * `status.rs` — `is_final` returns false for `Running | PendingInit |
 * Interrupted`). Completion watchers must loop past an interrupt
 * until a truly terminal state arrives.
 *
 * @module
 */

import { BehaviorSubject } from "./_deps/behavior-subject.js";
import { monotonicMs } from "./_deps/monotonic.js";

export type AgentStatus =
  | { readonly status: "pending_init" }
  | {
      readonly status: "running";
      readonly turnId: string;
      readonly startedAtMs: number;
    }
  | {
      // Keep-alive worker that finished a turn and is waiting for more work.
      // Non-final (like `running`) so wait/list semantics keep watching, and
      // reversible so a later assign_task turn can mark it `running` again.
      readonly status: "idle";
      readonly turnId: string;
      readonly endedAtMs: number;
    }
  | {
      readonly status: "completed";
      readonly turnId: string;
      readonly endedAtMs: number;
      readonly lastMessage?: string;
    }
  | {
      readonly status: "errored";
      readonly turnId: string;
      readonly endedAtMs: number;
      readonly error: string;
    }
  | { readonly status: "shutdown"; readonly endedAtMs: number }
  | { readonly status: "not_found" }
  | {
      readonly status: "interrupted";
      readonly turnId: string;
      readonly endedAtMs: number;
      readonly reason: string;
    };

export type AgentStatusJson =
  | "pending_init"
  | "running"
  | "idle"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { readonly completed: string | null }
  | { readonly errored: string };

const FINAL_STATES: ReadonlySet<AgentStatus["status"]> = new Set([
  "completed",
  "errored",
  "shutdown",
  "not_found",
]);

const IRREVERSIBLE_STATES: ReadonlySet<AgentStatus["status"]> = new Set([
  "completed",
  "errored",
  "shutdown",
  "not_found",
]);

export function isFinal(status: AgentStatus): boolean {
  return FINAL_STATES.has(status.status);
}

/**
 * Hand-port of reference `agent_status_from_event` (status.rs:6-21).
 * Maps an `EventMsg` to the AgentStatus the FSM should transition to,
 * or `undefined` if the event doesn't drive a status change.
 *
 * Reference mapping:
 *   - TurnStarted               -> Running
 *   - TurnComplete              -> Completed(last_agent_message)
 *   - TurnAborted(Interrupted   -> Interrupted
 *                |BudgetLimited)
 *   - TurnAborted(other)        -> Errored(reason)
 *   - Error                     -> Errored(message)
 *   - ShutdownComplete          -> Shutdown
 *   - else                      -> None
 *
 * AgenC's TurnAbortedEvent.reason is a free-text string; the mapper
 * recognizes the two reference interrupt-class reasons and treats anything
 * else as an errored transition.
 */
export function agentStatusFromEvent(event: {
  readonly type: string;
  readonly payload?: unknown;
}): AgentStatus | undefined {
  switch (event.type) {
    case "turn_started": {
      const payload =
        (event.payload as {
          turnId?: string;
          startedAt?: number;
        }) ?? {};
      return {
        status: "running",
        turnId: payload.turnId ?? "",
        startedAtMs: payload.startedAt ?? Date.now(),
      };
    }
    case "turn_complete": {
      const payload =
        (event.payload as {
          turnId?: string;
          lastAgentMessage?: string;
          completedAt?: number;
        }) ?? {};
      return {
        status: "completed",
        turnId: payload.turnId ?? "",
        endedAtMs: payload.completedAt ?? Date.now(),
        ...(payload.lastAgentMessage !== undefined
          ? { lastMessage: payload.lastAgentMessage }
          : {}),
      };
    }
    case "turn_aborted": {
      const payload =
        (event.payload as {
          turnId?: string;
          reason?: string;
        }) ?? {};
      const reason = (payload.reason ?? "").toLowerCase();
      const isInterruptClass =
        reason.includes("interrupt") || reason.includes("budget");
      const endedAtMs = Date.now();
      if (isInterruptClass) {
        return {
          status: "interrupted",
          turnId: payload.turnId ?? "",
          endedAtMs,
          reason: payload.reason ?? "interrupted",
        };
      }
      return {
        status: "errored",
        turnId: payload.turnId ?? "",
        endedAtMs,
        error: payload.reason ?? "errored",
      };
    }
    case "error": {
      const payload =
        (event.payload as {
          turnId?: string;
          message?: string;
        }) ?? {};
      return {
        status: "errored",
        turnId: payload.turnId ?? "",
        endedAtMs: Date.now(),
        error: payload.message ?? "error",
      };
    }
    default:
      return undefined;
  }
}

export function toAgentStatusJson(status: AgentStatus): AgentStatusJson {
  switch (status.status) {
    case "pending_init":
      return "pending_init";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "completed":
      return { completed: status.lastMessage ?? null };
    case "errored":
      return { errored: status.error };
    case "shutdown":
      return "shutdown";
    case "not_found":
      return "not_found";
  }
}

export function formatSubagentNotification(params: {
  readonly agentPath: string;
  readonly status: AgentStatus;
  readonly durableOutcomeRef?: {
    readonly projection_id: string;
    readonly agent_id: string;
    readonly turn_id: string;
    readonly task_id?: string;
    readonly rollout_path?: string;
  };
  readonly receipt?: {
    readonly lifecycle: "turn";
    readonly outcome: "completed" | "errored" | "interrupted" | "nack";
    readonly turn_id: string;
    readonly task_id?: string;
    readonly tool_call_count: number;
    readonly message?: string;
    readonly reason?: string;
    readonly worktree?: {
      readonly state:
        | "committed_clean"
        | "unchanged_clean"
        | "dirty_uncommitted"
        | "diverged"
        | "unverifiable";
      readonly path: string;
      readonly branch: string;
      readonly git_root: string;
      readonly base_commit?: string;
      readonly head_commit?: string;
      readonly tree_hash?: string;
      readonly clean?: boolean;
      readonly base_is_ancestor?: boolean;
      readonly integration_ref?: string;
      readonly error?: string;
    };
  };
}): string {
  const payload = JSON.stringify({
    agent_path: params.agentPath,
    status: toAgentStatusJson(params.status),
    ...(params.receipt !== undefined ? { receipt: params.receipt } : {}),
    ...(params.durableOutcomeRef !== undefined
      ? { durable_outcome_ref: params.durableOutcomeRef }
      : {}),
  })
    // Keep model-controlled prose from terminating the outer framing. JSON
    // Unicode escapes preserve the exact decoded value for real parsers.
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return `<subagent_notification>\n${payload}\n</subagent_notification>`;
}

/**
 * Per-agent status tracker. Subscribers receive a replay of the
 * current state + every subsequent mutation.
 */
export class AgentStatusTracker {
  readonly subject: BehaviorSubject<AgentStatus>;

  constructor(initial: AgentStatus = { status: "pending_init" }) {
    this.subject = new BehaviorSubject<AgentStatus>(initial);
  }

  get value(): AgentStatus {
    return this.subject.value;
  }

  markRunning(turnId: string): void {
    this.set({ status: "running", turnId, startedAtMs: monotonicMs() });
  }

  markIdle(turnId: string): void {
    this.set({ status: "idle", turnId, endedAtMs: monotonicMs() });
  }

  markCompleted(turnId: string, lastMessage?: string): void {
    this.set({
      status: "completed",
      turnId,
      endedAtMs: monotonicMs(),
      ...(lastMessage !== undefined ? { lastMessage } : {}),
    });
  }

  markErrored(turnId: string, error: string): void {
    this.set({
      status: "errored",
      turnId,
      endedAtMs: monotonicMs(),
      error,
    });
  }

  /**
   * Canonical journal/close failure supersedes an already-completed task
   * terminal at the worker lifecycle level. This is deliberately narrower
   * than reopening normal completed agents for reuse.
   */
  markDurabilityErrored(turnId: string, error: string): void {
    this.subject.next({
      status: "errored",
      turnId,
      endedAtMs: monotonicMs(),
      error,
    });
  }

  markInterrupted(turnId: string, reason: string): void {
    this.set({
      status: "interrupted",
      turnId,
      endedAtMs: monotonicMs(),
      reason,
    });
  }

  markShutdown(): void {
    this.set({ status: "shutdown", endedAtMs: monotonicMs() });
  }

  subscribe(listener: (status: AgentStatus) => void): () => void {
    return this.subject.subscribe(listener);
  }

  changes(): AsyncIterable<AgentStatus> {
    return this.subject.changes();
  }

  complete(): void {
    this.subject.complete();
  }

  private set(status: AgentStatus): void {
    // Only irreversible states are sticky. Control-plane admission separately
    // enforces idle-only reuse, so a completed live handle cannot accept work.
    if (IRREVERSIBLE_STATES.has(this.subject.value.status)) return;
    this.subject.next(status);
  }
}
