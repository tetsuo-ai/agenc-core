import { describe, expect, test } from "vitest";
import { Semaphore } from "./concurrency.js";
import { AsyncRwLock } from "../utils/async-rwlock.js";

// ──────────────────────────────────────────────────────────────────────
// Abort-aware lock/semaphore acquisition (GOAL ITEM #2).
//
// These tests drive the REAL Semaphore + AsyncRwLock (no mocks) and
// exercise the lost-wakeup / double-grant races deterministically by
// controlling resolution order with explicit microtask / setImmediate
// yields. The central invariant being protected:
//
//   At every instant each in-use permit / write turn has EXACTLY ONE
//   owner. A grant handed toward a cancelling waiter is FORWARDED to the
//   next live waiter (queued-cancel) or kept by the already-granted
//   waiter that releases normally (granted-cancel) — NEVER dropped and
//   NEVER double-granted.
// ──────────────────────────────────────────────────────────────────────

const microtask = (): Promise<void> => Promise.resolve();
const tick = (): Promise<void> =>
  new Promise<void>((r) => setImmediate(r));

/** Settle-or-pending probe so we can assert a promise has NOT resolved. */
async function isPending<T>(p: Promise<T>): Promise<boolean> {
  const sentinel = Symbol("pending");
  const raced = await Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    Promise.resolve().then(() => sentinel),
  ]);
  return raced === sentinel;
}

describe("Semaphore abort-aware acquire", () => {
  // ── Test 1: No lost-wakeup / no-drop — cancel a QUEUED middle waiter.
  //    3 FIFO waiters on capacity-1; cancel the MIDDLE while queued;
  //    release the holder; the 3rd STILL acquires and the cancelled one
  //    rejected. A permit is never lost.
  test("no-drop: cancelling a queued middle waiter still lets the tail acquire", async () => {
    const sem = new Semaphore(1);
    const holder = await sem.acquire();
    expect(sem.available).toBe(0);

    const midCtl = new AbortController();
    const w1 = sem.acquire(); // FIFO #1
    const w2 = sem.acquire(midCtl.signal); // FIFO #2 — victim (queued)
    const w3 = sem.acquire(); // FIFO #3
    await microtask();
    expect(sem.queueDepth).toBe(3);

    // Cancel the middle waiter while it is still queued (holder still holds).
    midCtl.abort(new Error("cancel-mid"));
    await expect(w2).rejects.toThrow("cancel-mid");
    expect(sem.queueDepth).toBe(2);

    // Release the holder — the permit forwards to w1, then (after w1
    // releases) to w3. No permit was lost to the cancelled w2.
    holder();
    const r1 = await w1;
    r1();
    const r3 = await w3;
    expect(typeof r3).toBe("function");
    r3();

    expect(sem.available).toBe(1);
    expect(sem.queueDepth).toBe(0);
    expect(sem.acquiredCount).toBe(0);
  });

  // ── Test 2 (THE DOUBLE-GRANT BUG GUARD): granted-then-cancel must NOT
  //    double-grant. Arrange a waiter to be GRANTED by pumpNext (holder
  //    releases), then fire its abort in the SAME tick before it resumes.
  //    Assert: (a) no two holders ever run concurrently, (b) final
  //    acquired===0, queue empty, (c) no underflow throw.
  //
  //    This test FAILS against the design's original reject+forward
  //    `granted` branch (which double-grants the permit) and PASSES with
  //    the granted→no-op fix.
  test("double-grant guard: granted-then-cancel keeps exactly one holder, counts exact", async () => {
    const sem = new Semaphore(1);
    const holder = await sem.acquire();

    const victimCtl = new AbortController();
    // The victim is FIFO head; a tail waiter sits behind it.
    const victim = sem.acquire(victimCtl.signal);
    const tail = sem.acquire();
    await microtask();
    expect(sem.queueDepth).toBe(2);

    // Track concurrent holders to prove no double-grant ever runs two at
    // once under the released permit.
    let liveHolders = 0;
    let maxLiveHolders = 0;
    const runUnder = async (
      acquireP: Promise<() => void>,
    ): Promise<"ran" | "rejected"> => {
      let release: (() => void) | undefined;
      try {
        release = await acquireP;
      } catch {
        return "rejected";
      }
      liveHolders += 1;
      maxLiveHolders = Math.max(maxLiveHolders, liveHolders);
      await tick(); // hold across a turn so an overlap would be observable
      liveHolders -= 1;
      release();
      return "ran";
    };

    const victimRun = runUnder(victim);
    const tailRun = runUnder(tail);

    // Release the holder. pumpNext synchronously GRANTS the victim
    // (state→granted, victim's promise resolves). BEFORE the victim's
    // continuation runs, fire its abort in the same macrotask window.
    holder();
    // Abort now: the victim is already `granted`, so cancelWaiter is a
    // NO-OP — the victim keeps the permit and releases it normally.
    victimCtl.abort(new Error("granted-cancel"));

    const [victimOutcome, tailOutcome] = await Promise.all([
      victimRun,
      tailRun,
    ]);

    // The victim won the irrevocable grant, so it RAN (and released
    // normally). The tail then acquired the forwarded permit. Either way:
    // (a) never two holders at once.
    expect(maxLiveHolders).toBeLessThanOrEqual(1);
    // Both eventually acquired exactly one permit each (serially).
    expect(victimOutcome).toBe("ran");
    expect(tailOutcome).toBe("ran");

    // (b) exact count integrity at the end.
    await tick();
    expect(sem.acquiredCount).toBe(0);
    expect(sem.available).toBe(1);
    expect(sem.queueDepth).toBe(0);
    // (c) no underflow throw occurred (we'd have caught it as a rejection).
  });

  // ── Test 2b: granted-cancel where the granted victim is consumed via the
  //    real ToolCallRuntime stage-2 (signal-checked withRead) so the
  //    abort actually surfaces as a rejection while the permit is still
  //    conserved. This mirrors the production shared_server path.
  test("granted-cancel via stage-2 withRead: permit conserved, abort surfaces", async () => {
    const sem = new Semaphore(1);
    const lock = new AsyncRwLock<void>(undefined);
    const holder = await sem.acquire();

    const victimCtl = new AbortController();
    let victimRejected = false;

    // Production-shaped shared_server acquire: permit then signal-checked
    // withRead; finally releases the permit (idempotent).
    const sharedServerRun = async (signal: AbortSignal): Promise<string> => {
      const release = await sem.acquire(signal);
      try {
        return await lock.withRead(async () => "ran", signal);
      } finally {
        release();
      }
    };

    const victim = sharedServerRun(victimCtl.signal).catch((e: unknown) => {
      victimRejected = true;
      throw e;
    });
    const tail = sem.acquire();
    await microtask();
    expect(sem.queueDepth).toBe(2);

    holder();
    // Victim is granted the permit synchronously; abort while granted.
    victimCtl.abort(new Error("granted-cancel-2"));

    // The victim takes the permit, enters stage-2 withRead, which sees the
    // aborted signal and throws — releasing the permit in finally, which
    // forwards to the tail.
    await expect(victim).rejects.toThrow("granted-cancel-2");
    expect(victimRejected).toBe(true);

    const rTail = await tail;
    expect(typeof rTail).toBe("function");
    rTail();

    await tick();
    expect(sem.acquiredCount).toBe(0);
    expect(sem.available).toBe(1);
    expect(sem.queueDepth).toBe(0);
  });

  // ── Test 3: Count-integrity stress — N waiters with a deterministic mix
  //    of cancels (some queued, some at-grant) and normal releases. At the
  //    end: acquired===0, available===capacity, queue empty.
  test("count-integrity stress: mixed queued/at-grant cancels, exact final counts", async () => {
    const N = 20;
    const sem = new Semaphore(1);
    const holder = await sem.acquire();

    const ctls: AbortController[] = [];
    // Cancel pattern: every 3rd waiter is cancelled while queued; every 5th
    // (and not already a queued-cancel) is an at-grant cancel target — its
    // abort fires the instant it is granted the permit (a no-op that must
    // not drop or double-count the permit).
    const queuedCancel = new Set<number>();
    const atGrantCancel = new Set<number>();
    for (let i = 0; i < N; i++) {
      if (i % 3 === 0) queuedCancel.add(i);
      else if (i % 5 === 0) atGrantCancel.add(i);
    }

    let rejectedCount = 0;
    let acquiredCount = 0;
    let doubleSettled = 0;
    // Self-draining chain: on grant, the at-grant-cancel target fires its
    // own abort (granted ⇒ no-op) then releases; everyone else just
    // releases — forwarding the permit to the next live waiter in FIFO.
    const acquires: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      const ctl = new AbortController();
      ctls.push(ctl);
      let settledOnce = false;
      acquires.push(
        sem
          .acquire(ctl.signal)
          .then((release) => {
            if (settledOnce) doubleSettled += 1;
            settledOnce = true;
            acquiredCount += 1;
            if (atGrantCancel.has(i)) ctl.abort(new Error(`grant-cancel-${i}`));
            release();
          })
          .catch(() => {
            if (settledOnce) doubleSettled += 1;
            settledOnce = true;
            rejectedCount += 1;
          }),
      );
    }
    await microtask();
    expect(sem.queueDepth).toBe(N);

    // Cancel all queued-cancel victims while everything is parked.
    for (const i of queuedCancel) {
      ctls[i]!.abort(new Error(`queued-cancel-${i}`));
    }
    await microtask();
    expect(sem.queueDepth).toBe(N - queuedCancel.size);

    // Release the holder; the self-draining chain resolves the rest.
    holder();
    await Promise.all(acquires);
    await tick();

    expect(sem.acquiredCount).toBe(0);
    expect(sem.available).toBe(1);
    expect(sem.queueDepth).toBe(0);
    // Exact conservation: every waiter settled exactly once.
    expect(doubleSettled).toBe(0);
    expect(acquiredCount + rejectedCount).toBe(N);
    // Queued-cancel victims rejected; at-grant victims won the irrevocable
    // grant and ran. So rejected === queuedCancel.size exactly.
    expect(rejectedCount).toBe(queuedCancel.size);
    expect(acquiredCount).toBe(N - queuedCancel.size);
  });

  // ── Test 5: FIFO-preservation — uncancelled waiters acquire in
  //    registration order.
  test("FIFO: uncancelled waiters acquire in registration order", async () => {
    const sem = new Semaphore(1);
    const holder = await sem.acquire();

    const order: number[] = [];
    const ctls = [0, 1, 2, 3, 4].map(() => new AbortController());
    // Each acquire, on grant, records its order then immediately releases so
    // the permit forwards to the next survivor — a self-draining chain.
    const acquires = ctls.map((ctl, i) =>
      sem
        .acquire(ctl.signal)
        .then((release) => {
          order.push(i);
          release();
        })
        .catch(() => {}),
    );
    await microtask();
    expect(sem.queueDepth).toBe(5);

    // Cancel #1 and #3 while queued; survivors are 0, 2, 4 (in order).
    ctls[1]!.abort(new Error("c1"));
    ctls[3]!.abort(new Error("c3"));
    await microtask();
    expect(sem.queueDepth).toBe(3);

    // Release the holder; the self-draining chain forwards the permit
    // through the survivors in FIFO order.
    holder();
    await Promise.all(acquires);
    await tick();
    expect(order).toEqual([0, 2, 4]);
    expect(sem.acquiredCount).toBe(0);
    expect(sem.queueDepth).toBe(0);
  });

  // ── Already-aborted fast path: throws before enqueue, queue untouched.
  test("already-aborted signal throws before enqueue", async () => {
    const sem = new Semaphore(1);
    const holder = await sem.acquire();
    const ctl = new AbortController();
    ctl.abort(new Error("pre-aborted"));
    await expect(sem.acquire(ctl.signal)).rejects.toThrow("pre-aborted");
    expect(sem.queueDepth).toBe(0);
    holder();
    expect(sem.available).toBe(1);
  });

  // ── Capacity>1 correctness: forward-on-collision is per-permit.
  test("capacity=2: queued-cancel does not strand permits", async () => {
    const sem = new Semaphore(2);
    const h1 = await sem.acquire();
    const h2 = await sem.acquire();
    expect(sem.available).toBe(0);

    const midCtl = new AbortController();
    const w1 = sem.acquire();
    const w2 = sem.acquire(midCtl.signal);
    const w3 = sem.acquire();
    await microtask();
    expect(sem.queueDepth).toBe(3);

    midCtl.abort(new Error("cap2-cancel"));
    await expect(w2).rejects.toThrow("cap2-cancel");

    h1();
    h2();
    const r1 = await w1;
    const r3 = await w3;
    expect(typeof r1).toBe("function");
    expect(typeof r3).toBe("function");
    r1();
    r3();
    expect(sem.available).toBe(2);
    expect(sem.acquiredCount).toBe(0);
    expect(sem.queueDepth).toBe(0);
  });
});

describe("AsyncRwLock abort-aware writer", () => {
  // ── Test 1 (write lock): no-drop — cancel a queued middle writer; the
  //    tail writer STILL acquires; the reader behind reopens.
  test("no-drop: cancelling a queued middle writer still forwards the turn", async () => {
    const lock = new AsyncRwLock<number[]>([]);
    const order: string[] = [];

    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => {
      releaseHolder = r;
    });
    const holder = lock.withWrite(async () => {
      order.push("holder-start");
      await holderGate;
      order.push("holder-end");
    });
    await microtask(); // holder takes the turn (fast path)

    const midCtl = new AbortController();
    const w1 = lock.withWrite(async () => {
      order.push("w1");
    });
    const w2 = lock.withWrite(async () => {
      order.push("w2");
    }, midCtl.signal); // victim
    const w3 = lock.withWrite(async () => {
      order.push("w3");
    });
    const reader = lock.withRead(async () => {
      order.push("reader");
    });
    await microtask();
    expect(lock.writeQueueDepth).toBe(3);

    // Cancel the middle writer while queued.
    midCtl.abort(new Error("mid-writer-cancel"));
    await expect(w2).rejects.toThrow("mid-writer-cancel");
    expect(lock.writeQueueDepth).toBe(2);

    // Release the holder; the turn forwards w1 → w3, then the reader
    // ungates. w2 never ran.
    releaseHolder();
    await Promise.all([holder, w1, w3, reader]);

    expect(order).toContain("w1");
    expect(order).toContain("w3");
    expect(order).toContain("reader");
    expect(order).not.toContain("w2");
    expect(lock.activeReaders).toBe(0);
    expect(lock.writeQueueDepth).toBe(0);
    expect(lock.writeHeldNow).toBe(false);
  });

  // ── Test 2 (write lock granted-cancel correctness): granted-then-cancel
  //    must NOT double-grant the write turn. The granted writer keeps the
  //    turn; runHeld rechecks the signal and throws (never runs fn), then
  //    hands off ONCE to the tail. No two writers ever hold concurrently;
  //    counts exact; strict serial forwarding tail → extra.
  //
  //    NOTE on revert-sensitivity: unlike the Semaphore (Test #2), the
  //    WRITER granted→no-op fix is behaviorally EQUIVALENT to the design's
  //    original reject+forward branch in this promise model — the runHeld
  //    signal-recheck (which throws before fn) plus the setImmediate yields
  //    serialize the writers regardless, so a spurious second handoff is
  //    masked (it hits an empty queue or grants a writer that would have
  //    been granted anyway). This test therefore guards granted-cancel
  //    CORRECTNESS (no fn run, exactly-once serial forwarding, count
  //    integrity), not revert-sensitivity. The observable double-grant bug
  //    lives in the Semaphore, where the woken waiter takes the permit
  //    synchronously with no recheck — see the Semaphore double-grant guard.
  test("granted-cancel (writer): runs no fn, forwards exactly once, no overlap", async () => {
    const lock = new AsyncRwLock<void>(undefined);

    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => {
      releaseHolder = r;
    });
    const holder = lock.withWrite(async () => {
      await holderGate;
    });
    await microtask();

    const victimCtl = new AbortController();
    let victimFnRan = false;
    let liveWriters = 0;
    let maxLiveWriters = 0;
    const fnRunOrder: string[] = [];

    // Three queued writers behind the holder: victim (granted-cancel), then
    // tail, then extra. A buggy reject+forward `granted` branch issues a
    // SECOND handoff (the victim's own runHeld finally ALSO hands off), so
    // the tail AND the extra get granted while only one should hold → the
    // overlap / extra-early-run is observable. The fix hands off exactly
    // once: tail, then (after tail releases) extra — strictly serial.
    //
    // The tail HOLDS (gated) so we can inspect, mid-flight, whether the
    // extra writer was spuriously granted concurrently.
    let releaseTail!: () => void;
    const tailHold = new Promise<void>((r) => {
      releaseTail = r;
    });

    const victim = lock.withWrite(async () => {
      victimFnRan = true; // must NEVER happen
    }, victimCtl.signal);
    const tail = lock.withWrite(async () => {
      fnRunOrder.push("tail");
      liveWriters += 1;
      maxLiveWriters = Math.max(maxLiveWriters, liveWriters);
      await tailHold; // hold the write lock open for inspection
      liveWriters -= 1;
    });
    const extra = lock.withWrite(async () => {
      fnRunOrder.push("extra");
      liveWriters += 1;
      maxLiveWriters = Math.max(maxLiveWriters, liveWriters);
      await tick();
      liveWriters -= 1;
    });
    await microtask();
    expect(lock.writeQueueDepth).toBe(3);

    // Release the holder → pumpWrite grants the victim (state→granted).
    // Abort the victim in the SAME window: it is granted, so cancelWriteWaiter
    // must be a NO-OP. runHeld rechecks the aborted signal and THROWS before
    // running the victim's fn, then hands off ONCE to the tail.
    releaseHolder();
    victimCtl.abort(new Error("granted-writer-cancel"));

    await expect(victim).rejects.toThrow("granted-writer-cancel");
    // Let the tail be granted and start running (it then holds on tailHold).
    await tick();
    await tick();

    // MID-FLIGHT INSPECTION: the tail holds the write lock; the extra writer
    // must NOT have been granted yet. A double-handoff would have granted the
    // extra concurrently → fnRunOrder would contain "extra" and overlap.
    expect(fnRunOrder).toEqual(["tail"]);
    expect(lock.writeHeldNow).toBe(true);
    expect(maxLiveWriters).toBe(1);

    // Release the tail; now the extra is granted (serially).
    releaseTail();
    await extra;

    // The victim's fn NEVER ran.
    expect(victimFnRan).toBe(false);
    // Exactly-once forwarding, strict serial order, never two holders.
    expect(fnRunOrder).toEqual(["tail", "extra"]);
    expect(maxLiveWriters).toBe(1);

    await holder;
    await tick();
    expect(lock.writeQueueDepth).toBe(0);
    expect(lock.writeHeldNow).toBe(false);
    expect(lock.activeReaders).toBe(0);
  });

  // ── Reader abort path: a withRead aborted while gated behind a writer
  //    rejects and does NOT increment readers.
  test("reader gated behind a writer aborts without touching readers count", async () => {
    const lock = new AsyncRwLock<void>(undefined);
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => {
      releaseHolder = r;
    });
    const holder = lock.withWrite(async () => {
      await holderGate;
    });
    await microtask();

    const readerCtl = new AbortController();
    let readerFnRan = false;
    const reader = lock.withRead(async () => {
      readerFnRan = true;
    }, readerCtl.signal);
    await microtask();
    expect(lock.activeReaders).toBe(0); // gated, not yet a reader

    readerCtl.abort(new Error("reader-cancel"));
    await expect(reader).rejects.toThrow("reader-cancel");
    expect(lock.activeReaders).toBe(0); // never incremented
    expect(readerFnRan).toBe(false);

    releaseHolder();
    await holder;
    expect(lock.writeHeldNow).toBe(false);
    expect(lock.activeReaders).toBe(0);
  });

  // ── FIFO writer order among survivors.
  test("FIFO: surviving writers acquire in registration order", async () => {
    const lock = new AsyncRwLock<void>(undefined);
    const order: number[] = [];
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => {
      releaseHolder = r;
    });
    const holder = lock.withWrite(async () => {
      await holderGate;
    });
    await microtask();

    const ctls = [0, 1, 2, 3, 4].map(() => new AbortController());
    const writers = ctls.map((ctl, i) =>
      lock.withWrite(async () => {
        order.push(i);
      }, ctl.signal),
    );
    await microtask();
    expect(lock.writeQueueDepth).toBe(5);

    ctls[1]!.abort(new Error("w1-cancel"));
    ctls[3]!.abort(new Error("w3-cancel"));
    await microtask();
    expect(lock.writeQueueDepth).toBe(3);

    releaseHolder();
    const results = await Promise.allSettled([holder, ...writers]);
    // Survivors 0,2,4 ran in registration order; 1,3 rejected.
    expect(order).toEqual([0, 2, 4]);
    expect(results[2]!.status).toBe("rejected"); // writer index 1
    expect(results[4]!.status).toBe("rejected"); // writer index 3
    expect(lock.writeQueueDepth).toBe(0);
    expect(lock.writeHeldNow).toBe(false);
  });
});
