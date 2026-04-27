/**
 * AgentStatus — subagent lifecycle FSM.
 *
 * Hand-port of AgenC runtime `core/src/agent/status.rs` (27 LOC). Tracks the
 * state transitions of a spawned subagent from creation through
 * terminal states.
 *
 * Final states: `completed`, `errored`, `shutdown`.
 * Non-final: `idle`, `running`, `interrupted`.
 *
 * `interrupted` is intentionally non-final (matches AgenC runtime
 * `status.rs` — `is_final` returns false for `Running | PendingInit |
 * Interrupted`). Completion watchers must loop past an interrupt
 * until a truly terminal state (`completed`, `errored`, `shutdown`)
 * arrives.
 *
 * @module
 */

import { BehaviorSubject } from "./_deps/behavior-subject.js";
import { monotonicMs } from "./_deps/monotonic.js";

export type AgentStatus =
  | { readonly status: "idle" }
  | {
      readonly status: "running";
      readonly turnId: string;
      readonly startedAtMs: number;
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
  | {
      readonly status: "interrupted";
      readonly turnId: string;
      readonly endedAtMs: number;
      readonly reason: string;
    };

const FINAL_STATES: ReadonlySet<AgentStatus["status"]> = new Set([
  "completed",
  "errored",
  "shutdown",
]);

export function isFinal(status: AgentStatus): boolean {
  return FINAL_STATES.has(status.status);
}

/**
 * Per-agent status tracker. Subscribers receive a replay of the
 * current state + every subsequent mutation.
 */
export class AgentStatusTracker {
  readonly subject: BehaviorSubject<AgentStatus>;

  constructor(initial: AgentStatus = { status: "idle" }) {
    this.subject = new BehaviorSubject<AgentStatus>(initial);
  }

  get value(): AgentStatus {
    return this.subject.value;
  }

  markRunning(turnId: string): void {
    this.set({ status: "running", turnId, startedAtMs: monotonicMs() });
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

  complete(): void {
    this.subject.complete();
  }

  private set(status: AgentStatus): void {
    // Only genuinely terminal states are sticky (`completed`,
    // `errored`, `shutdown`). `interrupted` is non-final — the
    // tracker may transition back to `running` (e.g. resume) or
    // onward to a truly terminal state.
    if (isFinal(this.subject.value)) return;
    this.subject.next(status);
  }
}
