import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { restrictedFileSystemPolicy } from "./index.js";
import {
  MACOS_PATH_TO_SEATBELT_EXECUTABLE,
  chromiumBundleIdentifier,
  createSeatbeltCommandArgs,
  darwinUserTempDir,
} from "./seatbelt.js";

// macOS only: listed in DARWIN_ONLY_DEFAULT_TEST_FILES, so other platforms
// never discover it and nothing is skipped there.
describe("macOS seatbelt Chromium launch on a real Mac", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "agenc-chromium-darwin-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("compiles the browser profile in sandbox-exec", () => {
    const args = createSeatbeltCommandArgs({
      command: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      fileSystemSandboxPolicy: restrictedFileSystemPolicy([
        { path: { kind: "special", value: { kind: "root" } }, access: "read" },
      ]),
      networkSandboxPolicy: "disabled",
      sandboxPolicyCwd: dir,
      sessionTempRoot: dir,
      enforceManagedNetwork: false,
      chromiumBrowser: { bundleIdentifier: "com.google.Chrome", userTempDir: darwinUserTempDir() },
    });
    const result = spawnSync(
      MACOS_PATH_TO_SEATBELT_EXECUTABLE,
      [...args.slice(0, args.indexOf("--")), "--", "/usr/bin/true"],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("reads a binary Info.plist", () => {
    const macos = join(dir, "Brave Browser.app", "Contents", "MacOS");
    mkdirSync(macos, { recursive: true });
    const plist = join(dir, "Brave Browser.app", "Contents", "Info.plist");
    writeFileSync(
      plist,
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n' +
        "\t<key>CFBundleIdentifier</key>\n\t<string>com.brave.Browser</string>\n</dict>\n</plist>\n",
    );
    const executable = join(macos, "Brave Browser");
    writeFileSync(executable, "");
    expect(spawnSync("/usr/bin/plutil", ["-convert", "binary1", plist]).status).toBe(0);
    expect(chromiumBundleIdentifier(executable)).toBe("com.brave.Browser");
  });

  it("finds the per-user temp folder", () => {
    expect(darwinUserTempDir()).toMatch(/^\/private\/var\/folders\/.+\/T$/u);
  });
});
