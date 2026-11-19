import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { restrictedFileSystemPolicy } from "./index.js";
import { MACOS_PATH_TO_SEATBELT_EXECUTABLE, createSeatbeltCommandArgs } from "./seatbelt.js";

// macOS only: listed in DARWIN_ONLY_DEFAULT_TEST_FILES. In AgenC Desktop a chat's command must not open a window or a
// dialog that takes typing, nor start a program outside the sandbox (owner's decision, 2026-11-19).


let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agenc-dialogs-darwin-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(command: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(command[0]!, command.slice(1), { cwd: dir, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: dir, TMPDIR: tmpdir(), ...env } });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}


describe("macOS: a sandboxed command with network reaches no keychain", () => {
  it("cannot read a keychain item, so it cannot ask for one either", () => {
    // A throwaway keychain in a fake home's keychain folder, with an item the security tool may read.
    const home = join(dir, "home");
    const keychain = join(home, "Library", "Keychains", "agenc-test.keychain-db");
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    const security = (args: readonly string[]) => spawnSync("/usr/bin/security", [...args], { encoding: "utf8" });
    const searchList = security(["list-keychains", "-d", "user"]).stdout;
    expect(security(["create-keychain", "-p", randomBytes(16).toString("hex"), keychain]).status).toBe(0);
    try {
      expect(security(["add-generic-password", "-s", "agenc-test", "-a", "test", "-w", "harmless-test-value", keychain]).status).toBe(0);
      expect(security(["find-generic-password", "-s", "agenc-test", "-w", keychain]).stdout.trim()).toBe("harmless-test-value");
      const args = createSeatbeltCommandArgs({
        command: ["/usr/bin/security", "find-generic-password", "-s", "agenc-test", "-w", keychain],
        fileSystemSandboxPolicy: restrictedFileSystemPolicy([
          { path: { kind: "special", value: { kind: "root" } }, access: "read" },
          { path: { kind: "path", path: dir }, access: "write" },
        ]),
        networkSandboxPolicy: "enabled",
        sandboxPolicyCwd: dir,
        sessionTempRoot: dir,
        enforceManagedNetwork: false,
        keychainHome: home,
      });
      const read = run([MACOS_PATH_TO_SEATBELT_EXECUTABLE, ...args]);
      expect(read.status).not.toBe(0);
      expect(read.output).toContain("could not be found");
    } finally {
      security(["delete-keychain", keychain]);
    }
    expect(security(["list-keychains", "-d", "user"]).stdout).toBe(searchList);
  });
});
