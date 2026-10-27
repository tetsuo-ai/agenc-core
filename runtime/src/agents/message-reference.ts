import type { Session } from "../session/session.js";

/** Bounds the expanded handoff, not merely the small provider tool call. */
export const MAX_AGENT_MESSAGE_BYTES = 256 * 1_024;
const MAX_DELIMITER_BYTES = 1_024;

export const AGENT_MESSAGE_REFERENCE_GUIDANCE =
  "For a task already in the current user's message, use message_ref instead of copying large text into tool arguments. " +
  "Set message_ref.source to current_user_message; optionally select an exact excerpt with unique after and before delimiters (excluded from the result). " +
  "Core copies the referenced text verbatim, without spending your output tokens. Do not repeat that text in message. " +
  "The expanded message is limited to 256 KiB UTF-8 and uses the same child permissions, provider consent, context and cost admission as an inline message. " +
  "For files, give the child permitted paths to read; a reference does not grant new file access.";

export const agentMessageReferenceSchema = {
  type: "object",
  properties: {
    source: { type: "string", enum: ["current_user_message"] },
    after: { type: "string", description: "Unique literal delimiter immediately before the desired text, excluded. Omit to start at the beginning." },
    before: { type: "string", description: "Unique literal delimiter immediately after the desired text, excluded. Omit to end at the end." },
  },
  required: ["source"],
  additionalProperties: false,
} as const;

/** Resolve only the calling session's active human input, never a transcript
 * search, tool output, another session, or a filesystem path. Resolution runs
 * before routing/admission so those boundaries see and price the real task.
 */
/**
 * Some models fill every tool field: a call can carry a real message together
 * with a placeholder message_ref that selects no excerpt (no delimiters, or
 * empty ones), or an empty message next to a real reference. GPT models on
 * the OpenAI route did this on every spawn, so every helper was refused with
 * "Use either message or message_ref, not both". Treat null and empty values
 * as absent; when message has text and the reference selects no excerpt, the
 * explicit message wins. A message next to a reference that selects an
 * excerpt keeps both: GPT models write their own instruction in message and
 * point at the user's words with the excerpt, so resolveAgentMessage puts the
 * message first and the excerpt after it.
 */
export function normalizeAgentMessageArgs(args: Record<string, unknown>): {
  readonly message?: unknown;
  readonly message_ref?: unknown;
} {
  let message = args.message;
  let ref = args.message_ref;
  if (message === null || (typeof message === "string" && message.trim().length === 0)) message = undefined;
  if (ref === null) ref = undefined;
  if (ref !== undefined && typeof ref === "object" && !Array.isArray(ref)) {
    const record: Record<string, unknown> = { ...(ref as Record<string, unknown>) };
    for (const key of ["after", "before"] as const) {
      if (record[key] === null || record[key] === "") delete record[key];
    }
    const selectsExcerpt = record.after !== undefined || record.before !== undefined;
    ref = message !== undefined && !selectsExcerpt ? undefined : record;
  }
  return {
    ...(message !== undefined ? { message } : {}),
    ...(ref !== undefined ? { message_ref: ref } : {}),
  };
}

export function resolveAgentMessage(
  rawArgs: Record<string, unknown>,
  session: Pick<Session, "currentRootHumanTurn">,
): string {
  const args = normalizeAgentMessageArgs(rawArgs);
  let text: string;
  if (args.message_ref === undefined) {
    if (typeof args.message !== "string") throw new Error("message or message_ref is required");
    text = args.message;
  } else {
    if (args.message !== undefined && typeof args.message !== "string") throw new Error("message must be a string");
    const ref = args.message_ref;
    if (ref === null || typeof ref !== "object" || Array.isArray(ref)) throw new Error("message_ref must be an object");
    const record = ref as Record<string, unknown>;
    if (Object.keys(record).some(key => !["source", "after", "before"].includes(key)) ||
        record.source !== "current_user_message") throw new Error("message_ref.source must be current_user_message; no other sources are accessible");
    const source = session.currentRootHumanTurn?.()?.text;
    if (source === undefined) throw new Error("message_ref unavailable: this session has no active human message; supply message explicitly");
    let start = 0;
    let end = source.length;
    for (const key of ["after", "before"] as const) {
      const delimiter = record[key];
      if (delimiter === undefined) continue;
      if (typeof delimiter !== "string" || delimiter.length === 0 || Buffer.byteLength(delimiter, "utf8") > MAX_DELIMITER_BYTES) {
        throw new Error(`message_ref.${key} must be a nonempty literal of at most 1024 UTF-8 bytes`);
      }
      const index = source.indexOf(delimiter);
      if (index < 0 || source.indexOf(delimiter, index + 1) >= 0) throw new Error(`message_ref.${key} must occur exactly once in the current user message`);
      if (key === "after") start = index + delimiter.length;
      else end = index;
    }
    if (end <= start) throw new Error("message_ref delimiters select an empty or reversed excerpt");
    const excerpt = source.slice(start, end);
    text = args.message === undefined ? excerpt : `${args.message}\n\n${excerpt}`;
  }
  if (text.trim().length === 0) throw new Error("message or message_ref must contain a nonempty task");
  if (Buffer.byteLength(text, "utf8") > MAX_AGENT_MESSAGE_BYTES) throw new Error("Expanded agent message exceeds 256 KiB UTF-8; select a smaller excerpt or pass permitted file paths");
  return text;
}
