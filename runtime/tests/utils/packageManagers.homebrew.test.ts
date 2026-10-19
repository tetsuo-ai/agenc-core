import { describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  detectHomebrew,
  getPackageManager,
} from "../../src/utils/nativeInstaller/packageManagers.js";

describe("Homebrew AgenC formula detection", () => {
  test.each([
    "/opt/homebrew/Cellar/agenc/0.11.0/libexec/node_modules/.agenc-node/bin/node",
    "/usr/local/Cellar/agenc/0.11.0_1/libexec/node_modules/.agenc-node/bin/node",
    "/opt/homebrew/Cellar/agenc/0.11.0/libexec/node_modules/@tetsuo-ai/runtime/bin/agenc",
    "/opt/homebrew/opt/agenc/libexec/node_modules/.agenc-node/bin/node",
    "/opt/homebrew/Cellar/agenc/0.11.0/bin/agenc",
    "/opt/homebrew/opt/agenc/bin/agenc",
    "/home/linuxbrew/.linuxbrew/Cellar/agenc/0.19.11/libexec/node_modules/@tetsuo-ai/runtime/dist/bin/agenc.js",
    "/custom/brew/opt/agenc/libexec/node_modules/@tetsuo-ai/runtime/dist/bin/agenc.js",
  ])("recognizes the restored formula path %s", executablePath => {
    expect(
      detectHomebrew({
        platform: "macos",
        executablePaths: [executablePath],
      }),
    ).toBe(true);
  });

  test("resolves entry symlinks and does not trust a Homebrew-looking alias", () => {
    const root = mkdtempSync(join(tmpdir(), "brew-detect-"));
    try {
      const entry = join(root, "Cellar/agenc/0.19.11/libexec/node_modules/@tetsuo-ai/runtime/bin/agenc");
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, "");
      const alias = join(root, "agenc");
      symlinkSync(entry, alias);
      expect(detectHomebrew({ platform: "linux", executablePaths: [alias] })).toBe(true);
      rmSync(alias);
      rmSync(entry);
      writeFileSync(alias, "");
      symlinkSync(alias, entry);
      expect(detectHomebrew({ platform: "linux", executablePaths: [entry] })).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Homebrew environment variables alone do not identify an npm installation", () => {
    vi.stubEnv("HOMEBREW_PREFIX", "/opt/homebrew");
    try {
      expect(detectHomebrew({ platform: "linux", executablePaths: ["/usr/bin/node", "/home/user/.agenc/runtime/0.19.11/node_modules/@tetsuo-ai/runtime/bin/agenc"] })).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  test.each([
    "/opt/homebrew/Cellar/node/26.5.0/bin/node",
    "/opt/homebrew/lib/node_modules/@tetsuo-ai/agenc/bin/agenc",
    "/opt/homebrew/Cellar/agenc/0.11.0/bin/node",
    "/tmp/Cellar/agenc/0.11.0/libexec/node_modules/.agenc-node/bin/not-node",
  ])("does not mistake adjacent Homebrew/npm paths for the formula: %s", executablePath => {
    expect(
      detectHomebrew({
        platform: "macos",
        executablePaths: [executablePath],
      }),
    ).toBe(false);
  });

  test("preserves legacy Caskroom recognition and platform gating", () => {
    const executablePath =
      "/opt/homebrew/Caskroom/agenc/0.10.0/agenc.app/Contents/MacOS/agenc";
    expect(
      detectHomebrew({
        platform: "macos",
        executablePaths: [executablePath],
      }),
    ).toBe(true);
    expect(
      detectHomebrew({
        platform: "windows",
        executablePaths: [executablePath],
      }),
    ).toBe(false);
  });

  test("routes the formula private Node to the Homebrew package manager", async () => {
    const execPath = vi.spyOn(process, "execPath", "get").mockReturnValue(
      "/opt/homebrew/Cellar/agenc/0.11.0/libexec/node_modules/.agenc-node/bin/node",
    );
    try {
      getPackageManager.cache?.clear?.();
      await expect(getPackageManager()).resolves.toBe("homebrew");
    } finally {
      execPath.mockRestore();
      getPackageManager.cache?.clear?.();
    }
  });
});
