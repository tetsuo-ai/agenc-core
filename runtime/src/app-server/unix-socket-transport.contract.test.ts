import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import {
  AgenCUnixSocketServer,
  defaultAgenCDaemonSocketPath,
  prepareAgenCUnixSocketPath,
} from "./transport/unix-socket.js";

const itUnix = process.platform === "win32" ? it.skip : it;

function nextChunk(socket: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => {
      resolve(chunk.toString("utf8"));
    });
  });
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenc-unix-socket-"));
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

  itUnix("accepts newline-delimited JSON over a Unix socket", async () => {
    const dir = await tempDir();
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, connection) => {
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
