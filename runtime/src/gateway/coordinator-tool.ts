/**
 * Explicit worker coordination tool schema and argument parsing helpers.
 *
 * The runtime executes this through the session-scoped tool handler so it can
 * inspect and control workers bound to the current parent session.
 *
 * @module
 */

import type { Tool } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import type { ExecuteWithAgentInput } from "./delegation-tool.js";
import { parseExecuteWithAgentInput } from "./delegation-tool.js";

export const COORDINATOR_MODE_TOOL_NAME = "coordinator_mode";

const DIRECT_EXECUTION_ERROR =
  "coordinator_mode must run through a session-scoped tool handler";

export type CoordinatorModeAction =
  | "list"
  | "spawn"
  | "reuse"
  | "follow_up"
  | "stop";

export interface CoordinatorModeInput {
  readonly action: CoordinatorModeAction;
  readonly workerSessionId?: string;
  readonly request?: ExecuteWithAgentInput;
}

export type ParseCoordinatorModeResult =
  | { ok: true; value: CoordinatorModeInput }
  | { ok: false; error: string };

const ACTION_ALIASES: Readonly<Record<string, CoordinatorModeAction>> = {
  list: "list",
  list_workers: "list",
  spawn: "spawn",
  start: "spawn",
  new_worker: "spawn",
  reuse: "reuse",
  reuse_worker: "reuse",
  resume: "reuse",
  continue: "reuse",
  follow_up: "follow_up",
  followup: "follow_up",
  "follow-up": "follow_up",
  reply: "follow_up",
  message: "follow_up",
  stop: "stop",
  cancel: "stop",
  terminate: "stop",
  kill: "stop",
};

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAction(value: unknown): CoordinatorModeAction | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return ACTION_ALIASES[normalized];
}

function normalizeDelegationError(error: string): string {
  return error.replaceAll("execute_with_agent", COORDINATOR_MODE_TOOL_NAME);
}

function resolveWorkerSessionId(args: Record<string, unknown>): string | undefined {
  return (
    toNonEmptyString(args.workerSessionId) ??
    toNonEmptyString(args.worker_session_id) ??
    toNonEmptyString(args.subagentSessionId) ??
    toNonEmptyString(args.subagent_session_id)
  );
}

function sanitizeCoordinatorDelegationArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const executionContext = args.executionContext;
  if (
    !executionContext ||
    typeof executionContext !== "object" ||
    Array.isArray(executionContext)
  ) {
    return args;
  }

  const {
    workspaceRoot: _workspaceRoot,
    workspace_root: _workspaceRootLegacy,
    allowedReadRoots: _allowedReadRoots,
    allowed_read_roots: _allowedReadRootsLegacy,
    allowedWriteRoots: _allowedWriteRoots,
    allowed_write_roots: _allowedWriteRootsLegacy,
    ...safeExecutionContext
  } = executionContext as Record<string, unknown>;

  return {
    ...args,
    executionContext: safeExecutionContext,
  };
}

export function parseCoordinatorModeInput(
  args: Record<string, unknown>,
): ParseCoordinatorModeResult {
  const action = normalizeAction(args.action);
  if (!action) {
    return {
      ok: false,
      error:
        'coordinator_mode requires an "action" of "list", "spawn", "reuse", "follow_up", or "stop"',
    };
  }

  const workerSessionId = resolveWorkerSessionId(args);

  if (action === "list") {
    return {
      ok: true,
      value: { action },
    };
  }

  if (action === "stop") {
    if (!workerSessionId) {
      return {
        ok: false,
        error:
          'coordinator_mode action "stop" requires a non-empty "workerSessionId"',
      };
    }
    return {
      ok: true,
      value: {
        action,
        workerSessionId,
      },
    };
  }

  const parsedRequest = parseExecuteWithAgentInput(
    sanitizeCoordinatorDelegationArgs(args),
  );
  if (!parsedRequest.ok) {
    return {
      ok: false,
      error: normalizeDelegationError(parsedRequest.error),
    };
  }

  if (action === "spawn" && parsedRequest.value.continuationSessionId) {
    return {
      ok: false,
      error:
        'coordinator_mode action "spawn" does not accept "continuationSessionId"; use "reuse" or "follow_up" instead',
    };
  }

  const resolvedWorkerSessionId =
    workerSessionId ?? parsedRequest.value.continuationSessionId;

  return {
    ok: true,
    value: {
      action,
      ...(action === "spawn"
        ? {}
        : resolvedWorkerSessionId
          ? { workerSessionId: resolvedWorkerSessionId }
          : {}),
      request: parsedRequest.value,
    },
  };
}

export function createCoordinatorModeTool(): Tool {
  return {
    name: COORDINATOR_MODE_TOOL_NAME,
    description:
      "Explicitly list, spawn, reuse, follow up, or stop scoped worker sessions within the current parent session.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            'Worker coordination action: "list", "spawn", "reuse", "follow_up", or "stop".',
        },
        workerSessionId: {
          type: "string",
          description:
            "Optional existing worker session to reuse, follow up, or stop. Legacy planner payloads may also include it on spawn, where it is ignored.",
        },
        task: {
          type: "string",
          description: "Child task objective to execute for spawn/reuse/follow_up.",
        },
        objective: {
          type: "string",
          description:
            "Alias for task when planner emits objective-centric payloads.",
        },
        tools: {
          type: "array",
          description:
            "Optional explicit tool allowlist for the child task.",
          items: { type: "string" },
        },
        requiredToolCapabilities: {
          type: "array",
          description:
            "Capability-oriented tool requirements for child execution.",
          items: { type: "string" },
        },
        timeoutMs: {
          type: "number",
          description:
            "Optional child timeout in milliseconds (1000-3600000).",
        },
        inputContract: {
          type: "string",
          description: "Optional output format contract for child execution.",
        },
        acceptanceCriteria: {
          type: "array",
          description:
            "Optional acceptance criteria checklist for the child task.",
          items: { type: "string" },
        },
        executionContext: {
          type: "object",
          description:
            "Optional bounded artifact and verification hints for the child task. Runtime still owns trusted child workspace scope.",
          properties: {
            allowedTools: {
              type: "array",
              items: { type: "string" },
            },
            inputArtifacts: {
              type: "array",
              items: { type: "string" },
            },
            requiredSourceArtifacts: {
              type: "array",
              items: { type: "string" },
            },
            targetArtifacts: {
              type: "array",
              items: { type: "string" },
            },
            effectClass: {
              type: "string",
            },
            verificationMode: {
              type: "string",
            },
            stepKind: {
              type: "string",
            },
            fallbackPolicy: {
              type: "string",
            },
            resumePolicy: {
              type: "string",
            },
            approvalProfile: {
              type: "string",
            },
          },
        },
        delegationAdmission: {
          type: "object",
          description:
            "Optional runtime-owned delegation admission record describing why this child is isolated.",
          properties: {
            shape: {
              type: "string",
            },
            isolationReason: {
              type: "string",
            },
            ownedArtifacts: {
              type: "array",
              items: { type: "string" },
            },
            verifierObligations: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        spawnDecisionScore: {
          type: "number",
          description:
            "Optional planner or policy delegation score for policy gating.",
        },
      },
      required: ["action"],
    },
    execute: async () => ({
      content: safeStringify({ error: DIRECT_EXECUTION_ERROR }),
      isError: true,
    }),
  };
}
