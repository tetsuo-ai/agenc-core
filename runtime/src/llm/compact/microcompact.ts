/**
 * Microcompact layer — replaces the body of cold tool-result messages
 * with a placeholder so the model doesn't pay token cost to recall
 * stale tool output.
 *
 * Time-based path only. xAI does not expose a cache-editing API, so we
 * cannot surgically delete tool results without invalidating the cached
 * prefix; the time-based trigger is a reasonable approximation.
 *
 * Trigger: the gap since the last activity touch exceeds `gapMs`. When
 * the gap fires, the xAI server-side prompt cache has almost certainly
 * expired, so the prefix will be rewritten anyway — content-clearing
 * old tool results now shrinks what gets rewritten on the next request.
 *
 * @module
 */

import type { LLMMessage } from "../types.js";
import type { PreservedAttachment } from "./attachments.js";
import {
  COMPACT_BOUNDARY_SUBTYPE,
  DEFAULT_MICROCOMPACT_GAP_MS,
} from "./constants.js";

/**
 * Placeholder that replaces the content of a cold tool result. Kept
 * stable so the runtime's text filters, tests, and parity checks
 * line up.
 */
export const TIME_BASED_MC_CLEARED_MESSAGE =
  "[Old tool result content cleared]";

/**
 * Compactable tool names — only tool results from these tools are ever
 * content-cleared. Non-compactable tools (e.g. task lifecycle, small
 * status reads) are left alone because their results are already small
 * and carry state the model actively depends on.
 *
 * Covers:
 *   - file read/edit/write
 *   - shell
 *   - grep/glob
 *   - directory listing
 *   - web browse / fetch
 */
export const COMPACTABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // File I/O
  "system.readFile",
  "system.editFile",
  "system.writeFile",
  "system.appendFile",
  // Shell
  "system.bash",
  // Search
  "system.grep",
  "system.glob",
  // Directory listing (often large on repo-wide queries)
  "system.listDir",
  "system.repoInventory",
  // Web / HTTP
  "system.browse",
  "system.httpGet",
  "system.httpPost",
  "system.httpFetch",
  "system.extractLinks",
  "system.htmlToMarkdown",
]);

export interface MicrocompactState {
  readonly lastTouchMs: number;
  readonly clearedToolUseIds: ReadonlySet<string>;
  readonly compactCount: number;
}

export function createMicrocompactState(): MicrocompactState {
  return {
    lastTouchMs: 0,
    clearedToolUseIds: new Set<string>(),
    compactCount: 0,
  };
}

interface MicrocompactInput {
  readonly messages: readonly LLMMessage[];
  readonly state: MicrocompactState;
  readonly nowMs: number;
  readonly gapMs?: number;
  /**
   * How many of the most-recent compactable tool results to leave
   * untouched. Default is 5. Older compactable results get their
   * `content` replaced with the placeholder; newer results pass
   * through unchanged.
   */
  readonly keepRecent?: number;
}

interface MicrocompactResult {
  readonly action: "noop" | "microcompacted";
  readonly messages: readonly LLMMessage[];
  readonly state: MicrocompactState;
  readonly boundary?: LLMMessage;
  readonly preservedAttachments: readonly PreservedAttachment[];
}

const DEFAULT_KEEP_RECENT = 5;

/**
 * Walk messages and collect tool_call IDs whose tool name is in
 * `COMPACTABLE_TOOL_NAMES`, in encounter order. The IDs come from the
 * assistant's `toolCalls` array — the authoritative source of the tool
 * name — rather than being inferred from the tool-result message,
 * because tool results in AgenC's format carry a `toolName` hint but
 * the assistant turn is canonical.
 */
function collectCompactableToolCallIds(
  messages: readonly LLMMessage[],
): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const call of message.toolCalls) {
      if (COMPACTABLE_TOOL_NAMES.has(call.name)) {
        ids.push(call.id);
      }
    }
  }
  return ids;
}

/**
 * If the gap since the previous activity touch exceeds `gapMs`, walk
 * every tool-result message whose tool is in the compactable set and
 * content-clear all but the most recent `keepRecent` results. The
 * operation is deterministic across calls — re-running on a previously
 * microcompacted history is a no-op.
 *
 * The function mutates a shallow copy of `messages`; callers that
 * depend on reference-identity on no-op should compare `action`
 * against `"noop"` rather than `messages === input.messages`.
 */
export function applyMicrocompact(
  input: MicrocompactInput,
): MicrocompactResult {
  const gapMs = input.gapMs ?? DEFAULT_MICROCOMPACT_GAP_MS;
  const keepRecent = Math.max(1, input.keepRecent ?? DEFAULT_KEEP_RECENT);
  const idleFor = input.nowMs - input.state.lastTouchMs;
  const nextState: MicrocompactState = {
    lastTouchMs: input.nowMs,
    clearedToolUseIds: input.state.clearedToolUseIds,
    compactCount: input.state.compactCount,
  };

  if (input.state.lastTouchMs === 0 || idleFor < gapMs) {
    return {
      action: "noop",
      messages: input.messages,
      state: nextState,
      preservedAttachments: [],
    };
  }

  const compactableIds = collectCompactableToolCallIds(input.messages);
  if (compactableIds.length <= keepRecent) {
    return {
      action: "noop",
      messages: input.messages,
      state: nextState,
      preservedAttachments: [],
    };
  }

  const keepSet = new Set(compactableIds.slice(-keepRecent));
  const clearSet = new Set(
    compactableIds.filter((id) => !keepSet.has(id)),
  );
  if (clearSet.size === 0) {
    return {
      action: "noop",
      messages: input.messages,
      state: nextState,
      preservedAttachments: [],
    };
  }

  const cleared = new Set<string>(input.state.clearedToolUseIds);
  let clearedNow = 0;
  const rewritten: LLMMessage[] = input.messages.map((message) => {
    if (message.role !== "tool") return message;
    const toolCallId = message.toolCallId;
    if (!toolCallId || !clearSet.has(toolCallId)) return message;
    if (cleared.has(toolCallId)) return message;
    if (
      typeof message.content === "string" &&
      message.content === TIME_BASED_MC_CLEARED_MESSAGE
    ) {
      return message;
    }
    cleared.add(toolCallId);
    clearedNow++;
    return {
      ...message,
      content: TIME_BASED_MC_CLEARED_MESSAGE,
    };
  });

  if (clearedNow === 0) {
    return {
      action: "noop",
      messages: input.messages,
      state: nextState,
      preservedAttachments: [],
    };
  }

  return {
    action: "microcompacted",
    messages: rewritten,
    state: {
      lastTouchMs: input.nowMs,
      clearedToolUseIds: cleared,
      compactCount: input.state.compactCount + 1,
    },
    preservedAttachments: [],
    boundary: {
      role: "system",
      content:
        `[microcompact] cleared ${clearedNow} cold tool result(s) after ` +
        `${Math.round(idleFor / 1000)}s idle (kept last ${keepRecent})`,
    },
  };
}

// Boundary tagging is encoded in the `[microcompact]` content prefix —
// see COMPACT_BOUNDARY_SUBTYPE for the canonical layer name. Executor
// filters boundary messages by prefix before sending to the model.
void COMPACT_BOUNDARY_SUBTYPE;
