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
import type { ApprovalDisposition } from "./approvals.js";
import type { ExecuteWithAgentInput } from "./delegation-tool.js";
import { parseExecuteWithAgentInput } from "./delegation-tool.js";

export const COORDINATOR_MODE_TOOL_NAME = "coordinator_mode";

const DIRECT_EXECUTION_ERROR =
  "coordinator_mode must run through a session-scoped tool handler";

type CoordinatorModeAction =
  | "list"
  | "spawn"
  | "reuse"
  | "follow_up"
  | "stop"
  | "messages"
  | "ack"
  | "respond_permission"
  | "message";

export interface CoordinatorModeInput {
  readonly action: CoordinatorModeAction;
  readonly workerId?: string;
  readonly workerName?: string;
  readonly request?: ExecuteWithAgentInput;
  readonly messageId?: string;
  readonly direction?: "parent_to_worker" | "worker_to_parent";
  readonly status?: "pending" | "acknowledged" | "handled";
  readonly limit?: number;
  readonly disposition?: ApprovalDisposition;
  readonly subject?: string;
  readonly body?: string;
}

type ParseCoordinatorModeResult =
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
  messages: "messages",
  inbox: "messages",
  ack: "ack",
  acknowledge: "ack",
  respond_permission: "respond_permission",
  permission_response: "respond_permission",
  message: "message",
  note: "message",
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

function resolveWorkerId(args: Record<string, unknown>): string | undefined {
  return (
    toNonEmptyString(args.workerId) ??
    toNonEmptyString(args.workerSessionId) ??
    toNonEmptyString(args.worker_session_id) ??
    toNonEmptyString(args.subagentSessionId) ??
    toNonEmptyString(args.subagent_session_id)
  );
}

function normalizeDirection(
  value: unknown,
): CoordinatorModeInput["direction"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized === "parent_to_worker" || normalized === "worker_to_parent"
    ? normalized
    : undefined;
}

function normalizeStatus(
  value: unknown,
): CoordinatorModeInput["status"] | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized === "pending" ||
      normalized === "acknowledged" ||
      normalized === "handled"
    ? normalized
    : undefined;
}

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function normalizeDisposition(value: unknown): ApprovalDisposition | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "yes" || normalized === "no" || normalized === "always"
    ? normalized
    : undefined;
}

export function parseCoordinatorModeInput(
  args: Record<string, unknown>,
): ParseCoordinatorModeResult {
  const action = normalizeAction(args.action);
  if (!action) {
    return {
      ok: false,
      error:
        'coordinator_mode requires an "action" of "list", "spawn", "reuse", "follow_up", "stop", "messages", "ack", "respond_permission", or "message"',
    };
  }

  const workerId = resolveWorkerId(args);
  const workerName =
    toNonEmptyString(args.workerName) ??
    toNonEmptyString(args.worker_name);
  const messageId =
    toNonEmptyString(args.messageId) ??
    toNonEmptyString(args.message_id);
  const direction = normalizeDirection(args.direction);
  const status = normalizeStatus(args.status);
  const limit = normalizeLimit(args.limit);
  const disposition = normalizeDisposition(args.disposition);
  const subject =
    toNonEmptyString(args.subject) ??
    toNonEmptyString(args.title);
  const body =
    toNonEmptyString(args.body) ??
    toNonEmptyString(args.message_body) ??
    toNonEmptyString(args.text);

  if (action === "list") {
    return {
      ok: true,
      value: { action },
    };
  }

  if (action === "messages") {
    return {
      ok: true,
      value: {
        action,
        ...(workerId ? { workerId } : {}),
        ...(direction ? { direction } : {}),
        ...(status ? { status } : {}),
        ...(limit ? { limit } : {}),
      },
    };
  }

  if (action === "ack") {
    if (!messageId) {
      return {
        ok: false,
        error:
          'coordinator_mode action "ack" requires a non-empty "messageId"',
      };
    }
    return {
      ok: true,
      value: {
        action,
        messageId,
      },
    };
  }

  if (action === "respond_permission") {
    if (!messageId) {
      return {
        ok: false,
        error:
          'coordinator_mode action "respond_permission" requires a non-empty "messageId"',
      };
    }
    if (!disposition) {
      return {
        ok: false,
        error:
          'coordinator_mode action "respond_permission" requires a "disposition" of "yes", "no", or "always"',
      };
    }
    return {
      ok: true,
      value: {
        action,
        messageId,
        disposition,
      },
    };
  }

  if (action === "message") {
    if (!workerId) {
      return {
        ok: false,
        error:
          'coordinator_mode action "message" requires a non-empty "workerId"',
      };
    }
    if (!body) {
      return {
        ok: false,
        error:
          'coordinator_mode action "message" requires a non-empty "body"',
      };
    }
    return {
      ok: true,
      value: {
        action,
        workerId,
        ...(subject ? { subject } : {}),
        body,
      },
    };
  }

  if (action === "stop") {
    if (!workerId) {
      return {
        ok: false,
        error:
          'coordinator_mode action "stop" requires a non-empty "workerId"',
      };
    }
    return {
      ok: true,
      value: {
        action,
        workerId,
      },
    };
  }

  if (action === "spawn" && workerId) {
    return {
      ok: false,
      error:
        'coordinator_mode action "spawn" does not accept "workerId"; use "reuse" or "follow_up" instead',
    };
  }

  const hasDelegationRequest =
    typeof args.task === "string" ||
    typeof args.objective === "string";
  if (!hasDelegationRequest) {
    if (action === "spawn") {
      return {
        ok: true,
        value: {
        action,
        ...(workerName ? { workerName } : {}),
      },
    };
    }
    return {
      ok: false,
          error: `coordinator_mode action "${action}" requires a child request`,
    };
  }

  const parsedRequest = parseExecuteWithAgentInput(args);
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

  const resolvedWorkerId =
    workerId ?? parsedRequest.value.continuationSessionId;

  return {
    ok: true,
    value: {
        action,
        ...(resolvedWorkerId ? { workerId: resolvedWorkerId } : {}),
        ...(workerName ? { workerName } : {}),
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
            'Worker coordination action: "list", "spawn", "reuse", "follow_up", "stop", "messages", "ack", "respond_permission", or "message".',
        },
        workerId: {
          type: "string",
          description:
            "Optional persistent worker id to reuse, follow up, or stop. Legacy workerSessionId aliases still resolve.",
        },
        workerSessionId: {
          type: "string",
          description:
            "Legacy alias for workerId. Existing child session ids also resolve to the owning persistent worker when possible.",
        },
        workerName: {
          type: "string",
          description:
            "Optional stable worker name when spawning a persistent worker.",
        },
        messageId: {
          type: "string",
          description:
            "Mailbox message id for ack/respond_permission actions.",
        },
        direction: {
          type: "string",
          description:
            'Optional mailbox direction filter for "messages": "parent_to_worker" or "worker_to_parent".',
        },
        status: {
          type: "string",
          description:
            'Optional mailbox status filter for "messages": "pending", "acknowledged", or "handled".',
        },
        limit: {
          type: "number",
          description:
            'Optional maximum number of mailbox messages to return for "messages".',
        },
        disposition: {
          type: "string",
          description:
            'Approval disposition for "respond_permission": "yes", "no", or "always".',
        },
        subject: {
          type: "string",
          description:
            'Optional coordinator subject for "message".',
        },
        body: {
          type: "string",
          description:
            'Coordinator message body for "message".',
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
