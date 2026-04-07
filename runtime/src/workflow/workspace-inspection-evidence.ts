/**
 * Workspace inspection evidence — collapsed stub (Cut 1.1).
 *
 * Replaces the previous 288-LOC heuristic that detected when planner
 * acceptance criteria required workspace-grounded inspection. The
 * planner subsystem has been deleted; consumers now treat every turn
 * as not requiring workspace inspection grounding.
 *
 * @module
 */

interface ToolCallLike {
  readonly name?: string;
  readonly args?: unknown;
  readonly result?: string;
  readonly isError?: boolean;
}

export function textRequiresWorkspaceGroundedArtifactUpdate(
  _messageText: string,
): boolean {
  return false;
}

export function criterionRequiresWorkspaceInspectionVerification(
  _criterion: string,
): boolean {
  return false;
}

export function collectWorkspaceInspectionPathCandidates(_params: {
  readonly toolCalls?: readonly ToolCallLike[];
  readonly workspaceRoot?: string;
}): readonly string[] {
  return [];
}

export function isMeaningfulWorkspaceInspectionToolCall(
  _params: Record<string, unknown>,
): boolean {
  return false;
}
