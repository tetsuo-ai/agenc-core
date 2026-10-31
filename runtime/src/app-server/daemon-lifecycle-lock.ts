/** Shared lifecycle publication barrier and mutation lock. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireLocalSqliteLock } from "../utils/sqlite-lock.js";
import { resolveAgenCDaemonHome } from "./daemon-discovery.js";
import type { AgenCDaemonCliHost } from "./daemon-control.js";

export async function withAgenCDaemonLifecycleLock<T>(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  operation: () => Promise<T>,
  retryWakeSignal?: AbortSignal,
): Promise<T> {
  const release = await acquireAgenCDaemonLifecycleLock(
    host, undefined, undefined, retryWakeSignal,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}


export function reportAgenCDaemonLifecycleLockProgress(
  onProgress:
    | ((phase: string) => void | PromiseLike<void>)
    | undefined,
  phase: string,
): void {
  try {
    const result = onProgress?.(phase);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Diagnostics must never change daemon lifecycle lock semantics.
  }
}


export async function acquireAgenCDaemonLifecycleLock(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  onProgress?: (phase: string) => void | PromiseLike<void>,
  timeoutMs = 120_000,
  retryWakeSignal?: AbortSignal,
): Promise<() => Promise<void>> {
  const deadline = performance.now() + timeoutMs;
  reportAgenCDaemonLifecycleLockProgress(
    onProgress,
    "daemon home resolution started",
  );
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  reportAgenCDaemonLifecycleLockProgress(
    onProgress,
    "daemon home resolution complete",
  );
  await mkdir(daemonHome, { recursive: true, mode: 0o700 });
  reportAgenCDaemonLifecycleLockProgress(
    onProgress,
    "daemon home creation complete",
  );
  const release = await acquireLocalSqliteLock(
    join(daemonHome, "daemon-lifecycle.lock.sqlite"),
    {
      label: "AgenC daemon lifecycle",
      timeoutMs,
      deadline,
      ...(retryWakeSignal === undefined ? {} : { retryWakeSignal }),
      ...(onProgress === undefined ? {} : { onProgress }),
    },
  );
  return async () => {
    release();
  };
}


export const AGENC_DAEMON_RESTART_LOCK_FILENAME = "daemon-restart.lock.sqlite";


/**
 * The daemon restart lock: one `daemon restart --when-idle` step at a time
 * for a home. A restart holds it from its first look at the daemon until the
 * replacement reported its build, through the stop and the spawn, so another
 * restart never sees the daemon between them. It is a separate lock because
 * the lifecycle lock cannot be held that long: the daemon's own shutdown
 * cleanup takes it. Released by the operating system when a process dies.
 * Never take it while holding the lifecycle lock.
 */
export async function acquireAgenCDaemonRestartLock(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  await mkdir(daemonHome, { recursive: true, mode: 0o700 });
  const release = await acquireLocalSqliteLock(
    join(daemonHome, AGENC_DAEMON_RESTART_LOCK_FILENAME),
    { label: "AgenC daemon restart", timeoutMs },
  );
  return async () => {
    release();
  };
}

