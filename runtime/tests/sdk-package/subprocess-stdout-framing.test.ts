/**
 * Subprocess wiring for the stdout frame ceiling (#2092). Frame-splitting
 * rules live in `newline-frame.test.ts`; this file covers run settlement,
 * listener cleanup, and child reaping at the production 16 MiB bound.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENC_SDK_MAX_FRAME_BYTES,
  promptViaSubprocess,
  type AgencSubprocessChild,
  type AgencSubprocessSpawnFn,
} from "../../../packages/agenc-sdk/src/index";
import { STDOUT_OVERFLOW_KILL_GRACE_MS } from "../../../packages/agenc-sdk/src/subprocess";

const sessionId = "session_frame_1";
const agentId = "agent_frame_1";

const RESULT_LINE = {
  type: "result",
  sessionId,
  agentId,
  exitCode: 0,
  finalMessage: "ok",
  deniedPermissionRequestIds: [],
} as const;

function resultChunk(message = "ok"): Buffer {
  return Buffer.from(`${JSON.stringify({ ...RESULT_LINE, finalMessage: message })}\n`);
}

interface ProgrammableChild {
  readonly spawn: AgencSubprocessSpawnFn;
  readonly kills: string[];
  readonly stdoutEncodings: string[];
  readonly listenerCounts: () => {
    stdoutData: number;
    exit: number;
    abort: number;
  };
  emitStdout(chunk: Buffer | string): void;
  emitStderr(chunk: string): void;
  exit(code?: number | null, signal?: string | null): void;
}

function createProgrammableChild(
  signal?: AbortSignal,
  exitOnSigterm = false,
): ProgrammableChild {
  const processEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kills: string[] = [];
  const stdoutEncodings: string[] = [];

  const spawn: AgencSubprocessSpawnFn = () => {
    const stdoutStream = stdout as EventEmitter & {
      setEncoding: (encoding: string) => void;
      pause: () => void;
    };
    stdoutStream.setEncoding = (encoding: string) => {
      stdoutEncodings.push(encoding);
    };
    stdoutStream.pause = () => {};
    const stderrStream = stderr as EventEmitter & {
      setEncoding: (encoding: string) => void;
    };
    stderrStream.setEncoding = () => {};
    const child: AgencSubprocessChild = {
      stdin: {
        write: () => true,
        on: () => {},
        removeListener: () => {},
        end: () => {},
      },
      stdout: stdoutStream as unknown as AgencSubprocessChild["stdout"],
      stderr: stderrStream as unknown as AgencSubprocessChild["stderr"],
      on: (event: string, listener: (...args: never[]) => void) => {
        processEmitter.on(event, listener as (...args: unknown[]) => void);
        return child;
      },
      once: (event: string, listener: (...args: never[]) => void) => {
        processEmitter.once(event, listener as (...args: unknown[]) => void);
        return child;
      },
      removeListener: (event: string, listener: (...args: never[]) => void) => {
        processEmitter.removeListener(
          event,
          listener as (...args: unknown[]) => void,
        );
        return child;
      },
      kill: (sig?: string) => {
        const signalName = sig ?? "SIGTERM";
        kills.push(signalName);
        if (exitOnSigterm && signalName === "SIGTERM") {
          stdout.emit("end");
          processEmitter.emit("exit", null, "SIGTERM");
          processEmitter.emit("close", null, "SIGTERM");
        }
        return true;
      },
    };
    return child;
  };

  return {
    spawn,
    kills,
    stdoutEncodings,
    listenerCounts: () => ({
      stdoutData: getEventListeners(stdout, "data").length,
      exit: getEventListeners(processEmitter, "exit").length,
      abort:
        signal === undefined ? 0 : getEventListeners(signal, "abort").length,
    }),
    emitStdout: (chunk) => {
      stdout.emit("data", chunk);
    },
    emitStderr: (chunk) => {
      stderr.emit("data", chunk);
    },
    exit: (code = 0, sig = null) => {
      stdout.emit("end");
      processEmitter.emit("exit", code, sig);
      processEmitter.emit("close", code, sig);
    },
  };
}

async function drain(run: ReturnType<typeof promptViaSubprocess>): Promise<unknown> {
  try {
    for await (const event of run) {
      void event;
    }
    return await run.result();
  } catch (error) {
    return error;
  }
}

describe("SDK subprocess stdout frame limit", () => {
  it("accepts an exact-limit payload and a later valid result", async () => {
    const child = createProgrammableChild();
    const run = promptViaSubprocess("go", { spawn: child.spawn });

    child.emitStdout(
      Buffer.concat([
        Buffer.alloc(AGENC_SDK_MAX_FRAME_BYTES, 0x61),
        Buffer.from("\n"),
      ]),
    );
    child.emitStdout(resultChunk());
    child.exit(0);

    expect(child.stdoutEncodings).toEqual([]);
    await expect(run.result()).resolves.toMatchObject({
      exitCode: 0,
      finalMessage: "ok",
    });
  });

  it("settles overflow once, ignores a later result, and drops stdout listeners", async () => {
    const controller = new AbortController();
    const child = createProgrammableChild(controller.signal);
    const run = promptViaSubprocess("go", {
      spawn: child.spawn,
      signal: controller.signal,
    });
    expect(child.listenerCounts().stdoutData).toBe(1);
    expect(child.listenerCounts().abort).toBe(1);

    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      child.emitStderr("child-warning\n");
      child.emitStdout(Buffer.alloc(AGENC_SDK_MAX_FRAME_BYTES + 1, 0x61));
      const first = run.result();
      await expect(first).rejects.toThrow(/stdout frame exceeded 16777216 bytes/i);
      expect(child.kills).toEqual(["SIGTERM"]);
      await new Promise((resolve) => setTimeout(resolve, STDOUT_OVERFLOW_KILL_GRACE_MS + 30));
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(child.listenerCounts().exit).toBe(0);
      expect(processKill).not.toHaveBeenCalled();

      child.emitStdout(resultChunk("must-not-win"));
      child.exit(0);
      await expect(run.result()).rejects.toBe(await first.catch((error) => error));

      const drained = await drain(run);
      expect(drained).toBeInstanceOf(Error);
      expect((drained as Error).message).toMatch(/stdout frame exceeded/i);
      expect((drained as Error).message).not.toContain("a".repeat(64));
      expect((drained as Error).message).toContain("child-warning");
      expect(child.listenerCounts().stdoutData).toBe(0);
      expect(child.listenerCounts().abort).toBe(0);
    } finally {
      processKill.mockRestore();
    }
  });

  it("cancels an armed SIGKILL timer when a non-group child exits later", async () => {
    const child = createProgrammableChild();
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const run = promptViaSubprocess("go", { spawn: child.spawn });
      child.emitStdout(Buffer.alloc(AGENC_SDK_MAX_FRAME_BYTES + 1, 0x61));
      await expect(run.result()).rejects.toThrow(/stdout frame exceeded/i);
      expect(child.kills).toEqual(["SIGTERM"]);
      expect(child.listenerCounts().exit).toBe(1);
      child.exit(null, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, STDOUT_OVERFLOW_KILL_GRACE_MS + 30));
      expect(child.kills).toEqual(["SIGTERM"]);
      expect(child.listenerCounts().exit).toBe(0);
      expect(processKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });

  it("does not SIGKILL a child that exits on SIGTERM", async () => {
    const child = createProgrammableChild(undefined, true);
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const run = promptViaSubprocess("go", { spawn: child.spawn });
      child.emitStdout(Buffer.alloc(AGENC_SDK_MAX_FRAME_BYTES + 1, 0x61));
      await expect(run.result()).rejects.toThrow(/stdout frame exceeded/i);
      await new Promise((resolve) => setTimeout(resolve, STDOUT_OVERFLOW_KILL_GRACE_MS + 30));
      expect(child.kills).toEqual(["SIGTERM"]);
      expect(child.listenerCounts().exit).toBe(0);
      expect(processKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });
});

describe("SDK subprocess overflow reaps a real child", () => {
  const livePids = new Set<number>();

  afterEach(() => {
    for (const pid of livePids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already reaped
      }
    }
    livePids.clear();
  });

  it.skipIf(process.platform === "win32")(
    "terminates a newline-free overflowing writer",
    async () => {
      let childExit: Promise<void> | undefined;
      const spawn: AgencSubprocessSpawnFn = () => {
        const child = nodeSpawn(
          process.execPath,
          [
            "-e",
            `process.stdout.write(Buffer.alloc(${AGENC_SDK_MAX_FRAME_BYTES + 1}, 0x61)); setInterval(() => {}, 1000);`,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        if (child.pid !== undefined) livePids.add(child.pid);
        childExit = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(`overflowing child ${String(child.pid)} did not exit`),
            );
          }, 10_000);
          child.once("exit", () => {
            clearTimeout(timer);
            if (child.pid !== undefined) livePids.delete(child.pid);
            resolve();
          });
        });
        return child as unknown as AgencSubprocessChild;
      };

      const run = promptViaSubprocess("go", { spawn });
      await expect(run.result()).rejects.toThrow(
        /stdout frame exceeded 16777216 bytes/i,
      );
      await childExit;
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts an exact-limit frame of invalid UTF-8 from a real child",
    async () => {
      const encodings: string[] = [];
      const resultLine = `${JSON.stringify({ ...RESULT_LINE, finalMessage: "raw" })}\n`;
      const spawn: AgencSubprocessSpawnFn = () => {
        const child = nodeSpawn(
          process.execPath,
          [
            "-e",
            `process.stdout.write(Buffer.alloc(${AGENC_SDK_MAX_FRAME_BYTES}, 0xff)); process.stdout.write(${JSON.stringify(`\n${resultLine}`)});`,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        const stdout = child.stdout;
        if (stdout !== null) {
          const original = stdout.setEncoding.bind(stdout);
          stdout.setEncoding = ((encoding: BufferEncoding) => {
            encodings.push(encoding);
            return original(encoding);
          }) as typeof stdout.setEncoding;
        }
        if (child.pid !== undefined) livePids.add(child.pid);
        child.once("exit", () => {
          if (child.pid !== undefined) livePids.delete(child.pid);
        });
        return child as unknown as AgencSubprocessChild;
      };

      const run = promptViaSubprocess("go", { spawn });
      expect(encodings).toEqual([]);
      await expect(run.result()).resolves.toMatchObject({
        exitCode: 0,
        finalMessage: "raw",
      });
    },
  );
});
