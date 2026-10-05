import type { AgenCDaemonHealthService, AgenCDaemonHealthServiceOptions } from "./health.js";
import { healthPingResult } from "./health-ping.js";

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
  const nowMs = captured.nowMs ?? (() => Date.now());
  let pending: Promise<AgenCDaemonHealthService> | undefined;
  const get = () => pending ??= import("./health.js").then(
    ({ AgenCDaemonHealthService }) => new AgenCDaemonHealthService(captured),
  );
  return {
    // Resident print re-proves its authenticated connection before admission.
    // Preserve that ping without initializing the statistics implementation.
    ping: async () => healthPingResult(nowMs()),
    ready: async () => (await get()).ready(),
    stats: async () => (await get()).stats(),
  };
}
