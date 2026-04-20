import { describe, expect, it, vi } from "vitest";
import {
  Mailbox,
  MailboxClosedError,
  MAX_MAILBOX_BLOCK_MS,
  MAX_MAILBOX_DEPTH,
  isAgentExitedSentinel,
  type InterAgentCommunication,
} from "./mailbox.js";

function makeMsg(
  overrides: Partial<Omit<InterAgentCommunication, "seq">> = {},
): Omit<InterAgentCommunication, "seq"> {
  return {
    author: "parent",
    recipient: "child",
    content: "hi",
    triggerTurn: false,
    direction: "down",
    ...overrides,
  };
}

describe("Mailbox", () => {
  it("round-trips a send/drain", () => {
    const mb = new Mailbox({ threadId: "t1" });
    expect(mb.send(makeMsg())).toBe("sent");
    const drained = mb.drain();
    expect(drained).toHaveLength(1);
    const first = drained[0];
    if (isAgentExitedSentinel(first)) throw new Error("unexpected sentinel");
    expect(first.content).toBe("hi");
    expect(first.seq).toBeGreaterThan(0);
  });

  it("assigns strictly monotonic seq", () => {
    const mb = new Mailbox({ threadId: "t1" });
    for (let i = 0; i < 5; i++) mb.send(makeMsg({ content: `m${i}` }));
    const drained = mb.drain();
    const seqs = drained.map((m) => m.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("I-16: overflow parks new msg in salvage slot (no immediate drop)", async () => {
    const mb = new Mailbox({ threadId: "t1", maxDepth: 3 });
    expect(mb.send(makeMsg({ content: "a" }))).toBe("sent");
    expect(mb.send(makeMsg({ content: "b" }))).toBe("sent");
    expect(mb.send(makeMsg({ content: "c" }))).toBe("sent");
    // Queue full — new msg parks in overflow slot. No drop yet.
    expect(mb.send(makeMsg({ content: "d" }))).toBe("sent");
    // drain() within salvage window: promotes overflow, no drops.
    const drained = mb.drain();
    const contents = drained
      .filter((m): m is InterAgentCommunication => !isAgentExitedSentinel(m))
      .map((m) => m.content);
    expect(contents).toEqual(["a", "b", "c", "d"]);
    expect(mb.droppedTotal).toBe(0);
  });

  it("I-64: send is synchronous — never returns a Promise", () => {
    const mb = new Mailbox({ threadId: "t1" });
    const result = mb.send(makeMsg());
    expect(typeof result).toBe("string");
    expect(result).toBe("sent");
  });

  it("I-31: drain emits agent_exited sentinel exactly once after close", () => {
    const mb = new Mailbox({ threadId: "t1" });
    mb.send(makeMsg({ content: "x" }));
    mb.close("ok");
    const first = mb.drain();
    // Should contain both the "x" message + the sentinel.
    expect(first).toHaveLength(2);
    expect(isAgentExitedSentinel(first[1])).toBe(true);
    const second = mb.drain();
    expect(second).toHaveLength(0);
  });

  it("rejects send after close", () => {
    const mb = new Mailbox({ threadId: "t1" });
    mb.close();
    expect(mb.send(makeMsg())).toBe("rejected");
  });

  it("MAX_MAILBOX_DEPTH default is 1000", () => {
    expect(MAX_MAILBOX_DEPTH).toBe(1000);
  });

  it("fires onBackpressureStreak exactly once per streak", async () => {
    const onStreak = vi.fn();
    const mb = new Mailbox({
      threadId: "t1",
      maxDepth: 2,
      onBackpressureStreak: onStreak,
    });
    mb.send(makeMsg({ content: "a" }));
    mb.send(makeMsg({ content: "b" }));
    // Next two sends drop; should fire streak only once.
    mb.send(makeMsg({ content: "c" }));
    mb.send(makeMsg({ content: "d" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(onStreak).toHaveBeenCalledTimes(1);
  });

  it("hasPendingTriggerTurn respects the trigger bit", () => {
    const mb = new Mailbox({ threadId: "t1" });
    mb.send(makeMsg({ triggerTurn: false }));
    expect(mb.hasPendingTriggerTurn()).toBe(false);
    mb.send(makeMsg({ triggerTurn: true, content: "wake" }));
    expect(mb.hasPendingTriggerTurn()).toBe(true);
  });

  it("MailboxClosedError carries the thread id", () => {
    const err = new MailboxClosedError("abc");
    expect(err.threadId).toBe("abc");
    expect(err.name).toBe("MailboxClosedError");
  });

  it("I-16: overflow salvaged when drain() happens within the window", () => {
    const onDrop = vi.fn();
    const mb = new Mailbox({
      threadId: "t1",
      maxDepth: 2,
      onDrop,
    });
    mb.send(makeMsg({ content: "a" }));
    mb.send(makeMsg({ content: "b" }));
    // Parks in overflow, no drop.
    mb.send(makeMsg({ content: "c" }));
    expect(mb.droppedTotal).toBe(0);
    // drain() within the 5s window promotes overflow, nothing dropped.
    const drained = mb
      .drain()
      .filter((m): m is InterAgentCommunication => !isAgentExitedSentinel(m))
      .map((m) => m.content);
    expect(drained).toEqual(["a", "b", "c"]);
    expect(mb.droppedTotal).toBe(0);
    // onDrop is only fired via microtask, but since no drop happened,
    // flushing the microtask queue should still show zero calls.
    return Promise.resolve().then(() => {
      expect(onDrop).not.toHaveBeenCalled();
    });
  });

  it("I-16: overflow promoted after timer fires (oldest is dropped)", async () => {
    vi.useFakeTimers();
    try {
      const onDrop = vi.fn();
      const onStreak = vi.fn();
      const mb = new Mailbox({
        threadId: "t1",
        maxDepth: 2,
        onDrop,
        onBackpressureStreak: onStreak,
      });
      mb.send(makeMsg({ content: "a" }));
      mb.send(makeMsg({ content: "b" }));
      mb.send(makeMsg({ content: "c" }));
      expect(mb.droppedTotal).toBe(0);
      // Fire the salvage timer without a drain in between.
      vi.advanceTimersByTime(MAX_MAILBOX_BLOCK_MS);
      // Flush the microtask that emits onDrop + onBackpressureStreak.
      await Promise.resolve();
      await Promise.resolve();
      expect(mb.droppedTotal).toBe(1);
      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(onStreak).toHaveBeenCalledTimes(1);
      const drained = mb
        .drain()
        .filter((m): m is InterAgentCommunication => !isAgentExitedSentinel(m))
        .map((m) => m.content);
      expect(drained).toEqual(["b", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I-16: close() cancels a pending overflow timer (no late drops)", async () => {
    vi.useFakeTimers();
    try {
      const onDrop = vi.fn();
      const mb = new Mailbox({ threadId: "t1", maxDepth: 1, onDrop });
      mb.send(makeMsg({ content: "a" }));
      mb.send(makeMsg({ content: "b" })); // parks in overflow
      mb.close();
      // Advance well past the salvage window.
      vi.advanceTimersByTime(MAX_MAILBOX_BLOCK_MS * 2);
      await Promise.resolve();
      await Promise.resolve();
      expect(onDrop).not.toHaveBeenCalled();
      expect(mb.droppedTotal).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I-16: droppedTotal counts post-timer drops, not salvaged ones", async () => {
    vi.useFakeTimers();
    try {
      const mb = new Mailbox({ threadId: "t1", maxDepth: 2 });
      // First salvage window — drain before timer fires: no drop.
      mb.send(makeMsg({ content: "a" }));
      mb.send(makeMsg({ content: "b" }));
      mb.send(makeMsg({ content: "c" })); // overflow
      expect(mb.droppedTotal).toBe(0);
      mb.drain(); // salvage
      expect(mb.droppedTotal).toBe(0);

      // Second overflow — let timer fire: one drop.
      mb.send(makeMsg({ content: "d" }));
      mb.send(makeMsg({ content: "e" }));
      mb.send(makeMsg({ content: "f" })); // overflow
      vi.advanceTimersByTime(MAX_MAILBOX_BLOCK_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(mb.droppedTotal).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
