import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type * as React from 'react'
import type { z } from 'zod/v4'

import type { AssistantMessage } from '../types/message.js'
import type { PermissionDecision } from '../types/permissions.js'
import type {
  AnyObject,
  Tool,
  ToolUseContext,
} from '../tools/Tool.js'
import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'

export type WorkerBadgeProps = {
  name: string
  color: string
}

export type PermissionRequestProps<Input extends AnyObject = AnyObject> = {
  toolUseConfirm: ToolUseConfirm<Input>
  toolUseContext: ToolUseContext
  onDone(): void
  onReject(): void
  verbose: boolean
  workerBadge: WorkerBadgeProps | undefined
  setStickyFooter?: (jsx: React.ReactNode | null) => void
}

export type ToolUseConfirm<Input extends AnyObject = AnyObject> = {
  assistantMessage: AssistantMessage
  tool: Tool<Input>
  description: string
  input: z.infer<Input>
  toolUseContext: ToolUseContext
  toolUseID: string
  permissionResult: PermissionDecision
  permissionPromptStartTimeMs: number
  classifierCheckInProgress?: boolean
  classifierAutoApproved?: boolean
  classifierMatchedRule?: string
  workerBadge?: WorkerBadgeProps
  onUserInteraction(): void
  onAbort(): void
  onDismissCheckmark?(): void
  onAllow(
    updatedInput: z.infer<Input>,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
    contentBlocks?: ContentBlockParam[],
  ): void
  onReject(feedback?: string, contentBlocks?: ContentBlockParam[]): void
  recheckPermission(): Promise<void>
}
