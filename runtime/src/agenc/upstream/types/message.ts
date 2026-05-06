/**
 * Stub — message type definitions not included in source snapshot.
 *
 * The original source defines a rich Message discriminated union
 * with structured Content blocks, role tags, tool_use payloads, and so on.
 * That file is not mirrored to this open snapshot. This stub exists so
 * `tsc --noEmit` can resolve `import { Message, ... } from 'src/types/message'`
 * across the ~21 callers without fixing every transitive type the call
 * sites use.
 *
 * Once the real definitions are restored upstream-side or reconstructed
 * from runtime usage, replace these `any` aliases with proper types and
 * delete this comment. See issue #473 for the typecheck-foundation effort.
 */

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
