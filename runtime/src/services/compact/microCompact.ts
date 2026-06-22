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
import { isRecord } from "../../utils/record.js";

const MICROCOMPACT_MIN_CHARS = 6_000;
const MICROCOMPACT_KEEP_RECENT = 5;
const TOOL_RESULT_CLEARED_MESSAGE = "[Old tool result content cleared]";
const MCP_TOOL_PREFIX = "mcp__";
// Tool names MUST match the names the LIVE tool registry registers, not the
// legacy/upstream-snapshot names. The whole-file reader registers as
// "FileRead" (canonical `FILE_READ_TOOL_NAME` in
// `src/tools/system/file-read.ts`) and the shell tool registers as
// "exec_command" (`src/tools/system/exec-command.ts`) — NOT "Read"/"Bash".
// Keying on the upstream names left FileRead/exec_command results unbounded
// (the largest OOM contributors) and excluded from path-aware retention.
// The remaining names (Grep/Glob/Edit/Write) already match the live registry.
const COMPACTABLE_TOOLS = new Set([
  "FileRead",
  "Read",
  "exec_command",
  "Bash",
  "PowerShell",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
]);

// Path-bearing readers whose result carries a `file_path` argument, so the
// LATEST result per active path can be retained beyond the flat recent-N
// window. "FileRead" is the live whole-file reader; "Read" is kept for the
// upstream snapshot / parity.
const PATH_BEARING_READ_TOOLS = new Set(["FileRead", "Read"]);

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
  const readPathByToolUseId = collectReadFilePaths(messages);
  const compactableResultPositions = collectCompactableToolResultPositions(
    messages,
    compactableIds,
  );
  const keepIds = new Set(
    compactableResultPositions
      .slice(-MICROCOMPACT_KEEP_RECENT)
      .map((position) => position.toolUseId),
  );
  // Path-aware retention: always preserve the most-recently-read result for
  // each distinct file path the agent has read. Without this, the active
  // working file is evicted by the flat recent-N window and the agent
  // re-reads it on the next turn (context-retention thrash).
  for (
    const toolUseId of latestReadResultPerPath(
      compactableResultPositions,
      readPathByToolUseId,
    )
  ) {
    keepIds.add(toolUseId);
  }
  const clearAfterMs = getTimeBasedMicrocompactClearAfterMs();
  const now = Date.now();
  const apiContextManagement = getAPIContextManagement(
    context?.options?.apiMicrocompact,
  );
  return {
    messages: messages.map((message) => {
      const rewrittenBlocks = isWithinTimeWindow(message, now, clearAfterMs)
        ? undefined
        : microcompactContentBlocks(
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
      // gaphunt3 #3: mirror the content-block branch's compactable-tool gate
      // on the standalone tool-message branch. The live pipeline stores tool
      // results as standalone role:"tool" messages, so without this gate every
      // large result was cleared regardless of the COMPACTABLE_TOOLS allowlist,
      // discarding results from non-compactable tools (Task/agent/custom tools).
      const isNonCompactableTool =
        message.toolName !== undefined && !isCompactableTool(message.toolName);
      const isExcludedById =
        message.toolCallId !== undefined &&
        compactableIds.size > 0 &&
        !compactableIds.has(message.toolCallId) &&
        !(message.toolName !== undefined && isCompactableTool(message.toolName));
      if (
        text.length < MICROCOMPACT_MIN_CHARS ||
        !isToolLikeMessage(message) ||
        isNonCompactableTool ||
        isExcludedById ||
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

/**
 * Map every Read tool_use id to the file path it read. Read tool uses carry
 * their target under `file_path` (in `toolCalls[].arguments` JSON for the
 * standalone-message shape, or in the `input` object for content blocks).
 */
function collectReadFilePaths(
  messages: readonly RuntimeMessage[],
): Map<string, string> {
  const paths = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!PATH_BEARING_READ_TOOLS.has(call.name)) continue;
      const filePath = readFilePathFromArguments(call.arguments);
      if (filePath !== undefined) paths.set(call.id, filePath);
    }
    const blocks = asContentBlocks(message.message?.content ?? message.content);
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") {
        continue;
      }
      if (!PATH_BEARING_READ_TOOLS.has(block.name)) continue;
      const filePath = readFilePathFromInput(block.input);
      if (filePath !== undefined) paths.set(block.id, filePath);
    }
  }
  return paths;
}

function readFilePathFromArguments(
  argumentsJson: string | undefined,
): string | undefined {
  if (typeof argumentsJson !== "string" || argumentsJson.length === 0) {
    return undefined;
  }
  try {
    return readFilePathFromInput(JSON.parse(argumentsJson));
  } catch {
    return undefined;
  }
}

function readFilePathFromInput(input: unknown): string | undefined {
  const record = isRecord(input) ? input : undefined;
  const filePath = record?.file_path;
  return typeof filePath === "string" && filePath.length > 0
    ? filePath
    : undefined;
}

/**
 * For each distinct file path, return the tool_use id of its last (most
 * recent) result position so that the active working file is never evicted.
 */
function latestReadResultPerPath(
  resultPositions: ReadonlyArray<{ readonly toolUseId: string }>,
  readPathByToolUseId: ReadonlyMap<string, string>,
): Set<string> {
  const latestByPath = new Map<string, string>();
  for (const position of resultPositions) {
    const filePath = readPathByToolUseId.get(position.toolUseId);
    if (filePath === undefined) continue;
    latestByPath.set(filePath, position.toolUseId);
  }
  return new Set(latestByPath.values());
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
  return content.filter(isRecord);
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

// Open-build no-op stub. Accepts the upstream (userMessageIndex, block) args so
// callers type-check; the values are intentionally ignored in this build.
export function pinCacheEdits(_userMessageIndex?: number, _block?: unknown): void {}
