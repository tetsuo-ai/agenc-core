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

export function textRequiresWorkspaceGroundedArtifactUpdate(
  _messageText: string,
): boolean {
  return false;
}

export function isMeaningfulWorkspaceInspectionToolCall(
  _params: Record<string, unknown>,
): boolean {
  return false;
}
