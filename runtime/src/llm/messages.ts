/**
 * `normalizeMessagesForAPI` — pure function that prepares an in-memory
 * `LLMMessage[]` for an API call. Mirrors the reference runtime's
 * message-normalization path.
 *
 * The runtime previously scattered this normalization across
 * `chat-executor-text.ts`, `chat-executor.ts`, and provider adapters.
 * This module collects the pure normalization steps so they can be
 * tested and reused.
 *
 * Steps in order:
 *   1. Strip "virtual" / boundary system messages whose content starts
 *      with `[snip]`, `[microcompact]`, `[autocompact]`,
 *      `[reactive-compact]`, or `[boundary]`.
 *   2. Drop empty assistant content unless that message is the very
 *      last one in the array.
 *   3. Merge consecutive same-role messages of role `user` so the API
 *      sees alternation.
 *   4. Drop tool result messages whose `toolCallId` does not match any
 *      preceding assistant `tool_calls` entry.
 *   5. Phase J: tag strategic messages with `cacheControl: "ephemeral"`
 *      breakpoints so provider adapters that support prompt caching
 *      (Anthropic, xAI Grok 4) can pin stable prefixes. Phase J tags
 *      the LAST system message, the LAST non-tool user message, and
 *      the LAST tool result that survived the normalization above.
 *      These are the three cut points the reference runtime uses.
 *      Providers that do not support cache_control
 *      silently ignore the tag.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";

const BOUNDARY_PREFIXES = [
  "[snip]",
  "[microcompact]",
  "[autocompact]",
  "[reactive-compact]",
  "[boundary]",
];

export interface NormalizeMessagesForAPIOptions {
  readonly dropOrphanToolMessages?: boolean;
}

export function normalizeMessagesForAPI(
  messages: readonly LLMMessage[],
  options?: NormalizeMessagesForAPIOptions,
): readonly LLMMessage[] {
  const stripped: LLMMessage[] = [];
  for (const message of messages) {
    if (message.role === "system" && typeof message.content === "string") {
      if (BOUNDARY_PREFIXES.some((prefix) => message.content.toString().startsWith(prefix))) {
        continue;
      }
    }
    stripped.push(message);
  }

  // Drop empty assistant content (except the last message — providers
  // will surface that explicitly so the caller can recover).
  const nonEmpty: LLMMessage[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const message = stripped[i];
    if (!message) continue;
    const isLast = i === stripped.length - 1;
    if (
      !isLast &&
      message.role === "assistant" &&
      isEmptyContent(message.content) &&
      !(message.toolCalls && message.toolCalls.length > 0)
    ) {
      continue;
    }
    nonEmpty.push(message);
  }

  // Merge consecutive user messages.
  const merged: LLMMessage[] = [];
  for (const message of nonEmpty) {
    const tail = merged[merged.length - 1];
    if (
      tail &&
      tail.role === "user" &&
      message.role === "user" &&
      typeof tail.content === "string" &&
      typeof message.content === "string"
    ) {
      merged[merged.length - 1] = {
        ...tail,
        content: `${tail.content}\n\n${message.content}`,
      };
    } else {
      merged.push(message);
    }
  }

  // Drop orphan tool messages unless the caller needs to preserve
  // them for downstream protocol repair.
  const seenToolCallIds = new Set<string>();
  const final: LLMMessage[] = [];
  const dropOrphanToolMessages = options?.dropOrphanToolMessages !== false;
  for (const message of merged) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        seenToolCallIds.add(call.id);
      }
    }
    if (message.role === "tool") {
      const toolCallId =
        (message as { toolCallId?: string }).toolCallId ??
        (message as { tool_call_id?: string }).tool_call_id;
      if (
        dropOrphanToolMessages &&
        (!toolCallId || !seenToolCallIds.has(toolCallId))
      ) {
        continue;
      }
    }
    final.push(message);
  }

  // Phase J: apply cache_control breakpoints to strategic messages.
  // We mutate the final array in-place by replacing up to three
  // messages with copies that carry the tag. Providers that do not
  // support cache_control strip the tag silently.
  return applyCacheControlBreakpoints(final);
}

/**
 * Tag the last system message, the last non-tool user message, and
 * the last tool message with a `cacheControl: "ephemeral"` marker so
 * providers that support prompt caching (Anthropic, xAI Grok 4) can
 * pin stable prefixes. Mirrors the reference runtime's three-cut-point
 * strategy.
 *
 * The tag is an optional camelCase field on the message object. The
 * core `LLMMessage` type does not declare it as required — provider
 * adapters that care (Grok 4) read it via a narrow cast; adapters
 * that don't (Ollama) leave it untouched. No runtime behavior
 * changes unless a provider adapter actively reads the field.
 */
export function applyCacheControlBreakpoints(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  if (messages.length === 0) return messages;
  const result: LLMMessage[] = messages.slice();
  const tagIndexes = selectCacheBreakpointIndexes(result);
  if (tagIndexes.length === 0) return result;
  for (const idx of tagIndexes) {
    const msg = result[idx];
    if (!msg) continue;
    const tagged: LLMMessage & { cacheControl?: "ephemeral" } = {
      ...msg,
      cacheControl: "ephemeral",
    };
    result[idx] = tagged;
  }
  return result;
}

/**
 * Pick up to three indices to tag with `cacheControl`:
 *   - the last `system` message (the prefix the model caches first)
 *   - the last `user` message (the query boundary)
 *   - the last `tool` message (the most recent tool_result boundary)
 *
 * Returns unique indices; may return fewer than three when the
 * message list lacks one of the roles. Order is undefined — the
 * caller only uses the set membership.
 */
function selectCacheBreakpointIndexes(
  messages: readonly LLMMessage[],
): readonly number[] {
  let lastSystem = -1;
  let lastUser = -1;
  let lastTool = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "system") lastSystem = i;
    else if (message.role === "user") lastUser = i;
    else if (message.role === "tool") lastTool = i;
  }
  const picked = new Set<number>();
  if (lastSystem >= 0) picked.add(lastSystem);
  if (lastUser >= 0) picked.add(lastUser);
  if (lastTool >= 0) picked.add(lastTool);
  return [...picked];
}

function isEmptyContent(content: LLMMessage["content"]): boolean {
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    return content.every((part) => {
      if (part && typeof part === "object" && part.type === "text") {
        return part.text.trim().length === 0;
      }
      return false;
    });
  }
  return false;
}
