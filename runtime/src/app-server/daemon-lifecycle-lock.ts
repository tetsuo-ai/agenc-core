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

