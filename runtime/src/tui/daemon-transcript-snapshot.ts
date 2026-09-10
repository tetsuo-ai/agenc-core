import type {
  JsonObject,
  SessionTranscriptV2Result,
} from "../app-server/protocol/index.js";
import { isRecord } from "../utils/record.js";
import { classifyTurnTerminal } from "../contracts/turn-terminal.js";

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
  const events: { readonly sequence: number; readonly event: JsonObject }[] = snapshot.messages.map((message) => {
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
  if (snapshot.events !== undefined && !Array.isArray(snapshot.events)) {
    throw new Error("Daemon returned invalid transcript notices");
  }
  const seenEventIds = new Set<string>();
  for (const notice of snapshot.events ?? []) {
    if (
      typeof notice.eventId !== "string" || notice.eventId.length === 0 ||
      !Number.isSafeInteger(notice.committedSequence) ||
      notice.committedSequence < 0 || notice.committedSequence > snapshot.asOfSequence ||
      !isRecord(notice.payload) ||
      (notice.type !== "token_count" && notice.type !== "turn_failed" && notice.type !== "turn_aborted") ||
      (notice.type !== "token_count" && classifyTurnTerminal(notice) === undefined)
    ) {
      throw new Error("Daemon returned an invalid transcript notice");
    }
    if (seenEventIds.has(notice.eventId)) continue;
    seenEventIds.add(notice.eventId);
    events.push({
      sequence: notice.committedSequence,
      event: {
        id: `snapshot:${snapshot.historyEpoch}:event:${notice.eventId}`,
        eventId: notice.eventId,
        type: notice.type,
        payload: notice.payload,
      },
    });
  }
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
  if (
    transcriptEvent.type === "token_count" || transcriptEvent.type === "turn_failed" ||
    transcriptEvent.type === "turn_aborted" || transcriptEvent.type === "error"
  ) {
    if (sequence !== undefined && (
      typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0 ||
      sequence > snapshot.asOfSequence
    )) return false;
    const eventId = params.eventId ?? transcriptEvent.eventId;
    if (snapshot.events?.some((notice) =>
      (typeof eventId === "string" && notice.eventId === eventId) ||
      (typeof sequence === "number" && sequence > 0 && notice.committedSequence === sequence),
    )) return true;
    if (snapshot.events === undefined || typeof sequence !== "number") return false;
    const terminal = typeof transcriptEvent.type === "string"
      ? classifyTurnTerminal({ type: transcriptEvent.type, payload: transcriptEvent.payload }, { legacyJournal: true })
      : undefined;
    return terminal !== undefined && (
      snapshot.activeTurn === undefined || terminal.turnId !== snapshot.activeTurn.turnId
    );
  }
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
