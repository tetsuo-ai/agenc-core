/**
 * Micro-compact older tool results.
 *
 * Source snapshot: `src/services/compact/microCompact.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import type { CompactContext, RuntimeMessage } from "./types.js";
import { getAPIContextManagement } from "./apiMicrocompact.js";
import { getTimeBasedMicrocompactClearAfterMs } from "./timeBasedMCConfig.js";
import {
  messageText,
  stringifyContent,
} from "./_deps/runtime.js";

const MICROCOMPACT_MIN_CHARS = 6_000;
const MICROCOMPACT_KEEP_RECENT = 5;
const TOOL_RESULT_CLEARED_MESSAGE = "[Old tool result content cleared]";
const MCP_TOOL_PREFIX = "mcp__";
const COMPACTABLE_TOOLS = new Set([
  "Read",
  "Bash",
  "PowerShell",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
]);

let microcompactSequence = 0;

export async function microcompactMessages(
  messages: RuntimeMessage[],
  context?: CompactContext,
  _querySource?: string,
): Promise<{
  readonly messages: RuntimeMessage[];
  readonly compactionInfo?: {
    readonly apiContextManagement?: ReturnType<typeof getAPIContextManagement>;
  };
}> {
  const compactableIds = collectCompactableToolUseIds(messages);
  const compactableResultPositions = collectCompactableToolResultPositions(
    messages,
    compactableIds,
  );
  const keepIds = new Set(
    compactableResultPositions
      .slice(-MICROCOMPACT_KEEP_RECENT)
      .map((position) => position.toolUseId),
  );
  const clearAfterMs = getTimeBasedMicrocompactClearAfterMs();
  const now = Date.now();
  const apiContextManagement = getAPIContextManagement(
    context?.options?.apiMicrocompact,
  );
  return {
    messages: messages.map((message) => {
      const rewrittenBlocks = microcompactContentBlocks(
        message.message?.content ?? message.content,
        compactableIds,
        keepIds,
      );
      if (rewrittenBlocks !== undefined) {
        return {
          ...message,
          content: rewrittenBlocks,
          message: {
            role: message.message?.role ?? message.role ?? "user",
            content: rewrittenBlocks,
          },
          isMeta: true,
        };
      }
      const text = messageText(message);
      if (
        text.length < MICROCOMPACT_MIN_CHARS ||
        !isToolLikeMessage(message) ||
        (message.toolCallId !== undefined && keepIds.has(message.toolCallId)) ||
        isWithinTimeWindow(message, now, clearAfterMs)
      ) {
        return message;
      }
      microcompactSequence += 1;
      const content =
        `[microcompact:${microcompactSequence}] Older tool output compressed; original length ${text.length.toLocaleString()} characters.`;
      return {
        ...message,
        content,
        message: {
          role: message.message?.role ?? message.role ?? "user",
          content,
        },
        isMeta: true,
      };
    }),
    ...(apiContextManagement
      ? { compactionInfo: { apiContextManagement } }
      : {}),
  };
}

export function resetMicrocompactState(): void {
  microcompactSequence = 0;
}

export function getMicrocompactSequenceForTests(): number {
  return microcompactSequence;
}

function isToolLikeMessage(message: RuntimeMessage): boolean {
  return (
    message.role === "tool" ||
    message.originalRole === "tool" ||
    message.isMeta === true ||
    message.type === "tool_result"
  );
}

function collectCompactableToolUseIds(
  messages: readonly RuntimeMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (isCompactableTool(call.name)) ids.add(call.id);
    }
    const blocks = asContentBlocks(message.message?.content ?? message.content);
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") {
        continue;
      }
      if (isCompactableTool(block.name)) ids.add(block.id);
    }
  }
  return ids;
}

function collectCompactableToolResultPositions(
  messages: readonly RuntimeMessage[],
  compactableIds: ReadonlySet<string>,
): Array<{ readonly toolUseId: string }> {
  const positions: Array<{ readonly toolUseId: string }> = [];
  for (const message of messages) {
    if (
      (message.role === "tool" || message.originalRole === "tool") &&
      message.toolCallId !== undefined &&
      (compactableIds.size === 0 ||
        compactableIds.has(message.toolCallId) ||
        (message.toolName !== undefined && isCompactableTool(message.toolName)))
    ) {
      positions.push({ toolUseId: message.toolCallId });
      continue;
    }
    for (const block of asContentBlocks(message.message?.content ?? message.content)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      if (compactableIds.size === 0 || compactableIds.has(block.tool_use_id)) {
        positions.push({ toolUseId: block.tool_use_id });
      }
    }
  }
  return positions;
}

function microcompactContentBlocks(
  content: unknown,
  compactableIds: ReadonlySet<string>,
  keepIds: ReadonlySet<string>,
): unknown[] | undefined {
  const blocks = asContentBlocks(content);
  if (blocks.length === 0) return undefined;
  let touched = false;
  const rewritten = blocks.map((block) => {
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      return block;
    }
    if (keepIds.has(block.tool_use_id)) return block;
    if (compactableIds.size > 0 && !compactableIds.has(block.tool_use_id)) {
      return block;
    }
    const text = stringifyContent(block.content ?? "");
    if (text.length < MICROCOMPACT_MIN_CHARS) return block;
    touched = true;
    return {
      ...block,
      content: TOOL_RESULT_CLEARED_MESSAGE,
    };
  });
  return touched ? rewritten : undefined;
}

function asContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === "object" && block !== null,
  );
}

function isCompactableTool(name: string): boolean {
  return COMPACTABLE_TOOLS.has(name) || name.startsWith(MCP_TOOL_PREFIX);
}

function isWithinTimeWindow(
  message: RuntimeMessage,
  now: number,
  clearAfterMs: number,
): boolean {
  if (!message.timestamp) return false;
  const timestamp = Date.parse(message.timestamp);
  return Number.isFinite(timestamp) && now - timestamp < clearAfterMs;
}

export function consumePendingCacheEdits(): readonly never[] {
  return [];
}

export function getPinnedCacheEdits(): readonly never[] {
  return [];
}

export function markToolsSentToAPIState(): void {}

export function pinCacheEdits(): void {}
