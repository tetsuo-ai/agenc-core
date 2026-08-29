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
 *   6. Await the MCP service disposal started at the shutdown boundary (or
 *      stop the concrete manager for compatibility-only callers).
 *
 * The whole teardown is bounded by `shutdownBudgetMs`. Any step that exceeds
 * the budget attempts a best-effort warning and moves on. Once the canonical
 * journal is sealed, that diagnostic may be dropped but teardown still cannot
 * reject or hang.
 */
export async function shutdownSessionLifecycle(
  opts: SessionLifecycleOpts,
): Promise<void> {
  const budgetMs =
    opts.shutdownBudgetMs ?? SESSION_LIFECYCLE_SHUTDOWN_BUDGET_MS;
  const deadlineMs = monotonicMs() + budgetMs;

  // Step 1: synchronously close startup admission and cancel MCP startup
  // before any awaited teardown step leaves a race window.
  const startupLifecycle = opts.session as Session & {
    beginShutdown?: () => void;
    drainDeferredStartupForShutdown?: () => Promise<void>;
    prepareOwnedMcpDisposalForShutdown?: (
      retryDeadlineMs: number,
    ) => Promise<void> | undefined;
  };
  startupLifecycle.beginShutdown?.();
  const ownedMcpDisposeTask =
    startupLifecycle.prepareOwnedMcpDisposalForShutdown?.(deadlineMs);
  if (!opts.session.abortController.signal.aborted) {
    opts.session.abortController.abort("session_shutdown");
  }

  // Step 2: drain startup activation before taking the agent-control
  // snapshot. This prevents deferred job recovery from spawning a child after
  // shutdownAll has already passed.
  if (startupLifecycle.drainDeferredStartupForShutdown !== undefined) {
    await raceBudget(
      startupLifecycle.drainDeferredStartupForShutdown(),
      deadlineMs,
      "deferred_startup_shutdown",
      opts.session,
    );
  }

  // Step 3: settle the root task, including any permission/effect
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

  // Step 4: cascade subagent shutdown (I-33 ordering — must happen
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
    // Step 5: live terminal shutdown.
    await raceBudget(
      unifiedExecManager.closeAll("session_shutdown"),
      deadlineMs,
      "unified_exec_shutdown",
      opts.session,
    );
  }

  // Step 6: I-33 + I-87 mailbox drain via Session.shutdown().
  await raceBudget(
    opts.session.shutdown(),
    deadlineMs,
    "session_inner_shutdown",
    opts.session,
  );

  // Step 7: prove the service-owned transaction queue and concrete manager
  // are closed (best-effort; I-6 fail-soft).
  if (monotonicMs() >= deadlineMs) {
    emitLifecycleWarning(
      opts.session.eventLog,
      opts.session.nextInternalSubId(),
      "shutdown_budget_exceeded",
      "mcp_manager_stop: no budget remaining; skipping stop",
    );
    return;
  }
  let mcpStopTask = ownedMcpDisposeTask;
  if (mcpStopTask === undefined && opts.mcpManager !== undefined) {
    try {
      mcpStopTask = opts.mcpManager.stop();
    } catch (err) {
      emitLifecycleWarning(
        opts.session.eventLog,
        opts.session.nextInternalSubId(),
        "mcp_stop_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (mcpStopTask !== undefined) {
    await raceBudget(
      mcpStopTask,
      deadlineMs,
      "mcp_manager_stop",
      opts.session,
    );
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
    emitLifecycleWarning(
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
      task
        .then(() => "done" as const)
        .catch((err) => {
          emitLifecycleWarning(
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
      emitLifecycleWarning(
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

function emitLifecycleWarning(
  eventLog: Session["eventLog"],
  subId: string,
  cause: string,
  message: string,
): void {
  try {
    emitWarning(eventLog, subId, cause, message);
  } catch {
    // Session shutdown may already have sealed or closed the canonical
    // journal while an outer deadline expires. Diagnostics are best-effort at
    // that boundary and must never turn bounded teardown into a rejection.
  }
}
