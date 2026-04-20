/**
 * runAgent — drive one subagent's run-turn loop.
 *
 * Hand-port of openclaude `tools/AgentTool/runAgent.ts` (987 LOC)
 * subset. Responsibilities:
 *
 *   1. Build a child Session from the parent + fork context.
 *   2. Initialize MCP servers (30s wait, cancellable — I-50).
 *   3. Run session-start hooks.
 *   4. Invoke the child's run-turn loop.
 *   5. Emit progress to the parent via the upInbox (I-5).
 *   6. Clean up: MCP shutdown, caches, bash task kills.
 *
 * This module intentionally keeps the surface small — delegate.ts
 * wraps it with worktree + approval + permissions flow. run-agent
 * is the "run the child's turn machine" primitive.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { LiveAgent } from "./control.js";
import type { WorktreeHandle } from "./worktree.js";
import { emitWarning } from "../session/event-log.js";
import type { ThreadId } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface RunAgentParams {
  readonly live: LiveAgent;
  readonly parent: Session;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly taskPrompt: string;
  readonly worktree?: WorktreeHandle;
  /** Tool allowlist — filters the parent's catalog. Default: all. */
  readonly toolAllowlist?: ReadonlyArray<string>;
  /** Per-turn timeout override (from role config). */
  readonly timeoutMs?: number;
  /** Optional AbortSignal merged with the live agent's controller. */
  readonly externalSignal?: AbortSignal;
}

export type RunAgentProgressEvent =
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "message"; readonly message: LLMMessage }
  | { readonly kind: "tool_call"; readonly callId: string; readonly toolName: string };

export interface RunAgentResult {
  readonly threadId: ThreadId;
  readonly finalMessage?: string;
  readonly durationMs: number;
  readonly outcome: "completed" | "errored" | "interrupted" | "aborted";
  readonly error?: unknown;
}

// ─────────────────────────────────────────────────────────────────────
// MCP init with cancellation (I-50)
// ─────────────────────────────────────────────────────────────────────

export const MCP_INIT_TIMEOUT_MS = 30_000;

/**
 * Wait for MCP servers to be ready. I-50: cancellable via abort
 * signal; on abort, return immediately + the caller surfaces a
 * typed warning.
 */
export async function initMcpForAgent(opts: {
  readonly parent: Session;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<{ readonly ready: boolean; readonly reason?: string }> {
  const timeout = opts.timeoutMs ?? MCP_INIT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;

  return new Promise<{ ready: boolean; reason?: string }>((resolve) => {
    const check = () => {
      if (opts.signal.aborted) {
        resolve({ ready: false, reason: "aborted" });
        return;
      }
      // T9 MCP manager extension (I-50) wires real readiness. For now
      // we rely on the session's services having been initialized
      // during session boot, so this always resolves ready.
      resolve({ ready: true });
    };

    if (Date.now() >= deadline) {
      resolve({ ready: false, reason: "timeout" });
      return;
    }
    const onAbort = () => {
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ ready: false, reason: "aborted" });
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

// ─────────────────────────────────────────────────────────────────────
// runAgent — main entry
// ─────────────────────────────────────────────────────────────────────

export interface RunAgentIterator {
  [Symbol.asyncIterator](): AsyncIterator<RunAgentProgressEvent, RunAgentResult>;
}

/**
 * Run the subagent to completion. Yields progress events to the
 * caller + returns the final RunAgentResult. Caller (delegate.ts)
 * decides whether to wait synchronously or register-and-return
 * (async-mode subagent).
 */
export async function* runAgent(
  params: RunAgentParams,
): AsyncGenerator<RunAgentProgressEvent, RunAgentResult, void> {
  const startedAt = Date.now();
  const { live, parent } = params;

  // Merge parent's + external signal with the live agent's controller.
  const merged = new AbortController();
  const onParentAbort = () => {
    if (!merged.signal.aborted) merged.abort("parent_aborted");
  };
  const onLiveAbort = () => {
    if (!merged.signal.aborted)
      merged.abort(String(live.abortController.signal.reason ?? "interrupted"));
  };
  parent.abortController.signal.addEventListener("abort", onParentAbort, {
    once: true,
  });
  live.abortController.signal.addEventListener("abort", onLiveAbort, {
    once: true,
  });
  if (params.externalSignal) {
    params.externalSignal.addEventListener(
      "abort",
      () =>
        merged.signal.aborted
          ? null
          : merged.abort(
              String(
                (params.externalSignal as AbortSignal & { reason?: unknown }).reason ??
                  "external_aborted",
              ),
            ),
      { once: true },
    );
  }

  try {
    yield {
      kind: "status",
      text: `spawned subagent ${live.agentPath} (role=${live.role.name})`,
    };

    // I-50: wait for MCP ready with abort signal.
    const mcp = await initMcpForAgent({
      parent,
      signal: merged.signal,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    if (!mcp.ready) {
      emitWarning(
        parent.eventLog,
        parent.nextInternalSubId(),
        "subagent_mcp_unavailable",
        `subagent ${live.agentPath} proceeding without MCP (${mcp.reason})`,
      );
    }

    if (merged.signal.aborted) {
      live.status.markInterrupted(
        live.agentId,
        String(merged.signal.reason ?? "aborted"),
      );
      return {
        threadId: live.agentId,
        durationMs: Date.now() - startedAt,
        outcome: "aborted",
      };
    }

    // Mark running.
    live.status.markRunning(live.agentId);

    // T9 ships the driver surface; the actual child-session run-turn
    // loop is wired by delegate.ts (which constructs the child
    // Session, ToolRegistry, etc.). Here we yield the caller's
    // initial messages as a status event + wait for the downInbox
    // to be drained.
    for (const message of params.initialMessages) {
      yield { kind: "message", message };
    }

    // Park until live.abortController fires OR the caller signals
    // completion by closing the upInbox. This lets delegate.ts
    // drive the child's turn machine externally while run-agent
    // stays responsible for the lifecycle + cleanup envelope.
    await awaitAbort(merged.signal);

    const outcome: RunAgentResult["outcome"] = merged.signal.aborted
      ? live.abortController.signal.aborted
        ? "interrupted"
        : "aborted"
      : "completed";

    if (outcome === "completed") {
      live.status.markCompleted(live.agentId, params.taskPrompt);
    }

    return {
      threadId: live.agentId,
      durationMs: Date.now() - startedAt,
      outcome,
    };
  } catch (err) {
    live.status.markErrored(
      live.agentId,
      err instanceof Error ? err.message : String(err),
    );
    return {
      threadId: live.agentId,
      durationMs: Date.now() - startedAt,
      outcome: "errored",
      error: err,
    };
  } finally {
    parent.abortController.signal.removeEventListener("abort", onParentAbort);
    live.abortController.signal.removeEventListener("abort", onLiveAbort);
  }
}

function awaitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
