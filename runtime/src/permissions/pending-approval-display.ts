import type { PendingToolApproval } from "../app-server/protocol/index.js";
import { permissionsMcpNoFsWrites } from "../tools/runtimes/mcp-filesystem-approval.js";
import { permissionsSingleCall } from "./approval-request-permissions.js";
import { sessionGrantScope } from "./session-grant-scope.js";

function displayValue(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * What `--scope session` would approve, as the request's permissions state
 * it. Unknown for a daemon that does not list them, and a cross-provider
 * consent is not a tool grant.
 */
function sessionGrantLine(request: PendingToolApproval): string | undefined {
  if (request.permissions === undefined || request.kind === "cross_provider_spawn") return undefined;
  const scope = sessionGrantScope({
    toolName: request.toolName,
    toolLabel: displayValue(request.toolName),
    input: request.input,
    coversAllCalls: permissionsMcpNoFsWrites(request.permissions),
    singleCall: permissionsSingleCall(request.permissions),
  });
  return `session grant covers ${scope.long}`;
}

export function formatPendingToolApprovals(requests: readonly PendingToolApproval[]): string {
  if (requests.length === 0) return "";
  const lines = [`Pending approvals (${requests.length})`];
  for (const request of requests) {
    lines.push(
      `request ${displayValue(request.requestId)}`,
      `owner run ${displayValue(request.ownerRunId)}`,
      `session ${displayValue(request.sessionId)}`,
      `tool ${displayValue(request.toolName)}`,
    );
    for (const [label, value] of [
      ["turn", request.turnId],
      ["permissions", request.permissions],
      ["reason", request.reason],
      ["input", request.input],
      ["plan file", request.planFilePath],
      ["plan", request.planContent],
      ["file preview", request.fileWritePreview],
    ] as const) {
      if (value !== undefined) lines.push(`${label} ${displayValue(value)}`);
    }
    const sessionGrant = sessionGrantLine(request);
    if (sessionGrant !== undefined) lines.push(sessionGrant);
    if ([request.ownerRunId, request.requestId].every((value) => /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/u.test(value))) {
      lines.push(
        `agenc permissions approve --session ${request.ownerRunId} --scope once ${request.requestId}`,
        `agenc permissions revoke --session ${request.ownerRunId} ${request.requestId}`,
      );
    } else {
      lines.push("Use permissions approve/revoke with the displayed owner run and request IDs.");
    }
  }
  return lines.join("\n");
}
