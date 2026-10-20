/**
 * Request context fit: the last reduction before a prepared model request is
 * refused for not fitting its context window.
 *
 * Compaction rewrites durable history; it can summarize everything except the
 * current request and the newest tool results, which the model has not seen
 * yet. When those alone leave no room (a parallel batch of whole-file reads on
 * a small window), every compaction tier has to refuse, and the turn used to
 * end with `compact_failed` although the system prompt and the user's request
 * fit easily (E2E gate scenario 7).
 *
 * This projection shortens tool-result bodies in the outgoing request only, in
 * a fixed order, each step only while the request is still too large:
 *
 *   1. earlier, already-consumed results, oldest first, to a short
 *      head-and-tail excerpt;
 *   2. the newest, unresolved results, cut to one common size (water filling,
 *      so small results stay whole and the largest give up the most), down to
 *      a floor that still shows their opening and closing lines;
 *   3. earlier results, oldest first, to a one-line reference;
 *   4. the newest results, largest first, to a one-line reference.
 *
 * No message is removed and no user or assistant message is changed: every
 * tool call keeps its paired result, and every shortened result says how much
 * was omitted, that the exact result is kept in the session history, and how
 * to read it again. Durable history and the rollout keep every result byte for
 * byte; nothing here is persisted. When even step 4 leaves the request too
 * large, only the instructions, tools, summary, user and assistant messages
 * remain, and the caller reports that the window is too small.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import {
  LIGHT_WORKSPACE_DATA_BOUNDARY,
  UNTRUSTED_TOOL_RESULT_BOUNDARY,
} from "../tools/untrusted-tool-result-framing.js";

/** Bytes kept from an earlier, already-consumed tool result in step 1. */
export const CONTEXT_FIT_EARLIER_RESULT_FLOOR_BYTES = 640;
/** Bytes kept at least from each newest, unresolved tool result in step 2. */
export const CONTEXT_FIT_UNRESOLVED_RESULT_FLOOR_BYTES = 768;
/** Share of the kept bytes taken from the start of a result. */
const HEAD_SHARE = 0.7;
/**
 * A cut moves back to a line break when one lies within this share of the
 * kept text, so numbered file lines and values are never shown half cut.
 */
const LINE_SNAP_SHARE = 0.75;

export interface ContextFitOptions {
  /** Session history file that keeps the exact results (#3157). */
  readonly historyPath?: string;
}

export interface ContextFitResult {
  readonly messages: LLMMessage[];
  /** UTF-8 bytes removed from tool-result bodies, notes included. */
  readonly freedBytes: number;
  readonly shortenedEarlier: number;
  readonly shortenedUnresolved: number;
  /** True when every result is a reference and fewer bytes than requested were freed. */
  readonly exhausted: boolean;
}

interface ToolResultEntry {
  readonly index: number;
  readonly text: string;
  readonly bytes: number;
  readonly unresolved: boolean;
  readonly toolName: string;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Text of a tool-result body, or undefined when it holds non-text parts. */
function toolResultText(message: LLMMessage): string | undefined {
  if (message.role !== "tool" || typeof message.toolCallId !== "string") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content.length === 0) return undefined;
  const texts: string[] = [];
  for (const part of message.content) {
    if (part.type !== "text") return undefined;
    texts.push(part.text);
  }
  return texts.join("\n");
}

function withText(message: LLMMessage, text: string): LLMMessage {
  // The shortened body no longer matches the result's integrity seal; the
  // sealed original stays in durable history and this copy is never stored.
  const { toolResultIntegrity: _sealed, ...runtimeOnly } = message.runtimeOnly ?? {};
  return {
    ...message,
    content: Array.isArray(message.content) ? [{ type: "text", text }] : text,
    ...(message.runtimeOnly !== undefined ? { runtimeOnly } : {}),
  };
}

/**
 * Tool results of the newest assistant tool-call batch are unresolved: the
 * model has not answered them yet. Everything earlier has been consumed.
 */
function collectToolResults(messages: readonly LLMMessage[]): ToolResultEntry[] {
  const lastCallIndex = messages.findLastIndex((message) =>
    message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0);
  const unresolvedIds = new Set(
    lastCallIndex < 0 ? [] : (messages[lastCallIndex]!.toolCalls ?? []).map((call) => call.id),
  );
  const callNames = new Map<string, string>();
  const entries: ToolResultEntry[] = [];
  messages.forEach((message, index) => {
    for (const call of message.toolCalls ?? []) callNames.set(call.id, call.name);
    const text = toolResultText(message);
    if (text === undefined) return;
    entries.push({
      index,
      text,
      bytes: utf8Bytes(text),
      unresolved: index > lastCallIndex && unresolvedIds.has(message.toolCallId!),
      toolName: message.toolName ?? callNames.get(message.toolCallId!) ?? "tool",
    });
  });
  return entries;
}

/** Longest prefix of `value` within `maximumBytes`, on a code-point boundary. */
function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (utf8Bytes(value) <= maximumBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const size = utf8Bytes(codePoint);
    if (bytes + size > maximumBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

/** Longest suffix of `value` within `maximumBytes`, on a code-point boundary. */
function utf8Suffix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const window = value.slice(-maximumBytes);
  const encoded = Buffer.from(window, "utf8");
  let start = Math.max(0, encoded.length - maximumBytes);
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

/**
 * The untrusted-data frame around a tool result (standard or Light). The
 * runtime note goes after the closing boundary, outside the data a tool could
 * have written; tool bodies are sanitized so they cannot contain a boundary.
 */
function splitFrame(text: string): { readonly prefix: string; readonly body: string; readonly suffix: string } {
  const standardOpen = text.indexOf(`${UNTRUSTED_TOOL_RESULT_BOUNDARY}\n`);
  const standardClose = `\n${UNTRUSTED_TOOL_RESULT_BOUNDARY}`;
  if (standardOpen >= 0 && text.endsWith(standardClose) &&
      standardOpen + UNTRUSTED_TOOL_RESULT_BOUNDARY.length + 1 <= text.length - standardClose.length) {
    const bodyStart = standardOpen + UNTRUSTED_TOOL_RESULT_BOUNDARY.length + 1;
    return { prefix: text.slice(0, bodyStart), body: text.slice(bodyStart, -standardClose.length), suffix: standardClose };
  }
  const lightOpen = `${LIGHT_WORKSPACE_DATA_BOUNDARY}\n`;
  const lightClose = `\n${LIGHT_WORKSPACE_DATA_BOUNDARY}`;
  if (text.startsWith(lightOpen) && text.endsWith(lightClose) && text.length >= lightOpen.length + lightClose.length) {
    return { prefix: lightOpen, body: text.slice(lightOpen.length, -lightClose.length), suffix: lightClose };
  }
  return { prefix: "", body: text, suffix: "" };
}

const RECOVERY_HINT = "If you need the omitted part, request only that part again (for a file, FileRead with offset and limit).";

function excerptNote(unresolved: boolean, historyPath: string | undefined): string {
  const history = historyPath !== undefined && unresolved
    ? `the session history (${historyPath})`
    : "the session history";
  return unresolved
    ? `[AgenC shortened this tool result to fit the model's context window. The exact result is kept in ${history}. ${RECOVERY_HINT}]`
    : `[AgenC shortened this earlier tool result to fit the model's context window. The exact result is kept in ${history}.]`;
}

/** Step 3 and 4: a one-line reference in place of the body. */
export function contextFitReference(entry: { readonly text: string; readonly toolName: string; readonly unresolved: boolean }): string {
  const size = `${entry.text.length.toLocaleString("en-US")} characters`;
  return entry.unresolved
    ? `[AgenC omitted the body of this ${entry.toolName} result (${size}) to fit the model's context window. ` +
      `The exact result is kept in the session history. ${RECOVERY_HINT}]`
    : `[AgenC omitted this earlier ${entry.toolName} result (${size}) to fit the model's context window. ` +
      "The exact result is kept in the session history.]";
}

/**
 * Head-and-tail excerpt keeping about `keepBytes` of the original text, with
 * the omitted span named in place and a runtime note after the frame. Cuts
 * move to nearby line breaks so numbered file lines stay whole.
 */
export function contextFitExcerpt(
  text: string,
  keepBytes: number,
  unresolved: boolean,
  options: ContextFitOptions = {},
): string {
  const { prefix, body, suffix } = splitFrame(text);
  const bodyBudget = Math.max(0, keepBytes - utf8Bytes(prefix) - utf8Bytes(suffix));
  let head = utf8Prefix(body, Math.floor(bodyBudget * HEAD_SHARE));
  const headBreak = head.lastIndexOf("\n");
  if (headBreak >= 0 && head.length - headBreak <= Math.ceil(head.length * LINE_SNAP_SHARE)) {
    head = head.slice(0, headBreak + 1);
  }
  let tail = utf8Suffix(body.slice(head.length), Math.max(0, bodyBudget - utf8Bytes(head)));
  const tailBreak = tail.indexOf("\n");
  if (tailBreak >= 0 && tailBreak < Math.ceil(tail.length * LINE_SNAP_SHARE)) {
    tail = tail.slice(tailBreak + 1);
  }
  const omitted = body.length - head.length - tail.length;
  if (omitted <= 0) return text;
  const gap = `${head.endsWith("\n") || head.length === 0 ? "" : "\n"}[... ${omitted.toLocaleString("en-US")} of ` +
    `${body.length.toLocaleString("en-US")} characters omitted ...]${tail.length === 0 ? "" : "\n"}`;
  return `${prefix}${head}${gap}${tail}${suffix}\n${excerptNote(unresolved, options.historyPath)}`;
}

/**
 * Shorten tool-result bodies until at least `bytesToFree` UTF-8 bytes are
 * removed, in the fixed order described in the module comment. Pure: the
 * same messages and budget always produce the same projection.
 */
export function fitToolResultsToBudget(
  messages: readonly LLMMessage[],
  bytesToFree: number,
  options: ContextFitOptions = {},
): ContextFitResult {
  const entries = collectToolResults(messages);
  const replacements = new Map<number, string>();
  const requested = Math.max(0, Math.ceil(bytesToFree));
  let remaining = requested;
  const currentBytes = (entry: ToolResultEntry): number => {
    const replaced = replacements.get(entry.index);
    return replaced === undefined ? entry.bytes : utf8Bytes(replaced);
  };
  const replace = (entry: ToolResultEntry, text: string): void => {
    const saved = currentBytes(entry) - utf8Bytes(text);
    if (saved <= 0) return;
    replacements.set(entry.index, text);
    remaining -= saved;
  };
  const earlier = entries.filter((entry) => !entry.unresolved);
  const unresolved = entries.filter((entry) => entry.unresolved);

  // 1. Earlier results to a short excerpt, oldest first.
  for (const entry of earlier) {
    if (remaining <= 0) break;
    replace(entry, contextFitExcerpt(entry.text, CONTEXT_FIT_EARLIER_RESULT_FLOOR_BYTES, false, options));
  }

  // 2. Newest results to the largest common size that frees enough.
  if (remaining > 0 && unresolved.length > 0) {
    const cutAt = (cap: number): Map<number, string> => {
      const cut = new Map<number, string>();
      for (const entry of unresolved) {
        if (entry.bytes <= cap) continue;
        const shortened = contextFitExcerpt(entry.text, cap, true, options);
        if (utf8Bytes(shortened) < entry.bytes) cut.set(entry.index, shortened);
      }
      return cut;
    };
    const freedBy = (cut: ReadonlyMap<number, string>): number => {
      let freed = 0;
      for (const entry of unresolved) {
        const shortened = cut.get(entry.index);
        if (shortened !== undefined) freed += entry.bytes - utf8Bytes(shortened);
      }
      return freed;
    };
    let low = CONTEXT_FIT_UNRESOLVED_RESULT_FLOOR_BYTES;
    let high = Math.max(low, ...unresolved.map((entry) => entry.bytes));
    let best = cutAt(low);
    if (freedBy(best) >= remaining) {
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const cut = cutAt(middle);
        if (freedBy(cut) >= remaining) {
          low = middle;
          best = cut;
        } else {
          high = middle - 1;
        }
      }
    }
    for (const entry of unresolved) {
      const shortened = best.get(entry.index);
      if (shortened !== undefined) replace(entry, shortened);
    }
  }

  // 3. Earlier results to a reference, oldest first.
  for (const entry of earlier) {
    if (remaining <= 0) break;
    replace(entry, contextFitReference(entry));
  }

  // 4. Newest results to a reference, largest first.
  for (const entry of [...unresolved].sort((left, right) => currentBytes(right) - currentBytes(left))) {
    if (remaining <= 0) break;
    replace(entry, contextFitReference(entry));
  }

  return {
    messages: replacements.size === 0
      ? [...messages]
      : messages.map((message, index) => {
        const shortened = replacements.get(index);
        return shortened === undefined ? message : withText(message, shortened);
      }),
    freedBytes: Math.max(0, requested - remaining),
    shortenedEarlier: earlier.filter((entry) => replacements.has(entry.index)).length,
    shortenedUnresolved: unresolved.filter((entry) => replacements.has(entry.index)).length,
    exhausted: remaining > 0,
  };
}
