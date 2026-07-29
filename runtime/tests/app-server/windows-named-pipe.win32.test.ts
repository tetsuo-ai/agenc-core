import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { connect as connectSdk } from "../../../packages/agenc-sdk/src/socket.js";
import {
  createAgenCJsonLineDaemonClient,
} from "../../src/app-server/agent-cli.js";
import {
  resolveAgenCDaemonSocketPath,
} from "../../src/app-server/daemon-cli.js";
import { JSON_RPC_VERSION } from "../../src/app-server/protocol/index.js";
import {
  AgenCUnixSocketServer,
  canConnectToUnixSocket,
  isAgenCWindowsNamedPipePath,
} from "../../src/app-server/transport/unix-socket.js";

if (process.platform !== "win32") {
  throw new Error("the native named-pipe integration test requires Windows");
}

test("the authenticated daemon client round-trips over a private Windows named pipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenc-daemon-pipe-"));
  const socketPath = resolveAgenCDaemonSocketPath({ AGENC_HOME: root });
  const authCookie = "windows-native-pipe-cookie";
  await writeFile(join(root, "daemon.cookie"), `${authCookie}\n`, "utf8");
  const server = new AgenCUnixSocketServer({
    socketPath,
    acceptAuthenticator: (message) =>
      message.method === "initialize" &&
      typeof message.params === "object" &&
      message.params !== null &&
      !Array.isArray(message.params) &&
      message.params.authCookie === authCookie,
    onMessage: async (message, connection) => {
      if (message.method === "initialize") {
        await connection.send({
          jsonrpc: JSON_RPC_VERSION,
          id: message.id ?? null,
          result: { accepted: true },
        });
        return;
      }
      if (message.method !== "agent.list") {
        throw new Error(`unexpected named-pipe method: ${message.method}`);
      }
      await connection.send({
        jsonrpc: JSON_RPC_VERSION,
        id: message.id ?? null,
        result: { agents: [] },
      });
    },
  });

  expect(isAgenCWindowsNamedPipePath(socketPath)).toBe(true);
  await server.listen();
  try {
    const client = createAgenCJsonLineDaemonClient({
      authCookie,
      socketPath,
      timeoutMs: 2_000,
    });
    await expect(client.listAgents()).resolves.toEqual({ agents: [] });

    const sdkClient = await connectSdk({
      env: { AGENC_HOME: root },
      autostart: false,
      readyTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
    });
    try {
      await expect(sdkClient.listAgents()).resolves.toEqual({ agents: [] });
    } finally {
      await sdkClient.close();
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
  await expect(canConnectToUnixSocket(socketPath)).resolves.toBe(false);
});

test("the built Windows CLI completes daemon start, status, SDK, reload, and stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenc-daemon-lifecycle-"));
  const agencHome = join(root, ".agenc");
  const binAgenc = resolve(import.meta.dirname, "../../dist/bin/agenc.js");
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    AGENC_HOME: agencHome,
    AGENC_CONFIG_DIR: agencHome,
    AGENC_AUTH_BACKEND: "local",
    AGENC_DAEMON_WEBSOCKET_HOST: "127.0.0.1",
    AGENC_DAEMON_WEBSOCKET_PORT: "0",
    AGENC_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    AGENC_ONBOARDING: "0",
    NODE_OPTIONS: "",
  };
  const socketPath = resolveAgenCDaemonSocketPath(env);
  let daemonPid: number | null = null;

  try {
    const started = runBuiltDaemonCli(binAgenc, ["daemon", "start"], env);
    expect(started.status, started.stderr || started.stdout).toBe(0);
    expect(started.stdout).toMatch(/AgenC daemon started \(pid \d+\)/u);
    daemonPid = await readPrivateDaemonPid(agencHome);

    const status = runBuiltDaemonCli(binAgenc, ["daemon", "status"], env);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    expect(status.stdout).toContain(`AgenC daemon running (pid ${daemonPid})`);

    const sdkClient = await connectSdk({
      env,
      autostart: false,
      readyTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    try {
      await expect(sdkClient.listAgents()).resolves.toEqual({ agents: [] });
    } finally {
      await sdkClient.close();
    }

    const reloaded = runBuiltDaemonCli(binAgenc, ["daemon", "reload"], env);
    expect(reloaded.status, reloaded.stderr || reloaded.stdout).toBe(0);
    expect(reloaded.stdout).toContain(
      `AgenC daemon reloaded configuration (pid ${daemonPid})`,
    );

    const stopped = runBuiltDaemonCli(binAgenc, ["daemon", "stop"], env);
    expect(stopped.status, stopped.stderr || stopped.stdout).toBe(0);
    expect(stopped.stdout).toContain(`AgenC daemon stopped (pid ${daemonPid})`);
    daemonPid = null;

    await expect(canConnectToUnixSocket(socketPath)).resolves.toBe(false);
    await expect(
      readFile(join(agencHome, "daemon.pid"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    runBuiltDaemonCli(binAgenc, ["daemon", "stop"], env);
    if (daemonPid !== null && isPidAlive(daemonPid)) {
      process.kill(daemonPid, "SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
});

function runBuiltDaemonCli(
  binAgenc: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [binAgenc, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
    windowsHide: true,
  });
}

async function readPrivateDaemonPid(agencHome: string): Promise<number> {
  const raw = (await readFile(join(agencHome, "daemon.pid"), "utf8")).trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(pid) || String(pid) !== raw || pid <= 0) {
    throw new Error(`invalid private daemon pid: ${raw}`);
  }
  return pid;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
