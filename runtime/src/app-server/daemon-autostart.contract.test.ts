import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgenCDaemonAutostartError,
  ensureAgenCDaemonAutostart,
  resolveAgenCDaemonAutostartConfig,
  shouldAutostartAgenCDaemon,
} from "./daemon-autostart.js";
import {
  readAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
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

  it("loads daemon autostart and mcp.server config together", async () => {
    const agencHome = await tempAgencHome();
    await writeFile(
      join(agencHome, "config.toml"),
      `
[daemon]
autostart = false

[mcp.server]
enabled = true
transport = "sse"
host = "localhost"
port = 0
      `,
    );

    await expect(
      resolveAgenCDaemonAutostartConfig({ AGENC_HOME: agencHome }, "/home/test"),
    ).resolves.toEqual({
      daemonEnabled: false,
      mcpServer: {
        enabled: true,
        transport: "sse",
        host: "localhost",
        port: 0,
      },
    });

    await rm(agencHome, { recursive: true, force: true });
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

  it("waits for the daemon cookie before reporting default readiness", async () => {
    const agencHome = await tempAgencHome();
    const baseHost = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(baseHost.env, baseHost.userHome);
    const cookiePath = resolveAgenCDaemonCookiePath(
      baseHost.env,
      baseHost.userHome,
    );
    let sleepCount = 0;
    const host: AgenCDaemonCliHost = {
      ...baseHost,
      sleep: async () => {
        sleepCount += 1;
        await writeFile(cookiePath, "ready-cookie\n", { mode: 0o600 });
      },
    };

    await expect(
      ensureAgenCDaemonAutostart({
        host,
        pollMs: 1,
        waitTimeoutMs: 100,
      }),
    ).resolves.toEqual({
      pid: 5201,
      pidPath,
      status: "started",
      ready: true,
      connected: false,
    });
    expect(sleepCount).toBe(1);

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
