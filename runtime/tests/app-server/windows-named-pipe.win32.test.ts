import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
