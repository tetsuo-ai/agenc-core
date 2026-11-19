import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxManager, restrictedFileSystemPolicy, unrestrictedFileSystemPolicy } from "./index.js";
import { MACOS_PATH_TO_SEATBELT_EXECUTABLE, createSeatbeltCommandArgs } from "./seatbelt.js";

// macOS only: listed in DARWIN_ONLY_DEFAULT_TEST_FILES. In AgenC Desktop a chat's command must not open a window or a
// dialog that takes typing, nor start a program outside the sandbox (owner's decision, 2026-11-19). Without these
// rules each dialog below would appear for a second and close itself; nothing here waits for a person.

/** JXA that says whether this process reaches a window server session. */
const WINDOW_SERVER_SESSION =
  "ObjC.import('CoreGraphics'); ObjC.castRefToObject($.CGSessionCopyCurrentDictionary()).isNil() ? 'none' : 'window server'";
const windowServer = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_SERVER_SESSION], { encoding: "utf8" })
  .stdout.trim() === "window server";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const DIALOG = "AgenC test dialog. It closes itself. Type nothing.";

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

/** A command as Core runs it when the session or an approved escalation puts it outside the sandbox. */
function unsandboxed(program: string, args: readonly string[], options: { chromiumBrowser?: boolean } = {}): string[] {
  return [...new SandboxManager().transform({
    command: { program, args: [...args], cwd: dir, env: {} },
    permissions: { fileSystem: unrestrictedFileSystemPolicy(), network: "enabled" },
    sandbox: "none",
    platform: "darwin",
    enforceManagedNetwork: false,
    sandboxPolicyCwd: dir,
    sessionTempRoot: dir,
    windowsSandboxLevel: "disabled",
    windowsSandboxPrivateDesktop: false,
    ...(options.chromiumBrowser === true ? { chromiumBrowser: true } : {}),
  }).command];
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

describe.skipIf(!windowServer)("macOS: a command outside the sandbox opens no window and starts nothing outside", () => {
  it("still runs in a profile, and keeps full access to files", () => {
    const command = unsandboxed("/bin/sh", ["-c", `echo ok > '${join(dir, "outside-cwd.txt")}' && cat '${join(dir, "outside-cwd.txt")}'`]);
    expect(command[0]).toBe(MACOS_PATH_TO_SEATBELT_EXECUTABLE);
    expect(run(command).stdout.trim()).toBe("ok");
  });

  it("has no window server or system alert: osascript's dialogs and a CFUserNotification fail at once", () => {
    expect(run(unsandboxed("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_SERVER_SESSION])).stdout.trim()).toBe("none");
    const dialog = run(unsandboxed("/usr/bin/osascript", ["-e", `display dialog "${DIALOG}" default answer "" with hidden answer giving up after 1`]));
    expect(dialog.status).not.toBe(0);
    expect(dialog.output).toContain("(-1713)");
    const alert = run(unsandboxed("/usr/bin/osascript", ["-l", "JavaScript", "-e",
      `ObjC.import("CoreFoundation"); "status " + $.CFUserNotificationDisplayAlert(1, 0, null, null, null, $("${DIALOG}"), $(""), null, null, null, Ref())`]));
    expect(alert.stdout.trim()).toBe("status 1100");
  });

  it("starts nothing through LaunchServices or Apple Events, and gets no authorization right", async () => {
    const id = `com.agenc.dialogstest.${process.pid}.${Date.now()}`;
    const app = join(dir, "AgenCDialogsProbe.app");
    const marker = join(dir, "probe-ran");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>probe</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/></dict></plist>\n`);
    writeFileSync(join(app, "Contents", "MacOS", "probe"), `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(join(app, "Contents", "MacOS", "probe"), 0o755);
    try {
      const opened = run(unsandboxed("/usr/bin/open", ["-g", "-j", app]));
      expect(opened.status).not.toBe(0);
      expect(spawnSync(LSREGISTER, ["-f", app]).status).toBe(0);
      const told = run(unsandboxed("/usr/bin/osascript", ["-e", "with timeout of 2 seconds", "-e", `tell application id "${id}" to activate`, "-e", "end timeout"]));
      expect(told.status).not.toBe(0);
      const finder = run(unsandboxed("/usr/bin/osascript", ["-e", 'tell application "Finder" to get name of startup disk']));
      expect(finder.output).toContain("(-600)");
      await new Promise(resolve => setTimeout(resolve, 2500));
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : null).toBeNull();
      // authd says whether it would have asked (-60007) or refuses (-60005); without -u nothing is ever shown.
      expect(run(unsandboxed("/usr/bin/security", ["authorize", "system.privilege.admin"])).output.trim()).toBe("NO (-60005)");
    } finally {
      spawnSync(LSREGISTER, ["-u", app]);
    }
  });

  it("leaves the Browser tool's Chromium launch to its own rules", () => {
    expect(unsandboxed("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new"], { chromiumBrowser: true })[0])
      .toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });
});
