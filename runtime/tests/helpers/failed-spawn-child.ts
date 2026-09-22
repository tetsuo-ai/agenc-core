import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants as osConstants } from "node:os";
import { PassThrough } from "node:stream";

export type FailedSpawnCode = "ENOENT" | "EACCES" | "EAGAIN" | "EMFILE" | "ENFILE";

/**
 * Stand-in for the ChildProcess Node returns when spawn fails with ENOENT,
 * EACCES, EAGAIN, EMFILE or ENFILE, with the shape the real one has until
 * Node reports the failure on the next tick:
 *
 * - `pid` is undefined, but the handle is open, so a real `kill()` in that
 *   window becomes kill(0, signal) and signals the caller's whole process
 *   group. This stand-in never signals anything; it records the signal in
 *   `groupSignals` instead.
 * - EMFILE and ENFILE leave `stdio`, `stdin`, `stdout` and `stderr`
 *   undefined. The other codes still create the pipes.
 * - On the next tick `exitCode` becomes the negative errno, `error` is
 *   emitted (never `exit`), then `close`. With no `error` listener, or a
 *   listener that throws, Node raises an uncaught exception: this stand-in
 *   records it in `uncaught` so a test can assert on it without crashing
 *   the test runner.
 */
export interface FailedSpawnChild extends ChildProcess {
  readonly groupSignals: Array<NodeJS.Signals | number | undefined>;
  readonly uncaught: unknown[];
  /** Settles after `error` and `close` were delivered. */
  readonly reported: Promise<void>;
}

/**
 * A spawn replacement that fails every call. Each child is created when the
 * code under test calls spawn, because Node schedules the failure report
 * from the spawn call: a child created earlier, before code that awaits,
 * would report before anyone could listen.
 */
export function failingSpawn(
  options: Parameters<typeof createFailedSpawnChild>[0] = {},
): {
  readonly children: FailedSpawnChild[];
  readonly spawn: (...args: unknown[]) => FailedSpawnChild;
} {
  const children: FailedSpawnChild[] = [];
  return {
    children,
    spawn: (...args: unknown[]) => {
      const command = typeof args[0] === "string" ? args[0] : options.command;
      const argv = Array.isArray(args[1])
        ? (args[1] as readonly unknown[]).map(String)
        : options.args;
      const child = createFailedSpawnChild({
        ...options,
        ...(command !== undefined ? { command } : {}),
        ...(argv !== undefined ? { args: argv } : {}),
      });
      children.push(child);
      return child;
    },
  };
}

export function createFailedSpawnChild(
  options: {
    readonly code?: FailedSpawnCode;
    readonly command?: string;
    readonly args?: readonly string[];
    /** Pipes for ENOENT, EACCES and EAGAIN (default 3). */
    readonly pipes?: number;
  } = {},
): FailedSpawnChild {
  const code = options.code ?? "EMFILE";
  const command = options.command ?? "agenc-test-program";
  const errno = osConstants.errno[code];
  const emitter = new EventEmitter();
  const groupSignals: Array<NodeJS.Signals | number | undefined> = [];
  const uncaught: unknown[] = [];
  let handleOpen = true;

  const stdioMissing = code === "EMFILE" || code === "ENFILE";
  const pipes = stdioMissing
    ? undefined
    : Array.from({ length: options.pipes ?? 3 }, () => new PassThrough());

  let resolveReported!: () => void;
  const reported = new Promise<void>((resolve) => {
    resolveReported = resolve;
  });

  const child = Object.assign(emitter, {
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    connected: false,
    spawnfile: command,
    spawnargs: [command, ...(options.args ?? [])],
    stdio: pipes,
    stdin: pipes?.[0],
    stdout: pipes?.[1],
    stderr: pipes?.[2],
    groupSignals,
    uncaught,
    reported,
    kill(signal?: NodeJS.Signals | number): boolean {
      if (!handleOpen) return false;
      // The real handle would deliver this to kill(0, signal).
      groupSignals.push(signal);
      return true;
    },
    ref(): void {},
    unref(): void {},
    disconnect(): void {},
    send(): boolean {
      return false;
    },
  }) as unknown as FailedSpawnChild;

  const deliver = (event: string, ...args: unknown[]): void => {
    if (event === "error" && emitter.listenerCount("error") === 0) {
      uncaught.push(args[0]);
      return;
    }
    try {
      emitter.emit(event, ...args);
    } catch (error) {
      uncaught.push(error);
    }
  };

  process.nextTick(() => {
    handleOpen = false;
    (child as { exitCode: number | null }).exitCode = -errno;
    child.stdin?.destroy();
    const error = Object.assign(new Error(`spawn ${command} ${code}`), {
      errno: -errno,
      code,
      syscall: `spawn ${command}`,
      path: command,
      spawnargs: [...(options.args ?? [])],
    });
    deliver("error", error);
    for (const pipe of pipes?.slice(1) ?? []) pipe.end();
    setImmediate(() => {
      deliver("close", -errno, null);
      resolveReported();
    });
  });

  return child;
}
