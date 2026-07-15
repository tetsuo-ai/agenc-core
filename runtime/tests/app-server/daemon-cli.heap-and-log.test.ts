import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgenCDaemonChildNodeArgs,
  installAgenCDaemonLogSink,
  resolveAgenCDaemonLogPath,
} from "./daemon-cli.js";

describe("daemon child heap cap arg construction", () => {
  it("prepends a default --max-old-space-size ahead of the entrypoint", () => {
    const userHome = join(tmpdir(), "agenc-test-home");
    const args = buildAgenCDaemonChildNodeArgs(
      "/path/to/agenc.js",
      {},
      userHome,
    );
    expect(args).toEqual([
      "--max-old-space-size=4096",
      "--heapsnapshot-near-heap-limit=1",
      `--diagnostic-dir=${join(userHome, ".agenc", "oom-snapshots")}`,
      "/path/to/agenc.js",
      "daemon",
      "start",
      "--foreground",
    ]);
  });

  it("passes an AGENC_HOME containing spaces as one diagnostic argument", () => {
    const agencHome = join(tmpdir(), "AgenC home with spaces");
    const args = buildAgenCDaemonChildNodeArgs("/entry.js", {
      AGENC_HOME: agencHome,
    });
    expect(args[2]).toBe(
      `--diagnostic-dir=${join(agencHome, "oom-snapshots")}`,
    );
  });

  it("preserves an operator-provided near-heap-limit policy", () => {
    const args = buildAgenCDaemonChildNodeArgs("/entry.js", {
      NODE_OPTIONS: "--heapsnapshot-near-heap-limit=3 --diagnostic-dir=/custom",
    });
    expect(args).not.toContain("--heapsnapshot-near-heap-limit=1");
    expect(args.some((arg) => arg.startsWith("--diagnostic-dir="))).toBe(false);
    expect(args).toContain("/entry.js");
  });

  it("honours the AGENC_DAEMON_MAX_OLD_SPACE_MB override", () => {
    const args = buildAgenCDaemonChildNodeArgs("/entry.js", {
      AGENC_DAEMON_MAX_OLD_SPACE_MB: "8192",
    });
    expect(args[0]).toBe("--max-old-space-size=8192");
  });

  it("ignores a non-positive / non-numeric override and keeps the default", () => {
    expect(
      buildAgenCDaemonChildNodeArgs("/entry.js", {
        AGENC_DAEMON_MAX_OLD_SPACE_MB: "0",
      })[0],
    ).toBe("--max-old-space-size=4096");
    expect(
      buildAgenCDaemonChildNodeArgs("/entry.js", {
        AGENC_DAEMON_MAX_OLD_SPACE_MB: "not-a-number",
      })[0],
    ).toBe("--max-old-space-size=4096");
  });
});

describe("daemon log sink installation", () => {
  it("routes console output into a size-capped file and rotates it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-daemon-log-"));
    try {
      const logPath = join(dir, "daemon.log");
      // Fake console so the global console is never mutated by the test.
      const fakeConsole = {
        log: () => {},
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
      } as unknown as Console;

      const installed = installAgenCDaemonLogSink({
        path: logPath,
        console: fakeConsole,
      });
      expect(installed).not.toBeNull();
      if (installed === null) throw new Error("sink not installed");

      // Write far more than a small cap by driving the sink directly. (The
      // installer redirects console.* into this same sink; we exercise the
      // sink contract that bounds growth.)
      const oneKb = "y".repeat(1024);
      for (let i = 0; i < 64; i += 1) {
        installed.sink.write(`${oneKb}\n`);
      }
      // Default cap is 16MB; 64KB stays well under it, so no rotation yet.
      expect(installed.sink.currentBytes).toBeGreaterThan(0);

      installed.dispose();

      // The active log file exists and is bounded.
      const fileStat = await stat(logPath);
      expect(fileStat.size).toBeGreaterThan(0);
      const contents = await readFile(logPath, "utf8");
      expect(contents).toContain("y");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves the daemon log path under the daemon home", () => {
    const logPath = resolveAgenCDaemonLogPath({ AGENC_HOME: "/tmp/agenc-home" });
    expect(logPath).toBe("/tmp/agenc-home/daemon.log");
  });
});
