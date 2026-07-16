import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SupervisedProcessStopReason =
  | "timeout"
  | "aborted"
  | "output_limit"
  | "consumer_limit"
  | "spawn_error"
  | "residual_process";

export interface SupervisedProcessCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly argv0?: string;
}

export interface SupervisedProcessControl {
  stop(reason?: "consumer_limit"): void;
}

export interface SupervisedProcessOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly terminateGraceMs?: number;
  readonly settleBackstopMs?: number;
  readonly onStdout?: (
    chunk: Buffer,
    control: SupervisedProcessControl,
  ) => void;
  readonly onStderr?: (
    chunk: Buffer,
    control: SupervisedProcessControl,
  ) => void;
}

export interface SupervisedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stopReason?: SupervisedProcessStopReason;
  readonly forced: boolean;
  readonly backstopExpired: boolean;
  readonly error?: Error;
}

const DEFAULT_TERMINATE_GRACE_MS = 500;
const DEFAULT_SETTLE_BACKSTOP_MS = 1_000;
const PROCESS_TREE_POLL_INTERVAL_MS = 20;

type ProcessTreeChild = Pick<
  ChildProcess,
  "pid" | "kill" | "exitCode" | "signalCode"
>;

export interface TerminateProcessTreeOptions {
  readonly terminateGraceMs?: number;
  readonly killGraceMs?: number;
  readonly label?: string;
}

/** Run a finite native helper with bounded output and process-tree cleanup. */
export function runSupervisedProcess(
  command: SupervisedProcessCommand,
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  validateLimits(options);
  if (options.signal?.aborted === true) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stopReason: "aborted",
      forced: false,
      backstopExpired: false,
    });
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.program, [...command.args], {
        cwd: command.cwd,
        env: command.env,
        argv0: command.argv0,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      child.stdin.end();
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stopReason: "spawn_error",
        forced: false,
        backstopExpired: false,
        error: toError(error),
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stopReason: SupervisedProcessStopReason | undefined;
    let forced = false;
    let settled = false;
    let closed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let processError: Error | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let backstopTimer: ReturnType<typeof setTimeout> | undefined;

    const control: SupervisedProcessControl = {
      stop: () => requestStop("consumer_limit"),
    };

    const append = (
      target: Buffer[],
      chunk: Buffer,
      callback: SupervisedProcessOptions["onStdout"],
    ): void => {
      if (settled) return;
      const remaining = options.maxOutputBytes - outputBytes;
      const accepted = remaining > 0
        ? chunk.subarray(0, Math.min(chunk.byteLength, remaining))
        : Buffer.alloc(0);
      if (accepted.byteLength > 0) {
        target.push(accepted);
        outputBytes += accepted.byteLength;
        try {
          callback?.(accepted, control);
        } catch (error) {
          processError = toError(error);
          requestStop("consumer_limit");
        }
      }
      if (accepted.byteLength < chunk.byteLength) requestStop("output_limit");
    };

    const finish = (backstopExpired: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (backstopTimer !== undefined) clearTimeout(backstopTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(stopReason !== undefined ? { stopReason } : {}),
        forced,
        backstopExpired,
        ...(processError !== undefined ? { error: processError } : {}),
      });
    };

    const maybeFinish = (): void => {
      if (!closed) return;
      if (stopReason !== undefined && isProcessTreeAlive(child)) return;
      finish(false);
    };

    function requestStop(reason: SupervisedProcessStopReason): void {
      stopReason ??= reason;
      signalProcessTree(child, "SIGTERM");
      if (forceTimer !== undefined) return;
      forceTimer = setTimeout(() => {
        forced = true;
        signalProcessTree(child, "SIGKILL");
        backstopTimer = setTimeout(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          finish(true);
        }, options.settleBackstopMs ?? DEFAULT_SETTLE_BACKSTOP_MS);
        backstopTimer.unref?.();
      }, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);
      forceTimer.unref?.();
    }

    const onAbort = (): void => requestStop("aborted");
    const timeoutTimer = setTimeout(
      () => requestStop("timeout"),
      options.timeoutMs,
    );
    timeoutTimer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort may race the pre-spawn check and listener installation.
    if (options.signal?.aborted === true) onAbort();

    child.stdout.on("data", (chunk: Buffer) =>
      append(stdout, chunk, options.onStdout)
    );
    child.stderr.on("data", (chunk: Buffer) =>
      append(stderr, chunk, options.onStderr)
    );
    child.once("error", (error) => {
      processError = error;
      requestStop("spawn_error");
      closed = true;
      maybeFinish();
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      closed = true;
      if (stopReason === undefined && isProcessTreeAlive(child)) {
        requestStop("residual_process");
      }
      maybeFinish();
    });
  });
}

function validateLimits(options: SupervisedProcessOptions): void {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("supervised process timeoutMs must be finite and positive");
  }
  if (!Number.isFinite(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    throw new Error("supervised process maxOutputBytes must be finite and positive");
  }
}

export function isProcessTreeAlive(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
): boolean {
  if (child.pid === undefined || process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  if (process.platform === "linux") {
    const procState = linuxProcessGroupHasLiveMember(child.pid);
    if (procState !== undefined) return procState;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a session-long process boundary and prove that its whole tree is gone.
 * Unlike waiting for the leader's `exit` event, this keeps checking the POSIX
 * process group so detached descendants cannot survive a workspace rebase.
 */
export async function terminateProcessTreeAndWait(
  child: ProcessTreeChild,
  options: TerminateProcessTreeOptions = {},
): Promise<void> {
  if (!isProcessTreeAlive(child)) return;
  signalProcessTree(child, "SIGTERM");
  if (
    await waitForProcessTreeExit(
      child,
      options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    )
  ) {
    return;
  }
  signalProcessTree(child, "SIGKILL");
  if (
    await waitForProcessTreeExit(
      child,
      options.killGraceMs ?? DEFAULT_SETTLE_BACKSTOP_MS,
    )
  ) {
    return;
  }
  throw new Error(
    `${options.label ?? "process"} tree survived forced shutdown` +
      (child.pid === undefined ? "" : ` (pid ${child.pid})`),
  );
}

export async function waitForProcessTreeExit(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("process tree wait timeoutMs must be finite and non-negative");
  }
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeAlive(child)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remaining));
    });
  }
  return true;
}

/** `kill(-pgid, 0)` counts zombies; they cannot execute and need no signal. */
function linuxProcessGroupHasLiveMember(pgid: number): boolean | undefined {
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try {
        stat = readFileSync(join("/proc", entry, "stat"), "utf8");
      } catch {
        continue;
      }
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) continue;
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
      const state = fields[0];
      const processGroup = Number.parseInt(fields[2] ?? "", 10);
      if (processGroup === pgid && state !== "Z" && state !== "X") return true;
    }
    return false;
  } catch {
    return undefined;
  }
}

export function signalProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (child.pid === undefined) {
    safeKill(child, signal);
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      safeKill(child, signal);
      return;
    }
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const taskkill = systemRoot === undefined
    ? undefined
    : join(systemRoot, "System32", "taskkill.exe");
  if (taskkill === undefined || !existsSync(taskkill)) {
    safeKill(child, signal);
    return;
  }
  const killer = spawn(
    taskkill,
    ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
    { stdio: "ignore", windowsHide: true },
  );
  let handled = false;
  const fallback = (): void => {
    if (handled) return;
    handled = true;
    safeKill(child, signal);
  };
  killer.once("error", fallback);
  killer.once("close", (code) => {
    if (code !== 0) fallback();
  });
}

function safeKill(
  child: Pick<ChildProcessWithoutNullStreams, "kill">,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    child.kill(signal);
  } catch {
    // The process has already exited.
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
