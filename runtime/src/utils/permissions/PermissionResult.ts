// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
export type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
// @ts-expect-error -- moved-source note: moved utility depends on not-yet-absorbed subsystem types.
} from '../../types/permissions.js'

// @ts-expect-error -- moved-source note: moved utility depends on not-yet-absorbed subsystem types.
import type { PermissionResult } from '../../types/permissions.js'

// Helper function to get the appropriate prose description for rule behavior
export function getRuleBehaviorDescription(
  permissionResult: PermissionResult['behavior'],
): string {
  switch (permissionResult) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    default:
      return 'asked for confirmation for'
  }
}
