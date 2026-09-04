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
/** Live compactable tool output (characters) a history may hold before the oldest results are cleared. */
const MICROCOMPACT_PRESSURE_CHARS = 120_000;
/** Share of the context window (at 4 characters per token) that caps that limit for small models. */
const MICROCOMPACT_PRESSURE_WINDOW_SHARE = 0.25;
const TOOL_RESULT_CLEARED_MESSAGE = "[Old tool result content cleared]";
const MCP_TOOL_PREFIX = "mcp__";
// Tool names MUST match the names the LIVE tool registry registers, not the
// legacy/upstream-snapshot names. The whole-file reader registers as
// "FileRead" (canonical `FILE_READ_TOOL_NAME` in
// `src/tools/system/file-read.ts`) and shell tools register as
// "exec_command" / "system.bash". Removed spellings below exist only so
// persisted historical transcripts remain compactable.
// Keying on the upstream names left FileRead/exec_command results unbounded
// (the largest OOM contributors) and excluded from path-aware retention.
// The remaining names (Grep/Glob/Edit/Write) already match the live registry.
const COMPACTABLE_TOOLS = new Set([
  "FileRead",
  "Read",
  "exec_command",
  "system.bash",
  "Bash",
  "PowerShell",
  "Grep",
  "Glob",
  "WebSearch",
  "web_fetch",
  "WebFetch",
  "Edit",
  "Write",
]);

// Path-bearing readers whose result carries a `file_path` argument, so the
// LATEST result per active path can be retained beyond the flat recent-N
// window. "FileRead" is the live whole-file reader; "Read" is retained only
// for persisted historical transcripts.
const PATH_BEARING_READ_TOOLS = new Set(["FileRead", "Read"]);

let microcompactSequence = 0;

function standaloneKey(message: RuntimeMessage, index: number): string {
  return message.toolCallId ?? `msg:${index}`;
}

interface CompactableResultPosition {
  readonly toolUseId: string;
  /** Length of the result text as the model would see it. */
  readonly chars: number;
  /** Inside the time-based clear window: never a victim. */
  readonly recent: boolean;
}

function pressureLimitChars(contextWindowTokens: number | undefined): number {
  if (
    contextWindowTokens === undefined ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return MICROCOMPACT_PRESSURE_CHARS;
  }
  const windowShare = Math.floor(contextWindowTokens * 4 * MICROCOMPACT_PRESSURE_WINDOW_SHARE);
  return Math.min(MICROCOMPACT_PRESSURE_CHARS, Math.max(MICROCOMPACT_MIN_CHARS * 2, windowShare));
}

/**
 * Which compactable results are cleared, replayed over the append-only
 * history so every projection of one history agrees byte for byte. Results
 * accumulate until their live text exceeds the pressure limit; the valve then
 * clears the oldest clearable ones down to half the limit, never the most
 * recent ones, never the latest read of a path, never a result inside the
 * time window. Between two firings nothing moves, so the provider's cached
 * prefix breaks once per batch instead of once per call, which is what a
 * recent-N window sliding with every tool result did (measured as mid-turn
 * cache misses of the whole tail).
 */
function decideClearedResults(
  positions: readonly CompactableResultPosition[],
  readPathByToolUseId: ReadonlyMap<string, string>,
  limitChars: number,
): Set<string> {
  const cleared = new Set<string>();
  const live: CompactableResultPosition[] = [];
  const latestReadByPath = new Map<string, string>();
  const target = Math.floor(limitChars / 2);
  let liveChars = 0;
  for (const position of positions) {
    const path = readPathByToolUseId.get(position.toolUseId);
    if (path !== undefined) latestReadByPath.set(path, position.toolUseId);
    if (position.chars < MICROCOMPACT_MIN_CHARS) continue;
    live.push(position);
    liveChars += position.chars;
    if (liveChars <= limitChars) continue;
    for (
      let index = 0;
      index < live.length - MICROCOMPACT_KEEP_RECENT && liveChars > target;

    ) {
      const victim = live[index]!;
      const victimPath = readPathByToolUseId.get(victim.toolUseId);
      const isLatestReadOfPath =
        victimPath !== undefined && latestReadByPath.get(victimPath) === victim.toolUseId;
      if (victim.recent || isLatestReadOfPath) {
        index += 1;
        continue;
      }
      cleared.add(victim.toolUseId);
      liveChars -= victim.chars;
      live.splice(index, 1);
    }
  }
  return cleared;
}

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
  const clearAfterMs = getTimeBasedMicrocompactClearAfterMs();
  const now = Date.now();
  const positions = collectCompactableToolResultPositions(
    messages,
    compactableIds,
    now,
    clearAfterMs,
  );
  const apiContextManagement = getAPIContextManagement(
    context?.options?.apiMicrocompact,
  );
  // Stable labels: a cleared result is named by its position among the
  // compactable results, which the append-only history never changes, instead
  // of by a process counter that renumbered it on every re-projection.
  const positionByToolUseId = new Map<string, number>(
    positions.map((position, index) => [position.toolUseId, index + 1]),
  );
  const clearedIds = decideClearedResults(
    positions,
    readPathByToolUseId,
    pressureLimitChars(context?.options?.contextWindowTokens),
  );

  return {
    messages: messages.map((message, index) => {
      const rewrittenBlocks = microcompactContentBlocks(
        message.message?.content ?? message.content,
        clearedIds,
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
      const key = standaloneKey(message, index);
      if (!clearedIds.has(key)) return message;
      const text = messageText(message);
      microcompactSequence += 1;
      const label =
        (message.toolCallId !== undefined
          ? positionByToolUseId.get(message.toolCallId)
          : undefined) ?? index + 1;
      const content =
        `[microcompact:${label}] Older tool output compressed; original length ${text.length.toLocaleString()} characters.`;
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


function collectCompactableToolResultPositions(
  messages: readonly RuntimeMessage[],
  compactableIds: ReadonlySet<string>,
  now: number,
  clearAfterMs: number,
): CompactableResultPosition[] {
  const positions: CompactableResultPosition[] = [];
  for (const message of messages) {
    const recent = isWithinTimeWindow(message, now, clearAfterMs);
    if (isStandaloneCompactableResult(message, compactableIds)) {
      positions.push({
        toolUseId: message.toolCallId!,
        chars: messageText(message).length,
        recent,
      });
      continue;
    }
    for (const block of asContentBlocks(message.message?.content ?? message.content)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      if (compactableIds.size === 0 || compactableIds.has(block.tool_use_id)) {
        positions.push({
          toolUseId: block.tool_use_id,
          chars: stringifyContent(block.content ?? "").length,
          recent,
        });
      }
    }
  }
  return positions;
}

/**
 * The live pipeline stores tool results as standalone role:"tool" messages.
 * They count only when the tool is compactable (gaphunt3 #3: results of
 * Task/agent/custom tools are never cleared), by allowlisted name or by the
 * id the assistant's tool_use gave them.
 */
function isStandaloneCompactableResult(
  message: RuntimeMessage,
  compactableIds: ReadonlySet<string>,
): boolean {
  if (message.role !== "tool" && message.originalRole !== "tool") return false;
  if (message.toolCallId === undefined || !isToolLikeMessage(message)) return false;
  if (message.toolName !== undefined) return isCompactableTool(message.toolName);
  return compactableIds.size === 0 || compactableIds.has(message.toolCallId);
}

function microcompactContentBlocks(
  content: unknown,
  clearedIds: ReadonlySet<string>,
): unknown[] | undefined {
  const blocks = asContentBlocks(content);
  if (blocks.length === 0) return undefined;
  let touched = false;
  const rewritten = blocks.map((block) => {
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      return block;
    }
    if (!clearedIds.has(block.tool_use_id)) return block;
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
