import { getHostPlatformForAnalytics } from '../../../agenc/upstream/utils/env' // upstream-import: keep target is owned by another Z-PURGE item
import { type CompletionType, logUnaryEvent } from '../../../agenc/upstream/utils/unaryLogging' // upstream-import: keep target is owned by another Z-PURGE item
import type { ToolUseConfirm } from './PermissionRequest.js'

export function logUnaryPermissionEvent(
  completion_type: CompletionType,
  {
    assistantMessage: {
      message: { id: message_id },
    },
  }: ToolUseConfirm,
  event: 'accept' | 'reject',
  hasFeedback?: boolean,
): void {
  void logUnaryEvent({
    completion_type,
    event,
    metadata: {
      language_name: 'none',
      message_id,
      platform: getHostPlatformForAnalytics(),
      hasFeedback: hasFeedback ?? false,
    },
  })
}
