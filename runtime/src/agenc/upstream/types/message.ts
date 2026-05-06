/** Message type placeholders for the upstream mirror. */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgenCSystemAPIErrorMessage } from '../../../errors/api.js'

export type Message = any
export type AssistantMessage = any
export type UserMessage = any
export type SystemMessage = any
export type SystemAPIErrorMessage = AgenCSystemAPIErrorMessage
export type AttachmentMessage = any
export type ProgressMessage = any
export type HookResultMessage = any
export type NormalizedUserMessage = any
