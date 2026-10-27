import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";
import { OneShotProcessServer } from "../../src/unified-exec/one-shot-process-server.js";

it.each(["parent", "child", undefined])("uses the reusable executor only for its bound owner (%s)", async ownerId => {
  const root = mkdtempSync(join(tmpdir(), "fast-owner-"));
  const manager = new UnifiedExecProcessManager({ cwd: root });
  const spawn = vi.spyOn(OneShotProcessServer.prototype, "spawn").mockResolvedValue(undefined);
  const prepare = vi.spyOn(OneShotProcessServer.prototype, "prepare").mockResolvedValue(false);
  try {
    await withOneShotFastMode(async () => {
      await manager.prepareOneShotCommandBoundary(ownerId, undefined);
      const result = await manager.execCommand({ cmd: "printf owner-checked", login: false, ownerId, yield_time_ms: 1000 });
      expect(result.stdout).toBe("owner-checked");
    }, "parent");
    expect(prepare).toHaveBeenCalledTimes(ownerId === "parent" && process.platform === "linux" ? 1 : 0);
    expect(spawn).toHaveBeenCalledTimes(ownerId === "parent" ? 1 : 0);
  } finally {
    await manager.closeAll();
    spawn.mockRestore();
    prepare.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
