import { describe, expect, it } from "vitest";
import {
  RECENT_ACTIVITIES_CAP,
  SubAgentProgressTracker,
} from "./sub-agent-progress.js";

function makeTracker(options?: ConstructorParameters<typeof SubAgentProgressTracker>[0]) {
  let clock = 1_000_000;
  const tracker = new SubAgentProgressTracker({
    emitIntervalMs: 0,
    now: () => clock,
    ...options,
  });
  return {
    tracker,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (value: number) => {
      clock = value;
    },
    get clock() {
      return clock;
    },
  };
}

describe("SubAgentProgressTracker", () => {
  it("accumulates tool rounds and reports lastToolName + recentActivities", () => {
    const h = makeTracker();
    h.tracker.attach({
      subagentSessionId: "sa-1",
      parentSessionId: "session-parent",
      parentToolCallId: "parent-call-1",
    });
    h.tracker.onToolExecuting({
      subagentSessionId: "sa-1",
      toolName: "system.readFile",
      args: { path: "/tmp/a.txt" },
    });
    h.advance(10);
    h.tracker.onToolResult({
      subagentSessionId: "sa-1",
      toolName: "system.readFile",
      isError: false,
      durationMs: 10,
    });
    h.advance(5);
    h.tracker.onToolExecuting({
      subagentSessionId: "sa-1",
      toolName: "system.bash",
      args: { command: "ls" },
    });
    h.advance(3);
    h.tracker.onToolResult({
      subagentSessionId: "sa-1",
      toolName: "system.bash",
      isError: true,
      durationMs: 3,
    });
    const snap = h.tracker.flushSnapshot("sa-1")!;
    expect(snap.toolUseCount).toBe(2);
    expect(snap.lastToolName).toBe("system.bash");
    expect(snap.recentActivities.map((a) => a.toolName)).toEqual([
      "system.readFile",
      "system.bash",
    ]);
    expect(snap.recentActivities[0]?.isError).toBe(false);
    expect(snap.recentActivities[0]?.durationMs).toBe(10);
    expect(snap.recentActivities[1]?.isError).toBe(true);
    expect(snap.lastActivity?.toolName).toBe("system.bash");
  });

  it("caps recentActivities at RECENT_ACTIVITIES_CAP", () => {
    const h = makeTracker();
    for (let i = 0; i < RECENT_ACTIVITIES_CAP + 4; i += 1) {
      h.tracker.onToolExecuting({
        subagentSessionId: "sa-cap",
        toolName: `tool-${i}`,
      });
    }
    const snap = h.tracker.flushSnapshot("sa-cap")!;
    expect(snap.toolUseCount).toBe(RECENT_ACTIVITIES_CAP + 4);
    expect(snap.recentActivities).toHaveLength(RECENT_ACTIVITIES_CAP);
    expect(snap.recentActivities[0]?.toolName).toBe("tool-4");
    expect(snap.recentActivities[RECENT_ACTIVITIES_CAP - 1]?.toolName).toBe(
      `tool-${RECENT_ACTIVITIES_CAP + 3}`,
    );
  });

  it("computes tokenCount = latestInputTokens + cumulativeOutputTokens", () => {
    const h = makeTracker();
    h.tracker.onProviderUsage({
      subagentSessionId: "sa-tok",
      inputTokens: 1_000,
      outputTokens: 50,
    });
    h.tracker.onProviderUsage({
      subagentSessionId: "sa-tok",
      inputTokens: 1_200,
      outputTokens: 30,
    });
    h.tracker.onProviderUsage({
      subagentSessionId: "sa-tok",
      inputTokens: 1_500,
      outputTokens: 40,
    });
    const snap = h.tracker.flushSnapshot("sa-tok")!;
    // latestInputTokens = 1500, cumulativeOutputTokens = 50 + 30 + 40 = 120
    expect(snap.tokenCount).toBe(1_620);
  });

  it("debounces snapshots by emitIntervalMs", () => {
    const h = makeTracker({ emitIntervalMs: 250 });
    h.tracker.onToolExecuting({
      subagentSessionId: "sa-deb",
      toolName: "a",
    });
    // First emission is due immediately (lastEmittedAt starts at 0).
    expect(h.tracker.consumeSnapshotIfDue("sa-deb")).not.toBeNull();
    h.advance(100);
    h.tracker.onToolExecuting({
      subagentSessionId: "sa-deb",
      toolName: "b",
    });
    expect(h.tracker.consumeSnapshotIfDue("sa-deb")).toBeNull();
    h.advance(200); // total 300ms since last emit
    h.tracker.onToolExecuting({
      subagentSessionId: "sa-deb",
      toolName: "c",
    });
    expect(h.tracker.consumeSnapshotIfDue("sa-deb")).not.toBeNull();
  });

  it("flushSnapshot bypasses debounce", () => {
    const h = makeTracker({ emitIntervalMs: 60_000 });
    h.tracker.onToolExecuting({ subagentSessionId: "sa-f", toolName: "x" });
    expect(h.tracker.consumeSnapshotIfDue("sa-f")).not.toBeNull();
    h.advance(10);
    expect(h.tracker.consumeSnapshotIfDue("sa-f")).toBeNull();
    expect(h.tracker.flushSnapshot("sa-f")).not.toBeNull();
  });

  it("detach releases the bucket", () => {
    const h = makeTracker();
    h.tracker.onToolExecuting({ subagentSessionId: "sa-d", toolName: "x" });
    expect(h.tracker.getBucketForTesting("sa-d")).toBeDefined();
    h.tracker.detach("sa-d");
    expect(h.tracker.getBucketForTesting("sa-d")).toBeUndefined();
    expect(h.tracker.flushSnapshot("sa-d")).toBeNull();
  });

  it("ensures buckets lazily when a tool event arrives without attach", () => {
    const h = makeTracker();
    h.tracker.onToolExecuting({
      subagentSessionId: "sa-lazy",
      toolName: "x",
    });
    const snap = h.tracker.flushSnapshot("sa-lazy")!;
    expect(snap.toolUseCount).toBe(1);
    expect(snap.lastToolName).toBe("x");
  });

  it("elapsedMs reflects startedAt on attach", () => {
    const h = makeTracker();
    h.tracker.attach({ subagentSessionId: "sa-e" });
    h.advance(1_234);
    const snap = h.tracker.flushSnapshot("sa-e")!;
    expect(snap.elapsedMs).toBe(1_234);
  });
});
