import type {
  JsonObject,
  SessionTranscriptV2Result,
} from "../app-server/protocol/index.js";
import { isRecord } from "../utils/record.js";

export function daemonTranscriptSnapshotEvents(
  snapshot: SessionTranscriptV2Result,
  sessionId: string,
): readonly JsonObject[] {
  if (
    snapshot.schemaVersion !== 2 ||
    snapshot.sessionId !== sessionId ||
    typeof snapshot.runId !== "string" ||
    typeof snapshot.historyEpoch !== "string" ||
    !Number.isSafeInteger(snapshot.asOfSequence) ||
    snapshot.asOfSequence < 0 ||
    !Array.isArray(snapshot.messages)
  ) {
    throw new Error("Daemon returned an invalid transcript snapshot");
  }
  const events = snapshot.messages.map((message) => {
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.text !== "string" ||
      typeof message.messageId !== "string" ||
      typeof message.commitEventId !== "string" ||
      !Number.isSafeInteger(message.committedSequence) ||
      message.committedSequence < 0 ||
      message.committedSequence > snapshot.asOfSequence
    ) {
      throw new Error("Daemon returned an invalid transcript message");
    }
    return {
      sequence: message.committedSequence,
      event: {
        id: `snapshot:${snapshot.historyEpoch}:${message.messageId}`,
        type: message.role === "user" ? "user_message" : "agent_message",
        payload: { message: message.text },
      } satisfies JsonObject,
    };
  });
  events.sort((left, right) => left.sequence - right.sequence);
  const transcript: JsonObject[] = events.map((entry) => entry.event);
  if (snapshot.activeTurn !== undefined) {
    const firstActiveMessage = snapshot.messages.find((message) =>
      message.turnId === snapshot.activeTurn?.turnId,
    );
    const activeIndex = firstActiveMessage === undefined ? -1 : transcript.findIndex((event) =>
      event.id === `snapshot:${snapshot.historyEpoch}:${firstActiveMessage.messageId}`,
    );
    transcript.splice(activeIndex < 0 ? transcript.length : activeIndex, 0, {
      id: `snapshot:active:${snapshot.activeTurn.turnId}`,
      type: "turn_started",
      payload: { turnId: snapshot.activeTurn.turnId },
    });
  }
  return transcript;
}

export function daemonTranscriptSnapshotCoversEvent(
  snapshot: SessionTranscriptV2Result,
  event: JsonObject,
  transcriptEvent: JsonObject,
): boolean {
  if (
    transcriptEvent.type === "run_runtime_settings_changed" ||
    transcriptEvent.type === "runtime_settings_authority_gap"
  ) return false;
  const params = event.params;
  if (!isRecord(params)) return false;
  if (params.runId !== undefined && params.runId !== snapshot.runId) return false;
  const sequence = params.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence)) return false;
  if (sequence > snapshot.asOfSequence) return false;
  const payload = transcriptEvent.payload;
  const turnId = params.turnId ?? (
    isRecord(payload) ? payload.turnId : undefined
  );
  if (snapshot.activeTurn === undefined || turnId !== snapshot.activeTurn.turnId) {
    return true;
  }
  if (transcriptEvent.type === "turn_started" || transcriptEvent.type === "turn_start") {
    return true;
  }
  if (
    transcriptEvent.type === "user_message" ||
    transcriptEvent.type === "agent_message" ||
    transcriptEvent.type === "agent_message_delta"
  ) {
    return snapshot.messages.some((message) =>
      message.turnId === turnId && message.committedSequence >= sequence,
    );
  }
  return false;
}
