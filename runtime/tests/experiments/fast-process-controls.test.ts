import { expect, test, vi } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { OneShotProcessServer } from "../../src/unified-exec/one-shot-process-server.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";

test("fast commands retain output bounds, timeouts, cancellation and terminal cleanup", async () => {
  const manager = new UnifiedExecProcessManager();
  const ownerId = "fast-controls";
  const owner = manager.createOwnerLifetime(ownerId);
  const binding = { ownerId, ownerBinding: owner.bind() };
  const spawn = vi.spyOn(OneShotProcessServer.prototype, "spawn");
  try {
    await withOneShotFastMode(async () => {
      const bounded = await manager.execCommand({ ...binding, cmd: "printf '%050000d' 0", max_output_tokens: 50 });
      expect(bounded.exitCode).toBe(0);
      expect(bounded.truncated).toBe(true);
      expect(bounded.output.length).toBeLessThan(1500);
      const timed = await manager.execCommand({ ...binding, cmd: "sleep 30", timeoutMs: 100, yield_time_ms: 1000 });
      expect(timed.timedOut).toBe(true);
      const abort = new AbortController();
      const pending = manager.execCommand({ ...binding, cmd: "sleep 30", __abortSignal: abort.signal });
      setTimeout(() => abort.abort(new Error("cancel test")), 100);
      const cancelled = await pending;
      expect(cancelled.exitCode).not.toBe(0);
      expect(cancelled.process_id).toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(3);
    }, ownerId);
  } finally { await manager.closeAll(); spawn.mockRestore(); }
});
