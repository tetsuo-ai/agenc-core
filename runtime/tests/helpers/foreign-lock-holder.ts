import { Worker } from "node:worker_threads";

/**
 * Hold a proper-lockfile lock directory from another thread, the way another
 * process holds it: the directory exists with a fresh mtime and disappears
 * only when that thread releases it, independently of this thread's event
 * loop. Resolves once the lock is held; `released` settles after release.
 */
export async function holdLockElsewhere(
  lockPath: string,
  holdMs: number,
): Promise<{ readonly released: Promise<void> }> {
  const worker = new Worker(
    `
      const { mkdirSync, rmdirSync } = require("node:fs");
      const { parentPort, workerData } = require("node:worker_threads");
      mkdirSync(workerData.lockPath);
      parentPort.postMessage("held");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
      rmdirSync(workerData.lockPath);
    `,
    { eval: true, workerData: { lockPath, holdMs } },
  );
  const released = new Promise<void>((resolve, reject) => {
    worker.once("exit", () => resolve());
    worker.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  // Wrapped: an async function would adopt a returned promise and make the
  // caller wait for the release before it could contend for the lock.
  return { released };
}
