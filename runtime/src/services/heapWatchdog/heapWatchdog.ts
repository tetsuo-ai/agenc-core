/**
 * Heap watchdog — OOM self-diagnosis for long-lived agenc processes.
 *
 * V8 aborts the process when the old-space limit is hit, so an OOM normally
 * leaves nothing behind but a native stack trace: no user-facing warning and
 * no way to tell WHAT was retaining memory.
 *
 * Capture itself is delegated to V8's `--heapsnapshot-near-heap-limit`
 * (armed by the install wrapper with `--diagnostic-dir` pointed at
 * `$AGENC_HOME/oom-snapshots`): it runs inside the GC, so it still fires in
 * the end-stage GC death spiral where JS timers starve — an in-process
 * `writeHeapSnapshot` at high pressure was measured to die mid-write there.
 *
 * This module owns the parts that ARE reliable from the event loop:
 *   - an early high-memory warning (once per crossing) while the process is
 *     still healthy;
 *   - a startup notice pointing at a fresh snapshot from a previous crash;
 *   - pruning the snapshot directory so captures never accumulate unbounded.
 *
 * Everything effectful is injectable for tests; decision helpers are pure.
 */
import { getHeapStatistics } from "node:v8";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const OOM_SNAPSHOT_DIRNAME = "oom-snapshots";
const SNAPSHOT_SUFFIX = ".heapsnapshot";

export const HEAP_CHECK_INTERVAL_MS = 10_000;
export const HEAP_WARN_RATIO = 0.75;
export const SNAPSHOTS_TO_KEEP = 2;
/** A snapshot younger than this at startup earns a "previous OOM" notice. */
export const RECENT_SNAPSHOT_NOTICE_MS = 24 * 60 * 60_000;

export type HeapPressure = "normal" | "warn";

/** Pure: classify heap usage against the limit. */
export function classifyHeapPressure(
  usedBytes: number,
  limitBytes: number,
): HeapPressure {
  if (limitBytes <= 0) return "normal";
  return usedBytes / limitBytes >= HEAP_WARN_RATIO ? "warn" : "normal";
}

export function oomSnapshotDir(agencHome: string): string {
  return join(agencHome, OOM_SNAPSHOT_DIRNAME);
}

/** V8's near-heap-limit snapshots are named `Heap.<date>.<pid>....heapsnapshot`. */
export function isSnapshotFileName(name: string): boolean {
  return name.endsWith(SNAPSHOT_SUFFIX);
}

/**
 * Delete all but the newest `keep` snapshots in `dir` (by mtime). Best-effort:
 * failures are ignored so housekeeping can never take the host process down.
 */
export function pruneSnapshots(dir: string, keep: number): void {
  let entries: Array<{ name: string; mtimeMs: number }>;
  try {
    entries = readdirSync(dir)
      .filter(isSnapshotFileName)
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
  } catch {
    return;
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
    try {
      unlinkSync(join(dir, entry.name));
    } catch {
      // best-effort
    }
  }
}

/** Newest snapshot in the home's oom dir, or null. */
export function newestSnapshot(
  agencHome: string,
): { readonly path: string; readonly mtimeMs: number } | null {
  const dir = oomSnapshotDir(agencHome);
  let best: { path: string; mtimeMs: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(dir).filter(isSnapshotFileName);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const path = join(dir, name);
      const mtimeMs = statSync(path).mtimeMs;
      if (best === null || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    } catch {
      // skip unreadable entries
    }
  }
  return best;
}

/**
 * One-line startup notice when a recent OOM snapshot exists, else null.
 * "Recent" avoids nagging forever about a months-old capture.
 */
export function recentOomSnapshotNotice(
  agencHome: string,
  nowMs: number = Date.now(),
): string | null {
  const newest = newestSnapshot(agencHome);
  if (newest === null) return null;
  if (nowMs - newest.mtimeMs > RECENT_SNAPSHOT_NOTICE_MS) return null;
  return (
    `agenc: a previous session ran out of memory — heap snapshot saved at ` +
    `${newest.path} (attach it to a bug report, then delete it)`
  );
}

export interface HeapWatchdogOptions {
  readonly agencHome: string;
  /** Warn sink; defaults to stderr-safe console.warn. */
  readonly warn?: (message: string) => void;
  /** Injectable stats for tests. */
  readonly heapStats?: () => { usedBytes: number; limitBytes: number };
  readonly intervalMs?: number;
}

export interface HeapWatchdogHandle {
  stop(): void;
  /** Test seam: run one check synchronously. */
  checkOnce(): HeapPressure;
}

/**
 * Start the watchdog. Prunes any accumulated snapshots once, then samples on
 * an unref'd interval (never keeps the process alive). All failure paths are
 * swallowed — diagnostics must never crash the host process.
 */
export function startHeapWatchdog(
  options: HeapWatchdogOptions,
): HeapWatchdogHandle {
  const warn =
    options.warn ??
    ((message: string) => {
      try {
        console.warn(message);
      } catch {
        // stderr gone — nothing sane to do
      }
    });
  const stats =
    options.heapStats ??
    (() => {
      const s = getHeapStatistics();
      return { usedBytes: s.used_heap_size, limitBytes: s.heap_size_limit };
    });

  try {
    pruneSnapshots(oomSnapshotDir(options.agencHome), SNAPSHOTS_TO_KEEP);
  } catch {
    // best-effort
  }

  let warned = false;
  const checkOnce = (): HeapPressure => {
    let pressure: HeapPressure = "normal";
    try {
      const { usedBytes, limitBytes } = stats();
      pressure = classifyHeapPressure(usedBytes, limitBytes);
      if (pressure === "normal") {
        warned = false;
        return pressure;
      }
      if (!warned) {
        warned = true;
        const usedMb = Math.round(usedBytes / 1048576);
        const limitMb = Math.round(limitBytes / 1048576);
        warn(
          `agenc: heap usage high (${usedMb}MB of ${limitMb}MB limit) — ` +
            `if this keeps climbing the process will run out of memory`,
        );
      }
    } catch {
      // Never let diagnostics take down the host process.
    }
    return pressure;
  };

  const timer = setInterval(
    checkOnce,
    options.intervalMs ?? HEAP_CHECK_INTERVAL_MS,
  );
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
    checkOnce,
  };
}
