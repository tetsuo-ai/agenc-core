import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  captureProcessTreeDescendants,
  isProcessTreeAlive,
  signalProcessTree,
  spawnContainedProcess,
  terminateProcessTreeAndWait,
} from "../../../../utils/supervisedProcess.js";

export type NeovimProcessHandle = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
};

export type SpawnNeovimProcessOptions = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Force the deterministic broker boundary in Linux containment tests. */
  readonly linuxContainment?: "auto" | "subreaper";
};

const trackedHandles = new Set<NeovimProcessHandle>();
const trackedTeardowns = new WeakMap<
  ChildProcessWithoutNullStreams,
  Promise<void>
>();
let cleanupHookInstalled = false;

export function spawnNeovimProcess(options: SpawnNeovimProcessOptions): NeovimProcessHandle {
  const detached = process.platform !== "win32";
  const child = spawnContainedProcess(options.executable, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    ...(options.linuxContainment !== undefined
      ? { linuxContainment: options.linuxContainment }
      : {}),
  });
  const pid = normalizeNeovimPid(child.pid);
  const handle: NeovimProcessHandle = {
    child,
    pid,
    kill: (signal = "SIGTERM") => killNeovimChild(child, detached, signal),
  };
  if (pid > 0) trackNeovimProcess(handle);
  return handle;
}

export function normalizeNeovimPid(pid: number | undefined): number {
  return pid ?? 0;
}

export function killNeovimChild(
  child: ChildProcessWithoutNullStreams,
  detached: boolean,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  const exited = child.exitCode !== null || child.signalCode !== null;
  const pid = child.pid;
  if (!pid) {
    return exited || killDirectChild(child, signal);
  }
  if (
    exited &&
    process.platform !== "win32" &&
    !isProcessTreeAlive(child)
  ) {
    return true;
  }
  if (
    (detached || process.platform === "win32") &&
    (signal === "SIGTERM" || signal === "SIGKILL")
  ) {
    signalProcessTree(child, signal);
    return true;
  }
  return exited || killDirectChild(child, signal);
}

export function waitForNeovimExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (!child.pid) return Promise.resolve();
  const trackedTeardown = trackedTeardowns.get(child);
  if (trackedTeardown) return trackedTeardown;
  const teardown = waitForNeovimExitOnce(child, timeoutMs);
  trackedTeardowns.set(child, teardown);
  // A failed teardown must stay retryable. In particular,
  // NeovimStartupCleanupError.retryCleanup() can be called after the process
  // finally becomes killable; retaining the rejected promise here would make
  // every later attempt replay the original failure without rechecking the
  // available platform boundary.
  void teardown.catch(() => {
    if (trackedTeardowns.get(child) === teardown) {
      trackedTeardowns.delete(child);
    }
  });
  return teardown;
}

/**
 * Extend the retained fallback boundary while the Neovim leader is alive.
 * Linux cgroups and Windows Job Objects already provide a kernel-owned
 * lifetime boundary. Darwin has no equivalent public API, so interactive RPC
 * settlement records descendants which are still observable through the PPID
 * tree; an immediate double-fork/setsid escape remains outside that guarantee.
 */
export function captureNeovimProcessDescendants(
  child: ChildProcessWithoutNullStreams,
): void {
  if (process.platform === "darwin") {
    captureProcessTreeDescendants(child);
  }
}

async function waitForNeovimExitOnce(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  const graceMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 1;
  captureNeovimProcessDescendants(child);
  await waitForLeaderExitOrGrace(child, graceMs);
  try {
    await terminateProcessTreeAndWait(child, {
      terminateGraceMs: graceMs,
      killGraceMs: Math.max(100, graceMs),
      label: "Neovim process",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Neovim process tree survived forced shutdown")
    ) {
      throw new Error(
        `Neovim process ${normalizeNeovimPid(child.pid)} did not exit after SIGKILL`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function cleanupTrackedNeovimProcesses(signal: NodeJS.Signals = "SIGTERM"): void {
  const handles = [...trackedHandles];
  for (const handle of handles) {
    if (signal === "SIGKILL" && handle.kill(signal)) trackedHandles.delete(handle);
    else if (signal !== "SIGKILL") handle.kill(signal);
  }
  if (signal !== "SIGKILL") {
    for (const handle of handles) {
      if (handle.kill("SIGKILL")) trackedHandles.delete(handle);
    }
  }
}

export function getTrackedNeovimProcessCountForTesting(): number {
  return trackedHandles.size;
}

export function runTrackedNeovimProcessExitCleanupForTesting(): void {
  cleanupTrackedNeovimProcesses("SIGTERM");
}

function trackNeovimProcess(handle: NeovimProcessHandle): void {
  trackedHandles.add(handle);
  handle.child.once("exit", () => {
    // A detached leader can exit while plugins or jobs remain in a cgroup, Job
    // Object, process group, or retained observed-identity set. Reap the
    // available boundary asynchronously and keep its handle registered until
    // that platform-specific cleanup attempt has settled.
    const teardown = trackedTeardowns.get(handle.child) ??
      terminateProcessTreeAndWait(handle.child, {
        terminateGraceMs: 100,
        killGraceMs: 1_000,
        label: "Neovim process",
      });
    trackedTeardowns.set(handle.child, teardown);
    void teardown.then(
      () => {
        trackedHandles.delete(handle);
      },
      () => {
        // Keep the failed owner registered so the process-exit backstop still
        // attempts cgroup/Job teardown, but release the failed attempt so an
        // explicit cleanup retry performs a fresh ownership check.
        if (trackedTeardowns.get(handle.child) === teardown) {
          trackedTeardowns.delete(handle.child);
        }
      },
    );
  });
  if (cleanupHookInstalled) return;
  cleanupHookInstalled = true;
  process.once("exit", runTrackedNeovimProcessExitCleanupForTesting);
}

function killDirectChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function waitForLeaderExitOrGrace(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once("exit", finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}
