import type { LLMMessage } from "../llm/types.js";
import { verifyToolResultIntegrity, withPersistedToolResultRepresentation } from "../session/tool-result-integrity.js";
import { readDedupEnabled } from "./read-result-options.js";

// Bounded, process-local evidence. Restored history without a live read is never deduplicated.
const observations = new Map<string, string>();
export function registerReadObservation(resultId: string, key: string): void {
  observations.set(resultId, key);
  if (observations.size > 4096) observations.delete(observations.keys().next().value!);
}

/** Only shorten this request. Durable history always keeps the original read. */
export function projectRepeatedReads(messages: readonly LLMMessage[]): readonly LLMMessage[] {
  if (!readDedupEnabled()) return messages;
  const visible = new Map<string, LLMMessage>();
  return messages.map((message) => {
    // A retained read before a compaction never serves as a reference after it.
    if (message.runtimeOnly?.compactionHistory !== undefined) visible.clear();
    const integrity = message.runtimeOnly?.toolResultIntegrity;
    const key = integrity === undefined ? undefined : observations.get(integrity.resultId);
    if (message.role !== "tool" || !["Read", "FileRead"].includes(message.toolName ?? "") ||
        !key || !message.toolCallId || typeof message.content !== "string" ||
        message.runtimeOnly?.toolResultIsError || integrity?.persisted.representation !== "original" ||
        verifyToolResultIntegrity({ integrity, toolCallId: message.toolCallId, content: message.content }).status !== "valid") return message;
    const earlier = visible.get(key);
    if (earlier === undefined || earlier.content !== message.content) {
      visible.set(key, message);
      return message;
    }
    const content = `[unchanged; same file and range as ${earlier.toolName} call ${JSON.stringify(earlier.toolCallId)}]`;
    return { ...message, content, runtimeOnly: { ...message.runtimeOnly,
      toolResultIntegrity: withPersistedToolResultRepresentation(integrity, "compacted", content),
    } };
  });
}
