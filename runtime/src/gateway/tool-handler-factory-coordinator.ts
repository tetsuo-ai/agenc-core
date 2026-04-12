/**
 * Explicit worker coordination on top of the delegated sub-agent runtime.
 *
 * This keeps worker lifecycle control session-scoped while reusing the same
 * admission, scope, and execution contract as execute_with_agent.
 *
 * @module
 */

import {
  parseCoordinatorModeInput,
  type CoordinatorModeInput,
} from "./coordinator-tool.js";
import {
  executeDelegationTool,
  type ExecuteDelegationToolParams,
} from "./tool-handler-factory-delegation.js";
import { assessDelegationScope } from "./delegation-scope.js";
import { assessDirectDelegationAdmission } from "./delegation-admission.js";
import {
  resolveDelegatedChildToolScope,
} from "../utils/delegation-validation.js";
import {
  deriveDelegatedExecutionEnvelopeFromParent,
} from "../utils/delegation-execution-context.js";
import {
  preflightDelegatedLocalFileScope,
  toolScopeRequiresStructuredExecutionContext,
} from "./delegated-scope-preflight.js";
import {
  computeDelegatedExecutionEnvelopeFingerprint,
  mergeVerifierRequirements,
} from "./delegated-runtime-result.js";
import type { PersistentWorkerManager } from "./persistent-worker-manager.js";
import {
  type PreparedPersistentWorkerAssignment,
} from "./persistent-worker-manager.js";
import { isSubAgentSessionId } from "./delegation-runtime.js";

interface CoordinatorWorkerSummary {
  readonly workerSessionId: string;
  readonly status: string;
  readonly depth: number;
  readonly startedAt: number;
  readonly task: string;
  readonly success?: boolean;
  readonly durationMs?: number;
  readonly toolCalls?: number;
  readonly completionState?: string;
  readonly stopReason?: string;
  readonly validationCode?: string;
  readonly outputPreview?: string;
}

type WorkerResolutionResult =
  | { ok: true; workerSessionId: string }
  | { ok: false; error: string };

interface ExecuteCoordinatorModeToolParams
  extends ExecuteDelegationToolParams {
  readonly workerManager?: PersistentWorkerManager | null;
}

function previewOutput(output: string | undefined, maxChars = 160): string | undefined {
  if (typeof output !== "string") return undefined;
  const normalized = output.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function buildWorkerSummary(
  params: ExecuteCoordinatorModeToolParams,
  workerSessionId: string,
): CoordinatorWorkerSummary | undefined {
  const info = params.subAgentManager?.getInfo(workerSessionId);
  if (!info) return undefined;
  const result = params.subAgentManager?.getResult(workerSessionId);
  return {
    workerSessionId: info.sessionId,
    status: info.status,
    depth: info.depth,
    startedAt: info.startedAt,
    task: info.task,
    ...(typeof result?.success === "boolean" ? { success: result.success } : {}),
    ...(typeof result?.durationMs === "number" ? { durationMs: result.durationMs } : {}),
    ...(result ? { toolCalls: result.toolCalls.length } : {}),
    ...(result?.completionState ? { completionState: result.completionState } : {}),
    ...(result?.stopReason ? { stopReason: result.stopReason } : {}),
    ...(result?.validationCode ? { validationCode: result.validationCode } : {}),
    ...(previewOutput(result?.output) ? { outputPreview: previewOutput(result?.output) } : {}),
  };
}

function buildLegacyListResult(
  params: ExecuteCoordinatorModeToolParams,
): string {
  const workers = (params.subAgentManager?.listAll() ?? [])
    .filter((worker) => worker.parentSessionId === params.sessionId)
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((worker) => buildWorkerSummary(params, worker.sessionId))
    .filter((worker): worker is CoordinatorWorkerSummary => Boolean(worker));

  const activeWorkerSessionIds = workers
    .filter((worker) => worker.status === "running")
    .map((worker) => worker.workerSessionId);

  return JSON.stringify({
    success: true,
    action: "list",
    workers,
    activeWorkerSessionIds,
    latestSuccessfulWorkerSessionId:
      params.subAgentManager?.findLatestSuccessfulSessionId(params.sessionId),
  });
}

function resolveExistingLegacyWorker(
  params: ExecuteCoordinatorModeToolParams,
  input: CoordinatorModeInput,
): WorkerResolutionResult {
  const requestedWorkerSessionId = input.workerId?.trim();
  if (!requestedWorkerSessionId) {
    const latestSuccessfulWorkerSessionId =
      params.subAgentManager?.findLatestSuccessfulSessionId(params.sessionId);
    if (!latestSuccessfulWorkerSessionId) {
      return {
        ok: false,
        error:
          "No reusable completed worker is available for this parent session",
      };
    }
    return {
      ok: true,
      workerSessionId: latestSuccessfulWorkerSessionId,
    };
  }

  const info = params.subAgentManager?.getInfo(requestedWorkerSessionId);
  if (!info) {
    return {
      ok: false,
      error: `Worker "${requestedWorkerSessionId}" was not found`,
    };
  }
  if (info.parentSessionId !== params.sessionId) {
    return {
      ok: false,
      error:
        `Worker "${requestedWorkerSessionId}" belongs to a different parent session`,
    };
  }
  if (info.status === "running") {
    return {
      ok: false,
      error:
        `Worker "${requestedWorkerSessionId}" is still running; wait for completion or stop it first`,
    };
  }
  return {
    ok: true,
    workerSessionId: requestedWorkerSessionId,
  };
}

function buildLegacyStopResult(
  params: ExecuteCoordinatorModeToolParams,
  input: CoordinatorModeInput,
): string {
  const workerSessionId = input.workerId?.trim();
  if (!workerSessionId) {
    return JSON.stringify({
      error:
        'coordinator_mode action "stop" requires a non-empty "workerId"',
    });
  }

  const info = params.subAgentManager?.getInfo(workerSessionId);
  if (!info) {
    return JSON.stringify({
      error: `Worker "${workerSessionId}" was not found`,
    });
  }
  if (info.parentSessionId !== params.sessionId) {
    return JSON.stringify({
      error:
        `Worker "${workerSessionId}" belongs to a different parent session`,
    });
  }
  if (info.status !== "running") {
    return JSON.stringify({
      success: true,
      action: "stop",
      workerSessionId,
      status: info.status,
      alreadyStopped: true,
    });
  }

  const stopped = params.subAgentManager?.cancel(workerSessionId) === true;
  if (!stopped) {
    return JSON.stringify({
      error: `Worker "${workerSessionId}" could not be stopped`,
    });
  }

  const stoppedInfo = params.subAgentManager?.getInfo(workerSessionId);
  return JSON.stringify({
    success: true,
    action: "stop",
    workerSessionId,
    status: stoppedInfo?.status ?? "cancelled",
  });
}

async function executeLegacyCoordinatorDelegation(
  params: ExecuteCoordinatorModeToolParams,
  input: CoordinatorModeInput,
): Promise<string> {
  if (!input.request) {
    return JSON.stringify({
      error: `coordinator_mode action "${input.action}" requires a child request`,
    });
  }

  const action = input.action;
  if (action === "spawn") {
    return executeDelegationTool({
      ...params,
      toolArgs: {
        ...input.request,
      },
    });
  }

  const resolvedWorker = resolveExistingLegacyWorker(params, input);
  if (!resolvedWorker.ok) {
    return JSON.stringify({ error: resolvedWorker.error });
  }

  return executeDelegationTool({
    ...params,
    toolArgs: {
      ...input.request,
      continuationSessionId: resolvedWorker.workerSessionId,
    },
  });
}

function emitCoordinatorFailure(
  params: ExecuteCoordinatorModeToolParams,
  input: NonNullable<CoordinatorModeInput["request"]>,
  payload: {
    readonly stage: string;
    readonly reason: string;
    readonly extra?: Record<string, unknown>;
  },
): void {
  params.lifecycleEmitter?.emit({
    type: "subagents.failed",
    timestamp: Date.now(),
    sessionId: params.sessionId,
    parentSessionId: params.sessionId,
    toolName: params.name,
    payload: {
      objective: input.objective ?? input.task,
      stage: payload.stage,
      reason: payload.reason,
      toolCallId: params.toolCallId,
      ...(payload.extra ?? {}),
    },
  });
}

async function preparePersistentWorkerAssignment(
  params: ExecuteCoordinatorModeToolParams,
  input: NonNullable<CoordinatorModeInput["request"]>,
): Promise<
  | { ok: true; assignment: PreparedPersistentWorkerAssignment }
  | { ok: false; response: string }
> {
  const scopeAssessment = assessDelegationScope(input);
  if (!params.unsafeBenchmarkMode && !scopeAssessment.ok) {
    emitCoordinatorFailure(params, input, {
      stage: "validation",
      reason: scopeAssessment.error ?? "Delegated scope requires decomposition",
      extra: {
        phases: scopeAssessment.phases,
        decomposition: scopeAssessment.decomposition,
      },
    });
    return {
      ok: false,
      response: JSON.stringify({
        success: false,
        status: "needs_decomposition",
        objective: input.objective ?? input.task,
        error: scopeAssessment.error ?? "Delegated scope requires decomposition",
        decomposition: scopeAssessment.decomposition,
      }),
    };
  }

  const objective = input.objective ?? input.task;
  const resolvedChildScope = resolveDelegatedChildToolScope({
    spec: input,
    requestedTools: input.tools,
    parentAllowedTools: params.availableToolNames,
    availableTools: params.availableToolNames,
    allowDelegationTools: isSubAgentSessionId(params.sessionId),
    enforceParentIntersection: true,
    strictExplicitToolAllowlist: Array.isArray(input.tools) && input.tools.length > 0,
    unsafeBenchmarkMode: params.unsafeBenchmarkMode,
  });
  const derivedExecutionEnvelope = deriveDelegatedExecutionEnvelopeFromParent({
    parentWorkspaceRoot: params.defaultWorkingDirectory,
    parentAllowedReadRoots: params.parentAllowedReadRoots,
    parentAllowedWriteRoots: params.parentAllowedWriteRoots,
    requestedExecutionContext: input.executionContext,
    requiresStructuredExecutionContext: toolScopeRequiresStructuredExecutionContext(
      resolvedChildScope.allowedTools,
    ),
    source: "direct_live_path",
  });
  if (!derivedExecutionEnvelope.ok) {
    emitCoordinatorFailure(params, input, {
      stage: "validation",
      reason: derivedExecutionEnvelope.error,
      extra: { issues: derivedExecutionEnvelope.issues },
    });
    return {
      ok: false,
      response: JSON.stringify({
        success: false,
        status: "failed",
        objective,
        error: derivedExecutionEnvelope.error,
        issues: derivedExecutionEnvelope.issues,
      }),
    };
  }

  const effectiveExecutionContext = derivedExecutionEnvelope.executionContext;
  const workingDirectory = derivedExecutionEnvelope.workingDirectory;
  const delegatedScopePreflight = preflightDelegatedLocalFileScope({
    executionContext: effectiveExecutionContext,
    workingDirectory,
    allowedTools: resolvedChildScope.allowedTools,
  });
  if (!delegatedScopePreflight.ok) {
    emitCoordinatorFailure(params, input, {
      stage: "validation",
      reason: delegatedScopePreflight.error,
      extra: { issues: delegatedScopePreflight.issues },
    });
    return {
      ok: false,
      response: JSON.stringify({
        success: false,
        status: "failed",
        objective,
        error: delegatedScopePreflight.error,
        issues: delegatedScopePreflight.issues,
      }),
    };
  }

  const admission = assessDirectDelegationAdmission({
    input: effectiveExecutionContext
      ? { ...input, executionContext: effectiveExecutionContext }
      : input,
    threshold: params.delegationThreshold ?? 0.2,
  });
  if (!params.unsafeBenchmarkMode && !admission.allowed) {
    emitCoordinatorFailure(params, input, {
      stage: "admission",
      reason: admission.reason,
      extra: {
        shape: admission.shape,
        diagnostics: admission.diagnostics,
      },
    });
    return {
      ok: false,
      response: JSON.stringify({
        success: false,
        status: "failed",
        objective,
        error: `Delegation admission rejected: ${admission.reason}`,
        shape: admission.shape,
        diagnostics: admission.diagnostics,
      }),
    };
  }

  const admittedInput =
    admission.allowed && !input.delegationAdmission
      ? {
          ...(effectiveExecutionContext
            ? { ...input, executionContext: effectiveExecutionContext }
            : input),
          delegationAdmission: admission.stepAdmissions[0]
            ? {
                ...(admission.stepAdmissions[0].shape
                  ? { shape: admission.stepAdmissions[0].shape }
                  : {}),
                isolationReason: admission.stepAdmissions[0].isolationReason,
                ownedArtifacts: admission.stepAdmissions[0].ownedArtifacts,
                verifierObligations:
                  admission.stepAdmissions[0].verifierObligations,
              }
            : undefined,
        }
      : effectiveExecutionContext
        ? { ...input, executionContext: effectiveExecutionContext }
        : input;
  const inheritedVerifierRequirement =
    isSubAgentSessionId(params.sessionId) &&
      typeof params.subAgentManager?.getVerifierRequirement === "function"
      ? params.subAgentManager.getVerifierRequirement(params.sessionId)
      : undefined;
  const verifierRequirement = mergeVerifierRequirements({
    inherited: inheritedVerifierRequirement,
    resolved: params.verifier?.resolveVerifierRequirement({
      runtimeRequired: params.runtimeContractFlags?.verifierRuntimeRequired,
      projectBootstrap: params.runtimeContractFlags?.verifierProjectBootstrap,
      workspaceRoot: workingDirectory,
    }),
  });
  return {
    ok: true,
    assignment: {
      request: input,
      objective,
      admittedInput,
      ...(params.shellProfile ? { shellProfile: params.shellProfile } : {}),
      allowedTools: resolvedChildScope.allowedTools,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(effectiveExecutionContext
        ? {
            executionContextFingerprint: JSON.stringify(effectiveExecutionContext),
          }
        : {}),
      executionEnvelopeFingerprint: computeDelegatedExecutionEnvelopeFingerprint({
        workingDirectory,
        executionContext: effectiveExecutionContext,
        allowedTools: resolvedChildScope.allowedTools,
      }),
      ...(verifierRequirement ? { verifierRequirement } : {}),
      ...(admittedInput.delegationAdmission?.ownedArtifacts
        ? { ownedArtifacts: admittedInput.delegationAdmission.ownedArtifacts }
        : {}),
      ...(params.unsafeBenchmarkMode ? { unsafeBenchmarkMode: true } : {}),
    },
  };
}

async function buildPersistentListResult(
  params: ExecuteCoordinatorModeToolParams,
  workerManager: PersistentWorkerManager,
): Promise<string> {
  const workers = await workerManager.listWorkers(params.sessionId);
  const latestReusableWorkerId = await workerManager.getLatestReusableWorkerId(
    params.sessionId,
  );
  return JSON.stringify({
    success: true,
    action: "list",
    workers: workers.map((worker) => ({
      ...worker,
      ...(worker.continuationSessionId
        ? { workerSessionId: worker.continuationSessionId }
        : {}),
    })),
    activeWorkerIds: workers
      .filter((worker) => worker.state !== "idle" && worker.state !== "completed")
      .map((worker) => worker.workerId),
    ...(latestReusableWorkerId ? { latestReusableWorkerId } : {}),
  });
}

async function buildPersistentStopResult(
  params: ExecuteCoordinatorModeToolParams,
  workerManager: PersistentWorkerManager,
  input: CoordinatorModeInput,
): Promise<string> {
  const workerId = input.workerId?.trim();
  if (!workerId) {
    return JSON.stringify({
      error: 'coordinator_mode action "stop" requires a non-empty "workerId"',
    });
  }
  const stopped = await workerManager.stopWorker({
    parentSessionId: params.sessionId,
    workerIdOrSessionId: workerId,
  });
  if (!stopped) {
    return JSON.stringify({
      error: `Worker "${workerId}" was not found`,
    });
  }
  return JSON.stringify({
    success: true,
    action: "stop",
    workerId: stopped.workerId,
    ...(stopped.continuationSessionId
      ? { workerSessionId: stopped.continuationSessionId }
      : {}),
    status: stopped.state,
    worker: stopped,
  });
}

async function buildPersistentMailboxMessagesResult(
  params: ExecuteCoordinatorModeToolParams,
  workerManager: PersistentWorkerManager,
  input: CoordinatorModeInput,
): Promise<string> {
  const messages = await workerManager.listMailboxMessages({
    parentSessionId: params.sessionId,
    ...(input.workerId ? { workerIdOrSessionId: input.workerId } : {}),
    ...(input.direction ? { direction: input.direction } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  });
  return JSON.stringify({
    success: true,
    action: "messages",
    messages,
  });
}

async function buildPersistentMailboxAckResult(
  params: ExecuteCoordinatorModeToolParams,
  workerManager: PersistentWorkerManager,
  input: CoordinatorModeInput,
): Promise<string> {
  const messageId = input.messageId?.trim();
  if (!messageId) {
    return JSON.stringify({
      error: 'coordinator_mode action "ack" requires a non-empty "messageId"',
    });
  }
  const message = await workerManager.acknowledgeMailboxMessage({
    parentSessionId: params.sessionId,
    messageId,
  });
  if (!message) {
    return JSON.stringify({
      error: `Mailbox message "${messageId}" was not found`,
    });
  }
  return JSON.stringify({
    success: true,
    action: "ack",
    message,
  });
}

async function buildPersistentPermissionResponseResult(
  params: ExecuteCoordinatorModeToolParams,
  workerManager: PersistentWorkerManager,
  input: CoordinatorModeInput,
): Promise<string> {
  const messageId = input.messageId?.trim();
  if (!messageId || !input.disposition) {
    return JSON.stringify({
      error:
        'coordinator_mode action "respond_permission" requires "messageId" and "disposition"',
    });
  }
  const response = await workerManager.respondToPermissionRequest({
    parentSessionId: params.sessionId,
    messageId,
    disposition: input.disposition,
  });
  if (!response) {
    return JSON.stringify({
      error: `Permission request "${messageId}" was not found`,
    });
  }
  return JSON.stringify({
    success: true,
    action: "respond_permission",
    message: response,
  });
}

async function buildPersistentCoordinatorMessageResult(
  params: ExecuteCoordinatorModeToolParams,
  workerManager: PersistentWorkerManager,
  input: CoordinatorModeInput,
): Promise<string> {
  const workerId = input.workerId?.trim();
  const body = input.body?.trim();
  if (!workerId || !body) {
    return JSON.stringify({
      error:
        'coordinator_mode action "message" requires non-empty "workerId" and "body"',
    });
  }
  const message = await workerManager.sendCoordinatorMessage({
    parentSessionId: params.sessionId,
    workerIdOrSessionId: workerId,
    body,
    ...(input.subject ? { subject: input.subject } : {}),
  });
  if (!message) {
    return JSON.stringify({
      error: `Worker "${workerId}" was not found`,
    });
  }
  return JSON.stringify({
    success: true,
    action: "message",
    message,
  });
}

async function executePersistentCoordinatorAction(
  params: ExecuteCoordinatorModeToolParams,
  workerManager: PersistentWorkerManager,
  input: CoordinatorModeInput,
): Promise<string> {
  switch (input.action) {
    case "list":
      return buildPersistentListResult(params, workerManager);
    case "messages":
      return buildPersistentMailboxMessagesResult(params, workerManager, input);
    case "ack":
      return buildPersistentMailboxAckResult(params, workerManager, input);
    case "respond_permission":
      return buildPersistentPermissionResponseResult(
        params,
        workerManager,
        input,
      );
    case "message":
      return buildPersistentCoordinatorMessageResult(
        params,
        workerManager,
        input,
      );
    case "stop":
      return buildPersistentStopResult(params, workerManager, input);
    case "spawn": {
      const worker = await workerManager.createWorker({
        parentSessionId: params.sessionId,
        workerName: input.workerName,
      });
      if (!input.request) {
        return JSON.stringify({
          success: true,
          action: "spawn",
          workerId: worker.workerId,
          workerName: worker.workerName,
          worker,
        });
      }
      const prepared = await preparePersistentWorkerAssignment(params, input.request);
      if (!prepared.ok) {
        return prepared.response;
      }
      const queued = await workerManager.assignToWorker({
        parentSessionId: params.sessionId,
        workerId: worker.workerId,
        assignment: prepared.assignment,
      });
      return JSON.stringify({
        success: true,
        action: "spawn",
        workerId: worker.workerId,
        workerName: worker.workerName,
        ...(queued.worker.continuationSessionId
          ? { workerSessionId: queued.worker.continuationSessionId }
          : {}),
        worker: queued.worker,
        task: {
          id: queued.task.id,
          kind: queued.task.kind,
          status: queued.task.status,
          summary: queued.task.summary,
          outputReady: queued.task.outputReady ?? false,
          waitTool: "task.wait",
          outputTool: "task.output",
        },
      });
    }
    case "reuse":
    case "follow_up": {
      if (!input.request) {
        return JSON.stringify({
          error: `coordinator_mode action "${input.action}" requires a child request`,
        });
      }
      const prepared = await preparePersistentWorkerAssignment(params, input.request);
      if (!prepared.ok) {
        return prepared.response;
      }
      const worker = await workerManager.pickWorkerForAssignment({
        parentSessionId: params.sessionId,
        workerIdOrSessionId: input.workerId,
        assignment: prepared.assignment,
      });
      if (!worker) {
        return JSON.stringify({
          error: input.workerId
            ? `Worker "${input.workerId}" was not found or is not compatible with the requested scope`
            : "No compatible reusable worker is available for this parent session",
        });
      }
      const queued = await workerManager.assignToWorker({
        parentSessionId: params.sessionId,
        workerId: worker.workerId,
        assignment: prepared.assignment,
      });
      return JSON.stringify({
        success: true,
        action: input.action,
        workerId: worker.workerId,
        workerName: worker.workerName,
        ...(queued.worker.continuationSessionId
          ? { workerSessionId: queued.worker.continuationSessionId }
          : {}),
        worker: queued.worker,
        task: {
          id: queued.task.id,
          kind: queued.task.kind,
          status: queued.task.status,
          summary: queued.task.summary,
          outputReady: queued.task.outputReady ?? false,
          waitTool: "task.wait",
          outputTool: "task.output",
        },
      });
    }
    default:
      return JSON.stringify({
        error: `Unsupported coordinator_mode action "${String((input as { action?: unknown }).action)}"`,
      });
  }
}

export async function executeCoordinatorModeTool(
  params: ExecuteCoordinatorModeToolParams,
): Promise<string> {
  const parsed = parseCoordinatorModeInput(params.toolArgs);
  if (!parsed.ok) {
    return JSON.stringify({ error: parsed.error });
  }

  const workerModeEnabled =
    params.runtimeContractFlags?.persistentWorkersEnabled === true;
  const workerManager = params.workerManager ?? null;
  const input = parsed.value;
  if (workerModeEnabled) {
    if (!workerManager) {
      return JSON.stringify({
        error: "Persistent worker runtime unavailable: worker manager is not initialized",
      });
    }
    return executePersistentCoordinatorAction(params, workerManager, input);
  }

  switch (input.action) {
    case "list":
      return buildLegacyListResult(params);
    case "stop":
      return buildLegacyStopResult(params, input);
    case "spawn":
    case "reuse":
    case "follow_up":
      return executeLegacyCoordinatorDelegation(params, input);
    default:
      return JSON.stringify({
        error: `Unsupported coordinator_mode action "${String((input as { action?: unknown }).action)}"`,
      });
  }
}
