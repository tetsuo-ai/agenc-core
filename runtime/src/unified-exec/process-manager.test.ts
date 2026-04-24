import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

import { UnifiedExecError, UnifiedExecProcessManager } from "./index.js";

const require = createRequire(import.meta.url);
const hasPtySupport = (() => {
  try {
    require.resolve("@homebridge/node-pty-prebuilt-multiarch");
    return true;
  } catch {
    return false;
  }
})();

describe("UnifiedExecProcessManager", () => {
  test("runs one-shot non-PTY commands without returning a session id", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });

    const result = await manager.execCommand({
      cmd: "printf agenc-codex",
      yield_time_ms: 250,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("agenc-codex");
    expect(result.process_id).toBeUndefined();
  });

  test("keeps non-PTY long-running commands pollable but stdin-closed", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
    try {
      const started = await manager.execCommand({
        cmd: "node -e \"setTimeout(()=>console.log('late-output'), 350)\"",
        yield_time_ms: 250,
      });

      expect(started.process_id).toEqual(expect.any(Number));
      await expect(
        manager.writeStdin({
          session_id: started.process_id!,
          chars: "ignored\n",
          yield_time_ms: 250,
        }),
      ).rejects.toMatchObject({
        code: "stdin_closed",
      } satisfies Partial<UnifiedExecError>);

      const polled = await manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
        yield_time_ms: 5_000,
      });
      expect(polled.stdout).toContain("late-output");
      expect(polled.process_id).toBeUndefined();
    } finally {
      await manager.closeAll("test_cleanup");
    }
  });

  test.runIf(hasPtySupport)(
    "persists PTY shell state across write_stdin calls",
    async () => {
      const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
      try {
        const started = await manager.execCommand({
          cmd: "bash -i",
          tty: true,
          yield_time_ms: 250,
        });

        expect(started.process_id).toEqual(expect.any(Number));
        const sessionId = started.process_id!;

        await manager.writeStdin({
          session_id: sessionId,
          chars: "export AGENC_UNIFIED_EXEC_TEST=ok\n",
          yield_time_ms: 250,
        });
        const echoed = await manager.writeStdin({
          session_id: sessionId,
          chars: "printf \"$AGENC_UNIFIED_EXEC_TEST\\n\"\n",
          yield_time_ms: 250,
        });

        expect(echoed.stdout).toContain("ok");
        expect(echoed.process_id).toBe(sessionId);
      } finally {
        await manager.closeAll("test_cleanup");
      }
    },
  );

  test.runIf(hasPtySupport)("closeAll terminates live PTY sessions", async () => {
    const manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
    const started = await manager.execCommand({
      cmd: "bash -i",
      tty: true,
      yield_time_ms: 250,
    });
    expect(started.process_id).toEqual(expect.any(Number));

    await manager.closeAll("test_cleanup");

    await expect(
      manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
      }),
    ).rejects.toMatchObject({
      code: "unknown_process",
    } satisfies Partial<UnifiedExecError>);
  });
});
