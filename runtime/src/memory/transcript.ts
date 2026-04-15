import type {
  MemoryBackend,
  TranscriptCapableMemoryBackend,
  TranscriptEvent,
  TranscriptEventInput,
  TranscriptLoadOptions,
  TranscriptEventVersion,
} from "./types.js";
import { TRANSCRIPT_EVENT_VERSION } from "./types.js";

export function isTranscriptCapableMemoryBackend(
  backend: MemoryBackend,
): backend is MemoryBackend & TranscriptCapableMemoryBackend {
  const candidate = backend as Partial<TranscriptCapableMemoryBackend>;
  return (
    typeof candidate.appendTranscript === "function" &&
    typeof candidate.loadTranscript === "function" &&
    typeof candidate.deleteTranscript === "function" &&
    typeof candidate.listTranscriptStreams === "function"
  );
}

export function materializeTranscriptEvent(
  streamId: string,
  seq: number,
  input: TranscriptEventInput,
): TranscriptEvent {
  return {
    version: (input.version ?? TRANSCRIPT_EVENT_VERSION) as TranscriptEventVersion,
    streamId,
    seq,
    eventId: input.eventId,
    kind: input.kind,
    payload: input.payload as TranscriptEvent["payload"],
    timestamp: input.timestamp ?? Date.now(),
    metadata: input.metadata,
    dedupeKey: input.dedupeKey,
  };
}

export function applyTranscriptLoadOptions(
  events: readonly TranscriptEvent[],
  options: TranscriptLoadOptions = {},
): TranscriptEvent[] {
  const filtered = events.filter((event) =>
    options.afterSeq === undefined ? true : event.seq > options.afterSeq,
  );
  const order = options.order ?? "asc";
  const ordered =
    order === "desc" ? [...filtered].sort((a, b) => b.seq - a.seq) : filtered;
  if (options.limit !== undefined && options.limit > 0) {
    return ordered.slice(0, options.limit);
  }
  return ordered;
}
