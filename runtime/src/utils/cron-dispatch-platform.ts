/**
 * The session scheduler loads and owns durable records only on Linux
 * (`session-cron-scheduler.ts`). Elsewhere a stored durable task would never
 * fire, so durable creation is refused before any write, and startup and the
 * gateway keep reporting durable storage as unavailable. The error keeps the
 * `DESCRIPTOR_UNSUPPORTED` code that existing callers already handle.
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
