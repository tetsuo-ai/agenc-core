/**
 * Guardian approval-request normalization.
 *
 * Source parity:
 * - core/src/guardian/approval_request.rs
 * - core/src/guardian/prompt.rs
 *
 * The guardian reviewer needs a stable, compact request payload that is
 * independent of the tool caller's raw object identity. This module builds
 * that payload from AgenC's approval context, serializes object keys in sorted
 * order, and truncates large strings recursively before prompt construction.
 *
 * @module
 */

import type { ToolPayload } from "../../tools/context.js";
import type { ApprovalCtx } from "./arbiter.js";

export const GUARDIAN_MAX_SERIALIZED_REQUEST_CHARS = 16_000;
const GUARDIAN_MAX_STRING_CHARS = 4_000;
const GUARDIAN_MAX_COLLECTION_ITEMS = 200;
const GUARDIAN_MAX_DEPTH = 12;
const NETWORK_APPROVAL_TOOL_NAMES = new Set([
  "network_access",
  "network.request",
  "request_network_access",
  "request_network",
]);

export type GuardianApprovalRequestKind =
  | "shell"
  | "tool"
  | "mcp_tool_call"
  | "network_access"
  | "request_permissions";

export interface GuardianApprovalRequestBase {
  readonly kind: GuardianApprovalRequestKind;
  readonly callId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly retryReason?: string;
  readonly availableDecisions?: ApprovalCtx["availableDecisions"];
  readonly networkApprovalContext?: ApprovalCtx["networkApprovalContext"];
  readonly networkPolicyInterfaces?: {
    readonly policyDecider: boolean;
    readonly blockedRequestObserver: boolean;
  };
  readonly additionalPermissions?: ApprovalCtx["additionalPermissions"];
  readonly proposedExecPolicyAmendment?: ApprovalCtx["proposedExecPolicyAmendment"];
  readonly proposedNetworkPolicyAmendments?: ApprovalCtx[
    "proposedNetworkPolicyAmendments"
  ];
  readonly cwd?: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
}

export interface GuardianShellApprovalRequest extends GuardianApprovalRequestBase {
  readonly kind: "shell";
  readonly command: readonly string[];
  readonly args: Record<string, unknown>;
}

export interface GuardianToolApprovalRequest extends GuardianApprovalRequestBase {
  readonly kind: "tool";
  readonly args: Record<string, unknown>;
  readonly payloadKind: string;
  readonly payload?: unknown;
}

export interface GuardianMcpToolCallApprovalRequest
  extends GuardianApprovalRequestBase {
  readonly kind: "mcp_tool_call";
  readonly serverName?: string;
  readonly args: Record<string, unknown>;
  readonly payload?: unknown;
}

export interface GuardianNetworkApprovalRequest
  extends GuardianApprovalRequestBase {
  readonly kind: "network_access";
  readonly host?: string;
  readonly port?: number;
  readonly url?: string;
  readonly args: Record<string, unknown>;
}

export interface GuardianRequestPermissionsApprovalRequest
  extends GuardianApprovalRequestBase {
  readonly kind: "request_permissions";
  readonly permissions: readonly string[];
  readonly args: Record<string, unknown>;
}

export type GuardianApprovalRequest =
  | GuardianShellApprovalRequest
  | GuardianToolApprovalRequest
  | GuardianMcpToolCallApprovalRequest
  | GuardianNetworkApprovalRequest
  | GuardianRequestPermissionsApprovalRequest;

export function buildGuardianApprovalRequest(
  ctx: ApprovalCtx,
  args: Record<string, unknown>,
): GuardianApprovalRequest {
  const base = guardianApprovalRequestBase(ctx);
  const payload = ctx.invocation.payload;
  if (payload.kind === "local_shell") {
    return {
      ...base,
      kind: "shell",
      command: payload.params.command,
      args,
    };
  }

  const command = commandFromArgs(args);
  if (command.length > 0 && isShellToolName(ctx.toolName)) {
    return {
      ...base,
      kind: "shell",
      command,
      args,
    };
  }

  if (payload.kind === "mcp") {
    return {
      ...base,
      kind: "mcp_tool_call",
      ...(typeof payload.server === "string" ? { serverName: payload.server } : {}),
      args,
      payload: compactForGuardianJson(payload),
    };
  }

  if (isNetworkRequest(ctx.toolName, args)) {
    return {
      ...base,
      kind: "network_access",
      ...networkTarget(args),
      args,
    };
  }

  const permissions = permissionList(args);
  if (permissions.length > 0) {
    return {
      ...base,
      kind: "request_permissions",
      permissions,
      args,
    };
  }

  return {
    ...base,
    kind: "tool",
    args,
    payloadKind: payloadKind(payload),
    payload: compactForGuardianJson(payload),
  };
}

export function guardianApprovalRequestTargetItemId(
  request: GuardianApprovalRequest,
): string {
  return request.callId;
}

export function guardianApprovalRequestTurnId(
  request: GuardianApprovalRequest,
): string {
  return request.turnId;
}

export function guardianApprovalRequestActionText(
  request: GuardianApprovalRequest,
): string {
  switch (request.kind) {
    case "shell":
      return formatShellCommand(request.command);
    case "mcp_tool_call":
      return request.serverName
        ? `${request.serverName}.${request.toolName} ${guardianApprovalRequestPrettyJson(request.args)}`
        : `${request.toolName} ${guardianApprovalRequestPrettyJson(request.args)}`;
    case "network_access": {
      const target = request.url ?? request.host ?? "unknown target";
      return `${request.toolName} ${target}`;
    }
    case "request_permissions":
      return `${request.toolName} requests ${request.permissions.join(", ")}`;
    case "tool":
      return `${request.toolName} ${guardianApprovalRequestPrettyJson(request.args)}`;
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
}

export function guardianApprovalRequestPrettyJson(
  value: unknown,
  maxChars = GUARDIAN_MAX_SERIALIZED_REQUEST_CHARS,
): string {
  let text: string;
  try {
    text = JSON.stringify(compactForGuardianJson(value), null, 2);
  } catch {
    text = String(value);
  }
  return truncateGuardianText(text, maxChars, "request");
}

export function compactForGuardianJson(value: unknown): unknown {
  return compactValue(value, {
    depth: 0,
    seen: new WeakSet<object>(),
  });
}

export function truncateGuardianText(
  text: string,
  maxChars = GUARDIAN_MAX_SERIALIZED_REQUEST_CHARS,
  label = "text",
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... guardian approval ${label} truncated ...]`;
}

function guardianApprovalRequestBase(ctx: ApprovalCtx): GuardianApprovalRequestBase {
  const turn = ctx.invocation.turn;
  return {
    kind: "tool",
    callId: ctx.callId,
    turnId: ctx.turnId || turn.subId,
    toolName: ctx.toolName,
    ...(ctx.retryReason !== undefined ? { retryReason: ctx.retryReason } : {}),
    ...(ctx.availableDecisions !== undefined
      ? { availableDecisions: ctx.availableDecisions }
      : {}),
    ...(ctx.networkApprovalContext !== undefined
      ? { networkApprovalContext: ctx.networkApprovalContext }
      : {}),
    ...guardianNetworkPolicyInterfaces(ctx),
    ...(ctx.additionalPermissions !== undefined
      ? { additionalPermissions: ctx.additionalPermissions }
      : {}),
    ...(ctx.proposedExecPolicyAmendment !== undefined
      ? { proposedExecPolicyAmendment: ctx.proposedExecPolicyAmendment }
      : {}),
    ...(ctx.proposedNetworkPolicyAmendments !== undefined
      ? { proposedNetworkPolicyAmendments: ctx.proposedNetworkPolicyAmendments }
      : {}),
    ...(typeof turn.cwd === "string" ? { cwd: turn.cwd } : {}),
    ...(turn.approvalPolicy?.value !== undefined
      ? { approvalPolicy: turn.approvalPolicy.value }
      : {}),
    ...(turn.sandboxPolicy?.value !== undefined
      ? { sandboxPolicy: turn.sandboxPolicy.value }
      : {}),
  };
}

function guardianNetworkPolicyInterfaces(
  ctx: ApprovalCtx,
): Pick<GuardianApprovalRequestBase, "networkPolicyInterfaces"> {
  if (
    ctx.networkPolicyDecider === undefined &&
    ctx.blockedRequestObserver === undefined
  ) {
    return {};
  }
  return {
    networkPolicyInterfaces: {
      policyDecider: ctx.networkPolicyDecider !== undefined,
      blockedRequestObserver: ctx.blockedRequestObserver !== undefined,
    },
  };
}

function commandFromArgs(args: Record<string, unknown>): readonly string[] {
  const command = args.command ?? args.cmd;
  if (typeof command === "string" && command.trim().length > 0) {
    return [command];
  }
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command;
  }
  if (
    Array.isArray(args.args) &&
    args.args.every((part) => typeof part === "string")
  ) {
    const head = typeof args.command === "string" ? [args.command] : [];
    return [...head, ...args.args];
  }
  return [];
}

function isShellToolName(toolName: string): boolean {
  return (
    toolName === "exec_command" ||
    toolName === "system.bash" ||
    toolName === "Bash"
  );
}

function isNetworkRequest(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  void args;
  return NETWORK_APPROVAL_TOOL_NAMES.has(toolName);
}

function formatShellCommand(command: readonly string[]): string {
  return command.length === 1 ? command[0] ?? "" : JSON.stringify(command);
}

function networkTarget(args: Record<string, unknown>): {
  readonly host?: string;
  readonly port?: number;
  readonly url?: string;
} {
  const host = typeof args.host === "string"
    ? args.host
    : typeof args.hostname === "string"
      ? args.hostname
      : undefined;
  const url = typeof args.url === "string" ? args.url : undefined;
  const port = typeof args.port === "number" && Number.isFinite(args.port)
    ? args.port
    : undefined;
  return {
    ...(host !== undefined ? { host } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

function permissionList(args: Record<string, unknown>): readonly string[] {
  const permissions = args.permissions;
  if (!Array.isArray(permissions)) return [];
  return permissions.filter((item): item is string => typeof item === "string");
}

function payloadKind(payload: ToolPayload): string {
  return typeof payload.kind === "string" ? payload.kind : "unknown";
}

function compactValue(
  value: unknown,
  state: { depth: number; seen: WeakSet<object> },
): unknown {
  if (typeof value === "string") {
    return truncateGuardianText(value, GUARDIAN_MAX_STRING_CHARS, "string");
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object") return String(value);
  if (state.seen.has(value)) return "[circular]";
  if (state.depth >= GUARDIAN_MAX_DEPTH) return "[max depth]";

  state.seen.add(value);
  const next = { depth: state.depth + 1, seen: state.seen };
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, GUARDIAN_MAX_COLLECTION_ITEMS)
        .map((item) => compactValue(item, next));
      if (value.length > GUARDIAN_MAX_COLLECTION_ITEMS) {
        items.push(`[... ${value.length - GUARDIAN_MAX_COLLECTION_ITEMS} more items truncated ...]`);
      }
      return items;
    }
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = compactValue(obj[key], next);
    }
    return sorted;
  } finally {
    state.seen.delete(value);
  }
}
