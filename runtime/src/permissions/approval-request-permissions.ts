import { RUN_WITHOUT_SANDBOX_PERMISSION } from "../sandbox/escalation/approvals.js";
import { MCP_NO_FS_WRITES_PERMISSION } from "../tools/runtimes/mcp-filesystem-approval.js";
import type { ApprovalCtx } from "./guardian/arbiter.js";

/**
 * What a permission request asks for: `tool.use`, plus the markers that
 * change what approving it does. The approval journal's `request_permissions`
 * event and every pending-request listing carry this same list, so a client
 * that reconnects or lists pending requests says what a session grant covers
 * as the live card does.
 */
export function approvalRequestPermissions(
  ctx: Pick<ApprovalCtx, "approvalKind" | "runsWithoutSandbox" | "mcpFilesystemApproval">,
): string[] {
  if (ctx.approvalKind === "cross_provider_spawn") return ["cross_provider_spawn"];
  return [
    "tool.use",
    ...(ctx.runsWithoutSandbox === true ? [RUN_WITHOUT_SANDBOX_PERMISSION] : []),
    ...(ctx.mcpFilesystemApproval !== undefined ? [MCP_NO_FS_WRITES_PERMISSION] : []),
  ];
}
