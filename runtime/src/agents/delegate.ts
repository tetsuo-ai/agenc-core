/**
 * Delegate — the canonical subagent spawn dispatcher.
 *
 * Hand-port of the donor spawn-dispatcher subset. Public entry point for:
 *
 *   - Isolation setup (worktree create + bind CWD, or CWD-only)
 *   - Fork mode selection
 *   - Sync vs async mode routing
 *   - Teardown (worktree remove if clean, keep/remove choice if dirty)
 *
 * AgenC's T9 ships the single `delegate()` entry; the TUI command
 * layer (T11) wires it into slash commands. Async mode registers
 * the thread with AgentControl and returns immediately; sync mode
 * awaits completion.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { LLMMessage } from "../llm/types.js";
import type { LLMContentPart } from "../llm/types.js";
import type { AgentControl, LiveAgent } from "./control.js";
import type { AgentRegistry, AgentPath } from "./registry.js";
import type { ForkMode } from "./fork-context.js";
import type { WorktreeHandle } from "./worktree.js";
import type { AgentThread } from "./thread.js";
import type {
  ChildToolPolicy,
  RunAgentProgressEvent,
  RunAgentResult,
} from "./run-agent.js";
import type { ReasoningEffort } from "../session/turn-context.js";
import { emitWarning } from "../session/event-log.js";
import { AgentThread as AgentThreadClass } from "./thread.js";
import { forkSubagent } from "./fork-context.js";
import {
  getOrCreateWorktree,
  findGitRoot,
  hasWorktreeChanges,
  captureBaseCommit,
  removeAgentWorktree,
} from "./worktree.js";
import { runAgent } from "./run-agent.js";
import { ResumeManager } from "./resume.js";
import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../sandbox/execution-broker.js";

// ─────────────────────────────────────────────────────────────────────
// Delegate options
// ─────────────────────────────────────────────────────────────────────

export type IsolationMode = "none" | "cwd" | "worktree";

export interface DelegateOpts {
  readonly parent: Session;
  readonly parentPath: AgentPath;
  readonly control: AgentControl;
  readonly registry: AgentRegistry;
  readonly taskPrompt: string;
  readonly taskContent?: readonly LLMContentPart[];
  readonly role?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string;
  readonly isolation?: IsolationMode;
  readonly worktreeSlug?: string;
  readonly forkMode?: ForkMode;
  readonly parentMessagesOverride?: ReadonlyArray<LLMMessage>;
  readonly runInBackground?: boolean;
  readonly forceSynchronous?: boolean;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly childToolPolicy?: ChildToolPolicy;
  readonly depthCap?: number;
  readonly maxTurns?: number;
  readonly externalSignal?: AbortSignal;
  readonly silent?: boolean;
  readonly resumeManager?: ResumeManager;
  /**
   * Keep the agent's downInbox loop alive between turns instead of
   * exiting after the first task completes. Used by the daemon for TUI
   * agents so multiple message.stream calls land on the same live thread.
   */
  readonly keepAlive?: boolean;
  readonly onProgress?: (
    event: RunAgentProgressEvent,
    thread: AgentThread,
  ) => void | Promise<void>;
}

export type DelegateOutcome =
  | { readonly kind: "sync_completed"; readonly result: RunAgentResult; readonly thread: AgentThread }
  | { readonly kind: "async_launched"; readonly thread: AgentThread }
  | { readonly kind: "rejected"; readonly reason: string };

// ─────────────────────────────────────────────────────────────────────
// delegate — main entry
// ─────────────────────────────────────────────────────────────────────

export async function delegate(
  opts: DelegateOpts,
): Promise<DelegateOutcome> {
  const isolation = opts.isolation ?? "none";
  const forkMode = opts.forkMode;
  const runInBackground = opts.runInBackground ?? true;

  if (
    isolation === "worktree" &&
    (!opts.worktreeSlug || opts.worktreeSlug.trim().length === 0)
  ) {
    return {
      kind: "rejected",
      reason: 'worktree isolation requires a non-empty worktreeSlug',
    };
  }

  // Set up worktree if requested.
  let worktree: WorktreeHandle | undefined;
  let baseCommit: string | null = null;
  let worktreeSandboxExecutionBroker: SandboxExecutionBrokerLike | undefined;
  let preserveLiveAfterRoleProvenanceFailure = false;
  if (isolation === "worktree") {
    const worktreeSlug = opts.worktreeSlug!;
    const workspaceRoot =
      opts.parent.sessionConfiguration.cwd ||
      opts.parent.config.cwd ||
      process.cwd();
    const canonicalGitRoot = findGitRoot(workspaceRoot);
    if (!canonicalGitRoot) {
      return {
        kind: "rejected",
        reason: "worktree isolation requested but cwd is not inside a git repository",
      };
    }
    try {
      const parentSandboxExecutionBroker =
        opts.parent.services?.sandboxExecutionBroker;
      if (parentSandboxExecutionBroker === undefined) {
        throw missingSandboxExecutionBoundary("child_agent");
      }
      worktreeSandboxExecutionBroker =
        parentSandboxExecutionBroker.forkForCwd(canonicalGitRoot);
      worktree = await getOrCreateWorktree({
        gitRoot: canonicalGitRoot,
        slug: worktreeSlug,
        sandboxExecutionBroker: worktreeSandboxExecutionBroker,
      });
      baseCommit = await captureBaseCommit(
        canonicalGitRoot,
        worktreeSandboxExecutionBroker,
      );
    } catch (err) {
      return {
        kind: "rejected",
        reason: `worktree setup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Spawn the live agent (AgentControl owns depth + slot + metadata).
  let live: LiveAgent;
  try {
    live = await opts.control.spawn({
      parentPath: opts.parentPath,
      ...(opts.role !== undefined ? { roleName: opts.role } : {}),
      ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
      ...(opts.depthCap !== undefined ? { depthCap: opts.depthCap } : {}),
    });
  } catch (err) {
    // Teardown worktree if we created one — slot reservation rolled back.
    if (worktree?.created) {
      await removeAgentWorktree({
        path: worktree.path,
        branch: worktree.branch,
        gitRoot: worktree.gitRoot,
        sandboxExecutionBroker:
          worktreeSandboxExecutionBroker ??
          requireChildWorktreeSandboxExecutionBroker(
            opts.parent,
            worktree.gitRoot,
          ),
      }).catch(() => {});
    }
    return {
      kind: "rejected",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Build the fork context.
  const parentMessages =
    opts.parentMessagesOverride ?? opts.parent.snapshotHistoryMessages();
  const fork = await forkSubagent({
    parent: opts.parent,
    parentMessages,
    ...(forkMode !== undefined ? { mode: forkMode } : {}),
    ...(opts.parentMessagesOverride !== undefined
      ? { useProvidedParentMessages: true }
      : {}),
    taskPrompt: opts.taskPrompt,
    ...(opts.taskContent !== undefined ? { taskContent: opts.taskContent } : {}),
    ...(worktree?.path !== undefined ? { worktreePath: worktree.path } : {}),
  });

  const buildThread = (
    wiring: ConstructorParameters<typeof AgentThreadClass>[1] = {},
  ): AgentThread =>
    new AgentThreadClass(
      {
        live,
        initialMessages: fork.messages,
        ...(forkMode !== undefined ? { forkMode } : {}),
        ...(worktree !== undefined ? { worktree } : {}),
        parentSessionId: opts.parent.conversationId,
        taskPrompt: opts.taskPrompt,
      },
      {
        parent: opts.parent,
        control: opts.control,
        registry: opts.registry,
        parentPath: live.agentPath,
        ...wiring,
      },
    );

  const execute = async (thread: AgentThread): Promise<RunAgentResult> =>
    runDelegateAgentLoop({
      thread,
      parent: opts.parent,
      parentPath: opts.parentPath,
      control: opts.control,
      taskPrompt: opts.taskPrompt,
      initialMessages: fork.messages,
      ...(worktree !== undefined ? { worktree } : {}),
      ...(opts.toolAllowlist !== undefined
        ? { toolAllowlist: opts.toolAllowlist }
        : {}),
      ...(opts.childToolPolicy !== undefined
        ? { childToolPolicy: opts.childToolPolicy }
        : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.externalSignal !== undefined
        ? { externalSignal: opts.externalSignal }
        : {}),
      ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.reasoningEffort !== undefined
        ? { reasoningEffort: opts.reasoningEffort }
        : {}),
      ...(opts.serviceTier !== undefined
        ? { serviceTier: opts.serviceTier }
        : {}),
      ...(opts.resumeManager !== undefined
        ? { resumeManager: opts.resumeManager }
        : {}),
      ...(opts.keepAlive !== undefined ? { keepAlive: opts.keepAlive } : {}),
      ...(opts.onProgress !== undefined
        ? { onProgress: opts.onProgress }
        : {}),
      onRoleProvenanceFailure: () => {
        preserveLiveAfterRoleProvenanceFailure = true;
      },
    });

  if (!opts.forceSynchronous && (runInBackground || live.role.config.background)) {
    // Async mode — fire-and-forget; caller sees the AgentThread handle.
    let thread!: AgentThread;
    const joinPromise = Promise.resolve().then(async () => {
      let asyncResult: RunAgentResult | undefined;
      try {
        asyncResult = await execute(thread);
        return asyncResult;
      } finally {
        if (!preserveLiveAfterRoleProvenanceFailure) {
          await markAsyncThreadSpawnEdgeClosed({
            control: opts.control,
            thread,
            parent: opts.parent,
          });
        }
        // On a terminal non-completed outcome (or a thrown run), release the
        // agent so its registry path/slot are freed and a re-spawn at the same
        // path does not collide with a leaked reservation. A clean completion
        // keeps the prior fire-and-forget behavior (no delegate-scoped shutdown).
        const shutdownAgent =
          !preserveLiveAfterRoleProvenanceFailure &&
          (asyncResult === undefined || asyncResult.outcome !== "completed");
        if (!preserveLiveAfterRoleProvenanceFailure) {
          await teardown({
            thread,
            control: opts.control,
            registry: opts.registry,
            parent: opts.parent,
            shutdownAgent,
            ...(baseCommit !== null ? { baseCommit } : {}),
          });
        }
      }
    });
    thread = buildThread({ joinPromise });
    return { kind: "async_launched", thread };
  }

  // Sync mode — await completion.
  const thread = buildThread();
  let result: RunAgentResult;
  try {
    result = await execute(thread);
  } finally {
    if (!preserveLiveAfterRoleProvenanceFailure) {
      await teardown({
        thread,
        control: opts.control,
        registry: opts.registry,
        parent: opts.parent,
        shutdownAgent: true,
        ...(baseCommit !== null ? { baseCommit } : {}),
      });
    }
  }

  return {
    kind: "sync_completed",
    result,
    thread,
  };
}

async function markAsyncThreadSpawnEdgeClosed(opts: {
  readonly control: AgentControl;
  readonly thread: AgentThread;
  readonly parent: Session;
}): Promise<void> {
  const markClosed = (
    opts.control as {
      readonly markThreadSpawnEdgeClosed?: (
        threadId: string,
      ) => Promise<void> | void;
    }
  ).markThreadSpawnEdgeClosed;
  if (typeof markClosed !== "function") return;
  try {
    await markClosed.call(opts.control, opts.thread.threadId);
  } catch (err) {
    emitWarning(
      opts.parent.eventLog,
      opts.parent.nextInternalSubId(),
      "thread_spawn_edge_close_failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function runToCompletion(
  params: Parameters<typeof runAgent>[0],
  onProgress?: (event: RunAgentProgressEvent) => void | Promise<void>,
): Promise<RunAgentResult> {
  const iter = runAgent(params);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await iter.next();
    if (step.done) {
      return step.value;
    }
    await onProgress?.(step.value);
  }
}

async function runDelegateAgentLoop(opts: {
  readonly thread: AgentThread;
  readonly parent: Session;
  readonly parentPath: AgentPath;
  readonly control: AgentControl;
  readonly taskPrompt: string;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly worktree?: WorktreeHandle;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly childToolPolicy?: ChildToolPolicy;
  readonly maxTurns?: number;
  readonly externalSignal?: AbortSignal;
  readonly silent?: boolean;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string;
  readonly resumeManager?: ResumeManager;
  readonly keepAlive?: boolean;
  readonly onProgress?: (
    event: RunAgentProgressEvent,
    thread: AgentThread,
  ) => void | Promise<void>;
  readonly onRoleProvenanceFailure: () => void;
}): Promise<RunAgentResult> {
  while (true) {
    const live = opts.thread.live;
    const result = await runToCompletion(
      {
        live,
        parent: opts.parent,
        initialMessages: opts.initialMessages,
        taskPrompt: opts.taskPrompt,
        ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
        ...(opts.toolAllowlist !== undefined
          ? { toolAllowlist: opts.toolAllowlist }
          : {}),
        ...(opts.childToolPolicy !== undefined
          ? { childToolPolicy: opts.childToolPolicy }
          : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.externalSignal !== undefined
          ? { externalSignal: opts.externalSignal }
          : {}),
        ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.reasoningEffort !== undefined
          ? { reasoningEffort: opts.reasoningEffort }
          : {}),
        ...(opts.serviceTier !== undefined
          ? { serviceTier: opts.serviceTier }
          : {}),
        ...(opts.keepAlive !== undefined ? { keepAlive: opts.keepAlive } : {}),
        onCacheSafeParams: (params) => {
          opts.thread.setSummaryCacheSafeParams(params);
        },
      },
      (event) => {
        opts.thread.recordSummaryProgressEvent(event);
        return opts.onProgress?.(event, opts.thread);
      },
    );

    if (result.outcome !== "errored") {
      opts.resumeManager?.recordSuccess(live.agentId);
      return result;
    }

    if (!opts.resumeManager) {
      return result;
    }

    const decision = opts.resumeManager.recordFailure(
      live.agentId,
      result.error ?? new Error("subagent turn failed"),
      opts.parent.abortController.signal.aborted ||
        live.abortController.signal.aborted,
    );

    if (decision.kind === "abort") {
      return result;
    }

    if (decision.kind === "restart") {
      const restarted = await restartLiveAgent({
        thread: opts.thread,
        parent: opts.parent,
        parentPath: opts.parentPath,
        control: opts.control,
        onRoleProvenanceFailure: opts.onRoleProvenanceFailure,
      });
      if (!restarted) {
        return result;
      }
      // The restarted agent gets a fresh thread id; carry the failure
      // count forward so RESUME_MAX_ATTEMPTS still trips on a subagent
      // that hard-fails repeatedly (otherwise the per-thread counter
      // resets to 0 on every restart and the loop is unbounded).
      if (restarted.agentId !== live.agentId) {
        opts.resumeManager.transferFailureCount(
          live.agentId,
          restarted.agentId,
        );
      }
      opts.thread.rebindLive(restarted);
      continue;
    }

    const nextLive = await recoverLiveAgent({
      thread: opts.thread,
      parent: opts.parent,
      parentPath: opts.parentPath,
      control: opts.control,
      onRoleProvenanceFailure: opts.onRoleProvenanceFailure,
    });
    if (!nextLive) {
      return result;
    }
    opts.thread.rebindLive(nextLive);
  }
}

async function recoverLiveAgent(opts: {
  readonly thread: AgentThread;
  readonly parent: Session;
  readonly parentPath: AgentPath;
  readonly control: AgentControl;
  readonly onRoleProvenanceFailure: () => void;
}): Promise<LiveAgent | null> {
  const live = opts.thread.live;
  try {
    opts.control.assertAgentMetadataRoleWorkspace(live.metadata);
  } catch (err) {
    opts.onRoleProvenanceFailure();
    emitWarning(
      opts.parent.eventLog,
      opts.parent.nextInternalSubId(),
      "subagent_resume_failed",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  emitWarning(
    opts.parent.eventLog,
    opts.parent.nextInternalSubId(),
    "subagent_resume_retry",
    `resume subagent ${live.agentPath} after ${live.status.value.status}`,
  );

  await opts.control.shutdown(
    live.agentId,
    "delegate_resume",
  );

  try {
    const resumed = await opts.control.resumeAgentFromRollout({
      rootThreadId: live.agentId,
      parentPath: opts.parentPath,
      metadata: live.metadata,
    });
    if (!resumed.rootLive) {
      throw new Error(`unable to resume live handle for ${live.agentPath}`);
    }
    return resumed.rootLive;
  } catch (err) {
    emitWarning(
      opts.parent.eventLog,
      opts.parent.nextInternalSubId(),
      "subagent_resume_failed",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function restartLiveAgent(opts: {
  readonly thread: AgentThread;
  readonly parent: Session;
  readonly parentPath: AgentPath;
  readonly control: AgentControl;
  readonly onRoleProvenanceFailure: () => void;
}): Promise<LiveAgent | null> {
  const live = opts.thread.live;
  try {
    opts.control.assertAgentMetadataRoleWorkspace(live.metadata);
  } catch (err) {
    opts.onRoleProvenanceFailure();
    emitWarning(
      opts.parent.eventLog,
      opts.parent.nextInternalSubId(),
      "subagent_restart_failed",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  emitWarning(
    opts.parent.eventLog,
    opts.parent.nextInternalSubId(),
    "subagent_restart_retry",
    `restart subagent ${live.agentPath} after hard failure`,
  );

  await opts.control.shutdown(live.agentId, "delegate_restart");

  try {
    return await opts.control.spawn({
      parentPath: opts.parentPath,
      roleName: live.metadata.agentRole ?? live.role.name,
      agentPath: live.agentPath,
      preferredNickname: live.nickname,
      expectedRoleProvenance: live.metadata,
    });
  } catch (err) {
    emitWarning(
      opts.parent.eventLog,
      opts.parent.nextInternalSubId(),
      "subagent_restart_failed",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Teardown
// ─────────────────────────────────────────────────────────────────────

async function teardown(opts: {
  readonly thread: AgentThread;
  readonly control: AgentControl;
  readonly registry: AgentRegistry;
  readonly parent: Session;
  readonly shutdownAgent: boolean;
  readonly baseCommit?: string;
}): Promise<void> {
  void opts.registry;

  if (opts.shutdownAgent) {
    // Sync compatibility callers still expect delegate-scoped teardown.
    await opts.control.shutdown(opts.thread.threadId, "delegate_teardown");
  }

  // If we own a worktree, decide keep-vs-remove.
  if (opts.thread.worktree && opts.baseCommit) {
    try {
      const changes = await hasWorktreeChanges({
        path: opts.thread.worktree.path,
        baseCommit: opts.baseCommit,
        sandboxExecutionBroker:
          requireChildWorktreeSandboxExecutionBroker(
            opts.parent,
            opts.thread.worktree.gitRoot,
          ),
      });
      if (!changes.hasCommits && !changes.isDirty) {
        await removeAgentWorktree({
          path: opts.thread.worktree.path,
          branch: opts.thread.worktree.branch,
          gitRoot: opts.thread.worktree.gitRoot,
          sandboxExecutionBroker:
            requireChildWorktreeSandboxExecutionBroker(
              opts.parent,
              opts.thread.worktree.gitRoot,
            ),
          onSparseCheckoutOrphaned: (detail) => {
            emitWarning(
              opts.parent.eventLog,
              opts.parent.nextInternalSubId(),
              "sparse_checkout_orphaned",
              detail,
            );
          },
          onPruneFailed: (detail) => {
            emitWarning(
              opts.parent.eventLog,
              opts.parent.nextInternalSubId(),
              "worktree_prune_failed",
              detail,
            );
          },
        });
      } else {
        // Dirty/has-commits — leave for ExitWorktreeTool to handle.
        emitWarning(
          opts.parent.eventLog,
          opts.parent.nextInternalSubId(),
          "worktree_has_changes",
          `worktree ${opts.thread.worktree.path} has changes (commits=${changes.hasCommits}, dirty=${changes.isDirty}); keep/remove handled by ExitWorktreeTool`,
        );
      }
    } catch (err) {
      emitWarning(
        opts.parent.eventLog,
        opts.parent.nextInternalSubId(),
        "worktree_teardown_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function requireChildWorktreeSandboxExecutionBroker(
  session: Session,
  cwd: string,
): SandboxExecutionBrokerLike {
  const broker = session.services?.sandboxExecutionBroker;
  if (broker === undefined) {
    throw missingSandboxExecutionBoundary("child_agent");
  }
  return broker.forkForCwd(cwd);
}
