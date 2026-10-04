// Message construction and legacy transcript handling must not load attachment producers.
import { randomUUID } from 'node:crypto'
import type { AttachmentMessage } from '../types/message.js'
import type { Attachment } from './attachments.js'
import { formatRelevantMemoryHeader } from '../memory/age.js'

const RETIRED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'autocheckpointing',
  'background_task_status',
  'mcp_resource',
  'todo',
  'task_progress',
  'ultramemory',
])

/**
 * Persisted sessions can contain attachment discriminators that no current
 * producer emits. Retired attachments are dropped at both model and TUI
 * boundaries; they have no executable producer or renderer.
 */
export function isRetiredAttachmentType(type: string): boolean {
  return RETIRED_ATTACHMENT_TYPES.has(type)
}

export function memoryHeader(path: string, mtimeMs: number): string {
  return formatRelevantMemoryHeader(path, mtimeMs)
}

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
