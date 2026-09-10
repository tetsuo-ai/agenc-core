/**
 * Recover complete, call-shaped JSON emitted as text by a local model.
 *
 * Native Ollama tool calls remain the preferred path. Text fallback is for
 * individual malformed responses, not an assumption about model size or
 * capabilities. Only the exact request catalog and argument schemas authorize
 * recovery; recovered calls still pass through the normal execution policy.
 *
 * This cannot infer intent from a standalone example identical to a call.
 * Keep recovery narrow: JSON-only blocks/lines, no inline examples, nested
 * fragments, incomplete values, or arbitrary source-code fences.
 */
import { randomUUID } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";

import type { LLMTool, LLMToolCall } from "../../types.js";

export interface SalvagedToolCalls {
  readonly toolCalls: readonly LLMToolCall[];
  /** Unconsumed text, byte-for-byte, including already streamed whitespace. */
  readonly content: string;
}

const MAX_CONTENT_CHARS = 1_048_576;
const MAX_CALLS = 64;
const MAX_DEPTH = 64;
const ajv = new Ajv({ strict: false, validateFormats: false, ownProperties: true });
const validators = new WeakMap<object, ValidateFunction | null>();

function matchesSchema(schema: Record<string, unknown>, value: object): boolean {
  let validate = validators.get(schema);
  if (validate === undefined) {
    try {
      validate = ajv.compile(schema);
    } catch {
      // Unsupported/invalid schemas must not make speculative text executable.
      validate = null;
    } finally {
      // Request catalogs can be regenerated each turn. Let the WeakMap own
      // their lifetime, rather than retaining every schema in AJV's cache.
      ajv.removeSchema(schema);
    }
    validators.set(schema, validate);
  }
  try {
    return validate !== null && validate(value) === true;
  } catch {
    return false;
  }
}

function toToolCall(
  value: unknown,
  known: ReadonlyMap<string, LLMTool>,
  makeId: () => string,
): LLMToolCall | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Extra fields suggest data or a tool schema, not an invocation envelope.
  if (Object.keys(record).some((key) => !["name", "arguments", "parameters"].includes(key))) return null;
  if ("arguments" in record && "parameters" in record) return null;
  const name = record.name;
  const tool = typeof name === "string" ? known.get(name) : undefined;
  if (!tool || typeof name !== "string") return null;

  let argumentsValue = "arguments" in record ? record.arguments
    : "parameters" in record ? record.parameters : {};
  if (typeof argumentsValue === "string") {
    const text = argumentsValue.trim();
    if (text[0] !== "{" || jsonSpanEnd(text, 0) !== text.length) return null;
    try {
      argumentsValue = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) return null;
  // JSON.parse accepts overflowing numeric literals as Infinity. Do not turn
  // them into null via JSON.stringify, silently changing a model's argument.
  const pending: unknown[] = [argumentsValue];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (typeof entry === "number" && !Number.isFinite(entry)) return null;
    if (entry !== null && typeof entry === "object") {
      for (const child of Object.values(entry)) pending.push(child);
    }
  }
  if (!matchesSchema(tool.function.parameters, argumentsValue)) return null;
  return { id: makeId(), name, arguments: JSON.stringify(argumentsValue) };
}

function callsFrom(
  parsed: unknown,
  known: ReadonlyMap<string, LLMTool>,
  makeId: () => string,
): LLMToolCall[] {
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length > MAX_CALLS) return [];
  const calls: LLMToolCall[] = [];
  for (const entry of entries) {
    const call = toToolCall(entry, known, makeId);
    // Never execute only the valid portion of a malformed batch.
    if (call === null) return [];
    calls.push(call);
  }
  return calls;
}

/** Balanced JSON, with strings/escapes and both bracket types tracked. */
function jsonSpanEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      if (stack.length > MAX_DEPTH) return -1;
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

interface Candidate {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

/** Linear scan: do not re-scan nested objects inside malformed outer values. */
function candidates(content: string): Candidate[] {
  const found: Candidate[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const newline = content.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(cursor, lineEnd).replace(/\r$/, "");
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2]!.trim().toLowerCase();
      const closer = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t\\r]*$`, "m");
      const restStart = lineEnd + 1;
      const closing = closer.exec(content.slice(restStart));
      if (!closing) break;
      const bodyEnd = restStart + closing.index;
      const to = bodyEnd + closing[0].length;
      if (language === "" || language === "json") {
        const body = content.slice(restStart, bodyEnd).trim();
        if ((body[0] === "{" || body[0] === "[") && jsonSpanEnd(body, 0) === body.length) {
          found.push({ text: body, from: cursor + line.indexOf(marker), to });
        }
      }
      cursor = to + 1;
    } else {
      const offset = line.search(/\S/);
      const start = cursor + offset;
      if (offset >= 0 && (content[start] === "{" || content[start] === "[")) {
        const end = jsonSpanEnd(content, start);
        if (end === -1) break;
        const nextNewline = content.indexOf("\n", end);
        const after = nextNewline === -1 ? content.length : nextNewline;
        if (content.slice(end, after).trim() === "") {
          found.push({ text: content.slice(start, end), from: start, to: end });
        }
        cursor = after + 1;
      } else cursor = lineEnd + 1;
    }
    if (found.length > MAX_CALLS) return [];
  }
  return found;
}

/**
 * The existing salvage grammar, restricted to one whole-response value.
 * Used only to diagnose rejected calls, never to grant execution authority.
 * Surrounding prose, multiple blocks and source-code fences are not candidates.
 */
export function standaloneTextToolCallCandidate(content: string): string | undefined {
  if (content.length > MAX_CONTENT_CHARS) return undefined;
  const found = candidates(content);
  if (found.length !== 1) return undefined;
  const candidate = found[0]!;
  if (content.slice(0, candidate.from).trim() || content.slice(candidate.to).trim()) return undefined;
  return candidate.text;
}

/**
 * Hold a potential value (and partial Markdown fence) until recovery decides.
 * The adapter only uses this when the actual request advertised tools.
 */
export function streamableLength(content: string): number {
  const marker = content.search(/[\[{`~]/);
  return marker === -1 ? content.length : marker;
}

export function salvageTextToolCalls(
  content: string,
  tools: readonly LLMTool[] | undefined,
  makeId: () => string = randomUUID,
): SalvagedToolCalls {
  if (!tools?.length || content.length > MAX_CONTENT_CHARS || content.trim().length === 0) {
    return { toolCalls: [], content };
  }
  const known = new Map(tools.map((tool) => [tool.function.name, tool]));
  const calls: LLMToolCall[] = [];
  const consumed: Candidate[] = [];
  for (const candidate of candidates(content)) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate.text); } catch { continue; }
    const found = callsFrom(parsed, known, makeId);
    if (found.length === 0) continue;
    calls.push(...found);
    if (calls.length > MAX_CALLS) return { toolCalls: [], content };
    consumed.push(candidate);
  }
  if (calls.length === 0) return { toolCalls: [], content };

  let remaining = "";
  let cursor = 0;
  for (const span of consumed) {
    remaining += content.slice(cursor, span.from);
    cursor = span.to;
  }
  remaining += content.slice(cursor);
  // Never trim: the prefix may already be visible in the streaming UI.
  return { toolCalls: calls, content: remaining };
}
