import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { daemonEventFromUnboundSessionEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner/journal-reconstruction.js";
import { buildCanonicalRunReplay } from "../../src/app-server/run-journal-replay.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import type { AdmissionUsageSummary } from "../../src/budget/admission-types.js";
import type { EventMsg } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { isCanonicalEventPayload } from "../../src/state/recovery-journal-schema.js";
import { daemonTranscriptSnapshotCoversEvent, daemonTranscriptSnapshotEvents } from "../../src/tui/daemon-transcript-snapshot.js";

function usage(sequence = 10, runId = "parent"): AdmissionUsageSummary {
  return {
    runId, sequence, costUsd: 1.25, heldCostUsd: 0.5,
    inputTokens: 100, outputTokens: 20, totalTokens: 120,
    modelCalls: 2, hasUnknownCost: true, models: [], agents: [],
  };
}

function event(sequence: number, msg: EventMsg): Extract<RolloutItem, { type: "event_msg" }> {
  return {
    type: "event_msg",
    payload: { id: `event:${sequence}`, eventId: `event:${sequence}`, seq: sequence, msg },
  };
}

function notification(item: Extract<RolloutItem, { type: "event_msg" }>): JsonObject {
  return { params: { runId: "parent", sequence: item.payload.seq, eventId: item.payload.eventId } };
}

function transcript(item: Extract<RolloutItem, { type: "event_msg" }>): JsonObject {
  return { ...item.payload.msg, eventId: item.payload.eventId } as JsonObject;
}

describe("canonical session usage observer integration", () => {
  it("accepts zero-sequence initial snapshots and finite cumulative totals", () => {
    expect(isCanonicalEventPayload("session_usage", usage(0))).toBe(true);
    expect(isCanonicalEventPayload("session_usage", usage())).toBe(true);
  });

  it.each([
    { sequence: -1 }, { sequence: 1.5 }, { costUsd: -1 }, { heldCostUsd: Infinity },
    { totalTokens: 1.5 }, { inputTokens: -1 }, { hasUnknownCost: "false" },
    { models: [{ model: "invalid" }] }, { agents: [{ runId: "invalid" }] }, { runId: "" },
  ])("rejects malformed usage payloads %j", (invalid) => {
    expect(isCanonicalEventPayload("session_usage", { ...usage(), ...invalid })).toBe(false);
  });

  it("forwards the original live canonical event identity", () => {
    const item = event(1, { type: "session_usage", payload: usage() });
    expect(daemonEventFromUnboundSessionEvent(item.payload)).toMatchObject({
      id: "event:1", eventId: "event:1", sequence: 1,
      type: "session_usage", payload: usage(),
    });
    expect(daemonEventFromUnboundSessionEvent({ msg: item.payload.msg })).toBeNull();
  });

  it("restores only the newest matching run snapshot across history resets", () => {
    const old = event(1, { type: "session_usage", payload: usage(10) });
    const current = event(2, { type: "session_usage", payload: usage(20) });
    const items: RolloutItem[] = [
      old, current,
      event(3, { type: "session_usage", payload: usage(30, "compact-child") }),
      event(4, { type: "session_usage", payload: usage(15) }),
      event(5, { type: "history_cleared", payload: {} }),
    ];
    const snapshot = sessionTranscriptV2FromRollout(items, "session", "parent");
    expect(snapshot.events?.filter((entry) => entry.type === "session_usage")).toEqual([
      { eventId: "event:2", committedSequence: 2, type: "session_usage", payload: usage(20) },
    ]);
    const restored = daemonTranscriptSnapshotEvents(snapshot, "session");
    expect(restored.filter((entry) => entry.type === "session_usage")).toHaveLength(1);
    expect(restored[0]?.payload).toEqual(usage(20));
    for (const item of [old, current]) {
      expect(daemonTranscriptSnapshotCoversEvent(snapshot, notification(item), transcript(item))).toBe(true);
    }
    const later = event(6, { type: "session_usage", payload: usage(21) });
    expect(daemonTranscriptSnapshotCoversEvent(snapshot, notification(later), transcript(later))).toBe(false);
    expect(daemonTranscriptSnapshotCoversEvent({ ...snapshot, events: undefined }, notification(old), transcript(old))).toBe(false);
  });

  it.each([usage(3, "another-run"), { ...usage(), heldCostUsd: -1 }])(
    "rejects mismatched or malformed usage in daemon snapshots",
    (payload) => {
      const snapshot = sessionTranscriptV2FromRollout([], "session", "parent");
      expect(() => daemonTranscriptSnapshotEvents({
        ...snapshot,
        asOfSequence: 1,
        events: [{ eventId: "usage", committedSequence: 1, type: "session_usage", payload }],
      }, "session")).toThrow(/invalid transcript notice/);
    },
  );

  it("classifies canonical usage replay as budget evidence", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE threads (thread_id TEXT PRIMARY KEY, rollout_path TEXT, archived_rollout_path TEXT);
        CREATE TABLE thread_rollout_items (
          id INTEGER PRIMARY KEY, thread_id TEXT, source_path TEXT, item_index INTEGER,
          item_type TEXT, event_id TEXT, event_seq INTEGER, payload_json TEXT
        );
        INSERT INTO threads VALUES ('parent', '/rollout/parent.jsonl', NULL);
      `);
      const item = event(1, { type: "session_usage", payload: usage() });
      database.prepare("INSERT INTO thread_rollout_items VALUES (1, 'parent', '/rollout/parent.jsonl', 1, 'event_msg', 'event:1', 1, ?)")
        .run(JSON.stringify(item.payload));
      const replay = buildCanonicalRunReplay(database, {
        projectDir: "/project", stateDbPath: "/project/state.sqlite", logsDbPath: "/project/logs.sqlite",
      }, "parent", 0, 10);
      expect(replay.events).toMatchObject([{ category: "budget", kind: "session_usage", payload: usage() }]);
    } finally {
      database.close();
    }
  });
});
