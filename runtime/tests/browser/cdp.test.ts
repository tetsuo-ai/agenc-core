/**
 * CDP launch-argument hardening and pipe-client robustness.
 *
 * Revert-sensitivity: the egress-flag assertions go red if any of the
 * proxy/host-resolver/WebRTC flags are dropped from buildChromiumArgs; the
 * buffer-cap assertion goes red if CdpConnection stops bounding an unterminated
 * frame (it would hang instead of rejecting).
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  buildChromiumArgs,
  CdpConnection,
  launchBrowser,
} from "../../src/browser/cdp.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isLivePid(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const state = stat.slice(closeParen + 2).trim().split(/\s+/)[0];
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillPid(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

describe("buildChromiumArgs egress hardening", () => {
  const args = buildChromiumArgs({
    executablePath: "/usr/bin/chromium",
    userDataDir: "/tmp/profile",
    headless: true,
    noSandbox: false,
    proxyPort: 4321,
  });

  test("forces all TCP egress through the loopback proxy", () => {
    expect(args).toContain("--proxy-server=127.0.0.1:4321");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
  });

  test("disables non-proxied WebRTC UDP so it cannot bypass the proxy", () => {
    expect(args).toContain(
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
  });
});

describe("CdpConnection frame ceiling", () => {
  test("fails closed on an unterminated frame past the cap", async () => {
    const write = new PassThrough();
    const read = new PassThrough();
    // 1 KiB cap so the test needn't push 128 MB.
    const conn = new CdpConnection(write, read, 1024);
    const pending = conn.send("Browser.getVersion");
    // A response frame with no NUL terminator that blows past the cap.
    read.write("x".repeat(4096));
    await expect(pending).rejects.toThrow(/exceeded/);
    expect(conn.closed).toBe(true);
  });

  test("normal NUL-delimited frames still dispatch", async () => {
    const write = new PassThrough();
    const read = new PassThrough();
    const conn = new CdpConnection(write, read, 1024);
    const pending = conn.send("Browser.getVersion");
    // Echo a well-formed result for id 1.
    read.write(JSON.stringify({ id: 1, result: { product: "Test/1.0" } }) + "\0");
    await expect(pending).resolves.toEqual({ product: "Test/1.0" });
    conn.close();
  });
});

describe("launchBrowser process-tree cleanup", () => {
  const testPosix = process.platform === "win32" ? test.skip : test;

  testPosix(
    "kills a TERM-resistant descendant when CDP launch fails",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agenc-cdp-tree-"));
      const marker = join(dir, "tree.json");
      const descendantScript = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  leader: process.ppid,
  descendant: process.pid,
}));
setInterval(() => {}, 1000);
`;
      const leaderScript = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
  stdio: "ignore",
});
function exitWhenReady() {
  if (!fs.existsSync(${JSON.stringify(marker)})) {
    setTimeout(exitWhenReady, 5);
    return;
  }
  process.exit(29);
}
exitWhenReady();
`;
      const broker = new SandboxExecutionBroker({
        mode: "danger_full_access",
        cwd: dir,
      });
      vi.spyOn(broker, "prepareSpawn").mockImplementation(
        (_surface, command) => ({
          program: process.execPath,
          args: ["-e", leaderScript],
          cwd: dir,
          env: command.env,
        }),
      );
      let descendant: number | undefined;
      try {
        await expect(
          launchBrowser({
            executablePath: process.execPath,
            userDataDir: join(dir, "profile"),
            headless: true,
            noSandbox: false,
            proxyPort: 4567,
            sandboxExecutionBroker: broker,
          }),
        ).rejects.toThrow(/did not establish a CDP pipe/);
        expect(existsSync(marker)).toBe(true);
        descendant = (
          JSON.parse(readFileSync(marker, "utf8")) as { descendant: number }
        ).descendant;
        await waitFor(() => !isLivePid(descendant!));

        expect(isLivePid(descendant)).toBe(false);
      } finally {
        forceKillPid(descendant);
        await rm(dir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
