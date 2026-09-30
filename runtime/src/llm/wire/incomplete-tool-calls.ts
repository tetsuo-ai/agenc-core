import { createHash } from "node:crypto";
import type { LLMIncompleteToolCall } from "../types.js";
import { decodeMcpToolNameFromWire } from "./mcp-tool-naming.js";

export const MAX_INCOMPLETE_TOOL_CALLS = 32;
export const MAX_INCOMPLETE_TOOL_IDENTITY_LENGTH = 256;

/** Non-executable diagnostics only. Never inspect or return argument bytes.
 * Missing, malformed, excessive or ambiguous identities omit the whole batch.
 * No generated IDs. Responses compatibility permits an absent call_id to use
 * a valid supplied item.id, but explicit malformed/null metadata is not absent.
 * Chat permits legacy omission of type, never a supplied non-function type.
 */
export function incompleteToolCallIdentities(
  raw: unknown,
  format: "chat" | "responses" | "identity",
  advertisedToolNames: readonly string[],
  namespace?: string,
): readonly LLMIncompleteToolCall[] {
  if (!Array.isArray(raw) || raw.length > MAX_INCOMPLETE_TOOL_CALLS) return [];
  const identities: LLMIncompleteToolCall[] = [];
  const ids = new Set<string>();
  const responseItemIds = new Set<string>();
  const otherResponseItemIds = new Set<string>();
  const valid = (value: unknown): value is string => typeof value === "string"
    && value.length > 0 && value.length <= MAX_INCOMPLETE_TOOL_IDENTITY_LENGTH
    && /^[A-Za-z0-9_.:-]+$/u.test(value);
  for (const value of raw) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (format === "responses" && item.type !== "function_call") {
      // Only occupancy matters here; do not parse another item's payload.
      if (valid(item.id)) {
        if (responseItemIds.has(item.id)) return [];
        otherResponseItemIds.add(item.id);
      }
      continue;
    }
    if (format === "responses" && Object.hasOwn(item, "id")) {
      if (!valid(item.id) || responseItemIds.has(item.id) || otherResponseItemIds.has(item.id)) return [];
      responseItemIds.add(item.id);
    }
    if (format === "chat" && Object.hasOwn(item, "type") && item.type !== "function") return [];
    const fn = format === "chat" && item.function !== null && typeof item.function === "object"
      && !Array.isArray(item.function) ? item.function as Record<string, unknown> : undefined;
    const id = format === "responses"
      ? Object.hasOwn(item, "call_id") ? item.call_id : item.id
      : item.id;
    const wireName = format === "chat" ? fn?.name : item.name;
    if (!valid(id) || !valid(wireName)) return [];
    const name = decodeMcpToolNameFromWire(wireName, advertisedToolNames);
    if (!valid(name) || !advertisedToolNames.includes(name) || ids.has(id)) return [];
    ids.add(id);
    identities.push({ id: namespace === undefined ? id : "call_" + createHash("sha256")
      .update(namespace).update("\0").update(id).digest("hex").slice(0, 32), name });
  }
  return identities;
}
