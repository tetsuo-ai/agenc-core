import type { RecoveredChildTaskReceipt } from "../session/subagent-receipt-recovery.js";
import type { SubagentTurnOutcomeEvent } from "../session/event-log.js";
import { formatSubagentNotification, type AgentStatus } from "./status.js";

function bounded(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= 8_192) return value;
  const suffix = "\n[Result truncated. See the durable outcome reference.]";
  const limit = 8_192 - Buffer.byteLength(suffix, "utf8");
  let text = "";
  let bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > limit) break;
    text += character;
  }
  return text + suffix;
}

function project(receipt: SubagentTurnOutcomeEvent): SubagentTurnOutcomeEvent {
  return { ...receipt,
    ...(receipt.message === undefined ? {} : { message: bounded(receipt.message) }),
    ...(receipt.reason === undefined ? {} : { reason: bounded(receipt.reason) }),
    ...(receipt.terminal === undefined ? {} : { terminal: { ...receipt.terminal,
      completedWork: bounded(receipt.terminal.completedWork),
      unfinishedWork: bounded(receipt.terminal.unfinishedWork) } }) };
}

export function recoveredChildStatus(receipt: SubagentTurnOutcomeEvent): AgentStatus {
  const projected = project(receipt);
  const common = { turnId: projected.turnId, endedAtMs: 0,
    ...(projected.terminal === undefined ? {} : { terminal: projected.terminal }) };
  // A recovered task result is terminal. An old keep-alive worker is never
  // advertised as idle or reusable after its process has gone away.
  return projected.outcome === "completed"
    ? { ...common, status: "completed", lastMessage: projected.message }
    : { ...common, status: "errored",
      error: projected.reason ?? projected.message ?? "The child task did not complete." };
}

export function recoveredChildProjectionId(item: RecoveredChildTaskReceipt): string {
  return `${item.receipt.agentId}:${item.receipt.turnId}:${item.receipt.outcome}`;
}

export function formatRecoveredChildTaskReceipt(item: RecoveredChildTaskReceipt): string {
  const receipt = project(item.receipt);
  const worktree = receipt.worktreeEvidence;
  return formatSubagentNotification({ agentPath: receipt.agentPath,
    status: recoveredChildStatus(receipt),
    receipt: { lifecycle: "turn", outcome: receipt.outcome, turn_id: receipt.turnId,
      tool_call_count: receipt.toolCallCount,
      ...(receipt.taskId === undefined ? {} : { task_id: receipt.taskId }),
      ...(receipt.message === undefined ? {} : { message: receipt.message }),
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      ...(receipt.terminal === undefined ? {} : { terminal: receipt.terminal }),
      ...(worktree === undefined ? {} : { worktree: {
        state: worktree.state, path: bounded(worktree.locator.path),
        branch: bounded(worktree.locator.branch), git_root: bounded(worktree.locator.gitRoot),
        ...(worktree.state === "unverifiable" ? { error: bounded(worktree.error) } : {
          base_commit: bounded(worktree.baseCommit), head_commit: bounded(worktree.headCommit),
          tree_hash: bounded(worktree.treeHash), clean: worktree.clean,
          base_is_ancestor: worktree.baseIsAncestor,
          ...(worktree.integrationRef === undefined ? {} : { integration_ref: bounded(worktree.integrationRef) }),
        }) } }),
    },
    durableOutcomeRef: { projection_id: recoveredChildProjectionId(item),
      agent_id: receipt.agentId, turn_id: receipt.turnId, rollout_path: item.sourcePath,
      ...(receipt.taskId === undefined ? {} : { task_id: receipt.taskId }) } });
}
