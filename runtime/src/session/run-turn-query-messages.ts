/**
 * Query projection for one sampling request: slicing after the compaction
 * boundary, tool-result budgeting, microcompaction and truncate-to-fit,
 * the Editor fit projection, and the in-memory tool-result retention
 * bound that mirrors microcompact. Pure move out of run-turn.ts; the
 * declarations are the originals byte for byte.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import { cloneLlmMessageSnapshot } from "../llm/content-conversion.js";
import { isAuthenticatedCompactionBoundary } from "./compaction-history-marker.js";
import {
  fromAgenCRuntimeMessages,
  toAgenCRuntimeMessages,
  type AgenCRuntimeMessage,
} from "./runtime-message-conversion.js";
import {
  applyToolResultBudget,
  resolveToolResultBudgetChars,
  shrinkOversizedToolResults,
  type ContentReplacementState,
} from "./_deps/tool-result-storage.js";
import { roughTokenCountEstimationForMessages } from "../llm/token-estimation.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import { FILE_READ_TOOL_NAME } from "../tools/system/file-read.js";
import type { AssistantMessage, Terminal, TurnState } from "./turn-state.js";
import {
  buildAgenCToolUseContext,
  toAgenCModelContext,
  type AgenCToolUseContext,
} from "./agenc-tool-use-context.js";
import { cloneLLMMessage, finitePositive } from "./run-turn-messages.js";

export const EDITOR_INTERACTION_MAX_QUERY_TOKENS = 128_000;

const PREPARED_TERMINAL = Symbol("agenc_prepared_terminal");

interface AgenCPreparedTerminal {
  readonly terminal: Terminal;
  readonly assistantMessage: AssistantMessage;
}

type PreparedState = TurnState & {
  [PREPARED_TERMINAL]?: AgenCPreparedTerminal;
};

async function prepareAgenCTurnContext(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  querySource: string,
  signal?: AbortSignal,
): Promise<void> {
  delete (state as PreparedState)[PREPARED_TERMINAL];
  if (signal?.aborted) return;
  toAgenCModelContext(ctx);
  const messages = messagesAfterAgenCBoundary(state.messages);
  if (ctx.editorInteraction !== undefined) {
    // Editor query preparation is a pure projection over a deep-cloned
    // snapshot. Ordinary preparation may persist oversized tool results,
    // mutate the shared ContentReplacementState, and run history
    // microcompaction. Those session-wide side effects cannot be inherited by
    // a request scoped to one immutable editor revision. Retain only the
    // non-persisting truncate-to-fit backstop so provider limits still hold.
    state.messagesForQuery = projectEditorQueryMessagesToFit(
      messages.map(cloneLlmMessageSnapshot),
      ctx.modelInfo.contextWindow,
    );
    state.snipTokensFreed = 0;
    return;
  }
  const toolUseContext = buildAgenCToolUseContext(session, ctx, {
    querySource,
  });
  try {
    const prepared = await prepareAgenCQueryMessages({
      messages,
      toolUseContext,
      querySource,
      contentReplacementState: state.contentReplacementState,
    });
    state.messagesForQuery = prepared.messages;
    state.snipTokensFreed = prepared.snipTokensFreed;
    if (prepared.committed) {
      state.messages = [...state.messagesForQuery];
    }
  } catch {
    state.messagesForQuery = messages.map(cloneLLMMessage);
    state.snipTokensFreed = 0;
  }
}

function getAgenCPreparedTerminal(
  state: TurnState,
): AgenCPreparedTerminal | undefined {
  return (state as PreparedState)[PREPARED_TERMINAL];
}

function messagesAfterAgenCBoundary(
  messages: readonly LLMMessage[],
): LLMMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAuthenticatedCompactionBoundary(message)) {
      return messages.slice(index + 1).map((item) => ({ ...item }));
    }
  }
  return messages.map((item) => ({ ...item }));
}

async function prepareAgenCQueryMessages(params: {
  readonly messages: readonly LLMMessage[];
  readonly toolUseContext: AgenCToolUseContext;
  readonly querySource: string;
  readonly contentReplacementState?: ContentReplacementState;
}): Promise<{
  readonly messages: LLMMessage[];
  readonly snipTokensFreed: number;
  readonly committed: boolean;
}> {
  try {
    let messages = toAgenCRuntimeMessages(params.messages);
    const budgeted = await applyToolResultBudget(
      messages,
      params.contentReplacementState,
      {
        limitChars: resolveToolResultBudgetChars(
          params.toolUseContext.options.contextWindowTokens,
        ),
        persist: persistOversizedToolResult,
      },
    );
    messages = budgeted.messages as AgenCRuntimeMessage[];
    const { microcompactMessages } =
      await import("../services/compact/microCompact.js");
    const microcompactResult = await microcompactMessages(
      messages,
      params.toolUseContext,
      params.querySource,
    );
    messages = microcompactResult.messages as AgenCRuntimeMessage[];
    const result = {
      messages: truncateToolResultsToFit(
        fromAgenCRuntimeMessages(messages),
        params.toolUseContext.options.contextWindowTokens,
      ),
      snipTokensFreed: 0,
      committed: false,
    };
    return {
      messages: result.messages,
      snipTokensFreed: result.snipTokensFreed,
      committed: result.committed,
    };
  } catch (error) {
    throw error;
  }
}

function editorQueryFitTokenLimit(
  contextWindowTokens: number | undefined,
): number {
  const window = finitePositive(contextWindowTokens);
  if (window === undefined) return EDITOR_INTERACTION_MAX_QUERY_TOKENS;
  const outputReserve = Math.min(
    16_000,
    Math.max(1_024, Math.floor(window / 4)),
  );
  return Math.min(
    EDITOR_INTERACTION_MAX_QUERY_TOKENS,
    Math.max(1_024, window - outputReserve),
  );
}

/**
 * Pure, request-local Editor history projection. Tool results are first
 * shrunk on the cloned snapshot, then complete oldest user-turn segments are
 * omitted until the provider payload fits. The active (latest) user segment
 * is never partially rewritten: if it alone exceeds the fixed request bound,
 * fail closed before contacting the provider.
 */
function projectEditorQueryMessagesToFit(
  messages: LLMMessage[],
  contextWindowTokens: number | undefined,
): LLMMessage[] {
  const fitTokens = editorQueryFitTokenLimit(contextWindowTokens);
  const truncated = truncateToolResultsToFit(
    messages,
    contextWindowTokens ?? EDITOR_INTERACTION_MAX_QUERY_TOKENS + 16_000,
  );
  if (roughTokenCountEstimationForMessages(truncated) <= fitTokens) {
    return truncated;
  }

  // System/developer framing precedes the first root-user turn and is not
  // disposable history. Keep it outside the turn segments so dropping an old
  // user turn can never also drop the provider's instruction boundary.
  const firstUserIndex = truncated.findIndex(
    (message) => message.role === "user",
  );
  const prefix = firstUserIndex > 0 ? truncated.slice(0, firstUserIndex) : [];
  const segmentable =
    firstUserIndex > 0 ? truncated.slice(firstUserIndex) : truncated;
  const segments: LLMMessage[][] = [];
  let current: LLMMessage[] = [];
  for (const message of segmentable) {
    if (message.role === "user" && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) segments.push(current);
  const latest = segments.at(-1) ?? [];
  const required = [...prefix, ...latest];
  const latestTokens = roughTokenCountEstimationForMessages(required);
  if (latestTokens > fitTokens) {
    throw new Error(
      "editor_interaction_context_limit: active Editor request " +
        `requires approximately ${latestTokens} tokens; limit ${fitTokens}`,
    );
  }

  let projected = [...latest];
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const candidate = [...prefix, ...(segments[index] ?? []), ...projected];
    if (roughTokenCountEstimationForMessages(candidate) > fitTokens) {
      continue;
    }
    projected = [...(segments[index] ?? []), ...projected];
  }
  return [...prefix, ...projected];
}

/**
 * Pre-send truncate-to-fit backstop. The mid-turn compact gate anchors
 * on the PREVIOUS sample's `promptTokens`, which cannot see tool
 * results added since — a burst of large results can push the next
 * request past the window and waste a full 413 round-trip before the
 * reactive collapse fires. When the assembled request's rough estimate
 * exceeds the window minus an output reserve, shrink oversized tool
 * results (head+tail slices, pairing preserved) at progressively
 * tighter caps until it fits or nothing shrinkable remains.
 */
function truncateToolResultsToFit(
  messages: LLMMessage[],
  contextWindowTokens: number | undefined,
): LLMMessage[] {
  const window = finitePositive(contextWindowTokens);
  if (window === undefined) return messages;
  const fitTokens = Math.max(8_000, window - 16_000);
  let estimate = roughTokenCountEstimationForMessages(messages);
  if (estimate <= fitTokens) return messages;
  let out = messages;
  for (const cap of [100_000, 50_000, 20_000, 8_000]) {
    const shrunk = shrinkOversizedToolResults(out, cap);
    if (shrunk.shrunkCount === 0) continue;
    out = shrunk.messages;
    estimate = roughTokenCountEstimationForMessages(out);
    if (estimate <= fitTokens) break;
  }
  return out;
}

/**
 * Persist an over-budget tool result via the shared tool-results store
 * (same disk layout as the single-result offload path in
 * `tools/execution.ts`, so the model's FileRead pointer works for both)
 * and return the preview replacement string, or null on failure.
 */
async function persistOversizedToolResult(
  content: string,
  toolUseId: string,
): Promise<string | null> {
  const { persistToolResult, buildLargeToolResultMessage } =
    await import("../utils/toolResultStorage.js");
  const persisted = await persistToolResult(content, toolUseId);
  if ("error" in persisted) return null;
  return buildLargeToolResultMessage(persisted);
}

// ─────────────────────────────────────────────────────────────────────
// In-memory tool-result retention bound (session-history-memory fix).
//
// Full tool-output content (build logs, large file reads, ctest output)
// otherwise accumulates UNBOUNDED in the live in-memory session for the
// whole session, in BOTH `state.messages` and the deep-cloned
// `sessionState.history`, causing GB-scale heap growth / OOM.
//
// The outbound request the model sees is already microcompacted
// (`state.messagesForQuery` via `microcompactMessages`), which keeps the
// most-recent-N tool results full and replaces OLDER large tool-result
// content with a compact marker. The durable in-memory copy is aligned
// to that same decision here: older large tool-result content is replaced
// with the same marker, while the most-recent-N tool results keep full
// content (so recent context the model relies on is unchanged).
//
// IMPORTANT: this only mutates the LIVE in-memory structures. The disk
// rollout (persisted response items via `rolloutStore.appendRollout`)
// must keep FULL content for resume, so this bound is only ever applied
// AFTER `persistNewResponseItems()` has persisted the full content, and
// only to messages that have already been persisted.
//
// The constants/heuristics below are kept in lockstep with `microCompact.ts`
// (`MICROCOMPACT_KEEP_RECENT`, `MICROCOMPACT_MIN_CHARS`,
// `TOOL_RESULT_CLEARED_MESSAGE`, `COMPACTABLE_TOOLS`) so the durable in-memory
// copy clears exactly the tool results microcompact already clears in the
// OUTBOUND view — older, large, compactable-tool results outside the
// most-recent-N window — and the model's view on the next turn never loses
// content the in-memory copy still owed it.
const IN_MEMORY_KEEP_RECENT_TOOL_RESULTS = 5;
const IN_MEMORY_TOOL_RESULT_MAX_CHARS = 6_000;
const IN_MEMORY_TOOL_RESULT_CLEARED_MARKER =
  "[Old tool result content cleared]";
const IN_MEMORY_MCP_TOOL_PREFIX = "mcp__";
// Shell tools register as "exec_command" / "system.bash" in the LIVE tool
// registry. Removed names in the compactable set exist only for persisted
// historical transcripts.
const IN_MEMORY_EXEC_COMMAND_TOOL_NAME = "exec_command";
// Tool names MUST match the LIVE tool registry. The whole-file reader is
// `FILE_READ_TOOL_NAME` ("FileRead") and the shell tool is "exec_command" —
// these (the largest tool outputs: whole-file reads, build/test logs) were
// previously absent, so their results were NEVER bounded in memory and the
// OOM bound missed its biggest targets. Grep/Glob/Edit/Write already match.
// Kept in lockstep with `microCompact.ts` `COMPACTABLE_TOOLS`.
const IN_MEMORY_COMPACTABLE_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  "Read",
  IN_MEMORY_EXEC_COMMAND_TOOL_NAME,
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

// Path-bearing readers whose tool call carries a `file_path` argument. The
// LATEST result per active path is retained full (model context preserved)
// even when it falls outside the most-recent-N window — mirroring
// microcompact's `PATH_BEARING_READ_TOOLS` path-aware retention.
const IN_MEMORY_PATH_BEARING_READ_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  "Read",
]);

function inMemoryReadFilePathFromArguments(
  argumentsJson: string | undefined,
): string | undefined {
  if (typeof argumentsJson !== "string" || argumentsJson.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const filePath = (parsed as Record<string, unknown>).file_path;
  return typeof filePath === "string" && filePath.length > 0
    ? filePath
    : undefined;
}

function isToolResultMessage(message: LLMMessage): boolean {
  return message.role === "tool" || message.toolCallId !== undefined;
}

function isInMemoryCompactableTool(name: string | undefined): boolean {
  if (name === undefined) return false;
  return (
    IN_MEMORY_COMPACTABLE_TOOLS.has(name) ||
    name.startsWith(IN_MEMORY_MCP_TOOL_PREFIX)
  );
}

function toolResultContentLength(content: LLMMessage["content"]): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part && typeof part === "object" && "text" in part) {
      const text = (part as { readonly text?: unknown }).text;
      if (typeof text === "string") total += text.length;
    }
  }
  return total;
}

/**
 * Replace OLDER large tool-result content in `messages` (mutating in place)
 * with a compact marker, keeping the most-recent-N tool results full so the
 * model's recent context is unchanged.
 *
 * `boundUpToIndex` caps how far into `messages` clearing may reach so that
 * in-flight / not-yet-persisted tail messages are never altered before their
 * full content has been persisted to the durable rollout. Only messages with
 * index < `boundUpToIndex` are eligible for clearing.
 *
 * Returns the number of tool-result messages whose content was cleared.
 */
function boundInMemoryToolResultContent(
  messages: LLMMessage[],
  boundUpToIndex: number,
): number {
  // Compactability is keyed off the assistant `toolCalls` that requested each
  // tool, exactly like microcompact's `collectCompactableToolUseIds` — the
  // tool-result message itself does not reliably carry `toolName`. A result is
  // compactable when its `toolCallId` was requested by a compactable tool, or
  // (fallback, mirroring microcompact) its own `toolName` is compactable.
  const compactableCallIds = new Set<string>();
  // Map every path-bearing read tool_use id → the `file_path` it read, so the
  // LATEST read per path can be retained full even outside the recent-N window.
  const readPathByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (isInMemoryCompactableTool(call.name)) compactableCallIds.add(call.id);
      if (IN_MEMORY_PATH_BEARING_READ_TOOLS.has(call.name)) {
        const filePath = inMemoryReadFilePathFromArguments(call.arguments);
        if (filePath !== undefined) readPathByCallId.set(call.id, filePath);
      }
    }
  }
  const isCompactableResult = (message: LLMMessage): boolean => {
    if (
      message.toolCallId !== undefined &&
      compactableCallIds.has(message.toolCallId)
    ) {
      return true;
    }
    return isInMemoryCompactableTool(message.toolName);
  };
  // Identify indices of compactable tool-result messages so we can preserve
  // the most-recent-N (matching microcompact's keep-recent window) full. Only
  // compactable-tool results are eligible — mirroring microcompact — so the
  // in-memory copy never clears a result the outbound view still keeps full.
  const compactableResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (
      message !== undefined &&
      isToolResultMessage(message) &&
      isCompactableResult(message)
    ) {
      compactableResultIndices.push(i);
    }
  }
  const keepFromIndex =
    compactableResultIndices.length > IN_MEMORY_KEEP_RECENT_TOOL_RESULTS
      ? compactableResultIndices[
          compactableResultIndices.length - IN_MEMORY_KEEP_RECENT_TOOL_RESULTS
        ]
      : -1;
  // Path-aware retention: for each distinct file path, keep the LATEST read
  // result full so the active working file is never evicted by the flat
  // recent-N window (otherwise the model re-reads it every turn — context
  // thrash). `compactableResultIndices` is in document order, so the last
  // index seen per path is the most-recent read of that path. Mirrors
  // microcompact's `latestReadResultPerPath`.
  const keepIndexByPath = new Map<string, number>();
  for (const index of compactableResultIndices) {
    const message = messages[index];
    const callId = message?.toolCallId;
    if (callId === undefined) continue;
    const filePath = readPathByCallId.get(callId);
    if (filePath === undefined) continue;
    keepIndexByPath.set(filePath, index);
  }
  const keepIndices = new Set<number>(keepIndexByPath.values());
  let cleared = 0;
  for (const index of compactableResultIndices) {
    // Never clear within the most-recent-N kept window.
    if (keepFromIndex >= 0 && index >= keepFromIndex) continue;
    // Never clear the most-recent read of an active file path.
    if (keepIndices.has(index)) continue;
    // Never clear content that has not yet been persisted to the rollout.
    if (index >= boundUpToIndex) continue;
    const message = messages[index];
    if (message === undefined) continue;
    if (
      toolResultContentLength(message.content) < IN_MEMORY_TOOL_RESULT_MAX_CHARS
    ) {
      continue;
    }
    if (message.content === IN_MEMORY_TOOL_RESULT_CLEARED_MARKER) continue;
    messages[index] = {
      ...message,
      content: IN_MEMORY_TOOL_RESULT_CLEARED_MARKER,
    };
    cleared += 1;
  }
  return cleared;
}

// Shared with run-turn.ts and its sibling modules.
export {
  prepareAgenCTurnContext,
  getAgenCPreparedTerminal,
  boundInMemoryToolResultContent,
};
