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
export function resolveAgentMessage(
  args: Record<string, unknown>,
  session: Pick<Session, "currentRootHumanTurn">,
): string {
  let text: string;
  if (args.message_ref === undefined) {
    if (typeof args.message !== "string") throw new Error("message or message_ref is required");
    text = args.message;
  } else {
    if (args.message !== undefined) throw new Error("Use either message or message_ref, not both");
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
    text = source.slice(start, end);
  }
  if (text.trim().length === 0) throw new Error("message or message_ref must contain a nonempty task");
  if (Buffer.byteLength(text, "utf8") > MAX_AGENT_MESSAGE_BYTES) throw new Error("Expanded agent message exceeds 256 KiB UTF-8; select a smaller excerpt or pass permitted file paths");
  return text;
}
