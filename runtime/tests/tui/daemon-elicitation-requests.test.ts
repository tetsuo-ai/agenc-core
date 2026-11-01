import { describe, expect, it } from "vitest";

import { DaemonElicitationRequests } from "../../src/tui/daemon-elicitation-requests.js";

const sent = (): Promise<void> => Promise.resolve();
const failed = (): Promise<void> => Promise.reject(new Error("socket closed"));

describe("DaemonElicitationRequests", () => {
  it("shows each occurrence once and closes only the occurrence the daemon names", () => {
    const requests = new DaemonElicitationRequests();
    const first = requests.begin("event:10", 10)!;
    expect(requests.begin("event:10", 10)).toBeUndefined();
    const second = requests.begin("event:20", 20)!;

    expect(requests.close("event:10", 10)).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(requests.close("event:99", 99)).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it("shows a request that reuses an answered request id in the same turn", async () => {
    const requests = new DaemonElicitationRequests();
    const first = requests.begin("event:10", 10)!;
    await expect(requests.deliver("event:10", first, sent)).resolves.toEqual({
      status: "delivered",
    });
    // The ordinary close for the answered occurrence names only that occurrence.
    expect(requests.close("event:10", 10)).toBe(false);

    const reused = requests.begin("event:20", 20);
    expect(reused).toBeDefined();
    expect(reused!.signal.aborted).toBe(false);
  });

  it("keeps an open prompt when an older close is replayed", () => {
    const requests = new DaemonElicitationRequests();
    const open = requests.begin("event:20", 20)!;

    expect(requests.close("event:10", 10)).toBe(false);
    expect(open.signal.aborted).toBe(false);
  });

  it("never reopens a closed request, however many others were settled after it", () => {
    const requests = new DaemonElicitationRequests();
    for (let sequence = 1; sequence <= 512; sequence += 1) {
      requests.begin(`event:${sequence}`, sequence);
    }
    requests.begin("event:513", 513);
    requests.close("event:513", 513);
    for (let sequence = 1; sequence <= 512; sequence += 1) {
      requests.close(`event:${sequence}`, sequence);
    }

    expect(requests.begin("event:513", 513)).toBeUndefined();
    for (let sequence = 1; sequence <= 512; sequence += 1) {
      expect(requests.begin(`event:${sequence}`, sequence)).toBeUndefined();
    }
    expect(requests.remembered).toBe(513);
  });

  it("ignores a request at or below the pending set's sequence that is not pending", () => {
    const requests = new DaemonElicitationRequests();
    expect(requests.reconcile(requests.mark(), 30, new Set(["event:25"]))).toEqual([]);

    expect(requests.begin("event:20", 20)).toBeUndefined();
    expect(requests.begin("event:30", 30)).toBeUndefined();
    expect(requests.begin("event:25", 25)).toBeDefined();
    // The bridge must refresh authority after receiving either request.
    expect(requests.begin("event:31", 31)).toBeUndefined();
    expect(requests.begin("ephemeral_1", undefined)).toBeUndefined();
    requests.reconcile(requests.mark(), 31, new Set(["event:31", "ephemeral_1"]));
    expect(requests.begin("event:31", 31)).toBeDefined();
    expect(requests.begin("ephemeral_1", undefined)).toBeDefined();
  });

  it("closes a shown prompt the pending set no longer lists", () => {
    const requests = new DaemonElicitationRequests();
    const missedClose = requests.begin("event:10", 10)!;
    const stillPending = requests.begin("event:12", 12)!;
    const mark = requests.mark();
    // Arrives while the set is requested: published after the daemon read it.
    const newer = requests.begin("event:16", 16)!;

    requests.reconcile(mark, 15, new Set(["event:12"]));

    expect(missedClose.signal.aborted).toBe(true);
    expect(stillPending.signal.aborted).toBe(false);
    expect(newer.signal.aborted).toBe(false);
    expect(requests.begin("event:10", 10)).toBeUndefined();
  });

  it("forgets a settled request only once a pending set covers it", () => {
    const requests = new DaemonElicitationRequests();
    requests.begin("event:10", 10);
    requests.close("event:10", 10);
    requests.begin("ephemeral_1", undefined);
    requests.close("ephemeral_1", undefined);
    expect(requests.remembered).toBe(2);

    requests.reconcile(requests.mark(), 9, new Set());
    expect(requests.remembered).toBe(0);
    expect(requests.begin("event:10", 10)).toBeUndefined();

    requests.reconcile(requests.mark(), 10, new Set());
    // Fresh authority covers both sequenced and unjournaled replays.
    expect(requests.remembered).toBe(0);
    expect(requests.begin("event:10", 10)).toBeUndefined();
    expect(requests.begin("ephemeral_1", undefined)).toBeUndefined();
  });

  it("applies the latest pending set, also one with a lower sequence after a daemon restart", () => {
    const requests = new DaemonElicitationRequests();
    requests.reconcile(requests.mark(), 25, new Set(["event:25"]));
    const lost = requests.begin("event:25", 25)!;

    // The restarted daemon's journal ends at 10 and its session waits for event:5.
    requests.reconcile(requests.mark(), 10, new Set(["event:5"]));

    expect(lost.signal.aborted).toBe(true);
    expect(requests.begin("event:5", 5)).toBeDefined();
  });

  it("settles a prompt without a sequence only when it was shown before the set was requested", async () => {
    const requests = new DaemonElicitationRequests();
    const before = requests.begin("sub-3", undefined)!;
    const answered = requests.begin("sub-4", undefined)!;
    await requests.deliver("sub-4", answered, failed);
    const mark = requests.mark();
    const after = requests.begin("sub-5", undefined)!;

    expect(requests.reconcile(mark, 50, new Set())).toEqual([]);

    expect(before.signal.aborted).toBe(true);
    expect(requests.unacknowledged).toEqual([]);
    expect(after.signal.aborted).toBe(false);
    // Fresh authority prevents old unjournaled requests from reopening.
    expect(requests.begin("sub-3", undefined)).toBeUndefined();
    expect(requests.begin("sub-4", undefined)).toBeUndefined();
    expect(requests.remembered).toBe(0);
  });

  it("keeps an answer that failed to send and sends it again while it is pending", async () => {
    const requests = new DaemonElicitationRequests();
    const prompt = requests.begin("event:10", 10)!;
    let attempts = 0;
    const send = (): Promise<void> => {
      attempts += 1;
      return attempts === 1 ? failed() : sent();
    };

    const delivery = await requests.deliver("event:10", prompt, send);
    expect(delivery).toMatchObject({ status: "failed", error: new Error("socket closed") });
    expect(requests.unacknowledged).toEqual(["event:10"]);
    // A replay of the request does not reopen it: the answer is kept.
    expect(requests.begin("event:10", 10)).toBeUndefined();

    expect(requests.reconcile(requests.mark(), 12, new Set(["event:10"]))).toEqual(["event:10"]);
    await expect(requests.resend("event:10")).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(requests.unacknowledged).toEqual([]);
    expect(requests.begin("event:10", 10)).toBeUndefined();
  });

  it("stops retrying an answer once the daemon closes its request", async () => {
    const requests = new DaemonElicitationRequests();
    const closedPrompt = requests.begin("event:10", 10)!;
    await requests.deliver("event:10", closedPrompt, failed);
    requests.close("event:10", 10);
    expect(requests.unacknowledged).toEqual([]);
    expect(requests.reconcile(requests.mark(), 12, new Set(["event:10"]))).toEqual([]);

    requests.reconcile(requests.mark(), 20, new Set(["event:20"]));
    const settledPrompt = requests.begin("event:20", 20)!;
    await requests.deliver("event:20", settledPrompt, failed);
    // The pending set no longer lists it: another client answered it.
    expect(requests.reconcile(requests.mark(), 22, new Set())).toEqual([]);
    expect(requests.unacknowledged).toEqual([]);
    expect(requests.begin("event:20", 20)).toBeUndefined();
  });

  it("sends nothing for a prompt closed before it was answered", async () => {
    const requests = new DaemonElicitationRequests();
    const prompt = requests.begin("event:10", 10)!;
    requests.close("event:10", 10);
    let attempts = 0;

    await expect(
      requests.deliver("event:10", prompt, () => {
        attempts += 1;
        return sent();
      }),
    ).resolves.toEqual({ status: "closed" });
    expect(attempts).toBe(0);
  });

  it("does not send an answer again while it is being sent", async () => {
    const requests = new DaemonElicitationRequests();
    const prompt = requests.begin("event:10", 10)!;
    let attempts = 0;
    let finish!: () => void;
    const delivery = requests.deliver("event:10", prompt, () => {
      attempts += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    expect(requests.reconcile(requests.mark(), 12, new Set(["event:10"]))).toEqual([]);
    await expect(requests.resend("event:10")).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    finish();
    await expect(delivery).resolves.toEqual({ status: "delivered" });
    expect(requests.unacknowledged).toEqual([]);
  });

  it("closes every prompt and accepts nothing once the event stream ends", async () => {
    const requests = new DaemonElicitationRequests();
    const prompt = requests.begin("event:10", 10)!;
    const answered = requests.begin("event:11", 11)!;
    await requests.deliver("event:11", answered, failed);

    requests.closeAll();

    expect(prompt.signal.aborted).toBe(true);
    expect(requests.unacknowledged).toEqual([]);
    expect(requests.begin("event:12", 12)).toBeUndefined();
    expect(requests.reconcile(requests.mark(), 20, new Set(["event:11"]))).toEqual([]);
  });
  it("bounds settled retention under 100,000 sequenced and unjournaled closes", () => {
    const requests = new DaemonElicitationRequests();
    for (let i = 1; i <= 100_000; i += 1) {
      requests.close(`uuid:${i}`, i % 2 === 0 ? i : undefined);
      if (requests.remembered >= 128) requests.reconcile(requests.mark(), i, new Set());
      expect(requests.remembered).toBeLessThan(128);
    }
    requests.reconcile(requests.mark(), 100_000, new Set());
    expect(requests.remembered).toBe(0);
    expect(requests.begin("uuid:1", undefined)).toBeUndefined();
    expect(requests.begin("uuid:2", 2)).toBeUndefined();
  });

  it("runtime loss clears prompts, answers and settlements without preventing future authority", async () => {
    const requests = new DaemonElicitationRequests();
    const prompt = requests.begin("old-open", 10)!;
    const answered = requests.begin("old-answer", 11)!;
    await requests.deliver("old-answer", answered, failed);
    requests.close("old-close", 12);
    requests.reset();
    expect(prompt.signal.aborted).toBe(true);
    expect(requests.unacknowledged).toEqual([]);
    expect(requests.remembered).toBe(0);
    requests.reconcile(requests.mark(), 10, new Set(["new-uuid"]));
    expect(requests.begin("old-open", 10)).toBeUndefined();
    expect(requests.begin("new-uuid", 10)).toBeDefined();
  });

});
