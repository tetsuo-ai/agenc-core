// Types extracted to src/types/permissions.ts to break import cycles
import type {
  PermissionAllowDecision as PermissionAllowDecisionType,
  PermissionAskDecision as PermissionAskDecisionType,
  PermissionDecision as PermissionDecisionType,
  PermissionDecisionReason as PermissionDecisionReasonType,
  PermissionDenyDecision as PermissionDenyDecisionType,
  PermissionMetadata as PermissionMetadataType,
  PermissionResult as PermissionResultType,
} from '../../types/permissions.js'

export type PermissionAllowDecision = PermissionAllowDecisionType
export type PermissionAskDecision = PermissionAskDecisionType
export type PermissionDecision = PermissionDecisionType
export type PermissionDecisionReason = PermissionDecisionReasonType
export type PermissionDenyDecision = PermissionDenyDecisionType
export type PermissionMetadata = PermissionMetadataType
export type PermissionResult = PermissionResultType

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
