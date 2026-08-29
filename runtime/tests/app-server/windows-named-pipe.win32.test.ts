import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { connect as connectSdk } from "../../../packages/agenc-sdk/src/socket.js";
import { assertWindowsPrivatePathSecurity } from "../../src/agents/workflow-private-path.js";
import { createAgenCJsonLineDaemonClient } from "../../src/app-server/agent-cli.js";
import {
  readAgenCDaemonSpawnStderrTail,
  resolveAgenCDaemonSocketPath,
} from "../../src/app-server/daemon-cli.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
} from "../../src/app-server/protocol/index.js";
import {
  AgenCUnixSocketServer,
  canConnectToUnixSocket,
  isAgenCWindowsNamedPipePath,
} from "../../src/app-server/transport/unix-socket.js";

if (process.platform !== "win32") {
  throw new Error("the native named-pipe integration test requires Windows");
}

test("the authenticated daemon client round-trips over a private Windows named pipe", async () => {
  const socketPath = await withWindowsPrivateFixtureRoot(
    "agenc-daemon-pipe-",
    async (root, registerCleanup) => {
      let server: AgenCUnixSocketServer | null = null;
      registerCleanup(async () => {
        if (server !== null) {
          await server.close();
        }
      });

      const resolvedSocketPath = resolveAgenCDaemonSocketPath({
        AGENC_HOME: root,
      });
      const authCookie = "windows-native-pipe-cookie";
      await writeFile(join(root, "daemon.cookie"), `${authCookie}\n`, "utf8");
      const configuredServer = new AgenCUnixSocketServer({
        socketPath: resolvedSocketPath,
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
              result: {
                type: "initialized",
                protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
                protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
                capabilities: {},
              },
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
      server = configuredServer;

      expect(isAgenCWindowsNamedPipePath(resolvedSocketPath)).toBe(true);
      await configuredServer.listen();

      const client = createAgenCJsonLineDaemonClient({
        authCookie,
        socketPath: resolvedSocketPath,
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
        expect(sdkClient.serverProtocolVersion).toBe(
          AGENC_DAEMON_PROTOCOL_VERSION,
        );
        await expect(sdkClient.listAgents()).resolves.toEqual({ agents: [] });
      } finally {
        await sdkClient.close();
      }

      return resolvedSocketPath;
    },
  );

  await expect(canConnectToUnixSocket(socketPath)).resolves.toBe(false);
});

test(
  "the built Windows CLI completes daemon start, status, SDK, reload, and stop",
  {
    timeout: 180_000,
  },
  async () => {
    await withWindowsPrivateFixtureRoot(
      "agenc-daemon-lifecycle-",
      async (root, registerCleanup) => {
        const agencHome = join(root, ".agenc");
        const binAgenc = resolve(
          import.meta.dirname,
          "../../dist/bin/agenc.js",
        );
        const env = {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          AGENC_HOME: agencHome,
          AGENC_AUTH_BACKEND: "local",
          AGENC_DAEMON_WEBSOCKET_HOST: "127.0.0.1",
          AGENC_DAEMON_WEBSOCKET_PORT: "0",
          AGENC_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          AGENC_ONBOARDING: "0",
          TUI_E2E_DEBUG: "1",
          NODE_OPTIONS: "",
        };
        const socketPath = resolveAgenCDaemonSocketPath(env);
        let daemonPid: number | null = null;

        registerCleanup(() => {
          if (daemonPid !== null && isPidAlive(daemonPid)) {
            process.kill(daemonPid, "SIGKILL");
          }
        });
        registerCleanup(() => {
          const cleanupStop = runBuiltDaemonCli(
            binAgenc,
            ["daemon", "stop"],
            env,
          );
          if (cleanupStop.error !== undefined) {
            throw cleanupStop.error;
          }
          if (cleanupStop.status !== 0) {
            throw new Error(
              `daemon cleanup stop failed with status ${String(cleanupStop.status)}: ${cleanupStop.stderr || cleanupStop.stdout}`,
            );
          }
        });

        const started = runBuiltDaemonCli(binAgenc, ["daemon", "start"], env);
        expect(started.status, started.stderr || started.stdout).toBe(0);
        expect(started.stdout).toMatch(/AgenC daemon started \(pid \d+\)/u);
        daemonPid = await readPrivateDaemonPid(agencHome);

        const status = runBuiltDaemonCli(binAgenc, ["daemon", "status"], env);
        expect(status.status, status.stderr || status.stdout).toBe(0);
        expect(status.stdout).toContain(
          `AgenC daemon running (pid ${daemonPid})`,
        );

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
        expect(stopped.stdout).toContain(
          `AgenC daemon stopped (pid ${daemonPid})`,
        );
        daemonPid = null;

        await expect(canConnectToUnixSocket(socketPath)).resolves.toBe(false);
        await expect(
          readFile(join(agencHome, "daemon.pid"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  },
);

type WindowsFixtureCleanup = () => void | Promise<void>;

async function withWindowsPrivateFixtureRoot<T>(
  prefix: string,
  action: (
    root: string,
    registerCleanup: (cleanup: WindowsFixtureCleanup) => void,
  ) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(userInfo().homedir, prefix));
  const cleanupActions: WindowsFixtureCleanup[] = [];
  const errors: unknown[] = [];
  let actionResult:
    | { readonly completed: true; readonly value: T }
    | { readonly completed: false } = { completed: false };
  const registerCleanup = (cleanup: WindowsFixtureCleanup): void => {
    cleanupActions.push(cleanup);
  };

  try {
    assertWindowsPrivatePathSecurity(root, "directory", true);
    actionResult = {
      completed: true,
      value: await action(root, registerCleanup),
    };
  } catch (error) {
    errors.push(error);
  }

  for (let index = cleanupActions.length - 1; index >= 0; index -= 1) {
    try {
      await cleanupActions[index]!();
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }

  throwWindowsFixtureErrors(
    errors,
    "Windows named-pipe fixture and cleanup failed",
  );
  if (!actionResult.completed) {
    throw new Error("Windows named-pipe fixture did not complete");
  }
  return actionResult.value;
}

function throwWindowsFixtureErrors(
  errors: readonly unknown[],
  message: string,
): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message, { cause: errors[0] });
}

function runBuiltDaemonCli(
  binAgenc: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, [binAgenc, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    const daemonSpawnStderr = readAgenCDaemonSpawnStderrTail(env);
    throw new Error(
      `built daemon CLI ${args.join(" ")} failed: ${result.error.message}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}\n` +
        `daemon spawn stderr: ${daemonSpawnStderr || "(empty)"}`,
      { cause: result.error },
    );
  }
  return result;
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
