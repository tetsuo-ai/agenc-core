import { describe, expect, it, vi } from "vitest";
import {
  Mailbox,
  MailboxClosedError,
  MAX_MAILBOX_BLOCK_MS,
  MAX_MAILBOX_DEPTH,
  MAX_MAILBOX_TRIGGER_BYTES,
  isAgentExitedSentinel,
  type InterAgentCommunication,
} from "./mailbox.js";

type MakeMsgOverrides = {
  readonly [K in keyof Omit<InterAgentCommunication, "seq">]?: Omit<
    InterAgentCommunication,
    "seq"
  >[K];
};

function makeMsg(
  overrides: MakeMsgOverrides = {},
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

function retainedEnvelopeBytes(
  message: Omit<InterAgentCommunication, "seq">,
): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
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

  it("close drains an accepted trigger overflow before the exit sentinel", () => {
    const mb = new Mailbox({ threadId: "t1", maxDepth: 1 });
    expect(mb.send(makeMsg({ content: "passive" }))).toBe("sent");
    expect(mb.send(makeMsg({ content: "trigger", triggerTurn: true }))).toBe(
      "sent",
    );

    mb.close("done");
    const drained = mb.drain();
    expect(
      drained
        .filter(
          (item): item is InterAgentCommunication =>
            !isAgentExitedSentinel(item),
        )
        .map((item) => item.content),
    ).toEqual(["passive", "trigger"]);
    expect(isAgentExitedSentinel(drained.at(-1)!)).toBe(true);
  });

  it("close drains an accepted passive overflow without silent loss", () => {
    const mb = new Mailbox({ threadId: "t1", maxDepth: 1 });
    expect(mb.send(makeMsg({ content: "passive-1" }))).toBe("sent");
    expect(mb.send(makeMsg({ content: "passive-2" }))).toBe("sent");

    mb.close("done");
    const drained = mb.drainThroughFirstTrigger();
    expect(
      drained
        .filter(
          (item): item is InterAgentCommunication =>
            !isAgentExitedSentinel(item),
        )
        .map((item) => item.content),
    ).toEqual(["passive-1", "passive-2"]);
    expect(isAgentExitedSentinel(drained.at(-1)!)).toBe(true);
    expect(mb.passiveBytes).toBe(0);
    expect(mb.droppedTotal).toBe(0);
  });

  it("close wakes sequence waiters so they can drain the exit sentinel", () => {
    const mb = new Mailbox({ threadId: "t1" });
    const observed: number[] = [];
    const unsubscribe = mb.seqWatch.subscribe((seq) => observed.push(seq));

    mb.close("done");

    expect(observed).toEqual([0, 1]);
    expect(isAgentExitedSentinel(mb.drain()[0])).toBe(true);
    unsubscribe();
  });

  it("retains passive context in the bounded queue until the first trigger", () => {
    const mb = new Mailbox({ threadId: "t1", maxDepth: 3 });
    for (const content of ["context-1", "context-2"]) {
      mb.send({
        author: "/root/peer",
        recipient: "/root/worker",
        content,
        triggerTurn: false,
        direction: "down",
      });
    }

    expect(mb.drainThroughFirstTrigger()).toEqual([]);
    expect(mb.size).toBe(2);

    mb.send({
      author: "/root",
      recipient: "/root/worker",
      content: "assigned task",
      triggerTurn: true,
      direction: "down",
    });
    mb.send({
      author: "/root/peer",
      recipient: "/root/worker",
      content: "future context",
      triggerTurn: false,
      direction: "down",
    });

    expect(
      mb
        .drainThroughFirstTrigger()
        .map((item) => ("content" in item ? item.content : item.type)),
    ).toEqual(["context-1", "context-2", "assigned task"]);
    expect(
      mb.drain().map((item) => ("content" in item ? item.content : item.type)),
    ).toEqual(["future context"]);
  });

  it("throws MailboxClosedError on send after close", () => {
    const mb = new Mailbox({ threadId: "t1" });
    mb.close();
    expect(() => mb.send(makeMsg())).toThrowError(MailboxClosedError);
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
      expect(drained).toEqual([
        expect.stringContaining(
          "mailbox_backpressure: omitted 1 passive message",
        ),
        "b",
        "c",
      ]);
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

  it("never evicts an accepted trigger under later passive and timer pressure", async () => {
    vi.useFakeTimers();
    try {
      const mb = new Mailbox({ threadId: "worker", maxDepth: 2 });
      mb.send(makeMsg({ content: "context-a" }));
      mb.send(makeMsg({ content: "context-b" }));
      expect(mb.send(makeMsg({ content: "task-1", triggerTurn: true }))).toBe(
        "sent",
      );
      expect(mb.send(makeMsg({ content: "late-passive" }))).toBe("dropped");

      vi.advanceTimersByTime(MAX_MAILBOX_BLOCK_MS);
      await Promise.resolve();
      const first = mb
        .drainThroughFirstTrigger()
        .filter(
          (item): item is InterAgentCommunication =>
            !isAgentExitedSentinel(item),
        )
        .map((item) => item.content);
      expect(first.at(-1)).toBe("task-1");
      expect(first).toContain("context-b");
      expect(first).toContainEqual(
        expect.stringContaining("omitted 1 passive message"),
      );
      expect(first).not.toContain("late-passive");

      expect(mb.send(makeMsg({ content: "task-2", triggerTurn: true }))).toBe(
        "sent",
      );
      const second = mb
        .drainThroughFirstTrigger()
        .filter(
          (item): item is InterAgentCommunication =>
            !isAgentExitedSentinel(item),
        )
        .map((item) => item.content);
      expect(second).toEqual([
        expect.stringContaining("omitted 1 passive message"),
        "task-2",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a trigger synchronously when only protected triggers occupy capacity", () => {
    const mb = new Mailbox({ threadId: "worker", maxDepth: 2 });
    expect(mb.send(makeMsg({ content: "task-1", triggerTurn: true }))).toBe(
      "sent",
    );
    expect(mb.send(makeMsg({ content: "task-2", triggerTurn: true }))).toBe(
      "sent",
    );
    expect(mb.send(makeMsg({ content: "task-3", triggerTurn: true }))).toBe(
      "dropped",
    );
    expect(
      mb
        .drain()
        .filter(
          (item): item is InterAgentCommunication =>
            !isAgentExitedSentinel(item),
        )
        .map((item) => item.content),
    ).toEqual(["task-1", "task-2"]);
  });

  it("bounds aggregate passive bytes and exposes deterministic omission provenance", () => {
    const first = makeMsg({ content: "aaaa" });
    const second = makeMsg({ content: "bbbb" });
    const mb = new Mailbox({
      threadId: "worker",
      maxDepth: 10,
      maxPassiveBytes:
        retainedEnvelopeBytes(first) + retainedEnvelopeBytes(second),
    });
    expect(mb.send(first)).toBe("sent");
    expect(mb.send(second)).toBe("sent");
    expect(mb.passiveBytes).toBe(
      retainedEnvelopeBytes(first) + retainedEnvelopeBytes(second),
    );
    expect(mb.send(makeMsg({ content: "cccc" }))).toBe("dropped");
    expect(
      mb.send(makeMsg({ content: "correlated-task", triggerTurn: true })),
    ).toBe("sent");

    const contents = mb
      .drainThroughFirstTrigger()
      .filter(
        (item): item is InterAgentCommunication => !isAgentExitedSentinel(item),
      )
      .map((item) => item.content);
    expect(contents).toEqual([
      "aaaa",
      "bbbb",
      expect.stringContaining("omitted 1 passive message"),
      "correlated-task",
    ]);
    expect(mb.passiveBytes).toBe(0);
  });

  it("snapshots passive byte accounting against post-send metadata mutation", () => {
    const inputContent = [{ type: "text", text: "12345" }];
    const message = makeMsg({
      content: "display",
      metadata: { inputContent },
    });
    const retainedBytes = retainedEnvelopeBytes(message);
    const mb = new Mailbox({
      threadId: "worker",
      maxPassiveBytes: retainedBytes,
    });
    expect(mb.send(message)).toBe("sent");
    expect(mb.passiveBytes).toBe(retainedBytes);
    inputContent[0]!.text = "x".repeat(1_000);
    const drained = mb.drain();
    expect(drained).toHaveLength(1);
    expect(
      isAgentExitedSentinel(drained[0]!)
        ? null
        : drained[0]!.metadata?.inputContent,
    ).toEqual([{ type: "text", text: "12345" }]);
    expect(mb.passiveBytes).toBe(0);
  });

  it("rejects an oversized content-part trigger before it enters the mailbox", () => {
    const mb = new Mailbox({ threadId: "worker" });
    const inputContent = [
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${"A".repeat(MAX_MAILBOX_TRIGGER_BYTES)}`,
        },
      },
    ];
    expect(
      mb.send(
        makeMsg({
          content: "[image]",
          triggerTurn: true,
          metadata: { inputContent },
        }),
      ),
    ).toBe("dropped");
    expect(mb.hasPendingTriggerTurn()).toBe(false);
    expect(mb.drain()).toEqual([]);
  });

  it("accepts exact-limit trigger content despite bounded envelope overhead", () => {
    const mb = new Mailbox({ threadId: "worker" });
    expect(
      mb.send(
        makeMsg({
          content: "x".repeat(MAX_MAILBOX_TRIGGER_BYTES),
          triggerTurn: true,
        }),
      ),
    ).toBe("sent");
    expect(mb.drain()).toHaveLength(1);
  });

  it("bounds non-consecutive passive omission bookkeeping", () => {
    const mb = new Mailbox({
      threadId: "worker",
      maxDepth: 1,
      maxPassiveBytes: 1,
    });
    expect(mb.send(makeMsg({ content: "control", triggerTurn: true }))).toBe(
      "sent",
    );
    for (let index = 0; index < 200; index += 1) {
      expect(mb.send(makeMsg({ content: `passive-${index}` }))).toBe("dropped");
      expect(
        mb.send(
          makeMsg({
            content: `blocked-control-${index}`,
            triggerTurn: true,
          }),
        ),
      ).toBe("dropped");
    }
    const omissions = (
      mb as unknown as { passiveOmissions: readonly unknown[] }
    ).passiveOmissions;
    expect(omissions.length).toBeLessThanOrEqual(128);
  });
});
