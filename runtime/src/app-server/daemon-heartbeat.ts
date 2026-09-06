import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeDurableAtomicFileSync } from "../utils/durable-atomic-file.js";

/**
 * The daemon's heartbeat file: rewritten every few seconds with the process's
 * pid, memory and event-loop lag, fsynced, removed on a clean shutdown. A
 * daemon that dies in a way no handler can see (SIGKILL, an abort with crash
 * reporting off) leaves its last heartbeat behind, and `agenc daemon status`
 * reports it beside "stopped" so an unexplained exit at least carries the
 * process's last known state (#2199).
 */
export const AGENC_DAEMON_HEARTBEAT_FILENAME = "daemon-heartbeat.json";
export const AGENC_DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;

export interface DaemonHeartbeat {
  readonly pid: number;
  readonly beat: number;
  readonly at: string;
  readonly uptimeS: number;
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly eventLoopLagMs: number;
}

export interface DaemonHeartbeatProcess {
  readonly pid: number;
  memoryUsage(): { readonly rss: number; readonly heapUsed: number };
  uptime(): number;
}

export function resolveAgenCDaemonHeartbeatPath(daemonHome: string): string {
  return join(daemonHome, AGENC_DAEMON_HEARTBEAT_FILENAME);
}

/**
 * Start the heartbeat. The event-loop lag is how late each tick fired against
 * its schedule: a loop blocked by synchronous work shows up here before the
 * process can miss anything else. Returns the disposer, which stops the timer
 * and removes the file so a clean stop leaves nothing to misreport.
 */
export function installAgenCDaemonHeartbeat(options: {
  readonly path: string;
  readonly intervalMs?: number;
  readonly proc?: DaemonHeartbeatProcess;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}): () => void {
  const proc = options.proc ?? (process as DaemonHeartbeatProcess);
  const intervalMs = options.intervalMs ?? AGENC_DAEMON_HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let beat = 0;
  let expectedAt = now() + intervalMs;
  const write = (lagMs: number): void => {
    beat += 1;
    const memory = proc.memoryUsage();
    const heartbeat: DaemonHeartbeat = {
      pid: proc.pid,
      beat,
      at: new Date(now()).toISOString(),
      uptimeS: Math.round(proc.uptime()),
      rssMb: Math.round(memory.rss / 1_048_576),
      heapUsedMb: Math.round(memory.heapUsed / 1_048_576),
      eventLoopLagMs: Math.round(lagMs),
    };
    try {
      writeDurableAtomicFileSync(
        options.path,
        `${options.path}.${proc.pid}.${randomUUID()}.tmp`,
        `${JSON.stringify(heartbeat, null, 2)}\n`,
      );
    } catch (error) {
      options.onError?.(error);
    }
  };
  write(0);
  const timer = setInterval(() => {
    const tickAt = now();
    const lagMs = Math.max(0, tickAt - expectedAt);
    expectedAt = tickAt + intervalMs;
    write(lagMs);
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(timer);
    try {
      if (readAgenCDaemonHeartbeat(options.path)?.pid === proc.pid) {
        rmSync(options.path, { force: true });
      }
    } catch {
      /* best-effort */
    }
  };
}

export function readAgenCDaemonHeartbeat(path: string): DaemonHeartbeat | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const numbers = ["pid", "beat", "uptimeS", "rssMb", "heapUsedMb", "eventLoopLagMs"] as const;
  if (!numbers.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))) {
    return null;
  }
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) return null;
  return record as unknown as DaemonHeartbeat;
}

/** One line for the status command: what the daemon last said about itself. */
export function describeDaemonHeartbeat(heartbeat: DaemonHeartbeat, nowMs: number): string {
  const ageS = Math.max(0, Math.round((nowMs - Date.parse(heartbeat.at)) / 1000));
  const uptime =
    heartbeat.uptimeS >= 3600
      ? `${Math.floor(heartbeat.uptimeS / 3600)} h ${Math.round((heartbeat.uptimeS % 3600) / 60)} min`
      : `${Math.round(heartbeat.uptimeS / 60)} min`;
  return (
    `the last daemon (pid ${heartbeat.pid}) sent its last heartbeat at ${heartbeat.at}, ${ageS} s ago: ` +
    `rss ${heartbeat.rssMb} MB, heap ${heartbeat.heapUsedMb} MB, event-loop lag ${heartbeat.eventLoopLagMs} ms, up ${uptime}`
  );
}

/**
 * Report the heartbeat a vanished daemon left behind. `pid` is the recorded
 * pid when there is one; a heartbeat from a different process is not reported
 * against it.
 */
export function reportLastDaemonHeartbeat(
  io: { readonly stderr: { write(text: string): unknown } },
  path: string,
  pid: number | null,
  nowMs: number = Date.now(),
): boolean {
  const heartbeat = readAgenCDaemonHeartbeat(path);
  if (heartbeat === null || (pid !== null && heartbeat.pid !== pid)) return false;
  io.stderr.write(`agenc: ${describeDaemonHeartbeat(heartbeat, nowMs)}\n`);
  return true;
}
