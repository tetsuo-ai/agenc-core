import { expect, it } from "vitest";
import { acquireCanonicalCompactionLease, withCanonicalBackgroundWork } from "../../src/session/canonical-background-work.js";

it("defers background publication until compaction releases and keeps competing compactions closed", async () => {
  const key = "compaction-first";
  const lease = await acquireCanonicalCompactionLease(key, () => new Error("busy"));
  const events: string[] = [];
  const pending = withCanonicalBackgroundWork(key, () => { events.push("background"); });
  await Promise.resolve();
  expect(events).toEqual([]);
  expect(() => acquireCanonicalCompactionLease(key, () => new Error("busy"))).toThrow("busy");
  lease.release();
  await pending;
  expect(events).toEqual(["background"]);
  const next = await acquireCanonicalCompactionLease(key, () => new Error("busy"));
  next.release();
});

it("waits for complete asynchronous background work and permits nested notices", async () => {
  const key = "background-first";
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const events: string[] = [];
  const background = withCanonicalBackgroundWork(key, async () => {
    entered();
    await withCanonicalBackgroundWork(key, () => { events.push("nested"); });
    await done;
    events.push("background-end");
  });
  await started;
  let acquired = false;
  const compaction = Promise.resolve(acquireCanonicalCompactionLease(key, () => new Error("busy"))).then((lease) => {
    acquired = true;
    events.push("compaction");
    return lease;
  });
  await Promise.resolve();
  expect(acquired).toBe(false);
  finish();
  await background;
  const lease = await compaction;
  expect(events).toEqual(["nested", "background-end", "compaction"]);
  lease.release();
});

it("cancels a waiting compaction without acquiring a late lease", async () => {
  const key = "cancel-wait";
  let finish!: () => void;
  const background = withCanonicalBackgroundWork(key, () => new Promise<void>((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const pending = Promise.resolve(acquireCanonicalCompactionLease(key, () => new Error("busy"), controller.signal));
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  finish();
  await background;
  const next = await acquireCanonicalCompactionLease(key, () => new Error("busy"));
  next.release();
});
