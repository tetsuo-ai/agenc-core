/**
 * `querySubagent` — recursive async-generator entry point for
 * subagent execution (Phase K of the 16-phase refactor in
 * TODO.MD).
 *
 * A subagent spawn is a recursive `executeChat()` call with a
 * restricted tool surface, a scoped system prompt, and a
 * derived execution context. The wrapper yields the child's
 * events up to the parent stream (so a parent webchat or
 * background run can display nested progress) and returns the
 * child's `Terminal` on completion.
 *
 * Phase K wire-up strategy
 * -------------------------
 * The existing subagent stack in `sub-agent.ts` spawns a
 * dedicated `ChatExecutor` instance per subagent and calls
 * `executor.execute()` directly inside a `raceAbort()` wrapper.
 * Phase E migrated every OTHER production caller to drain the
 * generator, but `sub-agent.ts:831` was deliberately skipped
 * because collapsing the subagent stack is a multi-session job.
 *
 * This PR lands the recursive wrapper as ADDITIVE infrastructure:
 * the new `querySubagent` function is available for callers that
 * want to spawn a subagent through the generator surface, but
 * `sub-agent.ts` is not yet migrated to use it. The migration
 * happens in a follow-up PR that also deletes or shrinks the
 * supporting machinery in `subagent-orchestrator.ts`,
 * `subagent-prompt-builder.ts`, etc. — the work that TODO.MD
 * Phase K estimated at ~6,500 LOC.
 *
 * @module
 */

import { executeChat } from "../llm/execute-chat.js";
import type { ChatExecutor } from "../llm/chat-executor.js";
import type {
  ChatExecuteParams,
  ChatExecutorResult,
} from "../llm/chat-executor-types.js";
import type {
  ExecuteChatYield,
  Terminal,
} from "../llm/streaming-events.js";

/**
 * Spec for a single subagent invocation. Callers build this from
 * whatever delegation contract they are honoring (admission
 * result, preflight scope, etc.) and pass it to `querySubagent`.
 * The spec is intentionally thin — rich contract plumbing lives
 * in `sub-agent.ts` and `delegation-admission.ts` and converts
 * INTO this shape at the last moment before dispatch.
 */
export interface SubagentQuerySpec {
  /** The subagent's own session id. */
  readonly sessionId: string;
  /** Parent session id (for lineage / tracing). */
  readonly parentSessionId?: string;
  /**
   * Execution parameters passed straight through to `executeChat`.
   * Callers are responsible for scoping these correctly:
   * `allowedTools`, `toolRouting`, `requiredToolEvidence`,
   * workspace root, abort signal, and max tool rounds should
   * already reflect the subagent's permission envelope.
   */
  readonly params: ChatExecuteParams;
}

/**
 * Result emitted alongside the generator's final `Terminal`.
 */
export interface SubagentQueryResult {
  readonly terminal: Terminal;
  /**
   * The underlying legacy `ChatExecutorResult` as carried through
   * the Phase C adapter's `Terminal.legacyResult` field. Present
   * until Phase F proper extracts the class body — callers that
   * need fields like `toolRoutingSummary`, `plannerSummary`,
   * `statefulSummary`, `economicsSummary`, `completionState`,
   * `stopReason`, etc. read them from here.
   */
  readonly legacyResult?: ChatExecutorResult;
}

/**
 * Recursive subagent entry point. Drives `executeChat` against a
 * subagent spec and yields the child's events to the caller. The
 * generator's `return` value (the `Terminal`) pairs with
 * `buildSubagentQueryResult` below to reconstruct the legacy
 * result shape the existing `sub-agent.ts` bookkeeping expects.
 *
 * Use this when you want the subagent's events (request_start,
 * stream_chunk, assistant, tool_result, tombstone) to bubble up
 * through the parent's generator stream. If the caller only
 * needs the final result and does not care about nested events,
 * `runSubagentToLegacyResult` below is the simpler entry point.
 */
export async function* querySubagent(
  chatExecutor: ChatExecutor,
  spec: SubagentQuerySpec,
): AsyncGenerator<ExecuteChatYield, Terminal, void> {
  const child = executeChat(chatExecutor, spec.params);
  // Forward every event from the child generator to the caller.
  // The generator contract ensures that when `child.return` fires,
  // its terminal value becomes this generator's return value too.
  let step = await child.next();
  while (!step.done) {
    yield step.value;
    step = await child.next();
  }
  return step.value;
}

/**
 * Convenience wrapper for callers that drain the subagent
 * generator and only want the final result shape. This is the
 * Phase K migration helper equivalent to
 * `executeChatToLegacyResult` but scoped to subagent spawns —
 * future `sub-agent.ts:831` migration will call this.
 */
export async function runSubagentToLegacyResult(
  chatExecutor: ChatExecutor,
  spec: SubagentQuerySpec,
): Promise<SubagentQueryResult> {
  const generator = querySubagent(chatExecutor, spec);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await generator.next();
    if (step.done) {
      const terminal = step.value;
      const result: SubagentQueryResult = terminal.legacyResult
        ? { terminal, legacyResult: terminal.legacyResult }
        : { terminal };
      if (terminal.error) throw terminal.error;
      return result;
    }
    // Events drained but not yielded further — this path is for
    // callers that want the final result without nested event
    // bubbling. Callers that DO want the events should iterate
    // `querySubagent` directly via `for await`.
  }
}
