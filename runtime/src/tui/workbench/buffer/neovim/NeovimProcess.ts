import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type NeovimProcessHandle = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly kill: (signal?: NodeJS.Signals) => void;
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
  trackNeovimProcess(handle);
  return handle;
}

export function normalizeNeovimPid(pid: number | undefined): number {
  return pid ?? 0;
}

export function killNeovimChild(
  child: ChildProcessWithoutNullStreams,
  detached: boolean,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (child.killed) return;
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }
  try {
    if (detached && process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    child.kill(signal);
  }
}

export function waitForNeovimExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      killNeovimChild(child, process.platform !== "win32", "SIGKILL");
      finish();
    }, Math.max(1, timeoutMs));
    child.once("exit", finish);
  });
}

export function cleanupTrackedNeovimProcesses(signal: NodeJS.Signals = "SIGTERM"): void {
  const handles = [...trackedHandles];
  for (const handle of handles) {
    handle.kill(signal);
  }
  if (signal !== "SIGKILL") {
    for (const handle of handles) {
      handle.kill("SIGKILL");
    }
  }
  trackedHandles.clear();
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
    trackedHandles.delete(handle);
  });
  if (cleanupHookInstalled) return;
  cleanupHookInstalled = true;
  process.once("exit", runTrackedNeovimProcessExitCleanupForTesting);
}
