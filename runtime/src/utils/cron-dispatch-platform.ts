/**
 * Durable records are dispatched only on Linux. Elsewhere no scheduler in the
 * process loads them (`session-cron-scheduler.ts` and `cronScheduler.ts` see
 * session tasks only), durable creation is refused before any write, and
 * startup and the gateway keep reporting durable storage as unavailable.
 * CronList shows stored records as dormant; CronDelete can still remove one.
 * The error keeps the `DESCRIPTOR_UNSUPPORTED` code that existing callers handle.
 */
export function durableCronDispatchSupported(): boolean {
  return process.platform === "linux";
}

export function durableCronDispatchUnsupported(): Error {
  return Object.assign(
    new Error(`durable scheduled tasks are dispatched only on Linux, not on ${process.platform}`),
    { code: "DESCRIPTOR_UNSUPPORTED" },
  );
}
