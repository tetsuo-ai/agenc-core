/**
 * Ports the donor app-server Unix socket acceptor shape onto AgenC's local
 * daemon control plane.
 *
 * Why this lives here:
 *   - F-03c owns the primary local socket path and per-connection JSON-line
 *     framing; daemon request dispatch remains separate.
 *
 * Cross-cuts deliberately NOT carried:
 *   - websocket upgrade and remote-control enrollment are not part of AgenC's
 *     local daemon socket surface.
 */

import { lstat, mkdir, chmod, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { JsonObject, JsonValue } from "../protocol/index.js";
import { AgenCStdioTransport, writeJsonLine } from "./stdio.js";

export const AGENC_DAEMON_SOCKET_DIR_MODE = 0o700;
export const AGENC_DAEMON_SOCKET_MODE = 0o600;

export function defaultAgenCDaemonSocketPath(homeDir = homedir()): string {
  return join(homeDir, ".agenc", "daemon.sock");
}

export interface AgenCUnixSocketMessageContext {
  readonly connectionId: number;
  send(message: JsonValue): Promise<void>;
  close(): void;
}

export interface AgenCUnixSocketServerOptions {
  readonly socketPath?: string;
  readonly homeDir?: string;
  readonly onMessage: (
    message: JsonObject,
    context: AgenCUnixSocketMessageContext,
  ) => void | Promise<void>;
  readonly onError?: (error: Error, connectionId: number | null) => void;
  readonly onConnectionClosed?: (connectionId: number) => void;
}

interface ActiveConnection {
  readonly socket: Socket;
  readonly transport: AgenCStdioTransport;
}

export class AgenCUnixSocketServer {
  readonly #options: AgenCUnixSocketServerOptions;
  readonly #connections = new Map<number, ActiveConnection>();
  #server: Server | null = null;
  #nextConnectionId = 1;

  constructor(options: AgenCUnixSocketServerOptions) {
    this.#options = options;
  }

  get socketPath(): string {
    return (
      this.#options.socketPath ??
      defaultAgenCDaemonSocketPath(this.#options.homeDir)
    );
  }

  async listen(): Promise<string> {
    if (process.platform === "win32") {
      throw new Error("AgenC Unix socket transport is not available on Windows");
    }
    if (this.#server !== null) {
      throw new Error("AgenC Unix socket transport is already listening");
    }

    const socketPath = this.socketPath;
    await prepareAgenCUnixSocketPath(socketPath);

    const server = createServer((socket) => {
      this.#acceptConnection(socket);
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });

    await chmod(socketPath, AGENC_DAEMON_SOCKET_MODE);
    return socketPath;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;

    for (const { socket, transport } of this.#connections.values()) {
      socket.destroy();
      await transport.close();
    }
    this.#connections.clear();

    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    await removeSocketPathIfPresent(this.socketPath);
  }

  #acceptConnection(socket: Socket): void {
    const connectionId = this.#nextConnectionId;
    this.#nextConnectionId += 1;

    const context: AgenCUnixSocketMessageContext = {
      connectionId,
      send: (message) => writeJsonLine(socket, message),
      close: () => {
        socket.end();
      },
    };
    const transport = new AgenCStdioTransport({
      input: socket,
      output: socket,
      onMessage: (message) => this.#options.onMessage(message, context),
      onError: (error) => this.#options.onError?.(error, connectionId),
      onClose: () => this.#connections.delete(connectionId),
    });

    this.#connections.set(connectionId, { socket, transport });
    socket.once("close", () => {
      this.#connections.delete(connectionId);
      this.#options.onConnectionClosed?.(connectionId);
    });
    socket.once("error", (error) => {
      this.#options.onError?.(error, connectionId);
    });
    transport.start();
  }
}

export async function prepareAgenCUnixSocketPath(
  socketPath: string,
): Promise<void> {
  await mkdir(dirname(socketPath), {
    recursive: true,
    mode: AGENC_DAEMON_SOCKET_DIR_MODE,
  });

  let existsAsSocket = false;
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) {
      throw new Error(
        `AgenC daemon socket path exists and is not a socket: ${socketPath}`,
      );
    }
    existsAsSocket = true;
  } catch (error) {
    const nodeError = asNodeError(error);
    if (nodeError.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (!existsAsSocket) {
    return;
  }

  if (await canConnectToUnixSocket(socketPath)) {
    throw new Error(`AgenC daemon socket is already in use at ${socketPath}`);
  }

  await removeSocketPathIfPresent(socketPath);
}

async function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      const nodeError = asNodeError(error);
      if (nodeError.code === "ENOENT" || nodeError.code === "ECONNREFUSED") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

async function removeSocketPathIfPresent(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (error) {
    const nodeError = asNodeError(error);
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}

function asNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException)
    : new Error(String(error));
}
