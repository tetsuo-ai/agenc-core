import { describe, expect, it } from "vitest";
import { sessionTranscriptV2FromRollout } from "../../src/app-server/background-agent-runner.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import type { EventMsg } from "../../src/session/event-log.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import {
  daemonTranscriptSnapshotCoversEvent,
  daemonTranscriptSnapshotEvents,
} from "../../src/tui/daemon-transcript-snapshot.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

function event(sequence: number | undefined, eventId: string, msg: EventMsg): RolloutItem {
  return { type: "event_msg", payload: { id: eventId, eventId, seq: sequence, msg } };
}

function transcriptEvent(item: RolloutItem): JsonObject {
  if (item.type !== "event_msg") throw new Error("Expected a public event");
  return { id: item.payload.id, ...item.payload.msg } as JsonObject;
}

function notification(item: RolloutItem): JsonObject {
  if (item.type !== "event_msg") throw new Error("Expected a public event");
  return {
    method: "event.session_event",
    params: {
      sessionId: "session-1",
      runId: "run-1",
      eventId: item.payload.eventId,
      sequence: item.payload.seq,
      event: transcriptEvent(item),
    },
  };
}

function failedTurn(): RolloutItem[] {
  return [
    event(1, "user", { type: "user_message", payload: { message: "Finish the tests" } }),
    event(2, "start", { type: "turn_started", payload: { turnId: "turn-1" } }),
    event(3, "usage-1", { type: "token_count", payload: {
      promptTokens: 10_000, completionTokens: 700, cachedInputTokens: 8_000,
      reasoningOutputTokens: 100, webSearchRequests: 2, model: "grok-4.5", provider: "grok",
    } }),
    event(4, "answer", { type: "agent_message", payload: { message: "I will run the tests now." } }),
    event(5, "usage-2", { type: "token_count", payload: {
      promptTokens: 2_000, completionTokens: 250, cacheCreationInputTokens: 300,
      model: "claude-sonnet-4-20250514", provider: "anthropic",
    } }),
    event(6, "failure", { type: "turn_failed", payload: {
      turnId: "turn-1", code: "max_cost_exceeded", message: "Stopped: session cost limit reached.",
    } }),
  ];
}

describe("durable resume notices", () => {
  it("restores failure explanations and exact per-sample spend through the production adapter", () => {
    const items = failedTurn();
    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1");
    const resumed = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(snapshot, "session-1"));
    const live = adaptTranscriptEvents(items.map(transcriptEvent));
    expect(JSON.stringify(resumed.messages)).toContain("Stopped: session cost limit reached.");
    expect(snapshot.events?.find((entry) => entry.eventId === "failure")).toMatchObject({
      type: "turn_failed", payload: { code: "max_cost_exceeded" }, committedSequence: 6,
    });
    expect(resumed.sessionCostUsd).toBeGreaterThan(0);
    expect(resumed.sessionCostUsd).toBe(live.sessionCostUsd);
    expect(resumed.latestUsage).toEqual(live.latestUsage);
    expect(resumed.isStreaming).toBe(false);
    const replay = items.filter((item) => !daemonTranscriptSnapshotCoversEvent(
      snapshot, notification(item), transcriptEvent(item),
    ));
    expect(replay).toEqual([]);
    const twice = adaptTranscriptEvents([
      ...daemonTranscriptSnapshotEvents(snapshot, "session-1"), ...replay.map(transcriptEvent),
    ]);
    expect(twice.sessionCostUsd).toBe(live.sessionCostUsd);
    expect(JSON.stringify(twice.messages).match(/Stopped: session cost limit reached\./gu)).toHaveLength(1);
  });

  it("retains active usage once and admits later samples and terminals", () => {
    const items = failedTurn().slice(0, 5);
    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1", {
      turnId: "turn-1", clientMessageId: "client-1",
    });
    const later = event(7, "usage-later", { type: "token_count", payload: {
      promptTokens: 5_000, completionTokens: 1_000, model: "grok-4.5", provider: "grok",
    } });
    const terminal = event(8, "failure-later", { type: "turn_failed", payload: {
      turnId: "turn-1", code: "provider_error", message: "Provider stopped responding.",
    } });
    for (const item of [items[2]!, items[4]!]) {
      expect(daemonTranscriptSnapshotCoversEvent(snapshot, notification(item), transcriptEvent(item))).toBe(true);
    }
    for (const item of [later, terminal]) {
      expect(daemonTranscriptSnapshotCoversEvent(snapshot, notification(item), transcriptEvent(item))).toBe(false);
    }
    const resumed = adaptTranscriptEvents([
      ...daemonTranscriptSnapshotEvents(snapshot, "session-1"), transcriptEvent(later), transcriptEvent(terminal),
    ]);
    expect(resumed.sessionCostUsd).toBe(adaptTranscriptEvents([...items, later].map(transcriptEvent)).sessionCostUsd);
    expect(JSON.stringify(resumed.messages)).toContain("Provider stopped responding.");
    expect(resumed.isStreaming).toBe(false);
  });

  it("preserves mixed unsequenced legacy notices and canonical turns without double counting", () => {
    const legacyUsage = event(undefined, "legacy-usage", { type: "token_count", payload: {
      promptTokens: 1_000, completionTokens: 20, model: "grok-4.5", provider: "grok",
    } });
    const legacyFailure = event(undefined, "legacy-failure", { type: "error", payload: {
      turnId: "legacy-turn", cause: "background_agent_error", message: "Legacy permission denied.",
    } });
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "Legacy request" } },
      { type: "response_item", payload: { role: "assistant", content: "Legacy partial answer" } },
      event(undefined, "legacy-start", { type: "turn_started", payload: { turnId: "legacy-turn" } }),
      legacyUsage, legacyUsage, legacyFailure, ...failedTurn(),
    ];
    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1");
    const resumed = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(snapshot, "session-1"));
    expect(JSON.stringify(resumed.messages)).toContain("Legacy permission denied.");
    expect(JSON.stringify(resumed.messages)).toContain("Stopped: session cost limit reached.");
    expect(resumed.sessionCostUsd).toBe(adaptTranscriptEvents([legacyUsage, ...failedTurn()].map(transcriptEvent)).sessionCostUsd);
    for (const item of [legacyUsage, legacyFailure]) {
      expect(daemonTranscriptSnapshotCoversEvent(snapshot, notification(item), transcriptEvent(item))).toBe(true);
    }
  });

  it("does not suppress notices absent from older daemon snapshots", () => {
    const snapshot = sessionTranscriptV2FromRollout(failedTurn(), "session-1", "run-1");
    const older = { ...snapshot, events: undefined };
    for (const item of failedTurn().filter((entry) => entry.type === "event_msg" &&
      ["token_count", "turn_failed"].includes(entry.payload.msg.type))) {
      expect(daemonTranscriptSnapshotCoversEvent(older, notification(item), transcriptEvent(item))).toBe(false);
    }
  });

  it("retains session spend across a history reset without resurrecting cleared failure text", () => {
    const items = [
      ...failedTurn(),
      event(7, "clear", { type: "history_cleared", payload: {} }),
      event(8, "new-user", { type: "user_message", payload: { message: "A fresh request" } }),
    ];
    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1");
    const resumed = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(snapshot, "session-1"));
    expect(resumed.sessionCostUsd).toBe(adaptTranscriptEvents(items.map(transcriptEvent)).sessionCostUsd);
    expect(resumed.sessionCostUsd).toBeGreaterThan(0);
    expect(JSON.stringify(resumed.messages)).not.toContain("Stopped: session cost limit reached.");
    expect(JSON.stringify(resumed.messages)).toContain("A fresh request");
    expect(daemonTranscriptSnapshotCoversEvent(snapshot, notification(items[5]!), transcriptEvent(items[5]!))).toBe(true);
  });

  it("restores abort reasons and rejects stale or duplicate failure identities", () => {
    const items = [
      ...failedTurn().slice(0, 5),
      event(6, "stale", { type: "turn_failed", payload: {
        turnId: "old-turn", code: "provider_error", message: "Stale failure",
      } }),
      event(7, "abort", { type: "turn_aborted", payload: { turnId: "turn-1", reason: "Permission denied" } }),
      event(8, "duplicate", { type: "turn_failed", payload: {
        turnId: "turn-1", code: "provider_error", message: "Duplicate failure",
      } }),
    ];
    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1");
    const resumed = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(snapshot, "session-1"));
    const text = JSON.stringify(resumed.messages);
    expect(text).toContain("Turn aborted: Permission denied");
    expect(text).not.toContain("Stale failure");
    expect(text).not.toContain("Duplicate failure");
    expect(resumed.isStreaming).toBe(false);
    for (const item of items.slice(5)) {
      expect(daemonTranscriptSnapshotCoversEvent(snapshot, notification(item), transcriptEvent(item))).toBe(true);
    }
  });

  it("does not collapse legacy usage rows whose subscription envelope IDs were reused", () => {
    const items: RolloutItem[] = [100, 200].map((promptTokens) => ({
      type: "event_msg",
      payload: { id: "reused-subscription", msg: { type: "token_count", payload: {
        promptTokens, completionTokens: 20, model: "grok-4.5", provider: "grok",
      } } },
    }));
    const snapshot = sessionTranscriptV2FromRollout(items, "session-1", "run-1");
    const resumed = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(snapshot, "session-1"));
    expect(snapshot.events).toHaveLength(2);
    expect(resumed.sessionCostUsd).toBe(items.reduce((cost, item) =>
      cost + adaptTranscriptEvents([transcriptEvent(item)]).sessionCostUsd, 0));
  });

  it("rejects malformed notices and deduplicates repeated snapshot event IDs", () => {
    const snapshot = sessionTranscriptV2FromRollout(failedTurn(), "session-1", "run-1");
    const notice = snapshot.events![0]!;
    expect(() => daemonTranscriptSnapshotEvents({ ...snapshot, events: [{
      ...notice, committedSequence: snapshot.asOfSequence + 1,
    }] }, "session-1")).toThrow(/invalid transcript notice/u);
    expect(() => daemonTranscriptSnapshotEvents({ ...snapshot, events: [{
      ...notice, type: "request_permissions" as never,
    }] }, "session-1")).toThrow(/invalid transcript notice/u);
    const once = adaptTranscriptEvents(daemonTranscriptSnapshotEvents(snapshot, "session-1"));
    const repeated = adaptTranscriptEvents(daemonTranscriptSnapshotEvents({
      ...snapshot, events: [...snapshot.events!, notice],
    }, "session-1"));
    expect(repeated.sessionCostUsd).toBe(once.sessionCostUsd);
  });
});
