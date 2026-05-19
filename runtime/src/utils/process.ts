import { execFile } from "node:child_process";

function handleEPIPE(
  stream: NodeJS.WriteStream,
): (err: NodeJS.ErrnoException) => void {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      stream.destroy();
    }
  };
}

export function registerProcessOutputErrorHandlers(): void {
  process.stdout.on("error", handleEPIPE(process.stdout));
  process.stderr.on("error", handleEPIPE(process.stderr));
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
