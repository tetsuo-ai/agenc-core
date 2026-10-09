import { expect, test } from "vitest";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";

test("fast commands retain output bounds, timeouts, cancellation and terminal cleanup", async () => {
  const manager = new UnifiedExecProcessManager();
  try {
    await withOneShotFastMode(async () => {
      const bounded = await manager.execCommand({ cmd: "printf '%050000d' 0", max_output_tokens: 50 });
      expect(bounded.exitCode).toBe(0);
      expect(bounded.truncated).toBe(true);
      expect(bounded.output.length).toBeLessThan(1500);
      const timed = await manager.execCommand({ cmd: "sleep 30", timeoutMs: 100, yield_time_ms: 1000 });
      expect(timed.timedOut).toBe(true);
      const abort = new AbortController();
      const pending = manager.execCommand({ cmd: "sleep 30", __abortSignal: abort.signal });
      setTimeout(() => abort.abort(new Error("cancel test")), 100);
      const cancelled = await pending;
      expect(cancelled.exitCode).not.toBe(0);
      expect(cancelled.process_id).toBeUndefined();
    });
  } finally { await manager.closeAll(); }
});
