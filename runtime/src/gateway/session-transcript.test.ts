import { describe, expect, it } from "vitest";

import { InMemoryBackend } from "../memory/in-memory/backend.js";
import {
  appendTranscriptBatch,
  createTranscriptHistorySnapshotEvent,
  createTranscriptMessageEvent,
  createTranscriptMetadataProjectionEvent,
  forkTranscript,
  historyFromTranscript,
  loadTranscript,
  metadataFromTranscript,
  recoverTranscriptHistory,
  recoverTranscriptState,
} from "./session-transcript.js";
import {
  SESSION_SHELL_PROFILE_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
} from "./session.js";

describe("session transcript adapter", () => {
  it("round-trips transcript events through transcript-capable backends", async () => {
    const backend = new InMemoryBackend();

    await appendTranscriptBatch(backend, "session-1", [
      createTranscriptMessageEvent({
        surface: "webchat",
        message: { role: "user", content: "hello" },
        dedupeKey: "user-1",
      }),
      createTranscriptMetadataProjectionEvent({
        surface: "webchat",
        key: "session.metadata",
        value: { shellProfile: "general" },
        dedupeKey: "meta-1",
      }),
      createTranscriptHistorySnapshotEvent({
        surface: "webchat",
        history: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        reason: "compaction",
        dedupeKey: "snapshot-1",
      }),
      createTranscriptMessageEvent({
        surface: "webchat",
        message: { role: "assistant", content: "post-compact" },
        dedupeKey: "assistant-1",
      }),
    ]);

    const transcript = await loadTranscript(backend, "session-1");
    expect(transcript).toBeDefined();
    expect(transcript?.events.map((event) => event.kind)).toEqual([
      "message",
      "metadata_projection",
      "history_snapshot",
      "message",
    ]);
    expect(historyFromTranscript(transcript)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "assistant", content: "post-compact" },
    ]);
  });

  it("forks transcript streams without reusing event ids", async () => {
    const backend = new InMemoryBackend();

    await appendTranscriptBatch(backend, "source", [
      createTranscriptMessageEvent({
        surface: "text",
        message: { role: "user", content: "fork me" },
      }),
    ]);

    expect(await forkTranscript(backend, "source", "target")).toBe(true);

    const source = await loadTranscript(backend, "source");
    const target = await loadTranscript(backend, "target");
    expect(historyFromTranscript(target)).toEqual(historyFromTranscript(source));
    expect(target?.events[0]?.eventId).not.toBe(source?.events[0]?.eventId);
  });

  it("replays only the latest whitelisted session metadata projection", async () => {
    const backend = new InMemoryBackend();

    await appendTranscriptBatch(backend, "session-meta", [
      createTranscriptMetadataProjectionEvent({
        surface: "webchat",
        key: "session.metadata",
        value: {
          [SESSION_SHELL_PROFILE_METADATA_KEY]: "general",
          ignored: "value",
        },
      }),
      createTranscriptMetadataProjectionEvent({
        surface: "webchat",
        key: "session.metadata",
        value: {
          [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
            previousResponseId: "resp-1",
          },
        },
      }),
    ]);

    const transcript = await loadTranscript(backend, "session-meta");
    expect(metadataFromTranscript(transcript)).toEqual({
      [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
        previousResponseId: "resp-1",
      },
    });
  });

  it("detects interrupted transcript turns and can inject a continuation prompt", async () => {
    const backend = new InMemoryBackend();

    await appendTranscriptBatch(backend, "session-interrupted", [
      createTranscriptMessageEvent({
        surface: "webchat",
        message: { role: "user", content: "finish the previous task" },
      }),
    ]);

    const transcript = await loadTranscript(backend, "session-interrupted");
    expect(recoverTranscriptState(transcript).interruption).toMatchObject({
      kind: "interrupted_prompt",
    });
    expect(
      recoverTranscriptHistory(transcript, { injectContinuationPrompt: true }).at(-1),
    ).toEqual({
      role: "user",
      content: "Continue from where you left off.",
    });
  });
});
