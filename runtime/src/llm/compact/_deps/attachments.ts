/**
 * Attachment-message helpers for compact prompt assembly. The
 * openclaude runtime threads file/agent/tool/MCP-instruction
 * attachments into the post-compact context; the gut runtime owns its
 * own attachment surface (`runtime/src/prompts/memory/attachments.ts`)
 * for memory injection but does not yet have an equivalent for the
 * compact-time deltas. These helpers produce the minimum
 * AttachmentMessage shape compact's prompt assembly needs.
 */

import { randomUUID } from "node:crypto";

interface AttachmentLike {
  readonly type?: string;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

export interface AttachmentMessage {
  readonly type: "attachment";
  readonly uuid: string;
  readonly timestamp: string;
  readonly attachment: AttachmentLike;
}

export function createAttachmentMessage(
  attachment: AttachmentLike,
): AttachmentMessage {
  return {
    type: "attachment",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    attachment,
  };
}

export interface FileAttachment {
  readonly type: "file";
  readonly path: string;
  readonly content: string;
  readonly [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateFileAttachment(..._args: any[]): Promise<any> {
  return null;
}

export function getAgentListingDeltaAttachment(
  ..._args: unknown[]
): AttachmentLike[] {
  return [];
}

export function getDeferredToolsDeltaAttachment(
  ..._args: unknown[]
): AttachmentLike[] {
  return [];
}

export function getMcpInstructionsDeltaAttachment(
  ..._args: unknown[]
): AttachmentLike[] {
  return [];
}
