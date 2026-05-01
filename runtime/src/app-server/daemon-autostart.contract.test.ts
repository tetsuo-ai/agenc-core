import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgenCDaemonAutostartError,
  ensureAgenCDaemonAutostart,
  shouldAutostartAgenCDaemon,
} from "./daemon-autostart.js";
import {
  readAgenCDaemonPid,
  resolveAgenCDaemonPidPath,
  writeAgenCDaemonPid,
  type AgenCDaemonCliHost,
} from "./daemon-cli.js";

function createHost(agencHome: string): AgenCDaemonCliHost & {
  readonly runningPids: Set<number>;
  readonly spawnedPids: number[];
} {
  let nextPid = 5200;
  const runningPids = new Set<number>();
  const spawnedPids: number[] = [];
  return {
    env: { AGENC_HOME: agencHome },
    userHome: "/home/test",
    entrypointPath: "/opt/agenc/bin/agenc.js",
    execPath: "/usr/bin/node",
    pid: 5100,
    runningPids,
    spawnedPids,
    spawnDetachedDaemon: () => {
      nextPid += 1;
      runningPids.add(nextPid);
      spawnedPids.push(nextPid);
      return nextPid;
    },
    isPidRunning: (pid) => runningPids.has(pid),
    terminatePid: (pid) => {
      runningPids.delete(pid);
    },
    sleep: async () => {},
  };
}

async function tempAgencHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-daemon-autostart-"));
}

describe("AgenC daemon autostart", () => {
  it("honors the autostart environment opt-out", () => {
    expect(shouldAutostartAgenCDaemon({})).toBe(true);
    expect(shouldAutostartAgenCDaemon({}, false)).toBe(false);
    expect(shouldAutostartAgenCDaemon({ AGENC_DAEMON_AUTOSTART: "0" })).toBe(
      false,
    );
    expect(
      shouldAutostartAgenCDaemon({ AGENC_DAEMON_AUTOSTART: "false" }),
    ).toBe(false);
    expect(shouldAutostartAgenCDaemon({ AGENC_DAEMON_AUTOSTART: "off" })).toBe(
      false,
    );
    expect(
      shouldAutostartAgenCDaemon({ AGENC_DAEMON_AUTOSTART: "1" }, false),
    ).toBe(true);
  });

  it("connects to an already-running daemon without spawning", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    host.runningPids.add(5300);
    await writeAgenCDaemonPid(pidPath, 5300);
    const connectedPids: number[] = [];

    await expect(
      ensureAgenCDaemonAutostart({
        host,
        isReady: ({ pid }) => pid === 5300,
        connect: ({ pid }) => {
          connectedPids.push(pid);
        },
      }),
    ).resolves.toEqual({
      pid: 5300,
      pidPath,
      status: "already-running",
      ready: true,
      connected: true,
    });
    expect(host.spawnedPids).toEqual([]);
    expect(connectedPids).toEqual([5300]);

    await rm(agencHome, { recursive: true, force: true });
  });

  it("starts a stopped daemon, waits for ready, and connects", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const readyChecks: number[] = [];
    const connectedPids: number[] = [];

    await expect(
      ensureAgenCDaemonAutostart({
        host,
        isReady: ({ pid }) => {
          readyChecks.push(pid);
          return host.runningPids.has(pid);
        },
        connect: ({ pid }) => {
          connectedPids.push(pid);
        },
      }),
    ).resolves.toEqual({
      pid: 5201,
      pidPath,
      status: "started",
      ready: true,
      connected: true,
    });
    await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(5201);
    expect(readyChecks).toEqual([5201]);
    expect(connectedPids).toEqual([5201]);

    await rm(agencHome, { recursive: true, force: true });
  });

  it("fails when the daemon does not become ready", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);

    await expect(
      ensureAgenCDaemonAutostart({
        host,
        waitTimeoutMs: 0,
        isReady: () => false,
      }),
    ).rejects.toBeInstanceOf(AgenCDaemonAutostartError);

    await rm(agencHome, { recursive: true, force: true });
  });
});
