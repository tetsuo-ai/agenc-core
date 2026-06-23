import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_AUTOSTART_READY_TIMEOUT_MS,
  AgenCDaemonAutostartError,
  ensureAgenCDaemonAutostart,
  resolveAgenCDaemonAutostartConfig,
  shouldAutostartAgenCDaemon,
} from "./daemon-autostart.js";
import {
  DEFAULT_DAEMON_READY_TIMEOUT_MS,
  readAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSocketPath,
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

async function listenUnixSocket(socketPath: string): Promise<Server> {
  const server = createServer((socket) => {
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/**
 * Leaves a *stale* Unix socket inode on disk: a path that still satisfies
 * `lstat().isSocket()` but has no listener (connect() yields ECONNREFUSED),
 * exactly the artifact a daemon crash without unlink leaves behind. A child
 * process binds the socket and is SIGKILLed so Node never runs its close-time
 * unlink. Bounded by a short readiness handshake.
 */
async function createStaleSocketInode(socketPath: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { createServer } = require("node:net");` +
        `const s = createServer(() => {});` +
        `s.listen(process.argv[1], () => { process.stdout.write("up\\n"); });`,
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("stale socket listener did not come up")),
        5_000,
      );
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  // Confirm the artifact is the stale-inode case we mean to exercise.
  if (!(await lstat(socketPath)).isSocket()) {
    throw new Error("expected a leftover socket inode");
  }
}

async function closeServer(server: Server | null): Promise<void> {
  if (server === null) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

describe("AgenC daemon autostart", () => {
  it("keeps the default readiness window long enough for cold starts", () => {
    // Raised from 15s to give cold hydration comfortable margin, and kept in
    // sync with the shared bare-control default so both paths move together.
    expect(AGENC_DAEMON_AUTOSTART_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      30_000,
    );
    expect(AGENC_DAEMON_AUTOSTART_READY_TIMEOUT_MS).toBe(
      DEFAULT_DAEMON_READY_TIMEOUT_MS,
    );
  });

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

  it("adopts a pidless daemon when its socket is present", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
    host.runningPids.add(5300);
    const socketServer = await listenUnixSocket(socketPath);

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [5300],
          isReady: ({ pid }) => pid === 5300,
        }),
      ).resolves.toEqual({
        pid: 5300,
        pidPath,
        status: "already-running",
        ready: true,
        connected: false,
      });
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(5300);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await closeServer(socketServer);
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("does not adopt a pidless daemon whose socket inode is stale (no listener)", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
    // A leftover socket inode exists (passes lstat().isSocket()) but nothing
    // is accepting on it, plus a live orphan PID. The recovery path must
    // probe connectability before adopting and fall through to spawning a
    // replacement instead of writing the orphan pid.
    await createStaleSocketInode(socketPath);
    const terminated: number[] = [];
    host.runningPids.add(5300);

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [5300],
          terminateOrphanDaemonPid: (pid) => {
            terminated.push(pid);
            host.runningPids.delete(pid);
          },
          isReady: ({ pid }) => host.runningPids.has(pid),
          waitTimeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        pid: 5201,
        status: "started",
      });
      expect(terminated).toEqual([5300]);
      expect(host.spawnedPids).toEqual([5201]);
      // The stale orphan PID must never be written as the live daemon.
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(5201);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("terminates a pidless daemon with no socket before spawning a replacement", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const terminated: number[] = [];
    host.runningPids.add(5300);

    await expect(
      ensureAgenCDaemonAutostart({
        host,
        findOrphanDaemonPids: () => [5300],
        terminateOrphanDaemonPid: (pid) => {
          terminated.push(pid);
          host.runningPids.delete(pid);
        },
        isReady: ({ pid }) => host.runningPids.has(pid),
      }),
    ).resolves.toEqual({
      pid: 5201,
      pidPath,
      status: "started",
      ready: true,
      connected: false,
    });
    expect(terminated).toEqual([5300]);
    expect(host.spawnedPids).toEqual([5201]);

    await rm(agencHome, { recursive: true, force: true });
  });

  it("waits for the daemon cookie and socket before reporting default readiness", async () => {
    const agencHome = await tempAgencHome();
    const baseHost = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(baseHost.env, baseHost.userHome);
    const cookiePath = resolveAgenCDaemonCookiePath(
      baseHost.env,
      baseHost.userHome,
    );
    const socketPath = resolveAgenCDaemonSocketPath(
      baseHost.env,
      baseHost.userHome,
    );
    let sleepCount = 0;
    let socketServer: Server | null = null;
    const host: AgenCDaemonCliHost = {
      ...baseHost,
      sleep: async () => {
        sleepCount += 1;
        await writeFile(cookiePath, "ready-cookie\n", { mode: 0o600 });
        socketServer ??= await listenUnixSocket(socketPath);
      },
    };

    try {
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
    } finally {
      await closeServer(socketServer);
    }

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
