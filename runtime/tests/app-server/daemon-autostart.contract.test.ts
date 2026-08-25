import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgenCShutdownSignal,
  AgenCSignalProcess,
} from "../lifecycle/signal-handlers.js";
import {
  AGENC_DAEMON_AUTOSTART_READY_TIMEOUT_MS,
  AgenCDaemonAutostartError,
  ensureAgenCDaemonAutostart,
  resolveAgenCDaemonAutostartConfig,
  shouldAutostartAgenCDaemon,
} from "./daemon-autostart.js";
import {
  acquireAgenCDaemonLifecycleLock,
  DEFAULT_DAEMON_READY_TIMEOUT_MS,
  readAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSocketPath,
  runAgenCDaemonCli,
  writeAgenCDaemonPid,
  type AgenCDaemonCliHost,
} from "./daemon-cli.js";
import {
  daemonInstanceIdentityFromRuntimeInfo,
  readDaemonRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
  writeDaemonRuntimeInfo,
} from "./daemon-runtime-info.js";
import {
  AgenCDaemonProcessScanIncompleteError,
  type AgenCDaemonInstanceIdentity,
  type AgenCDaemonProcessIdentity,
} from "./daemon-instance-identity.js";

const TEST_CURRENT_RUNTIME_BUILD = {
  runtimeVersion: "0.17.0-test",
  commit: "test-current-commit",
  buildTime: "2026-08-19T00:00:00.000Z",
} as const;

function createHost(agencHome: string): AgenCDaemonCliHost & {
  readonly runningPids: Set<number>;
  readonly spawnedPids: number[];
  platform: NodeJS.Platform;
  readCurrentRuntimeBuild(): typeof TEST_CURRENT_RUNTIME_BUILD;
  readProcessIdentity(pid: number): string | null;
  requestDaemonInstanceIdentity(): AgenCDaemonInstanceIdentity;
  requestDaemonShutdown(expected: AgenCDaemonInstanceIdentity): void;
  inspectLegacyDaemonProcess(pid: number): AgenCDaemonProcessIdentity | null;
  recordDaemon(
    pid: number,
    overrides?: Partial<AgenCDaemonInstanceIdentity>,
  ): AgenCDaemonInstanceIdentity;
} {
  let nextPid = 5200;
  let nextInstance = 0;
  const runningPids = new Set<number>();
  const spawnedPids: number[] = [];
  const build = TEST_CURRENT_RUNTIME_BUILD;
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(agencHome);
  const host = {
    env: { AGENC_HOME: agencHome },
    userHome: "/home/test",
    entrypointPath: "/opt/agenc/bin/agenc.js",
    execPath: "/usr/bin/node",
    pid: 5100,
    platform: process.platform,
    readCurrentRuntimeBuild: () => TEST_CURRENT_RUNTIME_BUILD,
    runningPids,
    spawnedPids,
    spawnDetachedDaemon: () => {
      nextPid += 1;
      runningPids.add(nextPid);
      spawnedPids.push(nextPid);
      host.recordDaemon(nextPid);
      return nextPid;
    },
    isPidRunning: (pid) => runningPids.has(pid),
    readProcessIdentity: (pid) =>
      runningPids.has(pid) ? `test-process:${pid}:initial` : null,
    inspectLegacyDaemonProcess: (pid) => {
      const processStart = host.readProcessIdentity(pid);
      return processStart === null ? null : { pid, processStart };
    },
    recordDaemon: (
      pid: number,
      overrides: Partial<AgenCDaemonInstanceIdentity> = {},
    ) => {
      nextInstance += 1;
      const identity: AgenCDaemonInstanceIdentity = {
        pid,
        instanceId: `test-instance:${pid}:${nextInstance}`,
        processStart: `test-process:${pid}:initial`,
        ...build,
        ...overrides,
      };
      writeDaemonRuntimeInfo(runtimeInfoPath, {
        ...identity,
        startedAt: "2026-08-19T00:00:00.000Z",
      });
      return identity;
    },
    requestDaemonInstanceIdentity: () => {
      const identity = daemonInstanceIdentityFromRuntimeInfo(
        readDaemonRuntimeInfo(runtimeInfoPath),
      );
      if (identity === null)
        throw new Error("test daemon identity unavailable");
      return identity;
    },
    requestDaemonShutdown: (expected: AgenCDaemonInstanceIdentity) => {
      runningPids.delete(expected.pid);
    },
    terminatePid: (pid) => {
      runningPids.delete(pid);
    },
    sleep: async () => {},
  };
  return host;
}

async function tempAgencHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-daemon-autostart-"));
}

function createSignalProcess(): AgenCSignalProcess & {
  emit(signal: AgenCShutdownSignal): void;
} {
  const listeners = new Map<AgenCShutdownSignal, Set<() => void>>();
  const addListener = (
    signal: AgenCShutdownSignal,
    listener: () => void,
  ): void => {
    const signalListeners = listeners.get(signal) ?? new Set<() => void>();
    signalListeners.add(listener);
    listeners.set(signal, signalListeners);
  };
  return {
    once: addListener,
    removeListener: (signal, listener) => {
      listeners.get(signal)?.delete(listener);
    },
    emit: (signal) => {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
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
      resolveAgenCDaemonAutostartConfig(
        { AGENC_HOME: agencHome },
        "/home/test",
      ),
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
    host.recordDaemon(5300);
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

  it("uses one mandatory Windows process query for ordinary adoption", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    host.platform = "win32";
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5288;
    const processStart = `test-process:${pid}:windows-start`;
    const readProcessIdentity = vi.fn(() => processStart);
    host.readProcessIdentity = readProcessIdentity;
    host.runningPids.add(pid);
    host.recordDaemon(pid, { processStart });
    await writeAgenCDaemonPid(pidPath, pid);

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: () => true,
        }),
      ).resolves.toMatchObject({
        pid,
        status: "already-running",
      });
      expect(readProcessIdentity).toHaveBeenCalledTimes(1);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("does not repeat the Windows process query before build-skew self-shutdown", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    host.platform = "win32";
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const oldPid = 5287;
    const oldProcessStart = `test-process:${oldPid}:windows-start`;
    const processReads: number[] = [];
    host.readProcessIdentity = (pid) => {
      processReads.push(pid);
      return host.runningPids.has(pid)
        ? pid === oldPid
          ? oldProcessStart
          : `test-process:${pid}:initial`
        : null;
    };
    host.runningPids.add(oldPid);
    host.recordDaemon(oldPid, {
      processStart: oldProcessStart,
      runtimeVersion: "0.0.0-old",
      commit: "old-build",
      buildTime: "1970-01-01T00:00:00.000Z",
    });
    await writeAgenCDaemonPid(pidPath, oldPid);
    const numericSignals: number[] = [];
    host.terminatePid = (pid) => {
      numericSignals.push(pid);
      host.runningPids.delete(pid);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).resolves.toMatchObject({ status: "started" });

      expect(processReads.filter((pid) => pid === oldPid)).toHaveLength(1);
      expect(numericSignals).toEqual([]);
      expect(host.spawnedPids).toHaveLength(1);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("repairs a stale live pid file from the fully proved daemon sidecar", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const unrelatedReusedPid = 5298;
    const daemonPid = 5299;
    host.runningPids.add(unrelatedReusedPid);
    host.runningPids.add(daemonPid);
    await writeAgenCDaemonPid(pidPath, unrelatedReusedPid);
    host.recordDaemon(daemonPid);
    const signals: number[] = [];
    host.terminatePid = (pid) => {
      signals.push(pid);
      host.runningPids.delete(pid);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: ({ pid }) => pid === daemonPid,
          findSupersededDaemonPids: () => [],
        }),
      ).resolves.toMatchObject({
        pid: daemonPid,
        status: "already-running",
      });
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(daemonPid);
      expect(host.runningPids.has(unrelatedReusedPid)).toBe(true);
      expect(signals).toEqual([]);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("preserves a newer daemon publication while stale-pid repair waits", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const stalePid = 5295;
    const oldSidecarPid = 5296;
    const publishedPid = 5297;
    host.runningPids.add(stalePid);
    host.runningPids.add(oldSidecarPid);
    host.runningPids.add(publishedPid);
    await writeAgenCDaemonPid(pidPath, stalePid);
    host.recordDaemon(oldSidecarPid);
    const releasePublication = await acquireAgenCDaemonLifecycleLock(host);

    try {
      const ensuring = ensureAgenCDaemonAutostart({
        host,
        isReady: ({ pid }) => pid === publishedPid,
        findSupersededDaemonPids: () => [],
      });
      // The ensure has read the stale outer snapshot and is now queued on the
      // lifecycle transaction. Publish C while holding the same lock; the
      // repair must reread inside the lock instead of overwriting C with B.
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      host.recordDaemon(publishedPid);
      await writeAgenCDaemonPid(pidPath, publishedPid);
      await releasePublication();

      await expect(ensuring).resolves.toMatchObject({
        pid: publishedPid,
        status: "already-running",
      });
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(publishedPid);
      expect(host.runningPids.has(stalePid)).toBe(true);
      expect(host.runningPids.has(oldSidecarPid)).toBe(true);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await releasePublication();
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("serializes pidless repair against a newer daemon publication", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(agencHome);
    const recoveredPid = 5293;
    const publishedPid = 5294;
    host.runningPids.add(recoveredPid);
    host.runningPids.add(publishedPid);
    const recoveredIdentity = host.recordDaemon(recoveredPid);
    let proofEntered!: () => void;
    const proofStarted = new Promise<void>((resolveProof) => {
      proofEntered = resolveProof;
    });
    let finishProof!: () => void;
    const proofGate = new Promise<void>((resolveProof) => {
      finishProof = resolveProof;
    });
    let publicationCompleted!: () => void;
    const publicationDone = new Promise<void>((resolvePublication) => {
      publicationCompleted = resolvePublication;
    });
    let publisherAcquired = false;

    try {
      const ensuring = ensureAgenCDaemonAutostart({
        host,
        requestDaemonInstanceIdentity: async () => {
          proofEntered();
          await proofGate;
          return recoveredIdentity;
        },
        isReady: async () => {
          await publicationDone;
          return true;
        },
        findSupersededDaemonPids: () => [],
      });
      await proofStarted;

      const publishing = (async () => {
        const release = await acquireAgenCDaemonLifecycleLock(host);
        try {
          publisherAcquired = true;
          host.recordDaemon(publishedPid);
          await writeAgenCDaemonPid(pidPath, publishedPid);
        } finally {
          await release();
          publicationCompleted();
        }
      })();
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      expect(publisherAcquired).toBe(false);

      finishProof();
      await publishing;
      await expect(ensuring).rejects.toThrow(/sidecar records pid 5294/u);

      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(publishedPid);
      expect(
        daemonInstanceIdentityFromRuntimeInfo(
          readDaemonRuntimeInfo(runtimeInfoPath),
        )?.pid,
      ).toBe(publishedPid);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      finishProof();
      publicationCompleted();
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("pins tracked build-skew identity before terminating and replacing it", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const stalePid = 5301;
    host.runningPids.add(stalePid);
    await writeAgenCDaemonPid(pidPath, stalePid);
    host.recordDaemon(stalePid, {
      runtimeVersion: "0.0.0-test",
      commit: "test",
      buildTime: "1970-01-01T00:00:00.000Z",
    });
    const signals: Array<{
      readonly pid: number;
      readonly signal: NodeJS.Signals;
    }> = [];
    host.terminatePid = (pid, signal = "SIGTERM") => {
      signals.push({ pid, signal });
      host.runningPids.delete(pid);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).resolves.toMatchObject({ pid: 5201, status: "started" });

      // Portable replacement uses the authenticated daemon self-shutdown RPC,
      // not a numeric signal that could race PID reuse.
      expect(signals).toEqual([]);
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(5201);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("gives up with a typed error when build skew persists across every restart cycle", async () => {
    // Permanent-skew environment: every daemon this host spawns publishes a
    // build identity that differs from the CLI's on-disk runtime, so the
    // skew branch fires on every ensure cycle. Before the restart-cycle cap
    // this recursed forever: respawn + full /proc scan + lifecycle lock at
    // ~200% CPU behind a blank screen.
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const skewedBuild = {
      runtimeVersion: "0.0.0-skewed",
      commit: "skewed-commit",
      buildTime: "1970-01-01T00:00:00.000Z",
    };
    const baseSpawn = host.spawnDetachedDaemon;
    host.spawnDetachedDaemon = () => {
      const pid = baseSpawn();
      host.recordDaemon(pid, skewedBuild);
      return pid;
    };
    const oldPid = 5480;
    host.runningPids.add(oldPid);
    await writeAgenCDaemonPid(pidPath, oldPid);
    host.recordDaemon(oldPid, skewedBuild);
    const sleeps: number[] = [];
    host.sleep = async (ms: number) => {
      sleeps.push(ms);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          name: "AgenCDaemonAutostartError",
          message: expect.stringMatching(/gave up after 3 restart cycles/),
        }),
      );
      // Bounded work: one spawn per cycle, never an unbounded respawn storm.
      expect(host.spawnedPids.length).toBeLessThanOrEqual(4);
      // Backoff between repeated restart cycles (the first restart stays
      // immediate; escalation starts when the condition repeats).
      expect(sleeps.filter((ms) => ms >= 250).length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("replaces a different commit even when buildTime is unchanged", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const currentBuild = TEST_CURRENT_RUNTIME_BUILD;
    const pid = 5309;
    host.runningPids.add(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    host.recordDaemon(pid, {
      ...currentBuild,
      commit: `${currentBuild.commit}-different`,
    });

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid: readyPid }) => host.runningPids.has(readyPid),
        }),
      ).resolves.toMatchObject({ pid: 5201, status: "started" });
      expect(host.runningPids.has(pid)).toBe(false);
      expect(host.spawnedPids).toEqual([5201]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("preserves metadata when the stopped PID is rebound by a new daemon", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(agencHome);
    const pid = 5308;
    const reusedProcessStart = `test-process:${pid}:reused`;
    let processStart = `test-process:${pid}:initial`;
    host.runningPids.add(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    host.recordDaemon(pid, {
      processStart,
      runtimeVersion: "0.0.0-test",
      commit: "test",
      buildTime: "1970-01-01T00:00:00.000Z",
    });
    host.readProcessIdentity = () => processStart;
    let replacementIdentity: AgenCDaemonInstanceIdentity | null = null;
    host.requestDaemonShutdown = () => {
      // The authenticated daemon exits, then a concurrent daemon reuses its
      // numeric PID and publishes a fresh identity before cleanup runs.
      processStart = reusedProcessStart;
      replacementIdentity = host.recordDaemon(pid, { processStart });
    };
    let now = 0;
    host.sleep = async (ms) => {
      now += ms;
    };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid: readyPid }) => host.runningPids.has(readyPid),
        }),
      ).resolves.toMatchObject({ pid, status: "already-running" });

      expect(host.spawnedPids).toEqual([]);
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(pid);
      expect(
        daemonInstanceIdentityFromRuntimeInfo(
          readDaemonRuntimeInfo(runtimeInfoPath),
        ),
      ).toEqual(replacementIdentity);
    } finally {
      nowSpy.mockRestore();
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("serializes dead-generation metadata removal against provisional PID reuse", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(agencHome);
    const currentBuild = TEST_CURRENT_RUNTIME_BUILD;
    const pid = 5307;
    let processStart = `test-process:${pid}:old`;
    host.runningPids.add(pid);
    host.readProcessIdentity = (targetPid) =>
      host.runningPids.has(targetPid)
        ? targetPid === pid
          ? processStart
          : `test-process:${targetPid}:initial`
        : null;
    await writeAgenCDaemonPid(pidPath, pid);
    host.recordDaemon(pid, {
      processStart,
      runtimeVersion: "0.0.0-old",
      commit: "old",
      buildTime: "1970-01-01T00:00:00.000Z",
    });
    host.requestDaemonShutdown = () => {
      host.runningPids.delete(pid);
    };
    let publisherAcquired = false;
    let publisher: Promise<void> | null = null;
    let replacementIdentity: AgenCDaemonInstanceIdentity | null = null;

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid: readyPid }) => host.runningPids.has(readyPid),
          afterVerifiedExitBeforeMetadataRemoval: async () => {
            if (publisher !== null) return;
            publisher = (async () => {
              const release = await acquireAgenCDaemonLifecycleLock(host);
              try {
                publisherAcquired = true;
                processStart = `test-process:${pid}:reused`;
                host.runningPids.add(pid);
                // Publish the provisional PID first, exactly as detached start
                // does, then commit the new sidecar generation.
                await writeAgenCDaemonPid(pidPath, pid);
                replacementIdentity = host.recordDaemon(pid, {
                  ...currentBuild,
                  instanceId: "replacement-after-metadata-lock",
                  processStart,
                });
              } finally {
                await release();
              }
            })();
            await new Promise<void>((resolveDelay) =>
              setTimeout(resolveDelay, 25),
            );
            expect(publisherAcquired).toBe(false);
          },
        }),
      ).resolves.toMatchObject({ pid, status: "already-running" });
      await publisher;

      expect(host.spawnedPids).toEqual([]);
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(pid);
      expect(
        daemonInstanceIdentityFromRuntimeInfo(
          readDaemonRuntimeInfo(runtimeInfoPath),
        ),
      ).toEqual(replacementIdentity);
    } finally {
      await publisher?.catch(() => {});
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("fails closed when the sidecar changes during authenticated proof", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5302;
    host.runningPids.add(pid);
    const original = host.recordDaemon(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    host.requestDaemonInstanceIdentity = () => {
      host.recordDaemon(pid);
      return original;
    };
    const signals: NodeJS.Signals[] = [];
    host.terminatePid = (_pid, signal = "SIGTERM") => {
      signals.push(signal);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: () => true,
          findSupersededDaemonPids: () => [],
        }),
      ).rejects.toThrow(/sidecar changed during proof/u);
      expect(signals).toEqual([]);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("fails closed when the process identity changes after RPC binding", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5303;
    host.runningPids.add(pid);
    host.recordDaemon(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    let reads = 0;
    host.readProcessIdentity = () => {
      reads += 1;
      return reads === 1
        ? `test-process:${pid}:initial`
        : `test-process:${pid}:reused`;
    };
    const signals: NodeJS.Signals[] = [];
    host.terminatePid = (_pid, signal = "SIGTERM") => {
      signals.push(signal);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: () => true,
          findSupersededDaemonPids: () => [],
        }),
      ).rejects.toThrow(/process identity changed during proof/u);
      expect(signals).toEqual([]);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("fails closed when a legacy Linux sidecar cannot be proven same-home", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5304;
    host.runningPids.add(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    await writeFile(
      join(agencHome, "daemon-runtime.json"),
      `${JSON.stringify({
        pid,
        runtimeVersion: "0.15.0",
        commit: "legacy",
        buildTime: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const signals: NodeJS.Signals[] = [];
    host.terminatePid = (_pid, signal = "SIGTERM") => {
      signals.push(signal);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: () => true,
          findSupersededDaemonPids: () => [],
          inspectLegacyDaemonProcess: () => null,
        }),
      ).rejects.toThrow(/legacy daemon could not be proven.*same-home/u);
      expect(signals).toEqual([]);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("replaces a proven same-home legacy Linux daemon during upgrade", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5311;
    host.platform = "linux";
    host.runningPids.add(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    await writeFile(
      join(agencHome, "daemon-runtime.json"),
      `${JSON.stringify({
        pid,
        runtimeVersion: "0.15.0",
        commit: "legacy",
        buildTime: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    host.terminatePid = (targetPid, signal = "SIGTERM") => {
      signals.push({ pid: targetPid, signal });
      host.runningPids.delete(targetPid);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          inspectLegacyDaemonProcess: (targetPid) => ({
            pid: targetPid,
            processStart: `test-process:${targetPid}:initial`,
          }),
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid: readyPid }) => host.runningPids.has(readyPid),
        }),
      ).resolves.toMatchObject({ pid: 5201, status: "started" });
      expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
      expect(host.spawnedPids).toEqual([5201]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("replaces a proven same-home legacy Linux daemon without a sidecar", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5313;
    host.platform = "linux";
    host.runningPids.add(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    host.terminatePid = (targetPid, signal = "SIGTERM") => {
      signals.push({ pid: targetPid, signal });
      host.runningPids.delete(targetPid);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          inspectLegacyDaemonProcess: (targetPid) => ({
            pid: targetPid,
            processStart: `test-process:${targetPid}:initial`,
          }),
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid: readyPid }) => host.runningPids.has(readyPid),
        }),
      ).resolves.toMatchObject({ pid: 5201, status: "started" });
      expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
      expect(host.spawnedPids).toEqual([5201]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("gives an actionable portable recovery path for a live legacy daemon", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5312;
    host.platform = "darwin";
    host.runningPids.add(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    await writeFile(
      join(agencHome, "daemon-runtime.json"),
      `${JSON.stringify({
        pid,
        runtimeVersion: "0.15.0",
        commit: "legacy",
        buildTime: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    try {
      await expect(
        ensureAgenCDaemonAutostart({ host, isReady: () => true }),
      ).rejects.toThrow(/OS service\/process manager.*then retry/u);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("gives an actionable portable recovery path when a legacy daemon has no sidecar", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5314;
    host.platform = "darwin";
    host.runningPids.add(pid);
    await writeAgenCDaemonPid(pidPath, pid);
    const signals: NodeJS.Signals[] = [];
    host.terminatePid = (_targetPid, signal = "SIGTERM") => {
      signals.push(signal);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({ host, isReady: () => true }),
      ).rejects.toThrow(/OS service\/process manager.*then retry/u);
      expect(signals).toEqual([]);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("never signals a Darwin PID when self-shutdown acknowledges but survives", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5305;
    host.platform = "darwin";
    host.runningPids.add(pid);
    host.recordDaemon(pid, {
      buildTime: "1970-01-01T00:00:00.000Z",
    });
    await writeAgenCDaemonPid(pidPath, pid);
    host.requestDaemonShutdown = () => {
      // Acknowledged but intentionally still alive. Equal, second-resolution
      // lstart tokens must not authorize a numeric Darwin signal.
    };
    const signals: NodeJS.Signals[] = [];
    let now = 0;
    host.sleep = async (ms) => {
      now += ms;
    };
    host.terminatePid = (_pid, signal = "SIGTERM") => {
      signals.push(signal);
    };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: () => true,
          findSupersededDaemonPids: () => [],
        }),
      ).rejects.toThrow(/survived forced termination.*5305/u);
      expect(signals).toEqual([]);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      nowSpy.mockRestore();
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("blocks an unbound non-Linux orphan without signalling or spawning", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const orphanPid = 5307;
    host.platform = "darwin";
    host.runningPids.add(orphanPid);
    const signals: NodeJS.Signals[] = [];
    host.terminatePid = (_pid, signal = "SIGTERM") => {
      signals.push(signal);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [orphanPid],
          isReady: () => true,
        }),
      ).rejects.toThrow(/unbound daemon cannot be signalled/u);
      expect(signals).toEqual([]);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("uses a rebound Linux SIGTERM only when authenticated self-shutdown fails", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5306;
    host.platform = "linux";
    host.runningPids.add(pid);
    host.recordDaemon(pid, {
      buildTime: "1970-01-01T00:00:00.000Z",
    });
    await writeAgenCDaemonPid(pidPath, pid);
    host.requestDaemonShutdown = () => {
      throw new Error("shutdown transport unavailable");
    };
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    host.terminatePid = (targetPid, signal = "SIGTERM") => {
      signals.push({ pid: targetPid, signal });
      host.runningPids.delete(targetPid);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          inspectLegacyDaemonProcess: (targetPid) => ({
            pid: targetPid,
            processStart: `test-process:${targetPid}:initial`,
          }),
          isReady: ({ pid: readyPid }) => host.runningPids.has(readyPid),
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
        }),
      ).resolves.toMatchObject({ pid: 5201, status: "started" });
      expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("rebinds Linux SIGTERM once after acknowledged self-shutdown hangs", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const pid = 5310;
    host.platform = "linux";
    host.runningPids.add(pid);
    host.recordDaemon(pid, {
      buildTime: "1970-01-01T00:00:00.000Z",
    });
    await writeAgenCDaemonPid(pidPath, pid);
    let shutdownAcknowledged = false;
    host.requestDaemonShutdown = () => {
      // Acknowledged but deliberately hung.
      shutdownAcknowledged = true;
    };
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let now = 0;
    host.sleep = async (ms) => {
      now += ms;
    };
    host.terminatePid = (targetPid, signal = "SIGTERM") => {
      signals.push({ pid: targetPid, signal });
      host.runningPids.delete(targetPid);
    };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          inspectLegacyDaemonProcess: (targetPid) => ({
            pid: targetPid,
            processStart: `test-process:${targetPid}:initial`,
          }),
          requestDaemonInstanceIdentity: ({ pid: targetPid }) => {
            if (targetPid === pid && shutdownAcknowledged) {
              throw new Error("daemon ingress closed after shutdown ack");
            }
            return host.requestDaemonInstanceIdentity();
          },
          isReady: ({ pid: readyPid }) => host.runningPids.has(readyPid),
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
        }),
      ).resolves.toMatchObject({ pid: 5201, status: "started" });
      expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
      expect(now).toBe(5_000);
    } finally {
      nowSpy.mockRestore();
      await rm(agencHome, { recursive: true, force: true });
    }
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

  it.skipIf(process.platform === "win32")(
    "waits for the spawned foreground identity commit after socket readiness",
    async () => {
      const agencHome = await tempAgencHome();
      const host = createHost(agencHome);
      host.env.AGENC_DAEMON_WEBSOCKET_PORT = "0";
      const signalProcess = createSignalProcess();
      const spawnedPid = 5201;
      let foreground: Promise<number> | null = null;
      let beforeReadyEntered!: () => void;
      const socketListening = new Promise<void>((resolveListening) => {
        beforeReadyEntered = resolveListening;
      });
      let commitIdentity!: () => void;
      const identityCommitGate = new Promise<void>((resolveCommit) => {
        commitIdentity = resolveCommit;
      });
      host.spawnDetachedDaemon = () => {
        host.runningPids.add(spawnedPid);
        host.spawnedPids.push(spawnedPid);
        const foregroundHost = { ...host, pid: spawnedPid };
        foreground = runAgenCDaemonCli(
          { kind: "command", action: "run" },
          {
            host: foregroundHost,
            signalProcess,
            beforeDaemonReady: async () => {
              beforeReadyEntered();
              await identityCommitGate;
            },
          },
        );
        return spawnedPid;
      };

      let stopped = false;
      try {
        const ensuring = ensureAgenCDaemonAutostart({
          host,
          isReady: async () => {
            await socketListening;
            return true;
          },
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
        });
        await socketListening;
        let ensureSettled = false;
        void ensuring.finally(() => {
          ensureSettled = true;
        });
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
        expect(ensureSettled).toBe(false);
        expect(
          readDaemonRuntimeInfo(resolveAgenCDaemonRuntimeInfoPath(agencHome)),
        ).toBeNull();

        commitIdentity();
        await expect(ensuring).resolves.toMatchObject({
          pid: spawnedPid,
          status: "started",
        });
        expect(host.spawnedPids).toEqual([spawnedPid]);

        signalProcess.emit("SIGTERM");
        stopped = true;
        await expect(foreground).resolves.toBe(0);
      } finally {
        commitIdentity();
        if (!stopped) {
          signalProcess.emit("SIGTERM");
          await foreground?.catch(() => {});
        }
        await rm(agencHome, { recursive: true, force: true });
      }
    },
  );

  it("serializes concurrent ensures so only one daemon is spawned", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const options = {
      host,
      findOrphanDaemonPids: () => [] as const,
      findSupersededDaemonPids: () => [] as const,
      isReady: ({ pid }: { readonly pid: number }) => host.runningPids.has(pid),
    } as const;

    try {
      const [first, second] = await Promise.all([
        ensureAgenCDaemonAutostart(options),
        ensureAgenCDaemonAutostart(options),
      ]);
      expect(first.pid).toBe(5201);
      expect(second.pid).toBe(5201);
      expect(host.spawnedPids).toEqual([5201]);
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(5201);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("fails fast with the exit diagnosis when the spawned daemon dies before ready", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    // The child dies immediately after spawn: the pid was handed out but is
    // no longer running. Pre-fix the autostart burned the entire readiness
    // timeout polling a corpse, then reported a misleading "did not become
    // ready before timeout". With a generous timeout the fast-fail is only
    // observable because "exited" short-circuits the wait.
    host.spawnDetachedDaemon = () => {
      host.spawnedPids.push(9301);
      return 9301; // never added to runningPids
    };
    await writeFile(
      join(agencHome, "daemon-spawn-stderr.log"),
      "node: error while loading shared libraries: libatomic.so.1\n",
    );
    const startedAt = Date.now();
    await expect(
      ensureAgenCDaemonAutostart({
        host,
        waitTimeoutMs: 60_000,
        isReady: () => false,
      }),
    ).rejects.toThrow(
      /exited before becoming ready \(pid 9301\).*libatomic\.so\.1/,
    );
    // Far below the 60s readiness window: the dead pid short-circuits.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // The dead child's pid file must not poison the next autostart.
    await expect(
      readAgenCDaemonPid(resolveAgenCDaemonPidPath(host.env, host.userHome)),
    ).resolves.toBeNull();

    await rm(agencHome, { recursive: true, force: true });
  });

  it("still reports a timeout when the daemon is alive but slow", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    await expect(
      ensureAgenCDaemonAutostart({
        host,
        waitTimeoutMs: 50,
        pollMs: 5,
        isReady: () => false, // alive (runningPids has it) but never ready
      }),
    ).rejects.toThrow(/did not become ready before timeout/);

    await rm(agencHome, { recursive: true, force: true });
  });

  it("stops a superseded same-home daemon before spawning its replacement", async () => {
    const home = await tempAgencHome();
    const agencHome = join(home, ".agenc");
    const host = createHost(agencHome);
    host.env.HOME = home;
    const supersededPid = 5401;
    host.runningPids.add(supersededPid);
    let supersededWasAliveAtSpawn = false;
    const spawnDetachedDaemon = host.spawnDetachedDaemon;
    host.spawnDetachedDaemon = (env) => {
      supersededWasAliveAtSpawn = host.runningPids.has(supersededPid);
      return spawnDetachedDaemon(env);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [supersededPid],
          terminateOrphanDaemonPid: (pid) => {
            host.runningPids.delete(pid);
          },
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).resolves.toMatchObject({ status: "started" });

      expect(supersededWasAliveAtSpawn).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("waits for a forced pidless daemon to exit before spawning its replacement", async () => {
    const home = await tempAgencHome();
    const agencHome = join(home, ".agenc");
    const host = createHost(agencHome);
    host.env.HOME = home;
    const orphanPid = 5402;
    host.runningPids.add(orphanPid);
    let now = 0;
    let forceKillDelivered = false;
    let orphanWasAliveAtSpawn = false;
    const signals: NodeJS.Signals[] = [];
    const spawnDetachedDaemon = host.spawnDetachedDaemon;
    host.spawnDetachedDaemon = (env) => {
      orphanWasAliveAtSpawn = host.runningPids.has(orphanPid);
      return spawnDetachedDaemon(env);
    };
    host.terminatePid = (_pid, signal = "SIGTERM") => {
      signals.push(signal);
      if (signal === "SIGKILL") forceKillDelivered = true;
    };
    host.sleep = async (ms) => {
      now += ms;
      if (forceKillDelivered) host.runningPids.delete(orphanPid);
    };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const processKillSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => {
        if (pid === orphanPid && signal === "SIGKILL") {
          forceKillDelivered = true;
        }
        return true;
      });

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [orphanPid],
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).resolves.toMatchObject({ status: "started" });

      expect(orphanWasAliveAtSpawn).toBe(false);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      processKillSpy.mockRestore();
      nowSpy.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not signal a pidless daemon after its PID identity changes", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const orphanPid = 5403;
    host.runningPids.add(orphanPid);
    const signals: NodeJS.Signals[] = [];
    let identityReads = 0;
    host.readProcessIdentity = (pid) => {
      if (!host.runningPids.has(pid)) return null;
      if (pid !== orphanPid) return `test-process:${pid}:initial`;
      identityReads += 1;
      return identityReads === 1
        ? `test-process:${pid}:original`
        : `test-process:${pid}:reused`;
    };
    host.terminatePid = (_pid, signal = "SIGTERM") => {
      signals.push(signal);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [orphanPid],
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).resolves.toMatchObject({ status: "started" });

      expect(signals).toEqual([]);
      expect(host.runningPids.has(orphanPid)).toBe(true);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("fails closed without spawning when a pidless daemon survives SIGKILL", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const orphanPid = 5404;
    host.runningPids.add(orphanPid);
    const signals: NodeJS.Signals[] = [];
    let now = 0;
    host.terminatePid = (_pid, signal = "SIGTERM") => {
      signals.push(signal);
    };
    host.sleep = async (ms) => {
      now += ms;
    };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [orphanPid],
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).rejects.toThrow(/survived forced termination.*5404/u);

      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      nowSpy.mockRestore();
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("stops and removes a replacement when the post-spawn race reaper fails", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const racedPid = 5405;
    host.runningPids.add(racedPid);
    const runtimeInfoPath = join(agencHome, "daemon-runtime.json");
    const signals: Array<{
      readonly pid: number;
      readonly signal: NodeJS.Signals;
    }> = [];
    let supersededScans = 0;
    let now = 0;
    host.terminatePid = (pid, signal = "SIGTERM") => {
      signals.push({ pid, signal });
      if (pid !== racedPid) host.runningPids.delete(pid);
    };
    host.sleep = async (ms) => {
      now += ms;
    };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => {
            supersededScans += 1;
            return supersededScans === 1 ? [] : [racedPid];
          },
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).rejects.toThrow(/survived forced termination.*5405/u);

      const replacementPid = host.spawnedPids[0];
      expect(replacementPid).toBe(5201);
      expect(host.runningPids.has(5201)).toBe(false);
      await expect(
        readAgenCDaemonPid(resolveAgenCDaemonPidPath(host.env, host.userHome)),
      ).resolves.toBeNull();
      await expect(readFile(runtimeInfoPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(signals).toEqual([
        { pid: racedPid, signal: "SIGTERM" },
        { pid: racedPid, signal: "SIGKILL" },
      ]);
    } finally {
      nowSpy.mockRestore();
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("cancels only the exact spawned child after a portable post-proof failure", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    host.platform = "darwin";
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(agencHome);
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    host.terminatePid = (pid, signal = "SIGTERM") => {
      signals.push({ pid, signal });
    };
    const cancelSpawnedDaemon = vi.fn((pid: number) => {
      expect(pid).toBe(5201);
      host.runningPids.delete(pid);
    });
    host.cancelSpawnedDaemon = cancelSpawnedDaemon;

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: ({ pid }) => host.runningPids.has(pid),
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          connect: () => {
            throw new Error("injected connector failure");
          },
        }),
      ).rejects.toThrow(/injected connector failure/u);

      expect(cancelSpawnedDaemon).toHaveBeenCalledExactlyOnceWith(5201);
      expect(signals).toEqual([]);
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBeNull();
      expect(readDaemonRuntimeInfo(runtimeInfoPath)).toBeNull();
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it.each(["capture", "readiness", "publication barrier"] as const)(
    "cancels the exact spawned child when post-spawn %s throws",
    async (failurePhase) => {
      const agencHome = await tempAgencHome();
      const host = createHost(agencHome);
      host.platform = "darwin";
      const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
      const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(agencHome);
      const failure = new Error(`injected ${failurePhase} failure`);
      if (failurePhase === "capture") {
        host.readProcessIdentity = (pid) => {
          if (pid === 5201) throw failure;
          return host.runningPids.has(pid)
            ? `test-process:${pid}:initial`
            : null;
        };
      }
      const cancelSpawnedDaemon = vi.fn((pid: number) => {
        host.runningPids.delete(pid);
      });
      host.cancelSpawnedDaemon = cancelSpawnedDaemon;

      try {
        await expect(
          ensureAgenCDaemonAutostart({
            host,
            findOrphanDaemonPids: () => [],
            findSupersededDaemonPids: () => [],
            isReady: () => {
              if (failurePhase === "readiness") throw failure;
              return true;
            },
            ...(failurePhase === "publication barrier"
              ? {
                  identityPublicationBarrier: () => {
                    throw failure;
                  },
                }
              : {}),
          }),
        ).rejects.toBe(failure);

        expect(cancelSpawnedDaemon).toHaveBeenCalledExactlyOnceWith(5201);
        expect(host.runningPids.has(5201)).toBe(false);
        await expect(readAgenCDaemonPid(pidPath)).resolves.toBeNull();
        expect(readDaemonRuntimeInfo(runtimeInfoPath)).toBeNull();
      } finally {
        await rm(agencHome, { recursive: true, force: true });
      }
    },
  );

  it("cleans a spawned replacement after socket identity mismatch without clobbering raced metadata", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(agencHome);
    const racedPid = 5410;
    const requestRecordedIdentity = host.requestDaemonInstanceIdentity;
    let racedIdentity: AgenCDaemonInstanceIdentity | null = null;
    host.requestDaemonInstanceIdentity = async () => {
      if (host.spawnedPids.length === 0) {
        return requestRecordedIdentity();
      }
      if (racedIdentity === null) {
        host.runningPids.add(racedPid);
        racedIdentity = host.recordDaemon(racedPid);
        await writeAgenCDaemonPid(pidPath, racedPid);
      }
      return racedIdentity;
    };
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    host.terminatePid = (pid, signal = "SIGTERM") => {
      signals.push({ pid, signal });
      host.runningPids.delete(pid);
    };

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => [],
          isReady: ({ pid }) => host.runningPids.has(pid),
        }),
      ).rejects.toThrow(/authenticated identity does not match/u);

      const spawnedPid = host.spawnedPids[0];
      expect(spawnedPid).toBe(5201);
      expect(host.runningPids.has(spawnedPid!)).toBe(false);
      expect(host.runningPids.has(racedPid)).toBe(true);
      expect(signals).toEqual([{ pid: spawnedPid, signal: "SIGTERM" }]);
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(racedPid);
      expect(
        daemonInstanceIdentityFromRuntimeInfo(
          readDaemonRuntimeInfo(runtimeInfoPath),
        ),
      ).toEqual(racedIdentity);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("reaps superseded same-home daemons while keeping the tracked one", async () => {
    // The accumulation case: upgrades leave daemons running from
    // version-stamped runtime directories that the pid file cannot track.
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    host.runningPids.add(5300);
    host.runningPids.add(5401);
    host.runningPids.add(5402);
    host.recordDaemon(5300);
    await writeAgenCDaemonPid(pidPath, 5300);
    const terminated: number[] = [];

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: ({ pid }) => pid === 5300,
          findSupersededDaemonPids: () => [5300, 5401, 5402],
          terminateOrphanDaemonPid: (pid) => {
            terminated.push(pid);
            host.runningPids.delete(pid);
          },
        }),
      ).resolves.toMatchObject({ pid: 5300, status: "already-running" });

      // The tracked daemon survives; only the untrackable ones are stopped.
      expect(terminated.sort()).toEqual([5401, 5402]);
      expect(host.runningPids.has(5300)).toBe(true);
      await expect(readAgenCDaemonPid(pidPath)).resolves.toBe(5300);
      expect(host.spawnedPids).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("keeps orphan-path kill expectations when only orphan discovery is stubbed", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    host.runningPids.add(5300);
    host.recordDaemon(5300);
    await writeAgenCDaemonPid(pidPath, 5300);
    const terminated: number[] = [];

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          isReady: ({ pid }) => pid === 5300,
          findOrphanDaemonPids: () => [9001],
          terminateOrphanDaemonPid: (pid) => {
            terminated.push(pid);
          },
        }),
      ).resolves.toMatchObject({ pid: 5300, status: "already-running" });

      expect(terminated).toEqual([]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
    }
  });

  it("adopts a pidless daemon when its socket is present", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
    host.runningPids.add(5300);
    host.recordDaemon(5300);
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

  it("does not spawn when the bounded Linux daemon scan is incomplete", async () => {
    const agencHome = await tempAgencHome();
    const host = createHost(agencHome);
    host.platform = "linux";

    try {
      await expect(
        ensureAgenCDaemonAutostart({
          host,
          findOrphanDaemonPids: () => [],
          findSupersededDaemonPids: () => {
            throw new AgenCDaemonProcessScanIncompleteError(
              "test process-entry budget exhausted",
            );
          },
          isReady: () => true,
        }),
      ).rejects.toThrow(/scan incomplete.*refusing daemon lifecycle mutation/u);
      expect(host.spawnedPids).toEqual([]);
    } finally {
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
