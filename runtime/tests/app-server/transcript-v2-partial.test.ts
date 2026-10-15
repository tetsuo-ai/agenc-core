import { describe, expect, it } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import { daemonTranscriptSnapshotCoversEvent, daemonTranscriptSnapshotEvents } from "../../src/tui/daemon-transcript-snapshot.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import type { EventMsg } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";

const event = (seq: number, msg: EventMsg): RolloutItem => ({
  type: "event_msg", payload: { id: `event-${seq}`, eventId: `event-${seq}`, seq, msg },
});
const prefix = () => [
  event(1, { type: "user_message", payload: { message: "Tell me", messageId: "user" } }),
  event(2, { type: "turn_started", payload: { turnId: "turn" } }),
  event(3, { type: "agent_message_delta", payload: { delta: "Opening text. " } }),
  event(4, { type: "agent_message_delta", payload: { delta: "More text." } }),
];
const snapshot = (items = prefix(), active = true) => sessionTranscriptV2FromRollout(
  items, "session", "run", active ? { turnId: "turn" } : undefined,
);

describe("partial assistant transcript recovery", () => {
  it("restores the live prefix, suppresses covered deltas, and appends the continuation exactly once", () => {
    const state = snapshot();
    const events = daemonTranscriptSnapshotEvents(state, "session");
    const restored = adaptTranscriptEvents(events);
    expect(restored.streamingText).toBe("Opening text. More text.");
    expect(restored.isStreaming).toBe(true);
    expect(daemonTranscriptSnapshotCoversEvent(state, {
      params: { runId: "run", sequence: 4, turnId: "turn" },
    }, { type: "agent_message_delta", payload: { delta: "More text." } })).toBe(true);
    expect(daemonTranscriptSnapshotCoversEvent(state, {
      params: { runId: "run", sequence: 5, turnId: "turn" },
    }, { type: "agent_message_delta", payload: { delta: " Tail." } })).toBe(false);
    expect(adaptTranscriptEvents([...events, {
      id: "later", type: "agent_message_delta", payload: { delta: " Tail." },
    }]).streamingText).toBe("Opening text. More text. Tail.");
    const completed = adaptTranscriptEvents([...events,
      { id: "commit", type: "agent_message", payload: { message: "Opening text. More text. Tail." } },
      { id: "done", type: "turn_complete", payload: { turnId: "turn", lastAgentMessage: "Opening text. More text. Tail." } },
    ]);
    expect(completed.messages.filter(message => message.type === "assistant")).toHaveLength(1);
    expect(completed.streamingText).toBeNull();
  });

  it.each(["interrupted", "daemon_shutdown"] as const)("keeps %s partials for display and excludes them from model history", (reason) => {
    const items = [...prefix(), event(5, { type: "turn_aborted", payload: { turnId: "turn", reason } })];
    const state = snapshot(items, false);
    const display = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(state, "session"));
    expect(JSON.stringify(display.messages)).toContain("Opening text. More text.");
    expect(JSON.stringify(display.messages)).toContain("Interrupted partial answer");
    expect(display.isStreaming).toBe(false);
    expect(JSON.stringify(reconstructFromRollout(items).history)).not.toContain("Opening text");
  });

  it("marks an orphaned stream as interrupted when no runtime turn remains", () => {
    const state = snapshot(prefix(), false);
    expect(JSON.stringify(adaptTranscriptEvents(daemonTranscriptSnapshotEvents(state, "session")).messages)).toContain("Interrupted partial answer");
  });

  it("replaces the partial with the complete canonical message, including text beyond the partial cap", () => {
    const answer = "Full answer. ".repeat(10_000);
    const state = snapshot([...prefix(),
      event(5, { type: "agent_message", payload: { message: answer } }),
      event(6, { type: "turn_complete", payload: { turnId: "turn", lastAgentMessage: answer } }),
    ], false);
    expect(state.messages.map(message => message.text)).toEqual(["Tell me", answer]);
  });

  it("bounds the recovered prefix by UTF-8 bytes, explicitly marks truncation, and still covers later deltas", () => {
    const items = [...prefix(), event(5, { type: "agent_message_delta", payload: { delta: "😀".repeat(100_000) } }),
      event(6, { type: "agent_message_delta", payload: { delta: "omitted tail" } })];
    const state = snapshot(items);
    const text = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(state, "session")).streamingText!;
    expect(text.startsWith("Opening text. More text.")).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024 + 100);
    expect(text).toContain("Partial answer truncated");
    expect(text).not.toContain("�");
    expect(daemonTranscriptSnapshotCoversEvent(state, { params: { runId: "run", sequence: 6, turnId: "turn" } },
      { type: "agent_message_delta", payload: { delta: "omitted tail" } })).toBe(true);
  });

  it("keeps distinct completed segments and the interrupted final segment in order", () => {
    const state = snapshot([...prefix(),
      event(5, { type: "agent_message", payload: { message: "First segment" } }),
      event(6, { type: "agent_message_delta", payload: { delta: "Last segment" } }),
      event(7, { type: "turn_aborted", payload: { turnId: "turn", reason: "interrupted" } }),
    ], false);
    expect(state.messages.map(message => message.text)).toEqual(["Tell me", "First segment", "Last segment"]);
    const display = JSON.stringify(adaptTranscriptEvents(daemonTranscriptSnapshotEvents(state, "session")).messages);
    expect(display.indexOf("First segment")).toBeLessThan(display.indexOf("Last segment"));
  });

  it("does not carry a discarded prefix across an explicit transcript clear", () => {
    const state = snapshot([...prefix(), event(5, { type: "history_cleared", payload: { timestamp: 1 } })], false);
    expect(state.messages).toEqual([]);
  });

  it("does not advance canonical assistant identities for a shutdown partial before a checkpoint resume", () => {
    const state = snapshot([...prefix(),
      event(5, { type: "turn_aborted", payload: { turnId: "turn", reason: "daemon_shutdown" } }),
      event(6, { type: "turn_started", payload: { turnId: "turn" } }),
      event(7, { type: "agent_message", payload: { message: "Resumed response" } }),
    ]);
    const assistant = state.messages.filter(message => message.role === "assistant");
    expect(assistant).toHaveLength(2);
    expect(assistant[0].messageId).not.toBe(assistant[1].messageId);
    expect(assistant[1].messageId).toBe(snapshot([
      ...prefix().slice(0, 2), event(7, { type: "agent_message", payload: { message: "Resumed response" } }),
    ]).messages.at(-1)!.messageId);
  });
});
