import { describe, expect, test, vi } from "vitest";

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
  ])("recognizes the restored formula path %s", executablePath => {
    expect(
      detectHomebrew({
        platform: "macos",
        executablePaths: [executablePath],
      }),
    ).toBe(true);
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
