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

  test("force-kills abandoned non-tty processes once maxTimeoutMs elapses", async () => {
    // Regression: a non-tty exec_command with no explicit timeoutMs used to
    // have no hard kill — the model could yield and forget, leaving the
    // child running indefinitely. We saw this in the wild with three
    // `./agenc -c 'echo hi' --dump-tokens` zombies burning ~97% CPU each
    // for 95+ minutes after the agent moved on. Codex always enforces a
    // timeout (codex-rs/core/src/exec.rs `consume_output`); we now do too.
    const manager = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      maxTimeoutMs: 400,
    });
    try {
      const started = await manager.execCommand({
        cmd: "node -e \"setInterval(()=>{}, 1000)\"",
        yield_time_ms: 250,
      });
      // Yielded while still running — model gets a session_id.
      expect(started.process_id).toEqual(expect.any(Number));
      // Wait past the hard timeout, then poll. The hard-kill caused the
      // child to exit; the next writeStdin observes the terminal exitState
      // and returns the final result with no process_id (indicating the
      // session is gone). exit_code is null because the kernel killed the
      // child by signal rather than letting it exit cleanly.
      await new Promise((r) => setTimeout(r, 800));
      const polled = await manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
        yield_time_ms: 250,
      });
      expect(polled.process_id).toBeUndefined();
      expect(polled.exit_code).toBeNull();
      // And the slot is fully released — a second poll should now reject.
      await expect(
        manager.writeStdin({
          session_id: started.process_id!,
          chars: "",
          yield_time_ms: 250,
        }),
      ).rejects.toMatchObject({
        code: "unknown_process",
      } satisfies Partial<UnifiedExecError>);
    } finally {
      await manager.closeAll("test_cleanup");
    }
  });

  test("respects explicit timeoutMs for tty calls (default does not apply)", async () => {
    // tty=true is the interactive-session path — codex doesn't have a
    // direct analog because codex exec is always one-shot. We deliberately
    // exempt tty from the default hard timeout so persistent shells stay
    // alive across write_stdin polls. This test asserts that exemption.
    if (!hasPtySupport) return;
    const manager = new UnifiedExecProcessManager({
      cwd: process.cwd(),
      maxTimeoutMs: 200,
    });
    try {
      const started = await manager.execCommand({
        cmd: "bash -i",
        tty: true,
        yield_time_ms: 250,
      });
      expect(started.process_id).toEqual(expect.any(Number));
      // Wait past `maxTimeoutMs`. The session should still be alive.
      await new Promise((r) => setTimeout(r, 500));
      const polled = await manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
        yield_time_ms: 250,
      });
      expect(polled.process_id).toBe(started.process_id);
    } finally {
      await manager.closeAll("test_cleanup");
    }
  });

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
