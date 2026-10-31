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
    expect(requests.reconcile(30, new Set(["event:25"]))).toEqual([]);

    expect(requests.begin("event:20", 20)).toBeUndefined();
    expect(requests.begin("event:30", 30)).toBeUndefined();
    expect(requests.begin("event:25", 25)).toBeDefined();
    // Newer than the set: the daemon published it after the set was taken.
    expect(requests.begin("event:31", 31)).toBeDefined();
    // Without a sequence the set proves nothing.
    expect(requests.begin("ephemeral_1", undefined)).toBeDefined();
  });

  it("closes a shown prompt the pending set no longer lists", () => {
    const requests = new DaemonElicitationRequests();
    const missedClose = requests.begin("event:10", 10)!;
    const stillPending = requests.begin("event:12", 12)!;
    const newer = requests.begin("event:16", 16)!;

    requests.reconcile(15, new Set(["event:12"]));

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

    requests.reconcile(9, new Set());
    expect(requests.remembered).toBe(2);
    expect(requests.begin("event:10", 10)).toBeUndefined();

    requests.reconcile(10, new Set());
    // The sequence rule covers it now; only the unsequenced one is kept.
    expect(requests.remembered).toBe(1);
    expect(requests.begin("event:10", 10)).toBeUndefined();
    expect(requests.begin("ephemeral_1", undefined)).toBeUndefined();
  });

  it("does not apply a pending set older than one already applied", () => {
    const requests = new DaemonElicitationRequests();
    requests.reconcile(20, new Set());
    const prompt = requests.begin("event:25", 25)!;

    expect(requests.reconcile(10, new Set(["event:5"]))).toEqual([]);
    expect(requests.begin("event:5", 5)).toBeUndefined();
    expect(prompt.signal.aborted).toBe(false);
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

    expect(requests.reconcile(12, new Set(["event:10"]))).toEqual(["event:10"]);
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
    expect(requests.reconcile(12, new Set(["event:10"]))).toEqual([]);

    const settledPrompt = requests.begin("event:20", 20)!;
    await requests.deliver("event:20", settledPrompt, failed);
    // The pending set no longer lists it: another client answered it.
    expect(requests.reconcile(22, new Set())).toEqual([]);
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

    expect(requests.reconcile(12, new Set(["event:10"]))).toEqual([]);
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
    expect(requests.reconcile(20, new Set(["event:11"]))).toEqual([]);
  });
});
