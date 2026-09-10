/**
 * Recover a tool call a model wrote into its reply instead of returning.
 *
 * Ollama only populates `message.tool_calls` for models whose template emits
 * the structured form. A 7B routinely does not: given tools it writes the call
 * it wanted to make as JSON in `content`, ollama reports `tool_calls: null`,
 * and the runtime faithfully renders the JSON into the chat. That is what a
 * local model looked like to a user asking it to read a file:
 *
 *   {"name": "FileRead", "arguments": {"file_path": "note.txt"}}
 *
 * Nothing executed, nothing was read, and the answer was a fragment of
 * protocol. The model had done its half of the job; only the envelope was
 * wrong.
 *
 * These are the shapes actually observed from `qwen2.5-coder:7b` against a
 * live ollama, at temperature 0, and every one of them is handled here:
 *
 *   {"name": "FileRead", "arguments": {"file_path": "note.txt"}}
 *
 *   ```json
 *   [
 *       {"name": "Glob", "arguments": {"pattern": "*"}},
 *       {"name": "FileRead", "arguments": {"file_path": "note.txt"}}
 *   ]
 *   ```
 *
 *   {
 *     "name": "FileRead",
 *     "arguments": {
 *       "file_path": "note.txt"
 *     }
 *   }
 *
 *   I will first provide an explanation ... Here is the JSON object for the
 *   function call:
 *
 *   ```json
 *   {"name": "FileRead", "arguments": {"file_path": "note.txt"}}
 *   ```
 *
 * The last one matters most: the call is at the tail, after prose that is a
 * real answer and has to survive.
 *
 * THE RISK THIS MUST NOT TAKE. An ordinary reply must come through untouched.
 * Two observed replies that are not tool calls and must never be rewritten:
 * `Hello! How can I assist you today?`, and deepseek-r1's "I'm unable to read
 * files directly, but I can help ...". So this never guesses. A candidate is
 * salvaged only when it parses as JSON, carries a `name` that matches a tool
 * the request actually advertised, and its arguments are an object. Anything
 * else is left alone and reaches the user as the model wrote it.
 */

import { randomUUID } from "node:crypto";

import type { LLMTool, LLMToolCall } from "../../types.js";

/** What a salvage attempt produced. */
export interface SalvagedToolCalls {
  /** Calls recovered from the text, in the order the model wrote them. */
  readonly toolCalls: readonly LLMToolCall[];
  /**
   * The reply with the recovered JSON removed. Prose the model wrote around
   * the call is kept: it is often the only explanation the user gets.
   */
  readonly content: string;
}

/** A fenced block, with or without a language tag. */
const FENCED_BLOCK = /```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)```/g;

/**
 * Names the request advertised. A call to anything else is not a tool call we
 * can honour, and inventing one would be worse than showing the text.
 */
function advertisedNames(tools: readonly LLMTool[] | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    const name = tool?.function?.name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names;
}

/**
 * One parsed call, or null.
 *
 * `arguments` is the OpenAI spelling and what these models copy. `parameters`
 * shows up too, because it is the word used in the schema they were shown.
 */
function toToolCall(
  value: unknown,
  known: ReadonlySet<string>,
  makeId: () => string,
): LLMToolCall | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || !known.has(name)) return null;

  const rawArguments = record.arguments ?? record.parameters ?? {};
  // A string here is a model that stringified its own arguments, which is
  // legal in the wire format it is imitating. Anything not object-shaped is
  // not a call we can make.
  if (typeof rawArguments === "string") {
    return { id: makeId(), name, arguments: rawArguments };
  }
  if (
    typeof rawArguments !== "object" ||
    rawArguments === null ||
    Array.isArray(rawArguments)
  ) {
    return null;
  }
  return {
    id: makeId(),
    name,
    arguments: JSON.stringify(rawArguments),
  };
}

/** Calls from one parsed JSON value: a single call, or an array of them. */
function callsFrom(
  parsed: unknown,
  known: ReadonlySet<string>,
  makeId: () => string,
): LLMToolCall[] {
  if (Array.isArray(parsed)) {
    const calls: LLMToolCall[] = [];
    for (const entry of parsed) {
      const call = toToolCall(entry, known, makeId);
      // All or nothing: a list where one entry is not a call is not a list of
      // calls, and half-executing it would be worse than not executing it.
      if (call === null) return [];
      calls.push(call);
    }
    return calls;
  }
  const single = toToolCall(parsed, known, makeId);
  return single === null ? [] : [single];
}

/**
 * The span of the JSON value starting at `start`, or -1.
 *
 * Written by hand rather than by regex because the arguments nest, and a
 * regex that stops at the first `}` truncates every call with an object
 * argument. Strings are tracked so a brace inside a path or a message does
 * not close the value early.
 */
function jsonSpanEnd(text: string, start: number): number {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return -1;
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

interface Candidate {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

/** Fenced blocks first, then any bare JSON value in the text. */
function candidates(content: string): Candidate[] {
  const found: Candidate[] = [];
  FENCED_BLOCK.lastIndex = 0;
  for (const match of content.matchAll(FENCED_BLOCK)) {
    const body = match[1];
    if (body === undefined || match.index === undefined) continue;
    found.push({ text: body, from: match.index, to: match.index + match[0].length });
  }
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (char !== "{" && char !== "[") continue;
    // Skip anything already covered by a fence, so the same call is not
    // offered twice and the fence markers are removed with it.
    if (found.some((candidate) => i >= candidate.from && i < candidate.to)) continue;
    const end = jsonSpanEnd(content, i);
    if (end === -1) continue;
    found.push({ text: content.slice(i, end), from: i, to: end });
    i = end - 1;
  }
  return found.sort((a, b) => a.from - b.from);
}

/**
 * How much of a partial reply is safe to show the user now.
 *
 * Salvage can only run on a whole value, but the reply is streamed, so
 * without this the JSON reaches the screen token by token and the fix arrives
 * too late to matter: the user watches
 * `{"name": "FileRead", "arguments": ...` type itself out and only then does
 * it get replaced. That is the complaint, not a detail of it.
 *
 * So everything before the first point where a JSON value or a fenced block
 * could begin is safe to stream, and everything from there is held until the
 * stream ends and salvage has decided what it was. Ordinary prose has no such
 * point and streams exactly as before. A reply that really is about JSON is
 * held back and released whole, which is a small cost paid only by replies
 * that look like tool calls.
 */
export function streamableLength(content: string): number {
  const fence = content.indexOf("```");
  let earliest = fence === -1 ? content.length : fence;
  for (let i = 0; i < earliest; i += 1) {
    const char = content[i];
    if (char === "{" || char === "[") {
      earliest = i;
      break;
    }
  }
  return earliest;
}

/**
 * Pull tool calls out of a reply that was written as text.
 *
 * Returns the calls and the reply with their JSON removed. When nothing
 * salvageable is found the content comes back exactly as it went in, so a
 * plain answer is never disturbed.
 */
export function salvageTextToolCalls(
  content: string,
  tools: readonly LLMTool[] | undefined,
  /**
   * Injected so tests can be deterministic. The default has to be globally
   * unique, not merely unique within one reply: ids share a namespace with
   * every earlier turn in the session, and a per-response counter collided on
   * the second turn with `assistant tool call repeats "salvaged_0"`, which
   * rejects the history append and kills the turn.
   */
  makeId: () => string = randomUUID,
): SalvagedToolCalls {
  const known = advertisedNames(tools);
  if (known.size === 0 || content.trim().length === 0) {
    return { toolCalls: [], content };
  }

  const calls: LLMToolCall[] = [];
  const consumed: Array<{ from: number; to: number }> = [];
  for (const candidate of candidates(content)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.text);
    } catch {
      continue;
    }
    const found = callsFrom(parsed, known, makeId);
    if (found.length === 0) continue;
    calls.push(...found);
    consumed.push({ from: candidate.from, to: candidate.to });
  }

  if (calls.length === 0) return { toolCalls: [], content };

  let remaining = "";
  let cursor = 0;
  for (const span of consumed) {
    remaining += content.slice(cursor, span.from);
    cursor = span.to;
  }
  remaining += content.slice(cursor);

  // Prose around the call survives; the scaffolding that only introduced the
  // JSON ("Here is the JSON object for the function call:") is left as the
  // model wrote it rather than guessed at.
  return { toolCalls: calls, content: remaining.trim() };
}
