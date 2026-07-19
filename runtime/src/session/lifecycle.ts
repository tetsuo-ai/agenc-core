/**
 * Session lifecycle orchestration — the one callsite that drives
 * both the T9 subagent control plane AND the T9 MCP manager AND
 * the existing Session.shutdown() drain.
 *
 * The T5 `Session.shutdown()` already drains `childInboxes` under
 * `MAX_DRAIN_MS=2000` (I-87) and closes rollout + event log + txEvent.
 * What it does NOT do is cascade a shutdown into the T9 `AgentControl`
 * subsystem or stop the T9 `MCPManager`. That's this module's job.
 *
 * Invariants wired:
 *   I-33 (async-child unread mailbox drain on session exit) — delegated
 *        to `Session.shutdown()`, but sequenced after AgentControl has
 *        cascaded a shutdown signal so children don't refill mailboxes
 *        mid-drain.
 *   I-87 (async-child drain timeout, MAX_DRAIN_MS=2000) — the
 *        `Session.shutdown()` race is authoritative; here we add an
 *        outer budget for the full lifecycle teardown.
 *   I-50 (MCP startup wait cancellable) — lifecycle.stop() cancels the
 *        MCP startup token if boot is still in flight.
 *   I-6  (MCP fail-soft) — MCP manager stop is best-effort; errors
 *        emit warnings, don't block shutdown.
 *
 * @module
 */

import type { AgentControl } from "../agents/control.js";
import type { MCPManager } from "../mcp-client/manager.js";
import { monotonicMs } from "./_deps/utils.js";
import { emitWarning } from "./event-log.js";
import type { Session } from "./session.js";

/** Outer monotonic budget for the full lifecycle teardown (ms). */
export const SESSION_LIFECYCLE_SHUTDOWN_BUDGET_MS = 5_000;

export interface SessionLifecycleOpts {
  readonly session: Session;
  readonly agentControl?: AgentControl;
  readonly mcpManager?: MCPManager;
  /** Override budget for testing (ms). */
  readonly shutdownBudgetMs?: number;
}

/**
 * Orderly session shutdown:
 *   1. Quiesce the top-level abort controller (I-7) with a benign
 *      reason so phases see a shutdown signal.
 *   2. Abort and drain the root session's active task while its journal is open.
 *   3. Cascade-shutdown every live subagent tree via `AgentControl.shutdownAll`.
 *   4. Close live unified exec processes.
 *   5. Delegate to `Session.shutdown()` (drain childInboxes + close
 *      rollout + event log + txEvent).
 *   6. Stop the MCP manager (close all bridges + kill child procs).
 *
 * The whole teardown is bounded by `shutdownBudgetMs`. Any step that
 * exceeds the budget emits a warning event + moves on — we prefer
 * exiting with a complaint over hanging forever.
 */
export async function shutdownSessionLifecycle(
  opts: SessionLifecycleOpts,
): Promise<void> {
  const budgetMs =
    opts.shutdownBudgetMs ?? SESSION_LIFECYCLE_SHUTDOWN_BUDGET_MS;
  const deadlineMs = monotonicMs() + budgetMs;

  // Step 1: quiesce.
  if (!opts.session.abortController.signal.aborted) {
    opts.session.abortController.abort("session_shutdown");
  }

  // Step 2: settle the root task, including any permission/effect
  // continuations, before a background-run terminal can seal the journal.
  const abortAllTasks = (
    opts.session as Session & {
      abortAllTasks?: (reason: "interrupted") => Promise<void>;
    }
  ).abortAllTasks;
  if (typeof abortAllTasks === "function") {
    await raceBudget(
      abortAllTasks.call(opts.session, "interrupted"),
      deadlineMs,
      "session_active_task_shutdown",
      opts.session,
    );
  }

  // Step 3: cascade subagent shutdown (I-33 ordering — must happen
  // before Session.shutdown() drain, else children can refill mailboxes).
  if (opts.agentControl) {
    await raceBudget(
      opts.agentControl.shutdownAll("session_shutdown"),
      deadlineMs,
      "agent_control_shutdown",
      opts.session,
    );
  }

  const unifiedExecManager = (
    opts.session as {
      readonly services?: {
        readonly unifiedExecManager?: {
          readonly closeAll?: (reason?: string) => Promise<void>;
        };
      };
    }
  ).services?.unifiedExecManager;
  if (unifiedExecManager?.closeAll) {
    // Step 4: live terminal shutdown.
    await raceBudget(
      unifiedExecManager.closeAll("session_shutdown"),
      deadlineMs,
      "unified_exec_shutdown",
      opts.session,
    );
  }

  // Step 5: I-33 + I-87 mailbox drain via Session.shutdown().
  await raceBudget(
    opts.session.shutdown(),
    deadlineMs,
    "session_inner_shutdown",
    opts.session,
  );

  // Step 6: MCP manager stop (best-effort; I-6 fail-soft).
  if (opts.mcpManager) {
    try {
      await raceBudget(
        opts.mcpManager.stop(),
        deadlineMs,
        "mcp_manager_stop",
        opts.session,
      );
    } catch (err) {
      emitWarning(
        opts.session.eventLog,
        opts.session.nextInternalSubId(),
        "mcp_stop_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

async function raceBudget(
  task: Promise<void>,
  deadlineMs: number,
  step: string,
  session: Session,
): Promise<void> {
  const remaining = Math.max(0, deadlineMs - monotonicMs());
  if (remaining <= 0) {
    emitWarning(
      session.eventLog,
      session.nextInternalSubId(),
      "shutdown_budget_exceeded",
      `${step}: no budget remaining; skipping wait`,
    );
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), remaining);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      task.then(() => "done" as const).catch((err) => {
        emitWarning(
          session.eventLog,
          session.nextInternalSubId(),
          `${step}_failed`,
          err instanceof Error ? err.message : String(err),
        );
        return "done" as const;
      }),
      timeout,
    ]);
    if (outcome === "timeout") {
      emitWarning(
        session.eventLog,
        session.nextInternalSubId(),
        "shutdown_step_timeout",
        `${step}: exceeded remaining budget (${remaining}ms)`,
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
