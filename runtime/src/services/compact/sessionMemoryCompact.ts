/**
 * Session-memory compact helpers.
 *
 * Source snapshot: `src/services/compact/sessionMemoryCompact.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import { createUserMessage } from "./compact.js";
import { getCompactUserSummaryMessage } from "./prompt.js";
import type { CompactContext, CompactionResult, RuntimeMessage } from "./types.js";
import { isRecord } from "../../utils/record.js";

type SessionMemoryCompactEnv = Partial<Record<
  "AGENC_ENABLE_SESSION_MEMORY_COMPACT" | "AGENC_DISABLE_SESSION_MEMORY_COMPACT",
  string | undefined
>>;

export function shouldUseSessionMemoryCompaction(
  env: SessionMemoryCompactEnv = process.env,
): boolean {
  if (isTruthy(env.AGENC_DISABLE_SESSION_MEMORY_COMPACT)) return false;
  return isTruthy(env.AGENC_ENABLE_SESSION_MEMORY_COMPACT);
}

export function calculateMessagesToKeepIndex(
  messages: readonly RuntimeMessage[],
  keepCount = 4,
): number {
  return Math.max(0, messages.length - Math.max(0, keepCount));
}

export function preserveToolPairsFromIndex(
  messages: readonly RuntimeMessage[],
  keepIndex: number,
): RuntimeMessage[] {
  const clamped = Math.max(0, Math.min(messages.length, keepIndex));
  const kept = messages.slice(clamped);
  const requiredToolUseIds = collectToolResultIds(kept);
  if (requiredToolUseIds.size === 0) return kept;

  let start = clamped;
  for (let index = clamped - 1; index >= 0; index -= 1) {
    if (messageHasToolUse(messages[index], requiredToolUseIds)) {
      start = index;
    }
  }
  return messages.slice(start);
}

export async function trySessionMemoryCompaction(
  messages: readonly RuntimeMessage[] = [],
  context: CompactContext = {},
): Promise<CompactionResult | null> {
  if (!shouldUseSessionMemoryCompaction()) return null;
  const sessionMemory = context.deps?.sessionMemory;
  if (!sessionMemory?.getContent) return null;
  if (await sessionMemory.isEmpty?.()) return null;
  const content = (await sessionMemory.getContent())?.trim();
  if (!content) return null;

  const keepIndex = calculateMessagesToKeepIndex(messages);
  const messagesToKeep = preserveToolPairsFromIndex(messages, keepIndex);
  const boundaryMarker = createUserMessage({
    content: `<compact>Conversation compacted using session memory at ${new Date().toISOString()}</compact>`,
    isMeta: true,
  });
  const summaryMessage = createUserMessage({
    content: getCompactUserSummaryMessage(content, true, undefined, true),
    isMeta: true,
  });
  return {
    boundaryMarker,
    summaryMessages: [summaryMessage],
    attachments: [],
    hookResults: [],
    messagesToKeep,
    userDisplayMessage: "Conversation compacted with session memory",
  };
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function collectToolResultIds(
  messages: readonly RuntimeMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.toolCallId) ids.add(message.toolCallId);
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

function messageHasToolUse(
  message: RuntimeMessage | undefined,
  ids: ReadonlySet<string>,
): boolean {
  if (!message) return false;
  if (message.toolCalls?.some((call) => ids.has(call.id))) return true;
  return contentBlocks(message).some((block) =>
    block.type === "tool_use" && typeof block.id === "string" && ids.has(block.id),
  );
}

function contentBlocks(message: RuntimeMessage): Array<Record<string, unknown>> {
  const content = message.message?.content ?? message.content;
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}
