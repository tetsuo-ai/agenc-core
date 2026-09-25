/**
 * Subprocess wiring for the stdout frame ceiling (#2092). Frame-splitting
 * rules live in `newline-frame.test.ts`; this file covers run settlement,
 * listener cleanup, and child reaping at the production 16 MiB bound.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENC_SDK_MAX_FRAME_BYTES,
  promptViaSubprocess,
  type AgencSubprocessChild,
  type AgencSubprocessSpawnFn,
} from "../../../packages/agenc-sdk/src/index";

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
  readonly listenerCounts: () => {
    stdoutData: number;
    abort: number;
  };
  emitStdout(chunk: Buffer | string): void;
  emitStderr(chunk: string): void;
  exit(code?: number | null, signal?: string | null): void;
}

function createProgrammableChild(signal?: AbortSignal): ProgrammableChild {
  const processEmitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kills: string[] = [];

  const spawn: AgencSubprocessSpawnFn = () => {
    const stdoutStream = stdout as EventEmitter & {
      setEncoding: (encoding: string) => void;
      pause: () => void;
    };
    stdoutStream.setEncoding = () => {};
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
        kills.push(sig ?? "SIGTERM");
        return true;
      },
    };
    return child;
  };

  return {
    spawn,
    kills,
    listenerCounts: () => ({
      stdoutData: getEventListeners(stdout, "data").length,
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

    child.emitStderr("child-warning\n");
    child.emitStdout(Buffer.alloc(AGENC_SDK_MAX_FRAME_BYTES + 1, 0x61));
    const first = run.result();
    await expect(first).rejects.toThrow(/stdout frame exceeded 16777216 bytes/i);

    child.emitStdout(resultChunk("must-not-win"));
    child.exit(0);
    await expect(run.result()).rejects.toBe(await first.catch((error) => error));

    const drained = await drain(run);
    expect(drained).toBeInstanceOf(Error);
    expect((drained as Error).message).toMatch(/stdout frame exceeded/i);
    expect((drained as Error).message).not.toContain("a".repeat(64));
    expect((drained as Error).message).toContain("child-warning");
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(child.listenerCounts().stdoutData).toBe(0);
    expect(child.listenerCounts().abort).toBe(0);
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
});
