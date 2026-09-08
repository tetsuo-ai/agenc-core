import { describe, expect, it, vi } from "vitest";
import { DaemonEventReplay, DaemonEventReplayGapError } from "../../src/tui/daemon-event-replay.js";
import {
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  type SessionTranscriptEvent,
} from "../../src/tui/session-transcript.js";

describe("bounded daemon event replay", () => {
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid capacity %s", capacity => {
    expect(() => new DaemonEventReplay(capacity)).toThrow(RangeError);
  });

  it("keeps existing live delivery after retained history overflows", () => {
    const replay = new DaemonEventReplay(3);
    for (const event of [1, 2, 3]) replay.publish(event);
    const received: unknown[] = [];
    const unsubscribe = replay.subscribe(event => received.push(event));
    for (let event = 4; event <= 2_000; event += 1) replay.publish(event);
    expect(received).toEqual(Array.from({ length: 2_000 }, (_, index) => index + 1));
    const late = vi.fn();
    expect(() => replay.subscribe(late)).toThrow(DaemonEventReplayGapError);
    expect(late).not.toHaveBeenCalled();
    expect(replay.size).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(replay.size).toBe(0);
  });

  it("gives an explicit gap before invoking a late callback", () => {
    const replay = new DaemonEventReplay(1);
    replay.publish("first");
    replay.publish("missed");
    expect(() => replay.subscribe(vi.fn())).toThrow(expect.objectContaining({
      code: "DAEMON_EVENT_REPLAY_GAP", capacity: 1,
      message: expect.stringMatching(/reopen.*conversation/i),
    }));
    expect(replay.size).toBe(0);
  });

  it("delivers reentrant live events after a complete retained snapshot", () => {
    const replay = new DaemonEventReplay(3);
    for (const event of [1, 2, 3]) replay.publish(event);
    const received: unknown[] = [];
    const unsubscribe = replay.subscribe(event => {
      received.push(event);
      if (event === 1) replay.publish(4);
    });
    replay.publish(5);
    expect(received).toEqual([1, 2, 3, 4, 5]);
    unsubscribe();
  });

  it("enqueues each event for all subscribers before a callback can publish another", () => {
    const replay = new DaemonEventReplay(3);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const stopFirst = replay.subscribe(event => {
      first.push(event);
      if (event === 1) replay.publish(2);
    });
    const stopSecond = replay.subscribe(event => second.push(event));
    replay.publish(1);
    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
    stopFirst();
    stopSecond();
  });

  it("bounds a reentrant pending queue and leaves a healthy subscriber live", () => {
    const replay = new DaemonEventReplay(3);
    replay.publish(1);
    replay.publish(2);
    const healthy: unknown[] = [];
    const stopHealthy = replay.subscribe(event => healthy.push(event));
    const failing = vi.fn((event: unknown) => {
      if (event === 1) for (const nested of [3, 4, 5, 6]) replay.publish(nested);
    });
    expect(() => replay.subscribe(failing)).toThrow(DaemonEventReplayGapError);
    expect(failing).toHaveBeenCalledExactlyOnceWith(1);
    expect(replay.size).toBe(1);
    replay.publish(7);
    expect(healthy).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(failing).toHaveBeenCalledOnce();
    stopHealthy();
  });

  it("removes a callback that fails during replay", () => {
    const replay = new DaemonEventReplay(3);
    replay.publish(1);
    const failure = new Error("subscriber failed");
    const callback = vi.fn(() => { throw failure; });
    expect(() => replay.subscribe(callback)).toThrow(failure);
    expect(replay.size).toBe(0);
    replay.publish(2);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("delivers to healthy subscribers before rethrowing a live callback failure", () => {
    const replay = new DaemonEventReplay(3);
    const failure = new Error("live callback failed");
    replay.subscribe(() => { throw failure; });
    const received: unknown[] = [];
    const stopHealthy = replay.subscribe(event => received.push(event));
    expect(() => replay.publish(1)).toThrow(failure);
    expect(replay.size).toBe(1);
    replay.publish(2);
    expect(received).toEqual([1, 2]);
    stopHealthy();
  });

  it("does not deliver an already queued event after unsubscribe", () => {
    const replay = new DaemonEventReplay(3);
    let stopSecond = () => {};
    const stopFirst = replay.subscribe(() => stopSecond());
    const second = vi.fn();
    stopSecond = replay.subscribe(second);
    replay.publish(1);
    expect(second).not.toHaveBeenCalled();
    stopFirst();
  });

  it("preserves canonical reducer deduplication across replay and live overlap", () => {
    const replay = new DaemonEventReplay(3);
    const events = [1, 2, 3].map(sequence => ({
      id: `canonical-${sequence}`, seq: sequence, type: "user_message",
      payload: { message: `prompt ${sequence}` },
    }));
    replay.publish(events[0]);
    replay.publish(events[1]);
    let state = createSessionTranscriptStateForTesting([]);
    const unsubscribe = replay.subscribe(event => {
      state = appendSessionTranscriptEventForTesting(state, event as SessionTranscriptEvent);
    });
    replay.publish({ ...events[1] });
    replay.publish(events[2]);
    expect(state.events).toEqual(events);
    unsubscribe();
  });
});
