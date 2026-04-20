import { describe, expect, it, vi } from "vitest";
import {
  Mailbox,
  MailboxClosedError,
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

  it("I-16: drops oldest on overflow", async () => {
    const mb = new Mailbox({ threadId: "t1", maxDepth: 3 });
    expect(mb.send(makeMsg({ content: "a" }))).toBe("sent");
    expect(mb.send(makeMsg({ content: "b" }))).toBe("sent");
    expect(mb.send(makeMsg({ content: "c" }))).toBe("sent");
    // Exceeds cap — drops oldest but accepts new.
    expect(mb.send(makeMsg({ content: "d" }))).toBe("sent");
    const drained = mb.drain();
    const contents = drained
      .filter((m): m is InterAgentCommunication => !isAgentExitedSentinel(m))
      .map((m) => m.content);
    expect(contents).toEqual(["b", "c", "d"]);
    expect(mb.droppedTotal).toBe(1);
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
});
