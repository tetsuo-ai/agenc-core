/** Event-driven, bounded workflow DAG scheduler. */

import { createHash, randomUUID } from "node:crypto";

import {
  createWorkflowAgentInvocationEnvelope,
  type AgentInvocationEnvelope,
} from "../contracts/agent-invocation-envelope.js";
import type { Sha256Digest } from "../eval-contract/index.js";
import { estimateUtf8TokenUnits } from "../llm/token-accounting.js";
import type { Session } from "../session/session.js";
import {
  backgroundTaskLifecycle,
  registerAgentThreadTask,
  type BackgroundTaskLifecycle,
} from "../tasks/index.js";
import type { AgentControl } from "./control.js";
import { delegate, type IsolationMode } from "./delegate.js";
import {
  compileWorkflowGraph,
  type CompiledWorkflowGraph,
} from "./workflow-graph.js";
import {
  MAX_WORKFLOW_ARTIFACT_BYTES,
  MAX_WORKFLOW_FINAL_RESPONSE_BYTES,
  MAX_WORKFLOW_STEP_PREVIEW_BYTES,
  MAX_WORKFLOW_STEP_RESULT_TOKENS,
  type WorkflowHandoffArtifact,
} from "./workflow-handoff-schema.js";
import type { WorkflowHandoffArtifactStore } from "./workflow-handoff-store.js";
import { WorkflowHandoffSpool } from "./workflow-handoff-spool.js";
import type { EffectiveWorkflowLimits } from "./workflow-invocation.js";
import {
  MAX_WORKFLOW_HANDOFF_TOKENS,
  MAX_WORKFLOW_MAX_CONCURRENCY,
  MAX_WORKFLOW_EXPANDED_EDGES,
  type WorkflowDagManifestV2,
  type WorkflowRef,
  type WorkflowStepV2,
} from "./workflow-manifest-schema.js";
import type { AgentCapacityPermit, AgentRegistry } from "./registry.js";
import { joinAgentPath } from "./registry.js";
import {
  WORKFLOW_RESULT_VERSION,
  type WorkflowCancellationCause,
  type WorkflowCancellationV2,
  type WorkflowGroupOutcomeV2,
  type WorkflowGroupResultV2,
  type WorkflowHandoffReferenceV2,
  type WorkflowRunOutcomeV2,
  type WorkflowRunResultV2,
  type WorkflowStepOutcomeV2,
  type WorkflowStepResultV2,
} from "./workflow-result.js";
import { deriveAgentWorktreeSlug } from "./worktree.js";

const WORKFLOW_AGENT_NAME_DIGEST_HEX_LENGTH = 12;
const WORKFLOW_ERROR_MAX_SERIALIZED_BYTES = 2_048;
const WORKFLOW_WORST_CASE_NUMBER = -Number.MAX_VALUE;
const WORKFLOW_WORST_CASE_ERROR = "e".repeat(
  WORKFLOW_ERROR_MAX_SERIALIZED_BYTES - 2,
);
const WORKFLOW_WORST_CASE_ARTIFACT_ID = `wh_${"f".repeat(48)}`;
const WORKFLOW_WORST_CASE_HANDOFF: WorkflowHandoffReferenceV2 = Object.freeze({
  artifact_id: WORKFLOW_WORST_CASE_ARTIFACT_ID,
  storage_ref: `workflow-handoff:${WORKFLOW_WORST_CASE_ARTIFACT_ID}`,
  digest: `sha256:${"f".repeat(64)}`,
  byte_length: Number.MAX_SAFE_INTEGER,
  token_count: Number.MAX_SAFE_INTEGER,
  preview_truncated: true,
});
const WORKFLOW_HANDOFF_TOKEN_BYTES_PER_TOKEN = 1;
const WORKFLOW_GROUP_AGGREGATE_HEADER =
  "AGENC_WORKFLOW_GROUP_HANDOFF_V1\n";
const LEGACY_TEMPLATE_PATTERN =
  /\{\{\s*(steps|group)\.([A-Za-z0-9_-]+)\s*\}\}/gu;

type BlockReason = "none" | "failed" | "unknown";

export interface WorkflowSchedulerArtifactStore {
  publish: WorkflowHandoffArtifactStore["publish"];
  publishSource: WorkflowHandoffArtifactStore["publishSource"];
  retain: WorkflowHandoffArtifactStore["retain"];
  release: WorkflowHandoffArtifactStore["release"];
}

export interface RunAgentWorkflowV2Options {
  readonly session: Session;
  readonly control: AgentControl;
  readonly registry: AgentRegistry;
  readonly workflowId: string;
  readonly manifest: WorkflowDagManifestV2;
  readonly manifestDigest: Sha256Digest;
  readonly sourceVersion: 1 | 2;
  readonly effectiveLimits: EffectiveWorkflowLimits;
  readonly artifactStore: WorkflowSchedulerArtifactStore;
  readonly runId?: string;
  readonly parentPath?: string;
  readonly signal?: AbortSignal;
  readonly cancellationCause?: Exclude<
    WorkflowCancellationCause,
    "fail_fast_peer"
  >;
  readonly lifecycle?: BackgroundTaskLifecycle;
  readonly delegateFn?: typeof delegate;
  readonly acquireCapacity?: (
    ownerId: string,
    signal: AbortSignal,
  ) => Promise<AgentCapacityPermit>;
  readonly retireThread?: (threadId: string, reason: string) => Promise<void>;
  readonly cancelThread?: (threadId: string, reason: string) => Promise<void>;
  readonly countHandoffTokens?: (text: string) => number;
}

export class WorkflowSchedulerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowSchedulerError";
    this.code = code;
  }
}

interface RuntimeGroup {
  readonly name: string;
  readonly index: number;
  readonly memberOrdinals: readonly number[];
  remaining: number;
  result?: WorkflowGroupResultV2;
  artifact?: WorkflowHandoffArtifact;
}

interface ActiveExecution {
  readonly ordinal: number;
  readonly controller: AbortController;
  promise: Promise<CompletedExecution>;
  threadId?: string;
  cancellation?: WorkflowCancellationV2;
  authoritativeCancellation: boolean;
}

interface CompletedExecution {
  readonly ordinal: number;
  readonly result: WorkflowStepResultV2;
  readonly artifact?: WorkflowHandoffArtifact;
}

interface PreparedStepInvocation {
  readonly instruction: string;
  readonly envelope: AgentInvocationEnvelope;
}

interface WorkflowInputItem {
  readonly alias: string;
  readonly reference: WorkflowRef;
  readonly handoff: WorkflowHandoffReferenceV2;
  readonly extract_kind: "deterministic_bounded_extract";
}

/** Run a validated v2 manifest without wave barriers. */
export async function runAgentWorkflowV2(
  options: RunAgentWorkflowV2Options,
): Promise<WorkflowRunResultV2> {
  const graph = compileWorkflowGraph(options.manifest, {
    maximumExpandedEdges: MAX_WORKFLOW_EXPANDED_EDGES,
  });
  assertEffectiveLimits(options.effectiveLimits);

  const runId = options.runId ?? randomUUID();
  assertWorstCaseResultBudget(options, graph, runId);
  const parentPath = options.parentPath ?? "/root";
  const lifecycle = options.lifecycle ?? backgroundTaskLifecycle;
  const delegateFn = options.delegateFn ?? delegate;
  const acquireCapacity =
    options.acquireCapacity ??
    ((ownerId, signal) =>
      options.registry.acquireSpawnPermit({ ownerId, signal }));
  const retireThread =
    options.retireThread ??
    ((threadId, reason) => options.control.shutdown(threadId, reason));
  const cancelThread = options.cancelThread ?? retireThread;
  const countHandoffTokens =
    options.countHandoffTokens ?? conservativeHandoffTokenCount;

  const remaining = graph.nodes.map(
    (node) => node.dependencyOrdinals.length,
  );
  const blockReasons = graph.nodes.map<BlockReason>(() => "none");
  const results = new Array<WorkflowStepResultV2 | undefined>(
    graph.nodes.length,
  );
  const artifacts = new Array<WorkflowHandoffArtifact | undefined>(
    graph.nodes.length,
  );
  const groups = createRuntimeGroups(graph);
  const ready: number[] = [];
  let readyCursor = 0;
  const active = new Map<number, ActiveExecution>();
  const retainedArtifacts = new Map<string, WorkflowHandoffArtifact>();
  let admissionStopped = false;
  let initiatingCancellation: WorkflowCancellationV2 | undefined;
  let cancellationSequence = 0;
  let nodeTransitions = 0;
  let edgeConsumptions = 0;
  let readyEnqueues = 0;
  let launches = 0;
  let launchTail = Promise.resolve();

  for (const node of graph.nodes) {
    if (remaining[node.ordinal] === 0) {
      ready.push(node.ordinal);
      readyEnqueues += 1;
    }
  }

  const retainArtifact = (artifact: WorkflowHandoffArtifact): void => {
    const referenceId = `workflow-run:${runId}`;
    options.artifactStore.retain(artifact.artifact_id, referenceId, runId);
    retainedArtifacts.set(artifact.artifact_id, artifact);
  };

  const publishGroup = async (
    group: RuntimeGroup,
  ): Promise<WorkflowHandoffArtifact> => {
    const text = boundedGroupAggregate(
      group,
      graph,
      artifacts,
      options.effectiveLimits.maxHandoffTokens,
    );
    const tokenCount = validatedTokenCount(countHandoffTokens(text));
    const artifact = await options.artifactStore.publish({
      owner: {
        run_id: runId,
        workflow_id: options.workflowId,
        producer_step_id: safeGroupIdentity(runId, group.index, group.name),
      },
      idempotencyKey: `group:${group.index}`,
      bytes: Buffer.from(text, "utf8"),
      tokenCount,
    });
    retainArtifact(artifact);
    return artifact;
  };

  const updateGroup = async (ordinal: number): Promise<void> => {
    const groupName = graph.nodes[ordinal]!.step.group;
    if (groupName === undefined) return;
    const group = groups.get(groupName)!;
    group.remaining -= 1;
    if (group.remaining !== 0) return;

    const memberResults = group.memberOrdinals.map(
      (memberOrdinal) => results[memberOrdinal]!,
    );
    const memberIds = Object.freeze(
      group.memberOrdinals.map(
        (memberOrdinal) => graph.nodes[memberOrdinal]!.step.id,
      ),
    );
    let outcome = aggregateGroupOutcome(memberResults.map((item) => item.outcome));
    let artifact: WorkflowHandoffArtifact | undefined;
    if (outcome === "succeeded") {
      try {
        artifact = await publishGroup(group);
        group.artifact = artifact;
      } catch {
        outcome = "handoff_failed";
      }
    }
    group.result = Object.freeze({
      name: group.name,
      outcome,
      member_ids: memberIds,
      ...(artifact === undefined ? {} : { handoff: handoffReference(artifact) }),
    });
  };

  const terminalize = async (
    initialOrdinal: number,
    initialResult: WorkflowStepResultV2,
    initialArtifact?: WorkflowHandoffArtifact,
  ): Promise<void> => {
    const queue: Array<{
      readonly ordinal: number;
      readonly result: WorkflowStepResultV2;
      readonly artifact?: WorkflowHandoffArtifact;
    }> = [
      {
        ordinal: initialOrdinal,
        result: initialResult,
        ...(initialArtifact === undefined ? {} : { artifact: initialArtifact }),
      },
    ];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const terminal = queue[cursor]!;
      if (results[terminal.ordinal] !== undefined) {
        throw new WorkflowSchedulerError(
          "WORKFLOW_DUPLICATE_TRANSITION",
          `workflow step ordinal ${terminal.ordinal} transitioned twice`,
        );
      }
      results[terminal.ordinal] = terminal.result;
      artifacts[terminal.ordinal] = terminal.artifact;
      nodeTransitions += 1;
      await updateGroup(terminal.ordinal);

      for (const dependentOrdinal of
        graph.nodes[terminal.ordinal]!.dependentOrdinals) {
        edgeConsumptions += 1;
        remaining[dependentOrdinal] = remaining[dependentOrdinal]! - 1;
        blockReasons[dependentOrdinal] = joinBlockReason(
          blockReasons[dependentOrdinal]!,
          blockReasonForOutcome(terminal.result.outcome),
        );
        if (remaining[dependentOrdinal] !== 0) continue;

        const dependent = graph.nodes[dependentOrdinal]!.step;
        for (const groupName of referencedGroups(dependent)) {
          const groupOutcome = groups.get(groupName)?.result?.outcome;
          if (groupOutcome === undefined) {
            throw new WorkflowSchedulerError(
              "WORKFLOW_GROUP_NOT_TERMINAL",
              `workflow group ${JSON.stringify(groupName)} was not terminal ` +
                "when its consumer became ready",
            );
          }
          blockReasons[dependentOrdinal] = joinBlockReason(
            blockReasons[dependentOrdinal]!,
            blockReasonForOutcome(groupOutcome),
          );
        }
        const blockReason = blockReasons[dependentOrdinal]!;
        if (blockReason !== "none") {
          queue.push({
            ordinal: dependentOrdinal,
            result: blockedResult(dependent, dependentOrdinal, blockReason),
          });
        } else if (!admissionStopped) {
          ready.push(dependentOrdinal);
          readyEnqueues += 1;
        } else if (initiatingCancellation !== undefined) {
          queue.push({
            ordinal: dependentOrdinal,
            result: Object.freeze({
              id: dependent.id,
              ordinal: dependentOrdinal,
              outcome: "cancelled",
              ...(dependent.task_name === undefined
                ? {}
                : { task_name: dependent.task_name }),
              cancellation: initiatingCancellation,
            }),
          });
        }
      }
    }
  };

  const startExecution = (ordinal: number): void => {
    let releaseLaunchTurn!: () => void;
    const launchTurn = new Promise<void>((resolve) => {
      releaseLaunchTurn = resolve;
    });
    const launchPredecessor = launchTail;
    launchTail = launchTurn;
    const controller = new AbortController();
    const entry: ActiveExecution = {
      ordinal,
      controller,
      promise: Promise.resolve(undefined as never),
      authoritativeCancellation: false,
    };
    entry.promise = executeWorkflowNode({
      options,
      graph,
      ordinal,
      runId,
      parentPath,
      lifecycle,
      delegateFn,
      acquireCapacity,
      retireThread,
      artifacts,
      groups,
      controller,
      entry,
      retainArtifact,
      launchPredecessor,
      releaseLaunchTurn,
    });
    active.set(ordinal, entry);
    launches += 1;
  };

  const nextCancellation = (
    cause: WorkflowCancellationCause,
    causalStepId?: string,
  ): WorkflowCancellationV2 => {
    cancellationSequence += 1;
    return Object.freeze({
      cause,
      ...(causalStepId === undefined ? {} : { causal_step_id: causalStepId }),
      sequence: cancellationSequence,
    });
  };

  const cancelActive = async (
    cancellation: WorkflowCancellationV2,
  ): Promise<void> => {
    await Promise.all(
      [...active.values()].map(async (entry) => {
        if (entry.cancellation !== undefined) return;
        entry.cancellation = cancellation;
        entry.controller.abort(new Error(cancellation.cause));
        if (entry.threadId === undefined) return;
        try {
          await cancelThread(entry.threadId, cancellation.cause);
          entry.authoritativeCancellation = true;
        } catch {
          entry.authoritativeCancellation = false;
        }
      }),
    );
  };

  const cancelQueued = async (
    cancellation: WorkflowCancellationV2,
  ): Promise<void> => {
    for (const node of graph.nodes) {
      if (
        results[node.ordinal] !== undefined ||
        active.has(node.ordinal) ||
        remaining[node.ordinal] !== 0
      ) {
        continue;
      }
      await terminalize(
        node.ordinal,
        Object.freeze({
          id: node.step.id,
          ordinal: node.ordinal,
          outcome: "cancelled",
          ...(node.step.task_name === undefined
            ? {}
            : { task_name: node.step.task_name }),
          cancellation,
        }),
      );
    }
  };

  let abortServiced = false;
  let abortLatched = false;
  let abortEvent: Promise<"abort"> | undefined;
  let abortListener: (() => void) | undefined;
  const workflowSignal = options.signal;
  const latchAbort = (): void => {
    if (abortLatched) return;
    abortLatched = true;
    admissionStopped = true;
    initiatingCancellation = nextCancellation(
      options.cancellationCause ?? "user_abort",
    );
  };
  if (workflowSignal?.aborted === true) {
    latchAbort();
  } else if (workflowSignal !== undefined) {
    abortEvent = new Promise((resolve) => {
      abortListener = (): void => {
        latchAbort();
        resolve("abort");
      };
      workflowSignal.addEventListener("abort", abortListener, { once: true });
    });
  }

  const serviceLatchedAbort = async (): Promise<void> => {
    if (!abortLatched || abortServiced) return;
    const cancellation = initiatingCancellation;
    if (cancellation === undefined) {
      throw new WorkflowSchedulerError(
        "WORKFLOW_CANCELLATION_STATE",
        "workflow abort was latched without a cancellation record",
      );
    }
    abortServiced = true;
    await cancelActive(cancellation);
    await cancelQueued(cancellation);
  };

  try {
    while (nodeTransitions < graph.nodes.length) {
      // An abort may be latched synchronously while terminalizing a completed
      // node (for example, during group publication). Service it before either
      // admitting more work or interpreting an empty active set as a stall.
      await serviceLatchedAbort();
      while (
        !admissionStopped &&
        !abortLatched &&
        active.size < options.effectiveLimits.maxConcurrency &&
        readyCursor < ready.length
      ) {
        const ordinal = ready[readyCursor]!;
        readyCursor += 1;
        if (results[ordinal] !== undefined || active.has(ordinal)) continue;
        if (abortLatched) break;
        startExecution(ordinal);
      }

      if (active.size === 0) {
        if (nodeTransitions === graph.nodes.length) break;
        throw new WorkflowSchedulerError(
          "WORKFLOW_STALLED",
          "workflow scheduler stalled without runnable or active steps",
        );
      }

      const settled = await Promise.race([
        ...[...active.values()].map((entry) => entry.promise),
        ...(abortEvent !== undefined && !abortServiced ? [abortEvent] : []),
      ]);
      if (settled === "abort") {
        latchAbort();
        await serviceLatchedAbort();
        continue;
      }

      active.delete(settled.ordinal);
      await terminalize(settled.ordinal, settled.result, settled.artifact);

      if (
        options.effectiveLimits.failurePolicy === "fail_fast" &&
        settled.result.outcome !== "succeeded" &&
        initiatingCancellation === undefined
      ) {
        admissionStopped = true;
        initiatingCancellation = nextCancellation(
          "fail_fast_peer",
          settled.result.id,
        );
        await cancelActive(initiatingCancellation);
        await cancelQueued(initiatingCancellation);
      }
    }

    if (nodeTransitions !== graph.nodes.length) {
      throw new WorkflowSchedulerError(
        "WORKFLOW_TRANSITION_COUNT",
        `workflow transitioned ${nodeTransitions} of ${graph.nodes.length} steps`,
      );
    }
    if (edgeConsumptions !== graph.edgeCount) {
      throw new WorkflowSchedulerError(
        "WORKFLOW_EDGE_COUNT",
        `workflow consumed ${edgeConsumptions} of ${graph.edgeCount} edges`,
      );
    }

    const stepResults = Object.freeze(
      results.map((result, ordinal) => {
        if (result === undefined) {
          throw new WorkflowSchedulerError(
            "WORKFLOW_MISSING_RESULT",
            `workflow step ordinal ${ordinal} has no result`,
          );
        }
        return result;
      }),
    );
    const groupResults = Object.freeze(
      [...groups.values()].map((group) => {
        if (group.result === undefined) {
          throw new WorkflowSchedulerError(
            "WORKFLOW_MISSING_GROUP_RESULT",
            `workflow group ${JSON.stringify(group.name)} has no result`,
          );
        }
        return group.result;
      }),
    );
    const result: WorkflowRunResultV2 = Object.freeze({
      workflow_result_version: WORKFLOW_RESULT_VERSION,
      run_id: runId,
      workflow_id: options.workflowId,
      manifest_format_version: 2,
      manifest_digest: options.manifestDigest,
      outcome: deriveRunOutcome(stepResults, initiatingCancellation),
      effective_limits: Object.freeze({
        max_concurrency: options.effectiveLimits.maxConcurrency,
        max_handoff_tokens: options.effectiveLimits.maxHandoffTokens,
        failure_policy: options.effectiveLimits.failurePolicy,
      }),
      steps: stepResults,
      groups: groupResults,
      ...(initiatingCancellation === undefined
        ? {}
        : { cancellation: initiatingCancellation }),
      operation_counts: Object.freeze({
        node_transitions: nodeTransitions,
        edge_consumptions: edgeConsumptions,
        ready_enqueues: readyEnqueues,
        ready_dequeues: readyCursor,
        launches,
      }),
    });
    return compactResultPreviewsToLimit(result);
  } finally {
    if (abortListener !== undefined) {
      workflowSignal?.removeEventListener("abort", abortListener);
    }
    const referenceId = `workflow-run:${runId}`;
    for (const artifact of retainedArtifacts.values()) {
      try {
        options.artifactStore.release(artifact.artifact_id, referenceId, runId);
      } catch {
        // The committed artifact remains preserved for operator cleanup. A
        // failed release may leak retention, but never loses the only output.
      }
    }
  }
}

interface ExecuteWorkflowNodeOptions {
  readonly options: RunAgentWorkflowV2Options;
  readonly graph: CompiledWorkflowGraph;
  readonly ordinal: number;
  readonly runId: string;
  readonly parentPath: string;
  readonly lifecycle: BackgroundTaskLifecycle;
  readonly delegateFn: typeof delegate;
  readonly acquireCapacity: (
    ownerId: string,
    signal: AbortSignal,
  ) => Promise<AgentCapacityPermit>;
  readonly retireThread: (threadId: string, reason: string) => Promise<void>;
  readonly artifacts: readonly (WorkflowHandoffArtifact | undefined)[];
  readonly groups: ReadonlyMap<string, RuntimeGroup>;
  readonly controller: AbortController;
  readonly entry: ActiveExecution;
  readonly retainArtifact: (artifact: WorkflowHandoffArtifact) => void;
  readonly launchPredecessor: Promise<void>;
  readonly releaseLaunchTurn: () => void;
}

async function executeWorkflowNode(
  context: ExecuteWorkflowNodeOptions,
): Promise<CompletedExecution> {
  await context.launchPredecessor;
  let launchTurnReleased = false;
  const releaseLaunchTurn = (): void => {
    if (launchTurnReleased) return;
    launchTurnReleased = true;
    context.releaseLaunchTurn();
  };
  const node = context.graph.nodes[context.ordinal]!;
  const step = node.step;
  const safeIdentity = safeStepIdentity(
    context.runId,
    node.ordinal,
    step.id,
  );
  let permit: AgentCapacityPermit | undefined;
  try {
    context.controller.signal.throwIfAborted();
    permit = await context.acquireCapacity(
      context.runId,
      context.controller.signal,
    );
    context.controller.signal.throwIfAborted();
  } catch (error) {
    permit?.cancel();
    releaseLaunchTurn();
    return completedExecution(
      node,
      cancelledOrUnknownBeforeDispatch(context.entry, error),
    );
  }

  let invocation: PreparedStepInvocation;
  try {
    invocation = prepareStepInvocation(
      context.options,
      context.graph,
      node.ordinal,
      context.runId,
      safeIdentity,
      context.artifacts,
      context.groups,
    );
  } catch (error) {
    permit.cancel();
    releaseLaunchTurn();
    return completedExecution(node, failedResult(node, error));
  }

  let spool: WorkflowHandoffSpool;
  try {
    spool = WorkflowHandoffSpool.create({
      maximumBytes: MAX_WORKFLOW_ARTIFACT_BYTES,
      maximumTokens: MAX_WORKFLOW_STEP_RESULT_TOKENS,
      onLimit: (error) => context.controller.abort(error),
    });
  } catch (error) {
    permit.cancel();
    releaseLaunchTurn();
    return completedExecution(node, handoffFailedResult(node, error));
  }

  const agentPath = joinAgentPath(context.parentPath, safeIdentity);
  try {
    let outcome;
    try {
      outcome = await context.delegateFn({
        parent: context.options.session,
        parentPath: context.parentPath,
        control: context.options.control,
        registry: context.options.registry,
        taskPrompt: `Workflow step ${node.ordinal}`,
        invocationEnvelope: invocation.envelope,
        agentName: safeIdentity,
        runInBackground: true,
        // Workflow output is governed exclusively by the canonical spool and
        // artifact envelope. Suppress the ordinary child-to-parent mailbox
        // projection so it cannot create an ungoverned duplicate text path.
        silent: true,
        capacityPermit: permit,
        capacityOwnerId: context.runId,
        externalSignal: context.controller.signal,
        finalMessageSink: spool,
        ...(step.agent_type === undefined ? {} : { role: step.agent_type }),
        ...(step.model === undefined ? {} : { model: step.model }),
        ...isolationOptions(
          step.isolation,
          context.options.session.conversationId,
          agentPath,
          `${context.runId}:${node.ordinal}`,
        ),
        forkMode: undefined,
      });
    } catch (error) {
      permit.cancel();
      if (spool.failure !== undefined) {
        return completedExecution(
          node,
          handoffFailedResult(node, spool.failure),
        );
      }
      return completedExecution(node, failedResult(node, error));
    } finally {
      releaseLaunchTurn();
    }
    if (outcome.kind === "rejected") {
      return completedExecution(node, failedResult(node, outcome.reason));
    }

    const thread = outcome.thread;
    context.entry.threadId = thread.threadId;
    try {
      registerAgentThreadTask(context.lifecycle, thread as never, {
        description: `workflow:${safeIdentity}`,
        prompt: invocation.instruction,
      });
    } catch {
      // Task-pill registration is observational; lifecycle retirement is not.
    }

    let joined;
    let retirementFailure: unknown;
    try {
      joined =
        outcome.kind === "sync_completed" ? outcome.result : await thread.join();
    } catch (error) {
      joined = {
        threadId: thread.threadId,
        durationMs: 0,
        outcome: "aborted" as const,
        error,
      };
    } finally {
      try {
        await context.retireThread(thread.threadId, "workflow_step_retired");
      } catch (error) {
        retirementFailure = error;
      }
    }

    if (retirementFailure !== undefined) {
      return completedExecution(
        node,
        unknownResult(node, retirementFailure, context.entry.cancellation),
      );
    }
    if (spool.failure !== undefined) {
      return completedExecution(
        node,
        handoffFailedResult(node, spool.failure, joined.durationMs),
      );
    }
    if (joined.outcome !== "completed") {
      if (
        context.entry.cancellation !== undefined &&
        context.entry.authoritativeCancellation
      ) {
        return completedExecution(
          node,
          cancelledResult(node, context.entry.cancellation, joined.durationMs),
        );
      }
      if (joined.outcome === "errored") {
        return completedExecution(
          node,
          failedResult(node, joined.error, joined.durationMs),
        );
      }
      return completedExecution(
        node,
        unknownResult(
          node,
          joined.error ?? joined.outcome,
          context.entry.cancellation,
          joined.durationMs,
        ),
      );
    }

    if (joined.finalMessage !== undefined) {
      return completedExecution(
        node,
        handoffFailedResult(
          node,
          "workflow delegate returned output outside the handoff sink",
          joined.durationMs,
        ),
      );
    }
    try {
      const source = spool.seal();
      const tokenCount = validatedTokenCount(spool.tokenCount);
      const artifact = await context.options.artifactStore.publishSource({
        owner: {
          run_id: context.runId,
          workflow_id: context.options.workflowId,
          producer_step_id: safeIdentity,
        },
        idempotencyKey: `step:${node.ordinal}`,
        source,
        tokenCount,
      });
      context.retainArtifact(artifact);
      return completedExecution(
        node,
        Object.freeze({
          id: step.id,
          ordinal: node.ordinal,
          outcome: "succeeded",
          ...(step.task_name === undefined
            ? {}
            : { task_name: step.task_name }),
          duration_ms: joined.durationMs,
          handoff: handoffReference(artifact),
        }),
        artifact,
      );
    } catch (error) {
      return completedExecution(
        node,
        Object.freeze({
          id: step.id,
          ordinal: node.ordinal,
          outcome: "handoff_failed",
          ...(step.task_name === undefined
            ? {}
            : { task_name: step.task_name }),
          duration_ms: joined.durationMs,
          error: boundedError(error),
        }),
      );
    }
  } finally {
    await spool.dispose();
  }
}

function prepareStepInvocation(
  options: RunAgentWorkflowV2Options,
  graph: CompiledWorkflowGraph,
  ordinal: number,
  runId: string,
  safeIdentity: string,
  artifacts: readonly (WorkflowHandoffArtifact | undefined)[],
  groups: ReadonlyMap<string, RuntimeGroup>,
): PreparedStepInvocation {
  const step = graph.nodes[ordinal]!.step;
  const prepared =
    options.sourceVersion === 1
      ? prepareLegacyInputs(step, graph, artifacts, groups)
      : {
          instruction: step.message,
          references: Object.entries(step.inputs ?? {}).map(
            ([alias, reference]) => ({ alias, reference }),
          ),
        };
  const inputItems = prepared.references.map(({ alias, reference }) => {
    const artifact = artifactForReference(reference, graph, artifacts, groups);
    return { alias, reference, artifact };
  });
  const boundedItems = boundedInputItems(
    inputItems,
    options.effectiveLimits.maxHandoffTokens,
  );
  const envelope = createWorkflowAgentInvocationEnvelope({
    invocationId: `workflow:${runId}:${ordinal}`,
    runId,
    workflowId: options.workflowId,
    stepIdentity: safeIdentity,
    instruction: prepared.instruction,
    untrustedData: {
      kind: "workflow_inputs_v1",
      reduction: "deterministic_bounded_extract",
      maximum_handoff_tokens: options.effectiveLimits.maxHandoffTokens,
      logical_step_id: step.id,
      items: boundedItems,
    },
  });
  return Object.freeze({ instruction: prepared.instruction, envelope });
}

function prepareLegacyInputs(
  step: WorkflowStepV2,
  graph: CompiledWorkflowGraph,
  artifacts: readonly (WorkflowHandoffArtifact | undefined)[],
  groups: ReadonlyMap<string, RuntimeGroup>,
): {
  readonly instruction: string;
  readonly references: readonly {
    readonly alias: string;
    readonly reference: WorkflowRef;
  }[];
} {
  const references: Array<{ alias: string; reference: WorkflowRef }> = [];
  let nextAlias = 0;
  const instruction = step.message.replace(
    LEGACY_TEMPLATE_PATTERN,
    (_match, namespace: string, name: string) => {
      const alias = `legacy_${nextAlias}`;
      nextAlias += 1;
      const reference: WorkflowRef =
        namespace === "steps" ? { step: name } : { group: name };
      artifactForReference(reference, graph, artifacts, groups);
      references.push({ alias, reference });
      return `[[workflow-input:${alias}]]`;
    },
  );
  return Object.freeze({
    instruction,
    references: Object.freeze(references),
  });
}

function artifactForReference(
  reference: WorkflowRef,
  graph: CompiledWorkflowGraph,
  artifacts: readonly (WorkflowHandoffArtifact | undefined)[],
  groups: ReadonlyMap<string, RuntimeGroup>,
): WorkflowHandoffArtifact {
  if ("step" in reference) {
    const ordinal = graph.nodeById.get(reference.step)?.ordinal;
    const artifact = ordinal === undefined ? undefined : artifacts[ordinal];
    if (artifact === undefined) {
      throw new WorkflowSchedulerError(
        "WORKFLOW_INPUT_ARTIFACT_MISSING",
        `workflow input step ${JSON.stringify(reference.step)} has no committed handoff`,
      );
    }
    return artifact;
  }
  const artifact = groups.get(reference.group)?.artifact;
  if (artifact === undefined) {
    throw new WorkflowSchedulerError(
      "WORKFLOW_INPUT_ARTIFACT_MISSING",
      `workflow input group ${JSON.stringify(reference.group)} has no committed aggregate handoff`,
    );
  }
  return artifact;
}

function boundedInputItems(
  items: readonly {
    readonly alias: string;
    readonly reference: WorkflowRef;
    readonly artifact: WorkflowHandoffArtifact;
  }[],
  maximumTokens: number,
): readonly WorkflowInputItem[] {
  const maximumPreviewBytes =
    maximumTokens * WORKFLOW_HANDOFF_TOKEN_BYTES_PER_TOKEN;
  let reservedGroupBytes = 0;
  for (const item of items) {
    if (!("group" in item.reference)) continue;
    if (
      item.artifact.preview_truncated ||
      Buffer.byteLength(item.artifact.preview, "utf8") !==
        item.artifact.byte_length
    ) {
      throw new WorkflowSchedulerError(
        "WORKFLOW_GROUP_INPUT_INCOMPLETE",
        `workflow group ${JSON.stringify(item.reference.group)} does not have a complete model-facing aggregate`,
      );
    }
    reservedGroupBytes += Buffer.byteLength(item.artifact.preview, "utf8");
    if (reservedGroupBytes > maximumPreviewBytes) {
      throw new WorkflowSchedulerError(
        "WORKFLOW_GROUP_INPUT_LIMIT",
        `workflow group inputs require ${reservedGroupBytes} UTF-8 bytes but the admitted input limit is ${maximumPreviewBytes}`,
      );
    }
  }
  let remainingPreviewBytes = maximumPreviewBytes - reservedGroupBytes;
  return Object.freeze(
    items.map((item) => {
      const isGroup = "group" in item.reference;
      const preview = isGroup
        ? item.artifact.preview
        : boundedUtf8Prefix(item.artifact.preview, remainingPreviewBytes);
      if (!isGroup) {
        remainingPreviewBytes -= Buffer.byteLength(preview, "utf8");
      }
      return Object.freeze({
        alias: item.alias,
        reference: item.reference,
        handoff: Object.freeze({
          ...handoffReference(item.artifact, false),
          preview,
          preview_truncated:
            !isGroup &&
            (item.artifact.preview_truncated ||
              preview !== item.artifact.preview),
        }),
        extract_kind: "deterministic_bounded_extract" as const,
      });
    }),
  );
}

function createRuntimeGroups(
  graph: CompiledWorkflowGraph,
): Map<string, RuntimeGroup> {
  const groups = new Map<string, RuntimeGroup>();
  let index = 0;
  for (const [name, compiled] of graph.groups) {
    groups.set(name, {
      name,
      index,
      memberOrdinals: compiled.memberOrdinals,
      remaining: compiled.memberOrdinals.length,
    });
    index += 1;
  }
  return groups;
}

function boundedGroupAggregate(
  group: RuntimeGroup,
  graph: CompiledWorkflowGraph,
  artifacts: readonly (WorkflowHandoffArtifact | undefined)[],
  maximumTokens: number,
): string {
  const sources = group.memberOrdinals.map((ordinal) => {
    const artifact = artifacts[ordinal];
    if (artifact === undefined) {
      throw new WorkflowSchedulerError(
        "WORKFLOW_GROUP_ARTIFACT_MISSING",
        `successful workflow group ${JSON.stringify(group.name)} member ${ordinal} has no handoff`,
      );
    }
    return {
      id: graph.nodes[ordinal]!.step.id,
      artifact,
    };
  });
  const maximumBytes = Math.min(
    MAX_WORKFLOW_ARTIFACT_BYTES,
    // Group consumers currently receive the committed artifact through its
    // model-facing preview. Until a digest-bound read tool exists, keeping the
    // aggregate within that preview is required for complete JSON delivery.
    MAX_WORKFLOW_STEP_PREVIEW_BYTES,
    maximumTokens * WORKFLOW_HANDOFF_TOKEN_BYTES_PER_TOKEN,
  );
  const metadataMembers = sources.map(({ id, artifact }) => ({
    id,
    handoff: {
      ...handoffReference(artifact, false),
      preview: "",
      // `false` is one byte longer than `true`, making the metadata projection
      // an upper bound regardless of the final preview allocation.
      preview_truncated: false,
    },
  }));
  const metadata = serializeGroupAggregate(group.name, metadataMembers);
  const metadataBytes = Buffer.byteLength(metadata, "utf8");
  if (metadataBytes > maximumBytes) {
    throw new WorkflowSchedulerError(
      "WORKFLOW_GROUP_HANDOFF_LIMIT",
      `workflow group handoff metadata requires ${metadataBytes} UTF-8 bytes but the admitted limit is ${maximumBytes}`,
    );
  }

  const previewAllocation = allocateFairWorkflowGroupPreviews(
    sources.map(({ artifact }) => artifact.preview),
    maximumBytes - metadataBytes,
  );
  const members = sources.map(({ id, artifact }, index) => {
    const preview = previewAllocation.previews[index]!;
    return {
      id,
      handoff: {
        ...handoffReference(artifact, false),
        preview,
        preview_truncated:
          artifact.preview_truncated || preview !== artifact.preview,
      },
    };
  });
  const aggregate = serializeGroupAggregate(group.name, members);
  if (Buffer.byteLength(aggregate, "utf8") > maximumBytes) {
    throw new WorkflowSchedulerError(
      "WORKFLOW_GROUP_HANDOFF_LIMIT",
      "workflow group handoff preview allocation exceeded its admitted limit",
    );
  }
  return aggregate;
}

function serializeGroupAggregate(
  groupName: string,
  members: readonly unknown[],
): string {
  return `${WORKFLOW_GROUP_AGGREGATE_HEADER}${JSON.stringify({
    group: groupName,
    members,
  })}`;
}

export interface WorkflowGroupPreviewAllocationOperationCounts {
  readonly demandCodePointVisits: number;
  readonly allocationCodePointVisits: number;
  readonly retainedCodePointChunks: number;
}

export interface WorkflowGroupPreviewAllocation {
  readonly previews: readonly string[];
  readonly allocatedBodyBytes: number;
  readonly operationCounts: WorkflowGroupPreviewAllocationOperationCounts;
}

/** Max-min fair, stable, linear-space allocation for group preview JSON. */
export function allocateFairWorkflowGroupPreviews(
  values: readonly string[],
  maximumBodyBytes: number,
): WorkflowGroupPreviewAllocation {
  let demandCodePointVisits = 0;
  let allocationCodePointVisits = 0;
  const demandProfiles = values.map((value) => {
    let bodyBytes = 0;
    let minimumBodyBytes = 0;
    for (const codePoint of value) {
      demandCodePointVisits += 1;
      const codePointBytes = jsonEscapedCodePointBytes(codePoint);
      if (bodyBytes === 0) minimumBodyBytes = codePointBytes;
      bodyBytes += codePointBytes;
    }
    return { bodyBytes, minimumBodyBytes };
  });
  const minimumBodyBytes = demandProfiles.reduce(
    (total, profile) => total + profile.minimumBodyBytes,
    0,
  );
  if (minimumBodyBytes > maximumBodyBytes) {
    throw new WorkflowSchedulerError(
      "WORKFLOW_GROUP_HANDOFF_LIMIT",
      `workflow group handoff needs ${minimumBodyBytes} preview bytes to represent every nonempty member but only ${maximumBodyBytes} are available`,
    );
  }
  const additionalDemands = demandProfiles.map(
    (profile) => profile.bodyBytes - profile.minimumBodyBytes,
  );
  const availableAdditionalBytes = maximumBodyBytes - minimumBodyBytes;
  let low = 0;
  let high = Math.max(0, ...additionalDemands);
  while (low < high) {
    const share = Math.ceil((low + high) / 2);
    const required = additionalDemands.reduce(
      (total, demand) => total + Math.min(demand, share),
      0,
    );
    if (required <= availableAdditionalBytes) low = share;
    else high = share - 1;
  }

  const cursors = values.map((value, index) => {
    const iterator = value[Symbol.iterator]();
    const chunks: string[] = [];
    let bodyBytes = 0;
    let next: JsonCodePoint | undefined;
    const profile = demandProfiles[index]!;
    const targetBytes =
      profile.minimumBodyBytes + Math.min(additionalDemands[index]!, low);
    for (;;) {
      const step = iterator.next();
      if (step.done) break;
      allocationCodePointVisits += 1;
      const candidate = {
        text: step.value,
        bodyBytes: jsonEscapedCodePointBytes(step.value),
      };
      if (bodyBytes + candidate.bodyBytes > targetBytes) {
        next = candidate;
        break;
      }
      chunks.push(candidate.text);
      bodyBytes += candidate.bodyBytes;
    }
    return { iterator, chunks, bodyBytes, next };
  });
  let remaining =
    maximumBodyBytes -
    cursors.reduce((total, cursor) => total + cursor.bodyBytes, 0);
  let advanced = true;
  while (remaining > 0 && advanced) {
    advanced = false;
    for (const cursor of cursors) {
      const next = cursor.next;
      if (next === undefined) continue;
      if (next.bodyBytes > remaining) continue;
      cursor.chunks.push(next.text);
      cursor.bodyBytes += next.bodyBytes;
      remaining -= next.bodyBytes;
      const step = cursor.iterator.next();
      if (step.done) {
        cursor.next = undefined;
      } else {
        allocationCodePointVisits += 1;
        cursor.next = {
          text: step.value,
          bodyBytes: jsonEscapedCodePointBytes(step.value),
        };
      }
      advanced = true;
    }
  }
  const allocatedBodyBytes = cursors.reduce(
    (total, cursor) => total + cursor.bodyBytes,
    0,
  );
  const retainedCodePointChunks = cursors.reduce(
    (total, cursor) => total + cursor.chunks.length,
    0,
  );
  return Object.freeze({
    previews: Object.freeze(cursors.map((cursor) => cursor.chunks.join(""))),
    allocatedBodyBytes,
    operationCounts: Object.freeze({
      demandCodePointVisits,
      allocationCodePointVisits,
      retainedCodePointChunks,
    }),
  });
}

interface JsonCodePoint {
  readonly text: string;
  readonly bodyBytes: number;
}

function jsonEscapedCodePointBytes(value: string): number {
  const codePoint = value.codePointAt(0)!;
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (
    codePoint === 0x08 ||
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0c ||
    codePoint === 0x0d
  ) {
    return 2;
  }
  if (codePoint <= 0x1f) return 6;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function aggregateGroupOutcome(
  outcomes: readonly WorkflowStepOutcomeV2[],
): WorkflowGroupOutcomeV2 {
  if (outcomes.every((outcome) => outcome === "succeeded")) return "succeeded";
  if (
    outcomes.some(
      (outcome) =>
        outcome === "unknown_outcome" ||
        outcome === "blocked_dependency_unknown",
    )
  ) {
    return "unknown_outcome";
  }
  if (outcomes.some((outcome) => outcome === "handoff_failed")) {
    return "handoff_failed";
  }
  if (
    outcomes.some(
      (outcome) =>
        outcome === "failed" || outcome === "blocked_dependency_failed",
    )
  ) {
    return "failed";
  }
  return "cancelled";
}

function deriveRunOutcome(
  steps: readonly WorkflowStepResultV2[],
  cancellation: WorkflowCancellationV2 | undefined,
): WorkflowRunOutcomeV2 {
  if (
    steps.some(
      (step) =>
        step.outcome === "unknown_outcome" ||
        step.outcome === "blocked_dependency_unknown",
    )
  ) {
    return "unknown_outcome";
  }
  if (
    steps.some(
      (step) =>
        step.outcome === "failed" ||
        step.outcome === "handoff_failed" ||
        (step.outcome === "blocked_dependency_failed" &&
          cancellation === undefined),
    )
  ) {
    return "failed";
  }
  if (cancellation !== undefined && cancellation.cause !== "fail_fast_peer") {
    return "cancelled";
  }
  return "completed";
}

function blockedResult(
  step: WorkflowStepV2,
  ordinal: number,
  reason: Exclude<BlockReason, "none">,
): WorkflowStepResultV2 {
  return Object.freeze({
    id: step.id,
    ordinal,
    outcome:
      reason === "unknown"
        ? "blocked_dependency_unknown"
        : "blocked_dependency_failed",
    ...(step.task_name === undefined ? {} : { task_name: step.task_name }),
  });
}

function failedResult(
  node: CompiledWorkflowGraph["nodes"][number],
  error: unknown,
  durationMs?: number,
): WorkflowStepResultV2 {
  return Object.freeze({
    id: node.step.id,
    ordinal: node.ordinal,
    outcome: "failed",
    ...(node.step.task_name === undefined
      ? {}
      : { task_name: node.step.task_name }),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    error: boundedError(error),
  });
}

function handoffFailedResult(
  node: CompiledWorkflowGraph["nodes"][number],
  error: unknown,
  durationMs?: number,
): WorkflowStepResultV2 {
  return Object.freeze({
    id: node.step.id,
    ordinal: node.ordinal,
    outcome: "handoff_failed",
    ...(node.step.task_name === undefined
      ? {}
      : { task_name: node.step.task_name }),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    error: boundedError(error),
  });
}

function unknownResult(
  node: CompiledWorkflowGraph["nodes"][number],
  error: unknown,
  cancellation?: WorkflowCancellationV2,
  durationMs?: number,
): WorkflowStepResultV2 {
  return Object.freeze({
    id: node.step.id,
    ordinal: node.ordinal,
    outcome: "unknown_outcome",
    ...(node.step.task_name === undefined
      ? {}
      : { task_name: node.step.task_name }),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    ...(cancellation === undefined ? {} : { cancellation }),
    error: boundedError(error),
  });
}

function cancelledResult(
  node: CompiledWorkflowGraph["nodes"][number],
  cancellation: WorkflowCancellationV2,
  durationMs?: number,
): WorkflowStepResultV2 {
  return Object.freeze({
    id: node.step.id,
    ordinal: node.ordinal,
    outcome: "cancelled",
    ...(node.step.task_name === undefined
      ? {}
      : { task_name: node.step.task_name }),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    cancellation,
  });
}

function cancelledOrUnknownBeforeDispatch(
  entry: ActiveExecution,
  error: unknown,
): WorkflowStepResultV2 {
  const nodeLike = {
    ordinal: entry.ordinal,
    step: { id: String(entry.ordinal), message: "unreachable" },
  } as CompiledWorkflowGraph["nodes"][number];
  return entry.cancellation === undefined
    ? failedResult(nodeLike, error)
    : cancelledResult(nodeLike, entry.cancellation);
}

function completedExecution(
  node: CompiledWorkflowGraph["nodes"][number],
  result: WorkflowStepResultV2,
  artifact?: WorkflowHandoffArtifact,
): CompletedExecution {
  const normalized =
    result.id === node.step.id
      ? result
      : Object.freeze({
          ...result,
          id: node.step.id,
          ...(node.step.task_name === undefined
            ? {}
            : { task_name: node.step.task_name }),
        });
  return Object.freeze({
    ordinal: node.ordinal,
    result: normalized,
    ...(artifact === undefined ? {} : { artifact }),
  });
}

function blockReasonForOutcome(outcome: WorkflowStepOutcomeV2): BlockReason {
  switch (outcome) {
    case "succeeded":
      return "none";
    case "unknown_outcome":
    case "blocked_dependency_unknown":
      return "unknown";
    case "failed":
    case "cancelled":
    case "handoff_failed":
    case "blocked_dependency_failed":
      return "failed";
  }
}

function joinBlockReason(left: BlockReason, right: BlockReason): BlockReason {
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "failed" || right === "failed") return "failed";
  return "none";
}

function referencedGroups(step: WorkflowStepV2): readonly string[] {
  const groups = new Set<string>();
  for (const reference of [
    ...(step.after ?? []),
    ...Object.values(step.inputs ?? {}),
  ]) {
    if ("group" in reference) groups.add(reference.group);
  }
  return [...groups];
}

function handoffReference(
  artifact: WorkflowHandoffArtifact,
  includePreview = true,
): WorkflowHandoffReferenceV2 {
  return Object.freeze({
    artifact_id: artifact.artifact_id,
    storage_ref: artifact.storage_ref,
    digest: artifact.digest,
    byte_length: artifact.byte_length,
    token_count: artifact.token_count,
    ...(includePreview ? { preview: artifact.preview } : {}),
    preview_truncated: artifact.preview_truncated,
  });
}

function safeStepIdentity(runId: string, ordinal: number, logicalId: string): string {
  const digest = createHash("sha256")
    .update("agenc.workflow.step-path.v1\0")
    .update(runId)
    .update("\0")
    .update(String(ordinal))
    .update("\0")
    .update(logicalId)
    .digest("hex")
    .slice(0, WORKFLOW_AGENT_NAME_DIGEST_HEX_LENGTH);
  return `wf_${ordinal}_${digest}`;
}

function safeGroupIdentity(runId: string, index: number, logicalName: string): string {
  const digest = createHash("sha256")
    .update("agenc.workflow.group-artifact.v1\0")
    .update(runId)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(logicalName)
    .digest("hex")
    .slice(0, WORKFLOW_AGENT_NAME_DIGEST_HEX_LENGTH);
  return `group_${index}_${digest}`;
}

function isolationOptions(
  isolation: IsolationMode | undefined,
  sessionId: string,
  agentPath: string,
  spawnId: string,
): Readonly<Record<string, unknown>> {
  if (isolation === undefined || isolation === "none") return {};
  return {
    isolation,
    worktreeSlug: deriveAgentWorktreeSlug({ sessionId, agentPath, spawnId }),
  };
}

function conservativeHandoffTokenCount(text: string): number {
  return Math.max(
    1,
    estimateUtf8TokenUnits(text, WORKFLOW_HANDOFF_TOKEN_BYTES_PER_TOKEN),
  );
}

function validatedTokenCount(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_WORKFLOW_STEP_RESULT_TOKENS
  ) {
    throw new WorkflowSchedulerError(
      "WORKFLOW_HANDOFF_TOKEN_LIMIT",
      `workflow handoff token count must be between 0 and ${MAX_WORKFLOW_STEP_RESULT_TOKENS}`,
    );
  }
  return value;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedJsonString(message, WORKFLOW_ERROR_MAX_SERIALIZED_BYTES);
}

function boundedUtf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let prefix = value.slice(0, low);
  if (
    prefix.length > 0 &&
    prefix.charCodeAt(prefix.length - 1) >= 0xd800 &&
    prefix.charCodeAt(prefix.length - 1) <= 0xdbff
  ) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function assertEffectiveLimits(limits: EffectiveWorkflowLimits): void {
  if (
    limits.formatVersion !== 2 ||
    !Number.isSafeInteger(limits.maxConcurrency) ||
    limits.maxConcurrency < 1 ||
    limits.maxConcurrency > MAX_WORKFLOW_MAX_CONCURRENCY ||
    !Number.isSafeInteger(limits.maxHandoffTokens) ||
    limits.maxHandoffTokens < 1 ||
    limits.maxHandoffTokens > MAX_WORKFLOW_HANDOFF_TOKENS ||
    (limits.failurePolicy !== "continue_independent" &&
      limits.failurePolicy !== "fail_fast")
  ) {
    throw new WorkflowSchedulerError(
      "WORKFLOW_LIMITS_INVALID",
      "workflow effective limits are invalid",
    );
  }
}

function assertWorstCaseResultBudget(
  options: RunAgentWorkflowV2Options,
  graph: CompiledWorkflowGraph,
  runId: string,
): void {
  const longestStepId = graph.nodes.reduce(
    (longest, node) =>
      serializedStringBytes(node.step.id) > serializedStringBytes(longest)
        ? node.step.id
        : longest,
    "",
  );
  const cancellation: WorkflowCancellationV2 = Object.freeze({
    cause: "workflow_deadline",
    causal_step_id: longestStepId,
    sequence: Number.MAX_SAFE_INTEGER,
  });
  const groupMembers = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const group = node.step.group;
    if (group === undefined) continue;
    const members = groupMembers.get(group) ?? [];
    members.push(node.step.id);
    groupMembers.set(group, members);
  }
  const projection = {
    workflow_result_version: WORKFLOW_RESULT_VERSION,
    run_id: runId,
    workflow_id: options.workflowId,
    manifest_format_version: 2,
    manifest_digest: options.manifestDigest,
    outcome: "unknown_outcome",
    effective_limits: {
      max_concurrency: options.effectiveLimits.maxConcurrency,
      max_handoff_tokens: options.effectiveLimits.maxHandoffTokens,
      failure_policy: options.effectiveLimits.failurePolicy,
    },
    steps: graph.nodes.map((node) => ({
      id: node.step.id,
      ordinal: node.ordinal,
      outcome: "blocked_dependency_unknown",
      ...(node.step.task_name === undefined
        ? {}
        : { task_name: node.step.task_name }),
      duration_ms: WORKFLOW_WORST_CASE_NUMBER,
      error: WORKFLOW_WORST_CASE_ERROR,
      cancellation,
      handoff: WORKFLOW_WORST_CASE_HANDOFF,
    })),
    groups: [...groupMembers].map(([name, memberIds]) => ({
      name,
      outcome: "blocked_dependency_unknown",
      member_ids: memberIds,
      handoff: WORKFLOW_WORST_CASE_HANDOFF,
    })),
    cancellation,
    operation_counts: {
      node_transitions: Number.MAX_SAFE_INTEGER,
      edge_consumptions: Number.MAX_SAFE_INTEGER,
      ready_enqueues: Number.MAX_SAFE_INTEGER,
      ready_dequeues: Number.MAX_SAFE_INTEGER,
      launches: Number.MAX_SAFE_INTEGER,
    },
  };
  const maximumBytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
  if (maximumBytes > MAX_WORKFLOW_FINAL_RESPONSE_BYTES) {
    throw new WorkflowSchedulerError(
      "WORKFLOW_FINAL_RESPONSE_LIMIT",
      `workflow worst-case result requires ${maximumBytes} UTF-8 bytes but the response limit is ${MAX_WORKFLOW_FINAL_RESPONSE_BYTES}`,
    );
  }
}

function serializedStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedJsonString(value: string, maximumBytes: number): string {
  if (serializedStringBytes(value) <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (serializedStringBytes(candidate) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let prefix = value.slice(0, low);
  if (
    prefix.length > 0 &&
    isHighSurrogateCodeUnit(prefix.charCodeAt(prefix.length - 1))
  ) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function isHighSurrogateCodeUnit(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function compactResultPreviewsToLimit(
  result: WorkflowRunResultV2,
): WorkflowRunResultV2 {
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") <=
    MAX_WORKFLOW_FINAL_RESPONSE_BYTES
  ) {
    return result;
  }
  const compact: WorkflowRunResultV2 = Object.freeze({
    ...result,
    steps: Object.freeze(
      result.steps.map((step) =>
        step.handoff === undefined
          ? step
          : Object.freeze({
              ...step,
              handoff: Object.freeze({
                ...step.handoff,
                preview: undefined,
                preview_truncated: true,
              }),
            }),
      ),
    ),
    groups: Object.freeze(
      result.groups.map((group) =>
        group.handoff === undefined
          ? group
          : Object.freeze({
              ...group,
              handoff: Object.freeze({
                ...group.handoff,
                preview: undefined,
                preview_truncated: true,
              }),
            }),
      ),
    ),
  });
  if (
    Buffer.byteLength(JSON.stringify(compact), "utf8") >
    MAX_WORKFLOW_FINAL_RESPONSE_BYTES
  ) {
    throw new WorkflowSchedulerError(
      "WORKFLOW_FINAL_RESPONSE_LIMIT",
      `workflow result exceeds ${MAX_WORKFLOW_FINAL_RESPONSE_BYTES} UTF-8 bytes`,
    );
  }
  return compact;
}
