/**
 * Delegate — the canonical subagent spawn dispatcher.
 *
 * Public entry point for:
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
import { childReadOnlyDelegation } from "./readonly-delegation.js";
import type { ToolEffectDispositionEvidence } from "../contracts/run-contracts.js";
import type { LLMMessage } from "../llm/types.js";
import type { LLMContentPart } from "../llm/types.js";
import {
  assertAgentInvocationEnvelope,
  type AgentInvocationEnvelope,
} from "../contracts/agent-invocation-envelope.js";
import {
  MaxDepthExceededError,
  type AgentControl,
  type LiveAgent,
} from "./control.js";
import {
  AgentCapacityQueueFullError,
  AgentConcurrencyLimitError,
  AgentPathExistsError,
  type AgentCapacityPermit,
  type AgentRegistry,
  type AgentPath,
} from "./registry.js";
import { createToolEffectDispositionEvidence } from "../tools/effect-boundary.js";
import type { ForkMode } from "./fork-context.js";
import type { WorktreeHandle, WorktreeTurnEvidence } from "./worktree.js";
import type { AgentThread } from "./thread.js";
import type {
  ChildToolPolicy,
  RunAgentProgressEvent,
  RunAgentResult,
} from "./run-agent.js";
import type { ReasoningEffort } from "../session/turn-context.js";
import type { ModelInfo } from "../session/turn-context.js";
import type { ProviderSelection } from "../session/provider-service.js";
import { assertCrossProviderAllowed, assertChildExecutionPlan, assertPreparedChildMatchesPlan, currentChildProvider, resolveChildSelection, type ChildExecutionPlan } from "./cross-provider.js";
import type { AssistantOutputStreamSink } from "../contracts/assistant-output-stream.js";
import { emitWarning } from "../session/event-log.js";
import { AgentThread as AgentThreadClass } from "./thread.js";
import { forkSubagent } from "./fork-context.js";
import {
  getOrCreateWorktree,
  findGitRoot,
  hasWorktreeChanges,
  captureBaseCommit,
  removeAgentWorktree,
  WorktreePreconditionError,
} from "./worktree.js";
import { runAgent } from "./run-agent.js";
import { terminalFromAgentStatus } from "./status.js";
import { ResumeManager } from "./resume.js";
import {
  missingSandboxExecutionBoundary,
  type SandboxExecutionBrokerLike,
} from "../sandbox/execution-broker.js";

// ─────────────────────────────────────────────────────────────────────
// Delegate options
// ─────────────────────────────────────────────────────────────────────

export type IsolationMode = "none" | "cwd" | "worktree";

export type DelegateFinalMessageSink = AssistantOutputStreamSink;

export interface DelegateOpts {
  readonly parent: Session;
  readonly parentPath: AgentPath;
  /** Source-owned caller binding check, repeated across asynchronous setup. */
  readonly assertParentSessionActive?: () => void;
  readonly control: AgentControl;
  readonly registry: AgentRegistry;
  readonly taskPrompt: string;
  /** Correlation id for the initial task/assignment. */
  readonly taskId?: string;
  readonly taskContent?: readonly LLMContentPart[];
  readonly invocationEnvelope?: AgentInvocationEnvelope;
  readonly role?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly modelInfo?: ModelInfo;
  readonly providerSelection?: ProviderSelection;
  readonly plan?: ChildExecutionPlan;
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
  readonly capacityPermit?: AgentCapacityPermit;
  readonly capacityOwnerId?: string;
  readonly silent?: boolean;
  readonly deferInteractiveApprovals?: (toolName: string) => void;
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
  /**
   * When provided, provider assistant-text deltas are consumed at the model
   * stream boundary and the returned RunAgentResult never includes finalMessage.
   */
  readonly finalMessageSink?: DelegateFinalMessageSink;
}

export type DelegateOutcome =
  | {
      readonly kind: "sync_completed";
      readonly result: RunAgentResult;
      readonly thread: AgentThread;
    }
  | { readonly kind: "async_launched"; readonly thread: AgentThread }
  | {
      readonly kind: "rejected";
      readonly code:
        | "INVALID_DELEGATE_REQUEST"
        | "WORKTREE_UNAVAILABLE"
        | "AGENT_CONCURRENCY_LIMIT"
        | "AGENT_CAPACITY_QUEUE_FULL"
        | "AGENT_SPAWN_REJECTED";
      readonly category:
        | "invalid_request"
        | "environment"
        | "retryable_capacity"
        | "spawn_failed";
      readonly reason: string;
      readonly effectDisposition?: ToolEffectDispositionEvidence;
    };

function delegateModelOptions(
  opts: DelegateOpts,
): Pick<DelegateOpts, "plan" | "model" | "modelInfo" | "providerSelection" | "reasoningEffort" | "serviceTier"> {
  if (opts.plan !== undefined) return { plan: opts.plan };
  return {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.modelInfo !== undefined ? { modelInfo: opts.modelInfo } : {}),
    ...(opts.providerSelection !== undefined ? { providerSelection: opts.providerSelection } : {}),
    ...(opts.reasoningEffort !== undefined
      ? { reasoningEffort: opts.reasoningEffort }
      : {}),
    ...(opts.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
  };
}

/**
 * Evidence that a refused delegation created no child and no worktree. A
 * caller such as spawn_agent otherwise files the refusal as an unknown
 * outcome, which gates the whole session behind /resolve (luna-mac F1).
 */
function noChildCreated(reason: string): ToolEffectDispositionEvidence {
  return createToolEffectDispositionEvidence({
    disposition: "confirmed_no_effect",
    evidenceKind: "boundary_not_crossed",
    evidenceRef: "agents.delegate:refused-before-child",
    evidenceMaterial: reason,
  });
}

/**
 * AgentControl.spawn commits a child only at its durable spawn edge and rolls
 * back its slot, path and nickname for every refusal before that commit.
 * These refusals are raised only before it (the depth cap, the slot limits,
 * and a path another agent of this session holds). Any other failure,
 * including a thread id collision that the commit itself can report, stays
 * unknown.
 */
function refusedBeforeChildCommit(error: unknown): boolean {
  return (
    error instanceof AgentConcurrencyLimitError ||
    error instanceof AgentCapacityQueueFullError ||
    error instanceof AgentPathExistsError ||
    error instanceof MaxDepthExceededError
  );
}

// ─────────────────────────────────────────────────────────────────────
// delegate — main entry
// ─────────────────────────────────────────────────────────────────────

export async function delegate(opts: DelegateOpts): Promise<DelegateOutcome> {
  const isolation = opts.isolation ?? "none";
  const forkMode = opts.forkMode;
  const runInBackground = opts.runInBackground ?? true;
  const reject = (
    code: Extract<DelegateOutcome, { kind: "rejected" }>["code"],
    category: Extract<DelegateOutcome, { kind: "rejected" }>["category"],
    reason: string,
    effectDisposition?: ToolEffectDispositionEvidence,
  ): Extract<DelegateOutcome, { kind: "rejected" }> => {
    opts.capacityPermit?.cancel();
    return {
      kind: "rejected", code, category, reason,
      ...(effectDisposition !== undefined ? { effectDisposition } : {}),
    };
  };

  if (opts.plan !== undefined) {
    try {
      await assertChildExecutionPlan(opts.parent, opts.plan);
      if (opts.plan.parent.agentPath !== opts.parentPath ||
          opts.plan.task.id !== (opts.taskId ?? opts.plan.task.id)) {
        throw new Error("child execution plan task identity changed");
      }
      if (opts.plan.crossProvider && forkMode !== undefined &&
          opts.plan.route.provider !== currentChildProvider(opts.parent).provider) {
        throw new Error("Cross-provider subagents require fork_turns = none. Omit fork_turns or set it to none.");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return reject("INVALID_DELEGATE_REQUEST", "invalid_request", reason, noChildCreated(reason));
    }
  } else if (opts.providerSelection !== undefined) {
    const reason = "consent_unavailable: a cross-provider child requires a human-granted execution plan";
    return reject("INVALID_DELEGATE_REQUEST", "invalid_request", reason, noChildCreated(reason));
  }

  if (opts.invocationEnvelope !== undefined) {
    try {
      assertAgentInvocationEnvelope(opts.invocationEnvelope);
      if (opts.taskContent !== undefined) {
        throw new TypeError(
          "agent invocation envelope cannot be combined with legacy taskContent",
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return reject(
        "INVALID_DELEGATE_REQUEST",
        "invalid_request",
        reason,
        noChildCreated(reason),
      );
    }
  }

  if (
    isolation === "worktree" &&
    (!opts.worktreeSlug || opts.worktreeSlug.trim().length === 0)
  ) {
    const reason = "worktree isolation requires a non-empty worktreeSlug";
    return reject(
      "INVALID_DELEGATE_REQUEST",
      "invalid_request",
      reason,
      noChildCreated(reason),
    );
  }

  const parentThreadId = opts.registry.agentIdForPath?.(opts.parentPath);
  const readOnlyConstraint = childReadOnlyDelegation(
    opts.parent,
    opts.control.roleCatalog?.require(opts.role),
    parentThreadId === undefined ? undefined : opts.registry.agentMetadataForThread?.(parentThreadId)?.executionConstraint,
  );
  if (readOnlyConstraint !== undefined && isolation === "worktree") {
    const reason =
      "Read-only delegation cannot create a worktree. Use isolation none.";
    return reject(
      "INVALID_DELEGATE_REQUEST",
      "invalid_request",
      reason,
      noChildCreated(reason),
    );
  }

  // Set up worktree if requested.
  let worktree: WorktreeHandle | undefined;
  let baseCommit: string | null = null;
  let worktreeSandboxExecutionBroker: SandboxExecutionBrokerLike | undefined;
  let preserveLiveAfterRoleProvenanceFailure = false;
  let worktreeEvidenceRequiringReview: WorktreeTurnEvidence | undefined;
  if (isolation === "worktree") {
    const worktreeSlug = opts.worktreeSlug!;
    const workspaceRoot =
      opts.parent.sessionConfiguration.cwd ||
      opts.parent.config.cwd ||
      process.cwd();
    const canonicalGitRoot = findGitRoot(workspaceRoot);
    if (!canonicalGitRoot) {
      const refusal = new WorktreePreconditionError(
        "worktree isolation requested but cwd is not inside a git repository",
      );
      return reject(
        "WORKTREE_UNAVAILABLE",
        "environment",
        refusal.message,
        refusal.effectDisposition,
      );
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
        worktree.path,
        worktreeSandboxExecutionBroker,
      );
    } catch (err) {
      if (worktree?.created) {
        try {
          await removeAgentWorktree({
            path: worktree.path,
            branch: worktree.branch,
            gitRoot: worktree.gitRoot,
            sandboxExecutionBroker: worktreeSandboxExecutionBroker!,
          });
        } catch (cleanupError) {
          emitWarning(
            opts.parent.eventLog,
            opts.parent.nextInternalSubId(),
            "delegate_worktree_cleanup_failed",
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          );
        }
      }
      return reject(
        "WORKTREE_UNAVAILABLE",
        "environment",
        `worktree setup failed: ${err instanceof Error ? err.message : String(err)}`,
        worktree === undefined && err instanceof WorktreePreconditionError
          ? err.effectDisposition
          : undefined,
      );
    }
  }

  // Spawn the live agent (AgentControl owns depth + slot + metadata).
  let live: LiveAgent;
  try {
    opts.assertParentSessionActive?.();
    live = await opts.control.spawn({
      parentPath: opts.parentPath,
      ...(opts.role !== undefined ? { roleName: opts.role } : {}),
      ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
      ...(opts.depthCap !== undefined ? { depthCap: opts.depthCap } : {}),
      ...(opts.capacityPermit !== undefined
        ? { capacityPermit: opts.capacityPermit }
        : {}),
      ...(opts.capacityOwnerId !== undefined
        ? { capacityOwnerId: opts.capacityOwnerId }
        : {}),
      ...(opts.plan?.crossProvider || opts.providerSelection !== undefined
        ? { providerSelection: opts.plan?.route ?? opts.providerSelection }
        : {}),
      ...(opts.plan !== undefined ? { executionPlan: opts.plan } : {}),
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
      }).catch((cleanupError) => {
        emitWarning(
          opts.parent.eventLog,
          opts.parent.nextInternalSubId(),
          "delegate_worktree_cleanup_failed",
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        );
      });
    }
    const reason = err instanceof Error ? err.message : String(err);
    // A worktree created for this child is removed above, but that is a
    // change and its cleanup can fail, so only a spawn without one claims
    // no effect.
    const evidence =
      refusedBeforeChildCommit(err) && worktree?.created !== true
        ? noChildCreated(reason)
        : undefined;
    if (err instanceof AgentConcurrencyLimitError) {
      return reject(
        "AGENT_CONCURRENCY_LIMIT",
        "retryable_capacity",
        reason,
        evidence,
      );
    }
    if (err instanceof AgentCapacityQueueFullError) {
      return reject(
        "AGENT_CAPACITY_QUEUE_FULL",
        "retryable_capacity",
        reason,
        evidence,
      );
    }
    return reject("AGENT_SPAWN_REJECTED", "spawn_failed", reason, evidence);
  }

  // Build the fork context.
  let fork: Awaited<ReturnType<typeof forkSubagent>>;
  try {
    opts.assertParentSessionActive?.();
    const parentMessages =
      opts.parentMessagesOverride ?? opts.parent.snapshotHistoryMessages();
    fork = await forkSubagent({
      parent: opts.parent,
      parentMessages,
      ...(forkMode !== undefined ? { mode: forkMode } : {}),
      ...(opts.parentMessagesOverride !== undefined
        ? { useProvidedParentMessages: true }
        : {}),
      taskPrompt: opts.taskPrompt,
      ...(opts.taskContent !== undefined
        ? { taskContent: opts.taskContent }
        : {}),
      ...(opts.invocationEnvelope !== undefined
        ? { invocationEnvelope: opts.invocationEnvelope }
        : {}),
      ...(worktree?.path !== undefined ? { worktreePath: worktree.path } : {}),
    });
    opts.assertParentSessionActive?.();
  } catch (error) {
    const cleanupFailures: string[] = [];
    await opts.control
      .shutdown(live.agentId, "delegate_fork_failed")
      .catch((shutdownError) => {
        cleanupFailures.push(
          shutdownError instanceof Error
            ? shutdownError.message
            : String(shutdownError),
        );
      });
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
      }).catch((worktreeError) => {
        cleanupFailures.push(
          worktreeError instanceof Error
            ? worktreeError.message
            : String(worktreeError),
        );
      });
    }
    if (cleanupFailures.length > 0) {
      emitWarning(
        opts.parent.eventLog,
        opts.parent.nextInternalSubId(),
        "delegate_fork_cleanup_failed",
        cleanupFailures.join("; "),
      );
    }
    return reject(
      "AGENT_SPAWN_REJECTED",
      "spawn_failed",
      `agent fork setup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

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

  const execute = async (thread: AgentThread): Promise<RunAgentResult> => {
    opts.assertParentSessionActive?.();
    return runDelegateAgentLoop({
      thread,
      parent: opts.parent,
      parentPath: opts.parentPath,
      control: opts.control,
      taskPrompt: opts.taskPrompt,
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      initialMessages: fork.messages,
      ...(worktree !== undefined ? { worktree } : {}),
      ...(baseCommit !== null ? { worktreeBaseCommit: baseCommit } : {}),
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
      ...(opts.deferInteractiveApprovals !== undefined
        ? { deferInteractiveApprovals: opts.deferInteractiveApprovals } : {}),
      ...delegateModelOptions(opts),
      ...(opts.resumeManager !== undefined
        ? { resumeManager: opts.resumeManager }
        : {}),
      ...(opts.keepAlive !== undefined ? { keepAlive: opts.keepAlive } : {}),
      onWorktreeEvidence: (evidence) => {
        if (
          evidence.state !== "unchanged_clean" &&
          evidence.state !== "committed_clean"
        ) {
          worktreeEvidenceRequiringReview = evidence;
        }
      },
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.finalMessageSink !== undefined
        ? { finalMessageSink: opts.finalMessageSink }
        : {}),
      onRoleProvenanceFailure: () => {
        preserveLiveAfterRoleProvenanceFailure = true;
      },
    });
  };

  if (
    !opts.forceSynchronous &&
    (runInBackground || live.role.config.background)
  ) {
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
            ...(worktreeEvidenceRequiringReview !== undefined
              ? { worktreeEvidenceRequiringReview }
              : {}),
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
        ...(worktreeEvidenceRequiringReview !== undefined
          ? { worktreeEvidenceRequiringReview }
          : {}),
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
  finalMessageSink?: DelegateFinalMessageSink,
): Promise<RunAgentResult> {
  const iter = runAgent(params);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await iter.next();
    if (step.done) {
      if (finalMessageSink === undefined) return step.value;
      return withoutFinalMessage(step.value);
    }
    await onProgress?.(step.value);
  }
}

function withoutFinalMessage(result: RunAgentResult): RunAgentResult {
  return {
    threadId: result.threadId,
    durationMs: result.durationMs,
    outcome: result.outcome,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.toolCallCount === undefined
      ? {}
      : { toolCallCount: result.toolCallCount }),
  };
}

async function runDelegateAgentLoop(opts: {
  readonly thread: AgentThread;
  readonly parent: Session;
  readonly parentPath: AgentPath;
  readonly control: AgentControl;
  readonly taskPrompt: string;
  readonly taskId?: string;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly worktree?: WorktreeHandle;
  readonly worktreeBaseCommit?: string;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly childToolPolicy?: ChildToolPolicy;
  readonly maxTurns?: number;
  readonly externalSignal?: AbortSignal;
  readonly silent?: boolean;
  readonly deferInteractiveApprovals?: (toolName: string) => void;
  readonly model?: string;
  readonly modelInfo?: ModelInfo;
  readonly providerSelection?: ProviderSelection;
  readonly plan?: ChildExecutionPlan;
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string;
  readonly resumeManager?: ResumeManager;
  readonly keepAlive?: boolean;
  readonly onWorktreeEvidence: (evidence: WorktreeTurnEvidence) => void;
  readonly onProgress?: (
    event: RunAgentProgressEvent,
    thread: AgentThread,
  ) => void | Promise<void>;
  readonly finalMessageSink?: DelegateFinalMessageSink;
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
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
        ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
        ...(opts.worktreeBaseCommit !== undefined
          ? { worktreeBaseCommit: opts.worktreeBaseCommit }
          : {}),
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
        ...(opts.deferInteractiveApprovals !== undefined
          ? { deferInteractiveApprovals: opts.deferInteractiveApprovals } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.modelInfo !== undefined ? { modelInfo: opts.modelInfo } : {}),
        ...(opts.providerSelection !== undefined ? { providerSelection: opts.providerSelection } : {}),
        ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
        ...(opts.reasoningEffort !== undefined
          ? { reasoningEffort: opts.reasoningEffort }
          : {}),
        ...(opts.serviceTier !== undefined
          ? { serviceTier: opts.serviceTier }
          : {}),
        ...(opts.keepAlive !== undefined ? { keepAlive: opts.keepAlive } : {}),
        onWorktreeEvidence: opts.onWorktreeEvidence,
        onTerminalFundsStop: () => opts.control.markThreadSpawnEdgeClosed(live.agentId),
        ...(opts.finalMessageSink !== undefined
          ? { finalMessageSink: opts.finalMessageSink }
          : {}),
        onCacheSafeParams: (params) => {
          opts.thread.setSummaryCacheSafeParams(params);
        },
      },
      (event) => {
        opts.thread.recordSummaryProgressEvent(event);
        return opts.onProgress?.(event, opts.thread);
      },
      opts.finalMessageSink,
    );

    const terminal = opts.thread.live.status.value;
    const terminalOutcome = terminalFromAgentStatus(terminal);
    if (terminalOutcome !== undefined) {
      opts.control.recordTerminalOutcome(opts.thread.live.agentId, terminalOutcome);
    }

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
        ...(opts.providerSelection !== undefined ? { providerSelection: opts.providerSelection } : {}),
        ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
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

  await opts.control.shutdown(live.agentId, "delegate_resume");

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
  readonly providerSelection?: ProviderSelection;
  readonly plan?: ChildExecutionPlan;
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
  const persisted = live.metadata.crossProvider;
  const plan = live.metadata.executionPlan ?? opts.plan;
  const providerSelection = persisted === undefined
    ? opts.providerSelection
    : { provider: persisted.provider, model: persisted.model };
  try {
    if (plan !== undefined) await assertChildExecutionPlan(opts.parent, plan);
    if (persisted !== undefined && opts.providerSelection !== undefined &&
        (persisted.provider !== opts.providerSelection.provider ||
          persisted.model !== opts.providerSelection.model)) {
      throw new Error("child provider/model pair changed before restart");
    }
    if (providerSelection !== undefined) {
      assertCrossProviderAllowed(opts.parent, providerSelection.provider);
      const validated = await resolveChildSelection(
        opts.parent, providerSelection.provider, providerSelection.model,
      );
      if (validated.provider !== providerSelection.provider ||
          validated.model !== providerSelection.model) {
        throw new Error("child provider/model pair changed before restart");
      }
      const prepared = await opts.parent.providerService.prepareChild(validated, undefined, {}, true,
        plan?.route.provider === "agenc" ? plan.destination : undefined,
        plan?.destination);
      try {
        if (plan !== undefined) assertPreparedChildMatchesPlan(plan, prepared);
      } finally {
        await prepared.binding.instance.dispose?.();
      }
    }
  } catch (err) {
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
    const restarted = await opts.control.spawn({
      parentPath: opts.parentPath,
      roleName: live.metadata.agentRole ?? live.role.name,
      agentPath: live.agentPath,
      preferredNickname: live.nickname,
      expectedRoleProvenance: live.metadata,
      ...(providerSelection !== undefined ? { providerSelection } : {}),
      ...(plan !== undefined ? { executionPlan: plan } : {}),
    });
    if (providerSelection !== undefined &&
        (restarted.metadata.crossProvider?.provider !== providerSelection.provider ||
          restarted.metadata.crossProvider.model !== providerSelection.model)) {
      await opts.control.shutdown(restarted.agentId, "delegate_restart_provenance_failed");
      throw new Error("replacement spawn lost child provider/model provenance");
    }
    return restarted;
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
  readonly worktreeEvidenceRequiringReview?: WorktreeTurnEvidence;
  readonly baseCommit?: string;
}): Promise<void> {
  void opts.registry;

  if (opts.shutdownAgent) {
    // Sync compatibility callers still expect delegate-scoped teardown.
    await opts.control.shutdown(opts.thread.threadId, "delegate_teardown");
  }

  // If we own a worktree, decide keep-vs-remove.
  if (opts.thread.worktree && opts.baseCommit) {
    // A terminal worker can still have uncertain effects. A fresh query under
    // the parent's authority must not override the child's canonical evidence
    // and turn a fail-closed receipt into destructive automatic cleanup.
    if (opts.worktreeEvidenceRequiringReview !== undefined) {
      emitWarning(
        opts.parent.eventLog,
        opts.parent.nextInternalSubId(),
        "worktree_evidence_preserved",
        `worktree ${opts.thread.worktree.path} was preserved for explicit review (evidence=${opts.worktreeEvidenceRequiringReview.state})`,
      );
      return;
    }
    // A resumed worktree may contain commits retained from an earlier run.
    // The turn-start base only distinguishes this turn's output; it does not
    // prove the pre-existing worktree is safe to delete. Auto-cleanup is
    // therefore restricted to worktrees created by this delegate invocation.
    if (!opts.thread.worktree.created) {
      emitWarning(
        opts.parent.eventLog,
        opts.parent.nextInternalSubId(),
        "worktree_resumed_preserved",
        `resumed worktree ${opts.thread.worktree.path} was preserved for explicit review`,
      );
      return;
    }
    try {
      const changes = await hasWorktreeChanges({
        path: opts.thread.worktree.path,
        baseCommit: opts.baseCommit,
        sandboxExecutionBroker: requireChildWorktreeSandboxExecutionBroker(
          opts.parent,
          opts.thread.worktree.gitRoot,
        ),
      });
      if (!changes.hasCommits && !changes.isDirty) {
        await removeAgentWorktree({
          path: opts.thread.worktree.path,
          branch: opts.thread.worktree.branch,
          gitRoot: opts.thread.worktree.gitRoot,
          sandboxExecutionBroker: requireChildWorktreeSandboxExecutionBroker(
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
