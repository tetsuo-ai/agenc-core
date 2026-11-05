import { RUN_WITHOUT_SANDBOX_PERMISSION } from "../sandbox/escalation/approvals.js";
import { MCP_NO_FS_WRITES_PERMISSION } from "../tools/runtimes/mcp-filesystem-approval.js";
import type { ApprovalCtx } from "./guardian/arbiter.js";

/**
 * The permission named on a request the permission layer asked because of a
 * safety check: a protected path or an ambiguous path shape. A person
 * answers each such call. A session grant neither answers nor records it, so
 * approving it for the session approves this call only, and every client
 * says so.
 */
export const SINGLE_CALL_PERMISSION = "single_call";

/** Whether a projected permission list marks a request no session grant can cover. */
export function permissionsSingleCall(permissions: unknown): boolean {
  return Array.isArray(permissions) &&
    permissions.includes(SINGLE_CALL_PERMISSION);
}

/**
 * What a permission request asks for: `tool.use`, plus the markers that
 * change what approving it does. The approval journal's `request_permissions`
 * event and every pending-request listing carry this same list, so a client
 * that reconnects or lists pending requests says what a session grant covers
 * as the live card does.
 */
export function approvalRequestPermissions(
  ctx: Pick<ApprovalCtx, "approvalKind" | "runsWithoutSandbox" | "mcpFilesystemApproval" | "safetyCheck">,
): string[] {
  if (ctx.approvalKind === "cross_provider_spawn") return ["cross_provider_spawn"];
  return [
    "tool.use",
    ...(ctx.runsWithoutSandbox === true ? [RUN_WITHOUT_SANDBOX_PERMISSION] : []),
    ...(ctx.mcpFilesystemApproval !== undefined ? [MCP_NO_FS_WRITES_PERMISSION] : []),
    ...(ctx.safetyCheck === true ? [SINGLE_CALL_PERMISSION] : []),
  ];
}
