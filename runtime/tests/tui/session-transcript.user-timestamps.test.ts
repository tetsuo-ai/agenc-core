import { describe, expect, it, vi } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import { daemonTranscriptSnapshotEvents } from "../../src/tui/daemon-transcript-snapshot.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";

describe("rewind prompt timestamps", () => {
  const acceptedAt = "2026-10-19T09:00:00.000Z";
  const startedAt = Date.parse(acceptedAt) + 20;
  it.each([true, false])("preserves durable age through reconnect (acceptedAt=%s)", hasAcceptedAt => {
    const items: RolloutItem[] = [
      { type: "event_msg", payload: { id: "u", seq: 1, msg: { type: "user_message", payload: {
        message: "Rename photos safely", ...(hasAcceptedAt ? { acceptedAt } : {}),
      } } } },
      { type: "event_msg", payload: { id: "t", seq: 2, msg: { type: "turn_started", payload: { turnId: "turn", startedAt } } } },
    ];
    const expected = hasAcceptedAt ? acceptedAt : new Date(startedAt).toISOString();
    const snapshot = sessionTranscriptV2FromRollout(items, "session", "run");
    const events = daemonTranscriptSnapshotEvents(snapshot, "session");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(startedAt + 180_000);
      expect(adaptTranscriptEvents(events).messages[0].timestamp).toBe(expected);
      vi.advanceTimersByTime(60_000);
      expect(adaptTranscriptEvents(events).messages[0].timestamp).toBe(expected);
      expect(adaptTranscriptEvents(items.map(item => (item as { payload: unknown }).payload) as never).messages[0].timestamp).toBe(expected);
    } finally { vi.useRealTimers(); }
  });

  it("does not invent an age for migrated prompts without timing", () => {
    const message = adaptTranscriptEvents([{ type: "user_message", payload: { message: "Old prompt" } }]).messages[0];
    expect(message.timestamp).toBe("");
  });
});
