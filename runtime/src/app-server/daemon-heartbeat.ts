import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_DURABLE_ATOMIC_ASYNC_OPERATIONS,
  writeDurableAtomicFile,
  writeDurableAtomicFileSync,
} from "../utils/durable-atomic-file.js";
import { readCgroupMemoryEvidence } from "./daemon-memory-evidence.js";

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
/**
 * A heartbeat older than this is stale: the process may still exist, but it
 * has missed several ticks, so `status` must not vouch for it.
 */
export const AGENC_DAEMON_HEARTBEAT_FRESH_MS = 3 * AGENC_DAEMON_HEARTBEAT_INTERVAL_MS;

export interface DaemonHeartbeat {
  readonly pid: number;
  readonly beat: number;
  readonly at: string;
  readonly uptimeS: number;
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly eventLoopLagMs: number;
  readonly cgroup?: Readonly<Record<string, number>>;
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
 * The heartbeat left behind by a daemon that died where no handler could run.
 * The replacement autostarts seconds later and its first beat overwrote the
 * file, so the only record of the exit was gone before anyone could read it
 * (#2199). A starting daemon moves it here, and nothing but the next such
 * exit replaces it.
 */
export const AGENC_DAEMON_PREVIOUS_HEARTBEAT_FILENAME =
  "daemon-heartbeat.prev.json";

export function resolveAgenCDaemonPreviousHeartbeatPath(
  daemonHome: string,
): string {
  return join(daemonHome, AGENC_DAEMON_PREVIOUS_HEARTBEAT_FILENAME);
}

export interface ClaimedDaemonHeartbeat {
  readonly heartbeat: DaemonHeartbeat;
  /**
   * Where the heartbeat was kept, or null when it could not be moved out of
   * the way of this daemon's first beat and is about to be overwritten.
   */
  readonly keptPath: string | null;
}

/**
 * Keep the heartbeat of the daemon this one replaced, and return it to be
 * reported. A clean stop removes the file, so a heartbeat whose process is
 * gone is an exit that ran no handler: a SIGKILL, or an abort with crash
 * reporting off. A heartbeat whose pid is still alive belongs to a live
 * daemon and is left where it is, so a takeover never blinds `status`.
 */
export function claimAbandonedDaemonHeartbeat(options: {
  readonly path: string;
  readonly previousPath: string;
  readonly pid: number;
  readonly isPidRunning: (pid: number) => boolean;
}): ClaimedDaemonHeartbeat | null {
  const heartbeat = readAgenCDaemonHeartbeat(options.path);
  if (heartbeat === null || heartbeat.pid === options.pid) return null;
  if (options.isPidRunning(heartbeat.pid)) return null;
  try {
    renameSync(options.path, options.previousPath);
  } catch {
    // Another starting daemon claimed it first, or it cannot be kept. Report
    // it only while it is still on disk, so a race does not report it twice.
    const current = readAgenCDaemonHeartbeat(options.path);
    if (current?.pid !== heartbeat.pid || current.beat !== heartbeat.beat) {
      return null;
    }
    return { heartbeat, keptPath: null };
  }
  return { heartbeat, keptPath: options.previousPath };
}

/**
 * The line a starting daemon writes about the exit it replaced. It names the
 * kept file only when the keep succeeded: pointing an operator at a path that
 * holds nothing is worse than leaving the record inline, which it already is.
 */
export function describeClaimedDaemonExit(
  claim: ClaimedDaemonHeartbeat,
  nowMs: number,
): string {
  return (
    describeAbandonedDaemonExit(claim.heartbeat, nowMs) +
    (claim.keptPath === null
      ? "; it could not be kept, so this line is all that is left of it"
      : `; kept at ${claim.keptPath}`)
  );
}

/** One line for the daemon's log and for `status`: which daemon this one replaced. */
export function describeAbandonedDaemonExit(
  heartbeat: DaemonHeartbeat,
  nowMs: number,
): string {
  return (
    `the previous daemon (pid ${heartbeat.pid}) exited without recording a reason; ` +
    `its last heartbeat was at ${heartbeat.at}, ` +
    `${describeHeartbeatAge(heartbeatAgeSeconds(heartbeat, nowMs))} ago: ` +
    describeDaemonHeartbeatVitals(heartbeat)
  );
}

/** The disposer of an installed heartbeat. */
export interface DaemonHeartbeatDisposer {
  (): void;
  /** Resolves once no beat is being written (tests, orderly shutdown). */
  readonly idle: () => Promise<void>;
}

/** A beat that found the heartbeat already stopped publishes nothing. */
class HeartbeatStoppedError extends Error {}

/**
 * Start the heartbeat. The event-loop lag is how late each tick fired against
 * its schedule: a loop blocked by synchronous work shows up here before the
 * process can miss anything else. Returns the disposer, which stops the timer
 * and removes the file so a clean stop leaves nothing to misreport.
 *
 * The first beat is written synchronously, so the file exists once this
 * returns. Every later beat is written off the event loop: its file write and
 * fsync, and the directory fsync after the rename, run on the libuv thread
 * pool, so a slow disk delays the beat instead of every request the daemon is
 * serving (an fsync of several hundred ms on a busy disk used to stall model
 * requests and tool results every five seconds). The rename itself runs on the
 * event loop, after the stop check, so a beat in flight when the heartbeat is
 * stopped can never publish a file the disposer already removed. At most one
 * beat is written at a time; a tick that finds the previous beat still in
 * flight is skipped.
 */
export function installAgenCDaemonHeartbeat(options: {
  readonly path: string;
  readonly intervalMs?: number;
  readonly proc?: DaemonHeartbeatProcess;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly cgroupMemory?: () => Readonly<Record<string, number>> | undefined;
}): DaemonHeartbeatDisposer {
  const proc = options.proc ?? (process as DaemonHeartbeatProcess);
  const intervalMs = options.intervalMs ?? AGENC_DAEMON_HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let beat = 0;
  let expectedAt = now() + intervalMs;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const record = (lagMs: number): string => {
    beat += 1;
    const memory = proc.memoryUsage();
    const cgroup = options.cgroupMemory?.() ?? (process.platform === "linux" ? readCgroupMemoryEvidence() : undefined);
    const heartbeat: DaemonHeartbeat = {
      pid: proc.pid,
      beat,
      at: new Date(now()).toISOString(),
      uptimeS: Math.round(proc.uptime()),
      rssMb: Math.round(memory.rss / 1_048_576),
      heapUsedMb: Math.round(memory.heapUsed / 1_048_576),
      eventLoopLagMs: Math.round(lagMs),
      ...(cgroup ? { cgroup } : {}),
    };
    return `${JSON.stringify(heartbeat, null, 2)}\n`;
  };
  const temporaryPath = (): string =>
    `${options.path}.${proc.pid}.${randomUUID()}.tmp`;
  try {
    writeDurableAtomicFileSync(options.path, temporaryPath(), record(0));
  } catch (error) {
    options.onError?.(error);
  }
  const operations = {
    ...DEFAULT_DURABLE_ATOMIC_ASYNC_OPERATIONS,
    rename: async (from: string, to: string): Promise<void> => {
      if (stopped) throw new HeartbeatStoppedError();
      renameSync(from, to);
    },
  };
  const timer = setInterval(() => {
    const tickAt = now();
    const lagMs = Math.max(0, tickAt - expectedAt);
    expectedAt = tickAt + intervalMs;
    if (inFlight !== undefined || stopped) return;
    const write = writeDurableAtomicFile(
      options.path, temporaryPath(), record(lagMs), 0o600, operations,
    ).catch((error: unknown) => {
      if (!(error instanceof HeartbeatStoppedError)) options.onError?.(error);
    }).finally(() => {
      if (inFlight === write) inFlight = undefined;
    });
    inFlight = write;
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  const dispose = (): void => {
    stopped = true;
    clearInterval(timer);
    try {
      if (readAgenCDaemonHeartbeat(options.path)?.pid === proc.pid) {
        rmSync(options.path, { force: true });
      }
    } catch {
      /* best-effort */
    }
  };
  return Object.assign(dispose, {
    idle: async (): Promise<void> => {
      while (inFlight !== undefined) await inFlight;
    },
  });
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
  const cgroup: Record<string, number> = {};
  if (record.cgroup && typeof record.cgroup === "object") {
    for (const key of ["currentBytes", "limitBytes", "peakBytes", "oom", "oom_kill", "oom_group_kill", "high", "max"]) {
      const value = (record.cgroup as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) cgroup[key] = value;
    }
  }
  return { pid: record.pid as number, beat: record.beat as number, at: new Date(record.at).toISOString(),
    uptimeS: record.uptimeS as number, rssMb: record.rssMb as number, heapUsedMb: record.heapUsedMb as number,
    eventLoopLagMs: record.eventLoopLagMs as number,
    ...(Object.keys(cgroup).length > 0 ? { cgroup } : {}) };
}

export function heartbeatAgeSeconds(heartbeat: DaemonHeartbeat, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - Date.parse(heartbeat.at)) / 1000));
}

export function isDaemonHeartbeatFresh(heartbeat: DaemonHeartbeat, nowMs: number): boolean {
  const ageMs = nowMs - Date.parse(heartbeat.at);
  return ageMs >= 0 ? ageMs <= AGENC_DAEMON_HEARTBEAT_FRESH_MS : true;
}

/**
 * Nothing expires the kept record, so its age is read months after the exit.
 * Raw seconds stop carrying that ("2678400 s ago"), so it is written the way
 * the uptime beside it on the same line is.
 */
function describeHeartbeatAge(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) {
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes === 0
      ? `${Math.floor(seconds / 3600)} h`
      : `${Math.floor(seconds / 3600)} h ${minutes} min`;
  }
  const hours = Math.floor((seconds % 86400) / 3600);
  return hours === 0
    ? `${Math.floor(seconds / 86400)} d`
    : `${Math.floor(seconds / 86400)} d ${hours} h`;
}

function describeUptime(uptimeS: number): string {
  return uptimeS >= 3600
    ? `${Math.floor(uptimeS / 3600)} h ${Math.round((uptimeS % 3600) / 60)} min`
    : `${Math.round(uptimeS / 60)} min`;
}

/** "rss 600 MB, heap 250 MB, event-loop lag 0 ms, up 27 min" */
export function describeDaemonHeartbeatVitals(heartbeat: DaemonHeartbeat): string {
  return (
    `rss ${heartbeat.rssMb} MB, heap ${heartbeat.heapUsedMb} MB, ` +
    `event-loop lag ${heartbeat.eventLoopLagMs} ms, up ${describeUptime(heartbeat.uptimeS)}` +
    (heartbeat.cgroup ? `, cgroup=${JSON.stringify(heartbeat.cgroup)}` : "")
  );
}

/** One line for the status command: what the daemon last said about itself. */
export function describeDaemonHeartbeat(heartbeat: DaemonHeartbeat, nowMs: number): string {
  return (
    `the last daemon (pid ${heartbeat.pid}) sent its last heartbeat at ${heartbeat.at}, ` +
    `${heartbeatAgeSeconds(heartbeat, nowMs)} s ago: ${describeDaemonHeartbeatVitals(heartbeat)}`
  );
}

/**
 * The status lines for a daemon that is alive and beating but has not
 * published its identity record: it is still starting (recovering its agent
 * runs, which takes a while under memory pressure) or the record was removed.
 * Lifecycle commands wait for the record; clients may already be connected.
 * Without this, `status` could only call such a pid indeterminate (#2225).
 */
export function describeUnboundDaemonHeartbeat(heartbeat: DaemonHeartbeat, nowMs: number): string {
  return (
    `AgenC daemon alive but not yet bound (pid ${heartbeat.pid})\n` +
    "  identity: not published yet (still starting, or the runtime record was removed); " +
    "lifecycle commands wait for it\n" +
    `  heartbeat: ${heartbeatAgeSeconds(heartbeat, nowMs)} s ago, ${describeDaemonHeartbeatVitals(heartbeat)}\n`
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
