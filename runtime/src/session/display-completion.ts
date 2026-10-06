import type { Event, EventMsg } from "./event-log.js";
import { redactSecretsInValue } from "../secrets/sanitizer.js";
import { stableStringify } from "../utils/stableStringify.js";
import type { DisplayAttachment } from "../mcp-client/display-attachments.js";

// Leave room for the canonical journal envelope, sequence and hash. The
// recovery reader rejects any complete row above 4 MiB.
const MAX_COMPLETION_BODY_BYTES = 4 * 1024 * 1024 - 32 * 1024;
const OMITTED = "\n[Additional display attachments omitted: journal size limit]";

type DisplayCompletionEvent = Event & { readonly msg: Extract<EventMsg, { readonly type: "tool_call_completed" }> };

export function boundDisplayCompletionEvent(event: DisplayCompletionEvent): DisplayCompletionEvent {
  const pending = event.msg.payload.metadata?.displayAttachments;
  if (!Array.isArray(pending) || pending.length === 0) return event;
  const metadata = { ...event.msg.payload.metadata, displayAttachments: [] as DisplayAttachment[] };
  let result = "";
  const build = (): DisplayCompletionEvent => ({ ...event, msg: { ...event.msg, payload: { ...event.msg.payload, result, metadata } } });
  const size = (): number => Buffer.byteLength(stableStringify(redactSecretsInValue(build())), "utf8");
  if (size() > MAX_COMPLETION_BODY_BYTES) throw new Error("display completion metadata exceeds journal size limit");
  let omitted = false;
  for (const attachment of pending as DisplayAttachment[]) {
    metadata.displayAttachments.push(attachment);
    if (size() > MAX_COMPLETION_BODY_BYTES) {
      metadata.displayAttachments.pop();
      omitted = true;
    }
  }
  result = event.msg.payload.result;
  while (size() > MAX_COMPLETION_BODY_BYTES && result.length > 0) {
    const excess = size() - MAX_COMPLETION_BODY_BYTES;
    result = Buffer.from(result).subarray(0, Math.max(0, Buffer.byteLength(result) - excess - 1024)).toString("utf8");
  }
  if (omitted) {
    result += OMITTED;
    while (size() > MAX_COMPLETION_BODY_BYTES) result = result.slice(0, -Math.max(1, size() - MAX_COMPLETION_BODY_BYTES));
  }
  return build();
}
