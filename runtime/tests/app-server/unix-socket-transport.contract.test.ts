import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import {
  AgenCUnixSocketServer,
  defaultAgenCDaemonSocketPath,
  prepareAgenCUnixSocketPath,
  resolveAgenCPrivateUnixSocketOwnerUid,
} from "./transport/unix-socket.js";
import { compileAndLoadAgenCNativePeerCredentialBinding } from "./transport/peer-credentials.js";

const itUnix = process.platform === "win32" ? it.skip : it;
const itLinuxNative =
  process.platform === "linux" &&
  typeof process.getuid === "function" &&
  hasNativePeerCredentialBuildInputs()
    ? it
    : it.skip;

function nextChunk(socket: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => {
      resolve(chunk.toString("utf8"));
    });
  });
}

async function waitForSocketClose(socket: Socket): Promise<"closed" | "open"> {
  if (socket.closed || socket.destroyed) return "closed";
  return Promise.race([
    once(socket, "close").then(() => "closed" as const),
    new Promise<"open">((resolve) => {
      setTimeout(() => resolve("open"), 500);
    }),
  ]);
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-unix-socket-"));
}

function hasNativePeerCredentialBuildInputs(): boolean {
  const includeCandidates = [
    "/usr/include/node/node_api.h",
    resolve(dirname(process.execPath), "..", "include", "node", "node_api.h"),
  ];
  if (!includeCandidates.some((candidate) => existsSync(candidate))) {
    return false;
  }
  return spawnSync("cc", ["--version"], {
    stdio: "ignore",
  }).status === 0;
}

describe("AgenC Unix socket transport", () => {
  it("uses the AgenC daemon socket under the configured home", () => {
    expect(defaultAgenCDaemonSocketPath("/home/test")).toBe(
      "/home/test/.agenc/daemon.sock",
    );
  });

  itUnix("rejects a non-socket file at the daemon socket path", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, ".agenc", "daemon.sock");
    await writeFile(socketPath, "not a socket", { flag: "w" }).catch(
      async () => {
        await prepareAgenCUnixSocketPath(socketPath);
        await writeFile(socketPath, "not a socket", { flag: "w" });
      },
    );

    await expect(prepareAgenCUnixSocketPath(socketPath)).rejects.toThrow(
      /not a socket/,
    );
    await rm(dir, { recursive: true, force: true });
  });

  itUnix("fails closed before binding when a configured native addon cannot load", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      nativePeerCredentialAddonPath: join(dir, "missing.node"),
      onMessage: () => {},
    });

    await expect(server.listen()).rejects.toThrow(
      /configured peer credential native binding unavailable/,
    );
    expect(existsSync(socketPath)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  itUnix("rejects conflicting configured and injected native bindings", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      nativePeerCredentialAddonPath: join(dir, "configured.node"),
      nativePeerCredentialBinding: { getPeerUid: () => process.getuid?.() ?? 0 },
      onMessage: () => {},
    });

    await expect(server.listen()).rejects.toThrow(/mutually exclusive/);
    expect(existsSync(socketPath)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  itUnix("closes accepted sockets when required native credentials return no uid", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const onMessage = vi.fn();
    const onError = vi.fn();
    const onFatal = vi.fn();
    const server = new AgenCUnixSocketServer({
      socketPath,
      nativePeerCredentialBinding: { getPeerUid: () => null },
      requireNativePeerCredentialForConnections: true,
      onError,
      onRequiredNativePeerCredentialFailure: onFatal,
      onMessage,
    });

    await server.listen();
    try {
      const client = createConnection(socketPath);
      await once(client, "connect");
      await expect(waitForSocketClose(client)).resolves.toBe("closed");
      expect(onMessage).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("could not identify"),
        }),
        1,
      );
      expect(onFatal).toHaveBeenCalledOnce();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  itUnix("accepts newline-delimited JSON over a Unix socket", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, connection) => {
        const currentUid =
          typeof process.getuid === "function" ? process.getuid() : null;
        if (connection.peerUid !== null) {
          expect(connection.peerUid).toBe(currentUid);
        }
        expect(connection.privateSocketOwnerUid).toBe(currentUid);
        expect(message).toEqual({
          jsonrpc: JSON_RPC_VERSION,
          id: 1,
          method: "agent.list",
          params: {},
        });
        await connection.send({
          jsonrpc: JSON_RPC_VERSION,
          id: 1,
          result: { agents: [] },
        });
      },
    });

    await server.listen();
    expect(existsSync(socketPath)).toBe(true);
    await expect(resolveAgenCPrivateUnixSocketOwnerUid(socketPath)).resolves.toBe(
      typeof process.getuid === "function" ? process.getuid() : null,
    );

    const client = createConnection(socketPath);
    await once(client, "connect");
    client.write(
      '{"jsonrpc":"2.0","id":1,"method":"agent.list","params":{}}\n',
    );

    await expect(nextChunk(client)).resolves.toBe(
      '{"jsonrpc":"2.0","id":1,"result":{"agents":[]}}\n',
    );

    client.end();
    await server.close();
    expect(existsSync(socketPath)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  itLinuxNative("loads native SO_PEERCRED from an accepted Unix socket", async () => {
    const dir = await tempDir();
    const cacheDir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const binding = compileAndLoadAgenCNativePeerCredentialBinding({
      cacheDir,
      platform: "linux",
    });
    const server = new AgenCUnixSocketServer({
      socketPath,
      allowRuntimeNativePeerCredentialBuild: false,
      nativePeerCredentialBinding: binding,
      onMessage: async (_message, connection) => {
        expect(connection.peerUid).toBe(process.getuid?.());
        await connection.send({
          jsonrpc: JSON_RPC_VERSION,
          id: "native-peer",
          result: { accepted: true },
        });
      },
    });

    await server.listen();
    try {
      const client = createConnection(socketPath);
      await once(client, "connect");
      client.write(
        '{"jsonrpc":"2.0","id":"native-peer","method":"agent.list","params":{}}\n',
      );
      await expect(nextChunk(client)).resolves.toBe(
        '{"jsonrpc":"2.0","id":"native-peer","result":{"accepted":true}}\n',
      );
      client.end();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  itUnix("does not use non-private socket ownership as same-user proof", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: () => {},
    });

    await server.listen();
    try {
      await chmod(dir, 0o755);
      await expect(
        resolveAgenCPrivateUnixSocketOwnerUid(socketPath),
      ).resolves.toBeNull();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  itUnix("authenticates the first socket message before dispatch", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const onMessage = vi.fn(
      async (
        _message: Record<string, unknown>,
        connection: { send(message: Record<string, unknown>): Promise<void> },
      ) => {
        await connection.send({
          jsonrpc: JSON_RPC_VERSION,
          id: "ok",
          result: { accepted: true },
        });
      },
    );
    const server = new AgenCUnixSocketServer({
      socketPath,
      acceptAuthenticator: (message) =>
        message.method === "initialize" &&
        typeof message.params === "object" &&
        message.params !== null &&
        !Array.isArray(message.params) &&
        (message.params as { readonly authCookie?: unknown }).authCookie ===
          "socket-cookie",
      onAuthenticationFailed: async (message, connection) => {
        await connection.send({
          jsonrpc: JSON_RPC_VERSION,
          id: message.id,
          error: {
            code: -32000,
            message: "daemon connection authentication failed",
            data: { code: "CONNECTION_AUTHENTICATION_FAILED" },
          },
        });
      },
      onMessage,
    });

    await server.listen();
    try {
      const rejected = createConnection(socketPath);
      await once(rejected, "connect");
      rejected.write(
        '{"jsonrpc":"2.0","id":"bad","method":"initialize","params":{"authCookie":"wrong"}}\n',
      );
      await expect(nextChunk(rejected)).resolves.toContain(
        "CONNECTION_AUTHENTICATION_FAILED",
      );
      await expect(waitForSocketClose(rejected)).resolves.toBe("closed");
      expect(onMessage).not.toHaveBeenCalled();

      const nonInitialize = createConnection(socketPath);
      await once(nonInitialize, "connect");
      nonInitialize.write(
        '{"jsonrpc":"2.0","id":"not-init","method":"agent.list","params":{"authCookie":"socket-cookie"}}\n',
      );
      await expect(nextChunk(nonInitialize)).resolves.toContain(
        "CONNECTION_AUTHENTICATION_FAILED",
      );
      await expect(waitForSocketClose(nonInitialize)).resolves.toBe("closed");
      expect(onMessage).not.toHaveBeenCalled();

      const accepted = createConnection(socketPath);
      await once(accepted, "connect");
      accepted.write(
        '{"jsonrpc":"2.0","id":"ok","method":"initialize","params":{"authCookie":"socket-cookie"}}\n',
      );
      await expect(nextChunk(accepted)).resolves.toBe(
        '{"jsonrpc":"2.0","id":"ok","result":{"accepted":true}}\n',
      );
      accepted.end();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  itUnix("closes sockets that do not authenticate after accept", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const onMessage = vi.fn();
    const server = new AgenCUnixSocketServer({
      socketPath,
      acceptAuthenticator: () => true,
      acceptAuthenticationTimeoutMs: 10,
      onMessage,
    });

    await server.listen();
    try {
      const client = createConnection(socketPath);
      await once(client, "connect");
      await expect(waitForSocketClose(client)).resolves.toBe("closed");
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  itUnix("refuses to prepare an already active socket", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: () => {},
    });

    await server.listen();

    await expect(prepareAgenCUnixSocketPath(socketPath)).rejects.toThrow(
      /already in use/,
    );

    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
});
