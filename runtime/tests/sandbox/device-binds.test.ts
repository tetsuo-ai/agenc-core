import { describe, expect, it } from "vitest";

import { resolveSandboxDeviceBinds } from "./linux-launcher/linux-run-main.js";
import { createBwrapCommandArgs } from "./linux-launcher/bwrap.js";
import { restrictedFileSystemPolicy } from "./engine/index.js";

const TEST_SESSION_TEMP_ROOT = "/tmp/agenc-test-session-root";

/**
 * `--dev /dev` builds a fresh minimal devtmpfs, so a board on /dev/ttyUSB0 is
 * visible in sysfs from inside the sandbox but cannot be opened. Observed
 * verbatim from an agent with an ESP32 plugged in: "I can see the board in
 * sysfs, but I cannot open it for esptool or a serial monitor from here".
 * AGENC_SANDBOX_DEVICE_BINDS is the supervised, opt-in hole.
 */
describe("sandbox device passthrough", () => {
  it("accepts real character devices under /dev", () => {
    // /dev/null and /dev/zero exist as character devices on every Linux host.
    expect(
      resolveSandboxDeviceBinds({
        AGENC_SANDBOX_DEVICE_BINDS: "/dev/null:/dev/zero",
      }),
    ).toEqual(["/dev/null", "/dev/zero"]);
  });

  it("is off unless the operator opts in", () => {
    expect(resolveSandboxDeviceBinds({})).toEqual([]);
    expect(
      resolveSandboxDeviceBinds({ AGENC_SANDBOX_DEVICE_BINDS: "   " }),
    ).toEqual([]);
  });

  it("refuses anything that is not a device node under /dev", () => {
    expect(
      resolveSandboxDeviceBinds({
        AGENC_SANDBOX_DEVICE_BINDS: [
          "/etc/passwd", // outside /dev
          "/dev", // the directory itself
          "/dev/../etc/shadow", // traversal
          "relative/path", // not absolute
          "/dev/does-not-exist-xyz", // missing
        ].join(":"),
      }),
    ).toEqual([]);
  });

  it("drops duplicates so bwrap gets each node once", () => {
    expect(
      resolveSandboxDeviceBinds({
        AGENC_SANDBOX_DEVICE_BINDS: "/dev/null:/dev/null",
      }),
    ).toEqual(["/dev/null"]);
  });

  it("emits --dev-bind after --dev so the node survives the fresh devtmpfs", () => {
    const { args } = createBwrapCommandArgs(
      ["/bin/true"],
      restrictedFileSystemPolicy([], { includePlatformDefaults: true }),
      "/tmp",
      "/tmp",
      {
        mountProc: false,
        networkMode: "isolated",
        sessionTempRoot: TEST_SESSION_TEMP_ROOT,
        extraDeviceBindPaths: ["/dev/null"],
      },
    );
    const dev = args.indexOf("--dev");
    const bind = args.indexOf("--dev-bind");
    expect(dev).toBeGreaterThanOrEqual(0);
    expect(bind).toBeGreaterThan(dev);
    expect(args.slice(bind, bind + 3)).toEqual([
      "--dev-bind",
      "/dev/null",
      "/dev/null",
    ]);
  });

  it("adds no --dev-bind when the operator did not opt in", () => {
    const { args } = createBwrapCommandArgs(
      ["/bin/true"],
      restrictedFileSystemPolicy([], { includePlatformDefaults: true }),
      "/tmp",
      "/tmp",
      {
        mountProc: false,
        networkMode: "isolated",
        sessionTempRoot: TEST_SESSION_TEMP_ROOT,
      },
    );
    expect(args).not.toContain("--dev-bind");
  });

  it("expands a pattern so one setting covers every board plugged in", () => {
    // /dev/null and /dev/zero are character devices on every Linux host, so
    // /dev/[nz]* style patterns resolve without depending on a board.
    const resolved = resolveSandboxDeviceBinds({
      AGENC_SANDBOX_DEVICE_BINDS: "/dev/nul*",
    });
    expect(resolved).toContain("/dev/null");
  });

  it("keeps a pattern inside one path segment and inside /dev", () => {
    expect(
      resolveSandboxDeviceBinds({
        AGENC_SANDBOX_DEVICE_BINDS: ["/dev/*/../etc/*", "/*/null"].join(":"),
      }),
    ).toEqual([]);
  });

  it("dedupes when a pattern and an exact path both match", () => {
    expect(
      resolveSandboxDeviceBinds({
        AGENC_SANDBOX_DEVICE_BINDS: "/dev/null:/dev/nul*",
      }),
    ).toEqual(["/dev/null"]);
  });
});
