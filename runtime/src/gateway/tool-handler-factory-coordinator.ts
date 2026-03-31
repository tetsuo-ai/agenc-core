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
import { executeDelegationTool, type ExecuteDelegationToolParams } from "./tool-handler-factory-delegation.js";

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

function buildListResult(
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

function resolveExistingWorker(
  params: ExecuteCoordinatorModeToolParams,
  input: CoordinatorModeInput,
): WorkerResolutionResult {
  const requestedWorkerSessionId = input.workerSessionId?.trim();
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

function buildStopResult(
  params: ExecuteCoordinatorModeToolParams,
  input: CoordinatorModeInput,
): string {
  const workerSessionId = input.workerSessionId?.trim();
  if (!workerSessionId) {
    return JSON.stringify({
      error:
        'coordinator_mode action "stop" requires a non-empty "workerSessionId"',
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

async function executeCoordinatorDelegation(
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

  const resolvedWorker = resolveExistingWorker(params, input);
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

export interface ExecuteCoordinatorModeToolParams
  extends ExecuteDelegationToolParams {}

export async function executeCoordinatorModeTool(
  params: ExecuteCoordinatorModeToolParams,
): Promise<string> {
  const parsed = parseCoordinatorModeInput(params.toolArgs);
  if (!parsed.ok) {
    return JSON.stringify({ error: parsed.error });
  }

  const input = parsed.value;
  switch (input.action) {
    case "list":
      return buildListResult(params);
    case "stop":
      return buildStopResult(params, input);
    case "spawn":
    case "reuse":
    case "follow_up":
      return executeCoordinatorDelegation(params, input);
    default:
      return JSON.stringify({
        error: `Unsupported coordinator_mode action "${String((input as { action?: unknown }).action)}"`,
      });
  }
}
