import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
};

const trackedHandles = new Set<NeovimProcessHandle>();
let cleanupHookInstalled = false;

export function spawnNeovimProcess(options: SpawnNeovimProcessOptions): NeovimProcessHandle {
  const detached = process.platform !== "win32";
  const child = spawn(options.executable, [...options.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
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
  if (detached && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (!exited) return killDirectChild(child, signal);
      return isMissingProcessError(error);
    }
  }
  return exited || killDirectChild(child, signal);
}

export function waitForNeovimExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let forceExitTimer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceExitTimer) clearTimeout(forceExitTimer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      killNeovimChild(child, process.platform !== "win32", "SIGKILL");
      if (settled) return;
      forceExitTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off("exit", finish);
        reject(
          new Error(
            `Neovim process ${normalizeNeovimPid(child.pid)} did not exit after SIGKILL`,
          ),
        );
      }, Math.max(100, timeoutMs));
    }, Math.max(1, timeoutMs));
    child.once("exit", finish);
  });
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
    // A detached leader can exit while plugins or jobs remain in its owned
    // process group. Tear down that group before releasing global ownership.
    if (handle.kill("SIGKILL")) trackedHandles.delete(handle);
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

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
