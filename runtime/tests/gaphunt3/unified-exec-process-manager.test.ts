import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { UnifiedExecProcessManager } from "src/unified-exec/process-manager";

// gaphunt3 #44: the per-command upstream-abort listener (the leak this fix
// addresses) is removed synchronously when the process settles. A SEPARATE,
// self-cleaning transient listener is attached by collect()'s yield `delay(...)`
// — the loser of the exit-vs-yield race — and is removed when its timer fires
// after yieldMs. We therefore assert the count returns to 0 *eventually* (which
// excludes that transient) rather than instantly. Revert-sensitive: if the fix
// is reverted, the per-command listeners never auto-remove and the count never
// reaches 0, so this times out and returns a non-zero count.
async function waitForNoAbortListeners(
  signal: AbortSignal,
  timeoutMs = 8_000,
): Promise<number> {
  const start = Date.now();
  while (
    getEventListeners(signal, "abort").length > 0 &&
    Date.now() - start < timeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return getEventListeners(signal, "abort").length;
}

// gaphunt3 #44: spawnProcess attaches an upstream-abort listener to the supplied
// (session-scoped, long-lived) AbortSignal. The previous `{ once: true }` only
// auto-removed that listener on the abort path; on the normal-exit path it was
// never removed, leaking one dead listener per exec_command/bash call on a signal
// whose EventEmitter caps at Node's default 10 listeners. The fix captures the
// listener and removes it when the process settles (complete()/releaseProcessId()).

describe("gaphunt3 #44: upstream-abort listener does not leak on normal exit", () => {
  let manager: UnifiedExecProcessManager | undefined;

  afterEach(async () => {
    await manager?.closeAll("test_cleanup");
    manager = undefined;
  });

  it(
    "removes the upstream-abort listener after each short command completes",
    async () => {
      manager = new UnifiedExecProcessManager({ cwd: process.cwd() });

      // One long-lived "session" signal reused for every command, mirroring the
      // real session.abortController whose signal is shared across all tool calls.
      const sessionAbort = new AbortController();
      const signal = sessionAbort.signal;

      expect(getEventListeners(signal, "abort")).toHaveLength(0);

      // Run more commands than Node's default maxListeners (10). Before the fix
      // each completed command left one dead 'abort' listener attached, so the
      // count would climb to N and Node would emit MaxListenersExceededWarning.
      const N = 12;
      for (let i = 0; i < N; i += 1) {
        const result = await manager.execCommand({
          cmd: "printf agenc-leak-check",
          yield_time_ms: 250,
          __abortSignal: signal,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("agenc-leak-check");
      }

      // With the fix every per-command listener is removed once its process
      // settles, so the shared session signal returns to zero abort listeners
      // (after the last command's transient yield-delay listener self-clears).
      // Before the fix this stays at N forever (one leaked listener per command).
      expect(await waitForNoAbortListeners(signal)).toBe(0);

      // The session signal was never aborted, so no command should have been
      // torn down by it.
      expect(signal.aborted).toBe(false);
    },
    15_000,
  );

  it(
    "still removes the listener for a long-running command released via writeStdin",
    async () => {
      manager = new UnifiedExecProcessManager({ cwd: process.cwd() });
      const sessionAbort = new AbortController();
      const signal = sessionAbort.signal;

      // A command that outlives the first yield, so it returns a session_id and
      // its slot is only released on a later poll once it has exited. This drives
      // the releaseProcessId() teardown path rather than the immediate-exit path.
      const started = await manager.execCommand({
        cmd: "node -e \"setTimeout(()=>console.log('done'), 300)\"",
        yield_time_ms: 200,
        __abortSignal: signal,
      });
      expect(started.process_id).toEqual(expect.any(Number));
      // While still running, the listener is attached.
      expect(getEventListeners(signal, "abort").length).toBeGreaterThan(0);

      const polled = await manager.writeStdin({
        session_id: started.process_id!,
        chars: "",
        yield_time_ms: 5_000,
        __abortSignal: signal,
      });
      expect(polled.stdout).toContain("done");
      // Slot released on the terminal poll -> the per-command listener is
      // removed (the transient yield-delay listener self-clears shortly after).
      expect(polled.process_id).toBeUndefined();
      expect(await waitForNoAbortListeners(signal)).toBe(0);
    },
    15_000,
  );
});
