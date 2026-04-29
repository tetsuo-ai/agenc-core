import { describe, expect, it } from "vitest";
import { ReplayEventBridge } from "./bridge.js";
import { SqliteReplayTimelineStore } from "./sqlite-store.js";
import { InMemoryReplayTimelineStore } from "./in-memory-store.js";

describe("ReplayEventBridge storage defaults", () => {
  it("defaults to a durable sqlite store when no store config is provided", () => {
    const bridge = ReplayEventBridge.create({} as any, {});
    expect(bridge.getStore()).toBeInstanceOf(SqliteReplayTimelineStore);
  });

  it("preserves explicit in-memory store selection", () => {
    const bridge = ReplayEventBridge.create({} as any, {
      store: { type: "memory" },
    });
    expect(bridge.getStore()).toBeInstanceOf(InMemoryReplayTimelineStore);
  });

  it("rejects invalid sqlite config instead of silently falling back", () => {
    expect(() =>
      ReplayEventBridge.create({} as any, {
        store: {
          type: "sqlite",
          sqlitePath: "",
        },
      }),
    ).toThrow(/sqlitePath/i);
  });
});

