import type { RecoveredChildTaskReceipt } from "../session/subagent-receipt-recovery.js";
import type { SubagentTurnOutcomeEvent } from "../session/event-log.js";
import type { ChildTerminalOutcome } from "./child-terminal.js";
import { formatSubagentNotification, type AgentStatus } from "./status.js";

export const MAX_RECOVERED_CHILD_PROJECTION_BYTES = 64 * 1_024;
const OMITTED_RESULT = "Result text omitted because it exceeds the recovery projection limit. Inspect the durable child journal.";

export function boundedRecoveredChildText(value: string, maxBytes = 8_192): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n[Result truncated. See the durable outcome reference.]";
  const limit = maxBytes - Buffer.byteLength(suffix, "utf8");
  let text = "";
  let bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > limit) break;
    text += character;
  }
  return text + suffix;
}

function projectTerminal(terminal: ChildTerminalOutcome): ChildTerminalOutcome {
  // Canonical journal schemas accept additive fields. Never spread those
  // fields into model context or a supposedly bounded projection cache.
  return { provider: boundedRecoveredChildText(terminal.provider, 512), model: boundedRecoveredChildText(terminal.model, 512),
    reason: terminal.reason, retryable: terminal.retryable, dispatch: terminal.dispatch,
    completedWork: boundedRecoveredChildText(terminal.completedWork), unfinishedWork: boundedRecoveredChildText(terminal.unfinishedWork),
    ...(terminal.retryAfterMs === undefined ? {} : { retryAfterMs: terminal.retryAfterMs }),
    ...(terminal.costUsd === undefined ? {} : { costUsd: terminal.costUsd }) };
}

/** Exact identifiers remain intact; cache owners must account for their size. */
export function projectRecoveredChildReceipt(receipt: SubagentTurnOutcomeEvent): SubagentTurnOutcomeEvent {
  const worktree = receipt.worktreeEvidence;
  return { agentId: receipt.agentId, agentPath: receipt.agentPath,
    turnId: receipt.turnId, outcome: receipt.outcome, toolCallCount: receipt.toolCallCount,
    ...(receipt.taskId === undefined ? {} : { taskId: receipt.taskId }),
    ...(receipt.message !== undefined && Buffer.byteLength(receipt.message, "utf8") <= 8_192 ? { message: receipt.message } : {}),
    ...(receipt.reason === undefined ? {} : { reason: boundedRecoveredChildText(receipt.reason) }),
    ...(receipt.terminal === undefined ? {} : { terminal: projectTerminal(receipt.terminal) }),
    ...(worktree === undefined ? {} : { worktreeEvidence: {
      state: worktree.state, locator: { path: boundedRecoveredChildText(worktree.locator.path, 4_096),
        branch: boundedRecoveredChildText(worktree.locator.branch, 1_024), gitRoot: boundedRecoveredChildText(worktree.locator.gitRoot, 4_096) },
      ...(worktree.state === "unverifiable" ? { error: boundedRecoveredChildText(worktree.error) } : {
        baseCommit: boundedRecoveredChildText(worktree.baseCommit, 128), headCommit: boundedRecoveredChildText(worktree.headCommit, 128),
        treeHash: boundedRecoveredChildText(worktree.treeHash, 128), clean: worktree.clean, baseIsAncestor: worktree.baseIsAncestor,
        ...(worktree.integrationRef === undefined ? {} : { integrationRef: boundedRecoveredChildText(worktree.integrationRef, 1_024) }),
      }),
    } as SubagentTurnOutcomeEvent["worktreeEvidence"] }) };
}

export function recoveredChildStatus(receipt: SubagentTurnOutcomeEvent): AgentStatus {
  const projected = projectRecoveredChildReceipt(receipt);
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
  return `${item.receipt.agentId}:${item.receipt.turnId}:${item.admission === undefined ? item.receipt.outcome : "admitted"}`;
}

function recoveryReferences(item: RecoveredChildTaskReceipt, compact = false): Pick<
  Parameters<typeof formatSubagentNotification>[0], "durableOutcomeRef" | "durableAdmissionRef"
> {
  const receipt = item.receipt;
  const fits = (value: string, maxBytes = 256): boolean => Buffer.byteLength(value, "utf8") <= maxBytes;
  if (compact && (!fits(receipt.agentId) || !fits(receipt.turnId))) return {};
  const reference = { projection_id: recoveredChildProjectionId(item), agent_id: receipt.agentId,
    turn_id: receipt.turnId,
    ...(item.sourcePath.length > 0 && (!compact || fits(item.sourcePath, 1_024)) ? { rollout_path: item.sourcePath } : {}),
    ...(receipt.taskId !== undefined && (!compact || fits(receipt.taskId)) ? { task_id: receipt.taskId } : {}) };
  if (item.admission !== undefined) {
    return item.eventId !== undefined && (!compact || fits(item.eventId))
      ? { durableAdmissionRef: { ...reference, event_id: item.eventId,
        ...(item.spawnEdgeId !== undefined && (!compact || fits(item.spawnEdgeId)) ? { spawn_edge_id: item.spawnEdgeId } : {}) } } : {};
  }
  return { durableOutcomeRef: reference };
}

export function formatRecoveredChildTaskReceipt(item: RecoveredChildTaskReceipt): string {
  const receipt = projectRecoveredChildReceipt(item.receipt);
  const worktree = receipt.worktreeEvidence;
  const content = formatSubagentNotification({ agentPath: receipt.agentPath,
    ...(item.admission === undefined && receipt.outcome === "completed"
      ? { resultRef: { agent_id: receipt.agentId, turn_id: receipt.turnId } } : {}),
    status: recoveredChildStatus(receipt),
    ...(item.admission !== undefined ? {} : { receipt: { lifecycle: "turn" as const, outcome: receipt.outcome, turn_id: receipt.turnId,
      tool_call_count: receipt.toolCallCount,
      ...(receipt.taskId === undefined ? {} : { task_id: receipt.taskId }),
      ...(receipt.message === undefined ? {} : { message: receipt.message }),
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
      ...(receipt.terminal === undefined ? {} : { terminal: receipt.terminal }),
      ...(worktree === undefined ? {} : { worktree: {
        state: worktree.state, path: boundedRecoveredChildText(worktree.locator.path),
        branch: boundedRecoveredChildText(worktree.locator.branch), git_root: boundedRecoveredChildText(worktree.locator.gitRoot),
        ...(worktree.state === "unverifiable" ? { error: boundedRecoveredChildText(worktree.error) } : {
          base_commit: boundedRecoveredChildText(worktree.baseCommit), head_commit: boundedRecoveredChildText(worktree.headCommit),
          tree_hash: boundedRecoveredChildText(worktree.treeHash), clean: worktree.clean,
          base_is_ancestor: worktree.baseIsAncestor,
          ...(worktree.integrationRef === undefined ? {} : { integration_ref: boundedRecoveredChildText(worktree.integrationRef) }),
        }) } }),
    } }),
    ...recoveryReferences(item) });
  if (Buffer.byteLength(content, "utf8") <= MAX_RECOVERED_CHILD_PROJECTION_BYTES) return content;

  // Escaping control characters and notification delimiters can expand text
  // sixfold. Enforce the final serialized ceiling, not just raw field sizes.
  const fitsIdentity = (value: string): boolean => Buffer.byteLength(value, "utf8") <= 256;
  const referenceSafe = fitsIdentity(receipt.agentId) && fitsIdentity(receipt.turnId);
  const compact: SubagentTurnOutcomeEvent = {
    agentId: referenceSafe ? receipt.agentId : "[Identifier omitted]",
    agentPath: boundedRecoveredChildText(receipt.agentPath, 256),
    turnId: fitsIdentity(receipt.turnId) ? receipt.turnId : "[Identifier omitted]",
    outcome: receipt.outcome, toolCallCount: receipt.toolCallCount,
    reason: OMITTED_RESULT,
    ...(receipt.taskId === undefined || !fitsIdentity(receipt.taskId) ? {} : { taskId: receipt.taskId }),
    ...(receipt.terminal === undefined ? {} : { terminal: {
      ...projectTerminal(receipt.terminal),
      provider: boundedRecoveredChildText(receipt.terminal.provider, 256), model: boundedRecoveredChildText(receipt.terminal.model, 256),
      completedWork: OMITTED_RESULT, unfinishedWork: OMITTED_RESULT,
    } }),
  };
  return formatSubagentNotification({ agentPath: compact.agentPath,
    ...(referenceSafe && item.admission === undefined && receipt.outcome === "completed"
      ? { resultRef: { agent_id: receipt.agentId, turn_id: receipt.turnId } } : {}),
    status: recoveredChildStatus(compact),
    ...(item.admission !== undefined ? {} : { receipt: { lifecycle: "turn" as const, outcome: compact.outcome, turn_id: compact.turnId,
      tool_call_count: compact.toolCallCount, reason: OMITTED_RESULT,
      ...(compact.taskId === undefined ? {} : { task_id: compact.taskId }),
      ...(compact.terminal === undefined ? {} : { terminal: compact.terminal }) } }),
    ...recoveryReferences(item, true),
  });
}
