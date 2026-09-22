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

interface FailingSpawnOptions extends FailedSpawnChildOptions {
  /**
   * Runs inside the spawn call, after Node would have wired its `signal`
   * option: the place to abort "in the same tick as the failed spawn".
   */
  readonly onSpawn?: (child: FailedSpawnChild) => void;
}

/**
 * A spawn replacement that fails every call. Each child is created when the
 * code under test calls spawn, because Node schedules the failure report
 * from the spawn call: a child created earlier, before code that awaits,
 * would report before anyone could listen. A `signal` in the spawn options
 * is handled the way Node's spawn handles it.
 */
export function failingSpawn(options: FailingSpawnOptions = {}): {
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
      const spawnOptions = (Array.isArray(args[1]) ? args[2] : args[1]) as
        | { readonly signal?: AbortSignal; readonly killSignal?: NodeJS.Signals | number }
        | undefined;
      const child = createFailedSpawnChild({
        ...options,
        ...(command !== undefined ? { command } : {}),
        ...(argv !== undefined ? { args: argv } : {}),
        ...(spawnOptions?.signal !== undefined
          ? { abortSignal: spawnOptions.signal }
          : {}),
        ...(spawnOptions?.killSignal !== undefined
          ? { killSignal: spawnOptions.killSignal }
          : {}),
      });
      children.push(child);
      options.onSpawn?.(child);
      return child;
    },
  };
}

/**
 * An execFile replacement that fails every call, built on the same stand-in.
 * Like Node's execFile it hands only `signal` (not `killSignal`) to spawn,
 * and calls back once, with the first error or the close.
 */
export function failingExecFile(options: FailingSpawnOptions = {}): {
  readonly children: FailedSpawnChild[];
  readonly execFile: (...args: unknown[]) => FailedSpawnChild;
} {
  const children: FailedSpawnChild[] = [];
  return {
    children,
    execFile: (...args: unknown[]) => {
      const rest = [...args];
      const callback =
        typeof rest.at(-1) === "function"
          ? (rest.pop() as (error: Error | null, stdout: string, stderr: string) => void)
          : undefined;
      const command = typeof rest[0] === "string" ? rest[0] : options.command;
      const argv = Array.isArray(rest[1])
        ? (rest[1] as readonly unknown[]).map(String)
        : options.args;
      const execOptions = (Array.isArray(rest[1]) ? rest[2] : rest[1]) as
        | { readonly signal?: AbortSignal }
        | undefined;
      const child = createFailedSpawnChild({
        ...options,
        ...(command !== undefined ? { command } : {}),
        ...(argv !== undefined ? { args: argv } : {}),
        ...(execOptions?.signal !== undefined
          ? { abortSignal: execOptions.signal }
          : {}),
      });
      let calledBack = false;
      const finish = (error: Error | null): void => {
        if (calledBack) return;
        calledBack = true;
        callback?.(error, "", "");
      };
      child.on("error", (error: Error) => finish(error));
      child.on("close", (code: number | null) => {
        finish(
          code === 0
            ? null
            : Object.assign(new Error(`Command failed: ${command}`), { code }),
        );
      });
      children.push(child);
      options.onSpawn?.(child);
      return child;
    },
  };
}

interface FailedSpawnChildOptions {
  readonly code?: FailedSpawnCode;
  readonly command?: string;
  readonly args?: readonly string[];
  /** Pipes for ENOENT, EACCES and EAGAIN (default 3). */
  readonly pipes?: number;
  /** spawn's `signal` option, handled as Node's spawn handles it. */
  readonly abortSignal?: AbortSignal;
  /** spawn's `killSignal` option (what an abort sends). */
  readonly killSignal?: NodeJS.Signals | number;
}

export function createFailedSpawnChild(
  options: FailedSpawnChildOptions = {},
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
      groupSignals.push(signal ?? "SIGTERM");
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

  // Scheduled first, as Node schedules it inside the spawn call.
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

  // What Node's spawn does with its `signal` option (lib/child_process.js,
  // abortChildProcess): an abort calls child.kill(killSignal) and, when that
  // returns true, reports an AbortError on the child. An already-aborted
  // signal is handled on the next tick, after the failure report above.
  const abortSignal = options.abortSignal;
  if (abortSignal !== undefined) {
    const onAbort = (): void => {
      try {
        if (child.kill(options.killSignal)) {
          deliver(
            "error",
            Object.assign(new Error("The operation was aborted", { cause: abortSignal.reason }), {
              name: "AbortError",
              code: "ABORT_ERR",
            }),
          );
        }
      } catch (error) {
        deliver("error", error);
      }
    };
    if (abortSignal.aborted) {
      process.nextTick(onAbort);
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      emitter.once("exit", () => abortSignal.removeEventListener("abort", onAbort));
    }
  }

  return child;
}

/**
 * A started-looking child whose handle reports `pid` (0, -1, 1, ...), with
 * pipes. Its kill() records the signal and never sends one: the point of a
 * test using it is that a handle reporting an unsafe pid is not signalled.
 */
export interface PidStandIn extends ChildProcess {
  readonly signals: Array<NodeJS.Signals | number | undefined>;
}

export function createPidStandIn(pid: number): PidStandIn {
  const pipes = [new PassThrough(), new PassThrough(), new PassThrough()];
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    connected: false,
    stdio: pipes,
    stdin: pipes[0],
    stdout: pipes[1],
    stderr: pipes[2],
    signals,
    kill(signal?: NodeJS.Signals | number): boolean {
      signals.push(signal ?? "SIGTERM");
      return true;
    },
    ref(): void {},
    unref(): void {},
  }) as unknown as PidStandIn;
}
