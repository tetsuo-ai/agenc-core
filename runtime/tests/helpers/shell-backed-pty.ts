import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";

/**
 * A node-pty stand-in backed by a real process tree the test owns: a
 * detached shell (a session leader, like a real PTY child) running one
 * background `sleep`. kill() is node-pty's own implementation,
 * process.kill(this.pid, signal), on that real, positive pid.
 */
export interface ShellBackedPty {
  readonly pty: {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    readonly process: string;
    handleFlowControl: boolean;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(
      listener: (event: { exitCode: number; signal?: number }) => void,
    ): { dispose(): void };
    write(data: string): void;
    resize(columns: number, rows: number): void;
    clear(): void;
    pause(): void;
    resume(): void;
    kill(signal?: string): void;
  };
  readonly shellPid: number;
  readonly descendantPid: Promise<number>;
  readonly exited: Promise<void>;
  /** SIGKILL whatever is left of the tree. Safe to call more than once. */
  cleanup(): void;
}

export function spawnShellBackedPty(): ShellBackedPty {
  const shell: ChildProcess = spawn(
    "/bin/sh",
    ["-c", "sleep 30 & echo $!; wait"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const shellPid = shell.pid;
  if (shellPid === undefined || shellPid <= 1) {
    throw new Error("shell-backed PTY did not start");
  }
  const exited = new Promise<void>((resolve) => {
    shell.once("exit", () => resolve());
  });
  let reported: number | undefined;
  const descendantPid = new Promise<number>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error("shell-backed PTY did not report its child")),
      5_000,
    );
    shell.stdout!.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const match = /^(\d+)\n/.exec(text);
      if (match !== null && reported === undefined) {
        clearTimeout(timer);
        reported = Number(match[1]);
        resolve(reported);
      }
    });
  });
  const pty: ShellBackedPty["pty"] = {
    pid: shellPid,
    cols: 80,
    rows: 24,
    process: "sh",
    handleFlowControl: false,
    onData(listener) {
      const forward = (chunk: Buffer): void => listener(chunk.toString("utf8"));
      shell.stdout!.on("data", forward);
      return { dispose: () => shell.stdout!.off("data", forward) };
    },
    onExit(listener) {
      const forward = (code: number | null, signal: NodeJS.Signals | null): void => {
        listener({
          exitCode: code ?? 0,
          ...(signal === null ? {} : { signal: osConstants.signals[signal] }),
        });
      };
      shell.once("exit", forward);
      return { dispose: () => shell.off("exit", forward) };
    },
    write() {},
    resize() {},
    clear() {},
    pause() {},
    resume() {},
    kill(signal?: string) {
      try {
        process.kill(shellPid, signal ?? "SIGHUP");
      } catch {
        // node-pty swallows kill errors too.
      }
    },
  };
  return {
    pty,
    shellPid,
    descendantPid,
    exited,
    cleanup() {
      for (const pid of [-shellPid, reported]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },
  };
}

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntilProcessGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processIsRunning(pid);
}

export async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
