import { describe, expect, it } from "vitest";
import type { JsonObject, SessionTranscriptV2Result } from "../../src/app-server/protocol/index.js";
import {
  daemonTranscriptSnapshotCoversEvent,
  daemonTranscriptSnapshotEvents,
} from "../../src/tui/daemon-transcript-snapshot.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

function snapshot(overrides: Partial<SessionTranscriptV2Result> = {}): SessionTranscriptV2Result {
  return {
    schemaVersion: 2,
    sessionId: "session_1",
    runId: "run_1",
    historyEpoch: "epoch_1",
    asOfSequence: 12,
    messages: [
      { messageId: "user_1", commitEventId: "event:1", role: "user", text: "Build notes", turnId: "turn_1", committedSequence: 1 },
      { messageId: "assistant_1", commitEventId: "event:10", role: "assistant", text: "Notes are ready", turnId: "turn_1", committedSequence: 10 },
    ],
    ...overrides,
  };
}

function notification(sequence: number, type: string, turnId = "turn_1"): JsonObject {
  return {
    method: "event.session_event",
    params: {
      sessionId: "session_1",
      runId: "run_1",
      sequence,
      turnId,
      event: { type, payload: { turnId } },
    },
  };
}

function covers(state: SessionTranscriptV2Result, sequence: number, type: string, turnId?: string): boolean {
  return daemonTranscriptSnapshotCoversEvent(state, notification(sequence, type, turnId), {
    type,
    payload: { turnId: turnId ?? "turn_1" },
  });
}

describe("daemon transcript snapshot", () => {
  it("restores visible messages without leaving an idle session streaming", () => {
    const events = daemonTranscriptSnapshotEvents(snapshot(), "session_1");
    const transcript = adaptTranscriptEvents(events);
    expect(transcript.messages).toHaveLength(2);
    expect(JSON.stringify(transcript.messages)).toContain("Build notes");
    expect(JSON.stringify(transcript.messages)).toContain("Notes are ready");
    expect(transcript.isStreaming).toBe(false);
  });

  it("does not collapse migrated messages that share a sequence", () => {
    const state = snapshot();
    const events = daemonTranscriptSnapshotEvents({
      ...state,
      messages: state.messages.map((message) => ({ ...message, committedSequence: 0 })),
    }, "session_1");
    expect(adaptTranscriptEvents(events).messages).toHaveLength(2);
  });

  it("rejects an invalid or cross-session snapshot", () => {
    expect(() => daemonTranscriptSnapshotEvents(snapshot(), "other")).toThrow(/invalid transcript snapshot/u);
    expect(() => daemonTranscriptSnapshotEvents(snapshot({ asOfSequence: -1 }), "session_1")).toThrow();
    expect(() => daemonTranscriptSnapshotEvents(snapshot({ messages: [{ role: "tool" } as never] }), "session_1")).toThrow(/invalid transcript message/u);
  });

  it("drops covered replay messages and closed lifecycle events, not newer events", () => {
    for (const type of ["user_message", "agent_message", "agent_message_delta", "turn_started", "turn_complete", "request_permissions"]) {
      expect(covers(snapshot(), 10, type)).toBe(true);
      expect(covers(snapshot(), 13, type)).toBe(false);
    }
  });

  it("never drops runtime-settings authority events", () => {
    expect(covers(snapshot(), 2, "run_runtime_settings_changed")).toBe(false);
    expect(covers(snapshot(), 2, "runtime_settings_authority_gap")).toBe(false);
  });

  it("keeps active tools, approvals, and uncommitted deltas while deduplicating committed text", () => {
    const active = snapshot({ activeTurn: { turnId: "turn_1" } });
    expect(adaptTranscriptEvents(daemonTranscriptSnapshotEvents(active, "session_1")).isStreaming).toBe(true);
    expect(covers(active, 1, "user_message")).toBe(true);
    expect(covers(active, 2, "turn_started")).toBe(true);
    expect(covers(active, 9, "agent_message_delta")).toBe(true);
    expect(covers(active, 10, "agent_message")).toBe(true);
    expect(covers(active, 11, "agent_message_delta")).toBe(false);
    expect(covers(active, 11, "request_permissions")).toBe(false);
    expect(covers(active, 11, "tool_call_started")).toBe(false);
  });

  it("keeps unsequenced notifications and events from another run", () => {
    expect(daemonTranscriptSnapshotCoversEvent(snapshot(), {}, { type: "warning" })).toBe(false);
    expect(daemonTranscriptSnapshotCoversEvent(snapshot(), {
      params: { runId: "other", sequence: 1 },
    }, { type: "user_message" })).toBe(false);
  });

  it("does not repeat an active turn answer when its terminal arrives after attach", () => {
    const events = daemonTranscriptSnapshotEvents(snapshot({ activeTurn: { turnId: "turn_1" } }), "session_1");
    const transcript = adaptTranscriptEvents([
      ...events,
      { id: "event:13", type: "turn_complete", payload: { turnId: "turn_1", lastAgentMessage: "Notes are ready" } },
    ]);
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.isStreaming).toBe(false);
  });
});
