import type { AgenCDaemonHealthService, AgenCDaemonHealthServiceOptions } from "./health.js";

export type AgenCDaemonHealthHandlers = {
  [K in "ping" | "ready" | "stats"]: () =>
    ReturnType<AgenCDaemonHealthService[K]> | Promise<Awaited<ReturnType<AgenCDaemonHealthService[K]>>>;
};

export function createLazyDaemonHealth(
  options: AgenCDaemonHealthServiceOptions = {},
): AgenCDaemonHealthHandlers {
  // Uptime starts when the facade is constructed, not at the first health RPC.
  // Readiness/restoring counters remain live callbacks into the daemon.
  const captured = { ...options, startedAtMs: options.startedAtMs ?? Date.now() };
  let pending: Promise<AgenCDaemonHealthService> | undefined;
  const get = () => pending ??= import("./health.js").then(
    ({ AgenCDaemonHealthService }) => new AgenCDaemonHealthService(captured),
  );
  return {
    ping: async () => (await get()).ping(),
    ready: async () => (await get()).ready(),
    stats: async () => (await get()).stats(),
  };
}
