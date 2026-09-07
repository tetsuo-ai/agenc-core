import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompletedAgentEventCache,
  COMPLETED_EVENT_CACHE_LIMITS as limits,
} from "../../src/app-server/background-agent-runner/completed-event-cache.js";

describe("completed agent event cache", () => {
  afterEach(() => vi.useRealTimers());

  const event = (text = "hello") => ({
    id: "event-1",
    type: "agent_message_delta",
    payload: { delta: text },
  });

  it("owns payload bytes and releases them when consumed", () => {
    const cache = new CompletedAgentEventCache();
    const input = [event("🦀")];
    const expectedBytes =
      Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength("agent");
    cache.put("agent", input);
    expect(cache.retained).toEqual({ entries: 1, bytes: expectedBytes });
    input[0]!.payload.delta = "mutated";
    input.push(event());
    expect(cache.take("agent")).toEqual([event("🦀")]);
    expect(cache.retained).toEqual({ entries: 0, bytes: 0 });
    expect(cache.take("agent")).toBeUndefined();
  });

  it("caps entries across ten thousand unique completed agents", () => {
    const cache = new CompletedAgentEventCache();
    for (let i = 0; i < 10_000; i++) {
      cache.put(`agent-${i}`, [event()]);
      expect(cache.retained.entries).toBeLessThanOrEqual(limits.entries);
      expect(cache.retained.bytes).toBeLessThanOrEqual(limits.bytes);
    }
    expect(cache.take("agent-0")).toBeUndefined();
    expect(cache.take("agent-9999")).toEqual([event()]);
  });

  it("evicts by total UTF-8 bytes before reaching the entry cap", () => {
    const cache = new CompletedAgentEventCache();
    const input = [event("🦀".repeat(120_000))];
    for (let i = 0; i < 40; i++) cache.put(`agent-${i}`, input);
    expect(cache.retained.entries).toBeLessThan(40);
    expect(cache.retained.bytes).toBeLessThanOrEqual(limits.bytes);
    expect(cache.take("agent-0")).toBeUndefined();
    expect(cache.take("agent-39")).toEqual(input);
  });

  it("rejects oversized payloads and keys without retaining metadata", () => {
    const cache = new CompletedAgentEventCache();
    cache.put("large", [event("x".repeat(limits.entryBytes))]);
    cache.put("x".repeat(limits.entryBytes), [event()]);
    expect(cache.retained).toEqual({ entries: 0, bytes: 0 });
    expect(cache.take("large")).toBeUndefined();
  });

  it("replaces an entry atomically even when the new payload cannot serialize", () => {
    const cache = new CompletedAgentEventCache();
    cache.put("agent", [event()]);
    const circular = event();
    Object.assign(circular.payload, { circular });
    expect(() => cache.put("agent", [circular])).not.toThrow();
    expect(cache.retained).toEqual({ entries: 0, bytes: 0 });
  });

  it("keeps the newest replacement when evicting the least recently used entry", () => {
    const cache = new CompletedAgentEventCache();
    for (let i = 0; i < limits.entries; i++) cache.put(`agent-${i}`, [event()]);
    cache.put("agent-0", [event("replacement")]);
    cache.put("new-agent", [event()]);
    expect(cache.take("agent-1")).toBeUndefined();
    expect(cache.take("agent-0")).toEqual([event("replacement")]);
  });

  it("expires entries automatically using one timer and removes that timer when empty", async () => {
    vi.useFakeTimers();
    const cache = new CompletedAgentEventCache();
    cache.put("first", [event()]);
    await vi.advanceTimersByTimeAsync(100);
    cache.put("second", [event()]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(limits.ttlMs - 100);
    // Reading diagnostics does not itself prune: the timer must free the bytes.
    expect(cache.retained.entries).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(cache.retained).toEqual({ entries: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires before replay even if the event loop has not run the timer", () => {
    vi.useFakeTimers();
    const cache = new CompletedAgentEventCache();
    cache.put("agent", [event()]);
    vi.setSystemTime(Date.now() + limits.ttlMs);
    expect(cache.take("agent")).toBeUndefined();
    expect(cache.retained.bytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes a retained empty buffer from a cache miss", () => {
    const cache = new CompletedAgentEventCache();
    cache.put("empty", []);
    expect(cache.take("empty")).toEqual([]);
    expect(cache.take("unknown")).toBeUndefined();
  });

  it("copies identifiers without conflating malformed Unicode with a replacement character", () => {
    const cache = new CompletedAgentEventCache();
    cache.put("agent-\ud800", [event("surrogate")]);
    cache.put("agent-\ufffd", [event("replacement")]);
    expect(cache.take("agent-\ud800")).toEqual([event("surrogate")]);
    expect(cache.take("agent-\ufffd")).toEqual([event("replacement")]);
  });

  it("retains the existing per-agent event count gap", () => {
    const cache = new CompletedAgentEventCache();
    cache.put(
      "agent",
      Array.from({ length: 1_100 }, () => event()),
    );
    const replay = cache.take("agent")!;
    expect(replay).toHaveLength(1_001);
    expect(replay[0]).toMatchObject({
      type: "event_gap",
      payload: { retiredCount: 100 },
    });
  });
});
