import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("SessionRouter strict rejection handling", () => {
  it.each(["first", "edit", "sync"])("survives %s adapter failure with a pending prompt", (mode) => {
    const home = mkdtempSync(join(tmpdir(), "agenc-router-strict-"));
    const runtimeRoot = join(import.meta.dirname, "../..");
    try {
      const result = spawnSync(process.execPath, [
        "--unhandled-rejections=strict", "--import", "tsx",
        join(import.meta.dirname, "fixtures/session-router-delivery.mjs"), home, mode,
      ], {
        cwd: runtimeRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(runtimeRoot, "tsconfig.json") },
        encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        mode, sends: mode === "edit" ? 2 : 1, retainedOriginalError: true,
      });
      expect(result.stderr).not.toContain("PromiseRejectionHandledWarning");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);
});
