import { execFile } from "node:child_process";

export interface ProcessOutputBrokenPipeEvent {
  readonly stream: "stdout" | "stderr";
  readonly error: NodeJS.ErrnoException;
}

interface ProcessOutputStream {
  destroy(): unknown;
  listeners(event: "error"): Function[];
  on(
    event: "error",
    listener: (error: NodeJS.ErrnoException) => void,
  ): unknown;
}

interface ProcessOutputHandlerState {
  readonly subscribers: Set<
    (event: ProcessOutputBrokenPipeEvent) => void
  >;
}

const PROCESS_OUTPUT_HANDLER_STATE = Symbol.for(
  "agenc.process-output-error-handler.state.v1",
);

function processOutputHandlerState(
  streamName: ProcessOutputBrokenPipeEvent["stream"],
  stream: ProcessOutputStream,
): ProcessOutputHandlerState {
  for (const candidate of stream.listeners("error")) {
    const existing = Reflect.get(candidate, PROCESS_OUTPUT_HANDLER_STATE) as
      | ProcessOutputHandlerState
      | undefined;
    if (existing?.subscribers instanceof Set) return existing;
  }

  const state: ProcessOutputHandlerState = {
    subscribers: new Set(),
  };
  const listener = (error: NodeJS.ErrnoException): void => {
    if (error.code !== "EPIPE") throw error;
    try {
      stream.destroy();
    } catch {
      // The downstream pipe is already gone; lifecycle subscribers still need
      // the cancellation signal even when a custom stream throws on destroy.
    }
    for (const subscriber of [...state.subscribers]) {
      subscriber({ stream: streamName, error });
    }
  };
  Object.defineProperty(listener, PROCESS_OUTPUT_HANDLER_STATE, {
    value: state,
  });
  stream.on("error", listener);
  return state;
}

/**
 * Own stdout/stderr EPIPE delivery without creating competing stream handlers.
 *
 * The underlying listener intentionally stays installed after `dispose()`: a
 * stream can emit a queued EPIPE after the one-shot lifecycle has completed.
 * Registrations add only scoped subscribers, while `Symbol.for` lets module
 * reloads reuse the same process-wide listener. Non-EPIPE failures are
 * rethrown so this adapter never hides unrelated output errors.
 */
export function registerProcessOutputErrorHandlers(
  onBrokenPipe: (event: ProcessOutputBrokenPipeEvent) => void,
  streams: {
    readonly stdout: ProcessOutputStream;
    readonly stderr: ProcessOutputStream;
  } = { stdout: process.stdout, stderr: process.stderr },
): { dispose(): void } {
  let notified = false;
  const subscriber = (event: ProcessOutputBrokenPipeEvent): void => {
    if (notified) return;
    notified = true;
    onBrokenPipe(event);
  };
  const stdoutState = processOutputHandlerState("stdout", streams.stdout);
  const stderrState = processOutputHandlerState("stderr", streams.stderr);
  stdoutState.subscribers.add(subscriber);
  stderrState.subscribers.add(subscriber);

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stdoutState.subscribers.delete(subscriber);
      stderrState.subscribers.delete(subscriber);
    },
  };
}

function writeOut(stream: NodeJS.WriteStream, data: string): void {
  if (stream.destroyed) {
    return;
  }
  stream.write(data);
}

export function writeToStdout(data: string): void {
  writeOut(process.stdout, data);
}

/**
 * Write a message to stderr. Used by AgenC-owned utilities
 * (e.g. debug.ts) for low-level logging before the normal logger is
 * available. Synchronous to match the callers' expectations.
 */
export function writeToStderr(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    // Ignore — stderr may be closed during shutdown.
  }
}

export function exitWithError(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(message);
  process.exit(1);
}

export function peekForStdinData(
  stream: NodeJS.EventEmitter,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const done = (timedOut: boolean) => {
      clearTimeout(peek);
      stream.off("end", onEnd);
      stream.off("data", onFirstData);
      resolve(timedOut);
    };
    const onEnd = () => done(false);
    const onFirstData = () => clearTimeout(peek);
    const peek = setTimeout(done, ms, true);
    stream.once("end", onEnd);
    stream.once("data", onFirstData);
  });
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a subprocess and collect stdout/stderr without throwing on non-zero exit.
 */
export function runCommand(
  cmd: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const {
    cwd,
    timeoutMs,
    maxBuffer = 10 * 1024 * 1024,
    env = process.env,
  } = options;

  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        env,
      },
      (error, stdout, stderr) => {
        const code = (
          error as NodeJS.ErrnoException & { code?: number | string }
        )?.code;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error
            ? code === "ETIMEDOUT"
              ? 124
              : (child.exitCode ?? 1)
            : 0,
        });
      },
    );
  });
}
