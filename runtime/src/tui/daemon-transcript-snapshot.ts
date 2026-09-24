import { createHash } from "node:crypto";
import type {
  JsonObject,
  SessionArtifactReadParams,
  SessionArtifactReadResult,
  SessionTranscriptV2Result,
} from "../app-server/protocol/index.js";
import { isRecord } from "../utils/record.js";
import { classifyTurnTerminal } from "../contracts/turn-terminal.js";
import { isAdmissionUsageSummary } from "../session/usage-summary.js";

/** Resolve text references before the adapter can mark a replay as covered. */
export async function resolveDaemonTranscriptTextArtifacts(
  snapshot: SessionTranscriptV2Result,
  read: (params: SessionArtifactReadParams) => Promise<SessionArtifactReadResult>,
): Promise<SessionTranscriptV2Result> {
  const messages = await Promise.all(snapshot.messages.map(async (message) => {
    const artifact = message.textArtifact;
    if (artifact === undefined) return message;
    if (artifact.mimeType !== "text/plain" || artifact.id !== artifact.digest ||
      !/^[a-f0-9]{64}$/u.test(artifact.id) || !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 || artifact.size > 32 * 1024 * 1024) {
      throw new Error("Daemon returned an invalid transcript text artifact");
    }
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await read({ sessionId: snapshot.sessionId, id: artifact.id, offset, length: 512 * 1024 });
      if (chunk.sessionId !== snapshot.sessionId || chunk.id !== artifact.id || chunk.encoding !== "base64" ||
        chunk.size !== artifact.size || chunk.offset !== offset || typeof chunk.data !== "string") {
        throw new Error("Daemon returned an invalid transcript text chunk");
      }
      const bytes = Buffer.from(chunk.data, "base64");
      if (bytes.length > 512 * 1024 || offset + bytes.length > artifact.size ||
        (chunk.nextOffset !== null && (bytes.length === 0 || chunk.nextOffset !== offset + bytes.length)) ||
        (chunk.nextOffset === null && offset + bytes.length !== artifact.size)) {
        throw new Error("Daemon returned an invalid transcript text range");
      }
      chunks.push(bytes);
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    const full = Buffer.concat(chunks);
    if (createHash("sha256").update(full).digest("hex") !== artifact.digest) {
      throw new Error("Daemon returned a transcript text digest mismatch");
    }
    const { textArtifact: _textArtifact, ...rest } = message;
    return { ...rest, text: full.toString("utf8") };
  }));
  return { ...snapshot, messages };
}

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
    if (message.textArtifact !== undefined) {
      throw new Error("Daemon returned an unresolved text artifact");
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
    // A denied call is named by the transcript's own assistant text in the
    // TUI; the notice exists for clients that render the denial as a row.
    if (notice.type === "approval_denied") continue;
    if (
      typeof notice.eventId !== "string" || notice.eventId.length === 0 ||
      !Number.isSafeInteger(notice.committedSequence) ||
      notice.committedSequence < 0 || notice.committedSequence > snapshot.asOfSequence ||
      !isRecord(notice.payload) ||
      (notice.type !== "token_count" && notice.type !== "session_usage" && notice.type !== "turn_failed" && notice.type !== "turn_aborted" && notice.type !== "tool_call_completed") ||
      (notice.type === "session_usage" && (
        !isAdmissionUsageSummary(notice.payload) || notice.payload.runId !== snapshot.runId
      )) ||
      (notice.type === "tool_call_completed" && (
        typeof notice.payload.callId !== "string" ||
        !Array.isArray(notice.payload.displayAttachments) ||
        notice.payload.displayAttachments.length === 0
      )) ||
      (notice.type !== "token_count" && notice.type !== "session_usage" && notice.type !== "tool_call_completed" && classifyTurnTerminal(notice) === undefined)
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
  if (snapshot.truncated === true) transcript.unshift({
    id: `snapshot:${snapshot.historyEpoch}:truncated`,
    type: "warning",
    payload: { cause: "transcript_truncated", message: "Earlier transcript entries were omitted from this snapshot." },
  });
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
    transcriptEvent.type === "token_count" || transcriptEvent.type === "session_usage" || transcriptEvent.type === "turn_failed" ||
    transcriptEvent.type === "turn_aborted" || transcriptEvent.type === "error"
  ) {
    if (sequence !== undefined && (
      typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0 ||
      sequence > snapshot.asOfSequence
    )) return false;
    if (transcriptEvent.type === "session_usage") {
      const summary = transcriptEvent.payload;
      if (!isAdmissionUsageSummary(summary) || summary.runId !== snapshot.runId) return false;
      return snapshot.events?.some((notice) =>
        notice.type === "session_usage" && isAdmissionUsageSummary(notice.payload) &&
        notice.payload.runId === summary.runId && notice.payload.sequence >= summary.sequence,
      ) ?? false;
    }
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
