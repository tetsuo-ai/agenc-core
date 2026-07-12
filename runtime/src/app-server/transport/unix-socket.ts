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
import {
  loadAgenCNativePeerCredentialBinding,
  type AgenCNativePeerCredentialBinding,
} from "./peer-credentials.js";

const AGENC_DAEMON_SOCKET_DIR_MODE = 0o700;
const AGENC_DAEMON_SOCKET_MODE = 0o600;
const AGENC_DAEMON_SOCKET_ACCEPT_AUTH_TIMEOUT_MS = 5000;

export function defaultAgenCDaemonSocketPath(homeDir = homedir()): string {
  return join(homeDir, ".agenc", "daemon.sock");
}

export interface AgenCUnixSocketMessageContext {
  readonly connectionId: number;
  readonly peerUid: number | null;
  readonly privateSocketOwnerUid: number | null;
  send(message: JsonValue): Promise<void>;
  close(): void;
}

export interface AgenCUnixSocketServerOptions {
  readonly socketPath?: string;
  readonly homeDir?: string;
  readonly allowRuntimeNativePeerCredentialBuild?: boolean;
  readonly nativePeerCredentialBinding?: AgenCNativePeerCredentialBinding;
  readonly onNativePeerCredentialUnavailable?: (message: string) => void;
  readonly acceptAuthenticator?: (
    message: JsonObject,
    context: AgenCUnixSocketMessageContext,
  ) => boolean | Promise<boolean>;
  readonly acceptAuthenticationTimeoutMs?: number;
  readonly onAuthenticationFailed?: (
    message: JsonObject,
    context: AgenCUnixSocketMessageContext,
  ) => void | Promise<void>;
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
  #privateSocketOwnerUid: number | null = null;
  #nativePeerCredentialBinding: AgenCNativePeerCredentialBinding | null = null;
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

    // chmod inside the listen callback (todo-120) so the socket is not left
    // briefly world-accessible under a loose umask before mode 0600 applies.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        void chmod(socketPath, AGENC_DAEMON_SOCKET_MODE).then(
          () => resolve(),
          (error: unknown) =>
            reject(error instanceof Error ? error : new Error(String(error))),
        );
      });
    });

    this.#privateSocketOwnerUid =
      await resolveAgenCPrivateUnixSocketOwnerUid(socketPath);
    const nativePeerCredential = loadAgenCNativePeerCredentialBinding({
      allowRuntimeNativeBuild:
        this.#options.allowRuntimeNativePeerCredentialBuild,
      nativeBinding: this.#options.nativePeerCredentialBinding,
    });
    this.#nativePeerCredentialBinding = nativePeerCredential.binding;
    if (nativePeerCredential.error !== undefined) {
      this.#options.onNativePeerCredentialUnavailable?.(
        nativePeerCredential.error,
      );
    }
    return socketPath;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#privateSocketOwnerUid = null;
    this.#nativePeerCredentialBinding = null;

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
    const peerUid = resolveAgenCUnixSocketPeerUid(
      socket,
      this.#nativePeerCredentialBinding,
    );
    let accepted = this.#options.acceptAuthenticator === undefined;
    let closingUnauthenticated = false;
    let authenticationTimeout: NodeJS.Timeout | undefined;
    // The transport fires onMessage for each parsed line WITHOUT awaiting
    // the previous handler. When two requests arrive back-to-back (a
    // batched initialize + first real method, common from real clients),
    // both handlers race against `accepted`. Without serialization, the
    // second handler runs auth-check on a non-initialize method and gets
    // rejected with -32000 even though the connection's first message
    // legitimately authenticated. Gate everything on a single promise so
    // every subsequent message waits for the in-flight auth resolution.
    // `resolvedAuth` is the sentinel for "no auth in flight"; equality
    // against it identifies the very-first message that should claim the
    // auth slot synchronously (before awaiting anything).
    const resolvedAuth: Promise<void> = Promise.resolve();
    let authResolution: Promise<void> = resolvedAuth;
    const clearAuthenticationTimeout = (): void => {
      if (authenticationTimeout !== undefined) {
        clearTimeout(authenticationTimeout);
        authenticationTimeout = undefined;
      }
    };

    const context: AgenCUnixSocketMessageContext = {
      connectionId,
      peerUid,
      privateSocketOwnerUid: this.#privateSocketOwnerUid,
      send: (message) => writeJsonLine(socket, message),
      close: () => {
        socket.end();
      },
    };
    const transport = new AgenCStdioTransport({
      input: socket,
      output: socket,
      onMessage: async (message) => {
        // Two-step gate to handle line-batched [initialize, method]
        // messages that arrive in one TCP packet and trigger parallel
        // onMessage handlers. The transport fires handlers via
        // `Promise.resolve(onMessage(...))` without awaiting, so two
        // handlers can race the `accepted` flag.
        //
        // Step 1 (sync): if no auth is in flight AND we're not yet
        // accepted, CLAIM the auth slot synchronously by replacing the
        // shared `authResolution` promise BEFORE any await. Whichever
        // handler observes the still-resolved promise first wins; the
        // sibling sees the new pending promise and waits on it instead.
        //
        // Step 2 (async): wait for whichever auth resolution is in
        // flight, then check `accepted`/`closingUnauthenticated`.
        let resolveAuth: (() => void) | undefined;
        if (!accepted && authResolution === resolvedAuth) {
          // We're the first message on this connection. Claim the slot.
          authResolution = new Promise((r) => {
            resolveAuth = r;
          });
        } else {
          await authResolution;
        }
        if (resolveAuth === undefined) {
          // We waited for someone else's auth. They've already set
          // accepted / closingUnauthenticated. Fall through to dispatch
          // (or short-circuit if their auth failed).
          if (closingUnauthenticated) return;
          if (!accepted) return; // sibling rejected; we should also stop
          await this.#options.onMessage(message, context);
          return;
        }
        // We claimed the slot — run the auth check and resolve our
        // promise so siblings can proceed.
        try {
          if (closingUnauthenticated) {
            resolveAuth();
            return;
          }
          let authenticated = false;
          try {
            authenticated =
              (await this.#options.acceptAuthenticator?.(message, context)) ===
              true;
          } catch (error) {
            clearAuthenticationTimeout();
            this.#options.onError?.(asNodeError(error), connectionId);
            socket.destroy();
            return;
          }
          if (!authenticated) {
            closingUnauthenticated = true;
            clearAuthenticationTimeout();
            try {
              await this.#options.onAuthenticationFailed?.(message, context);
            } finally {
              socket.end();
            }
            return;
          }
          accepted = true;
          clearAuthenticationTimeout();
        } finally {
          resolveAuth();
        }
        await this.#options.onMessage(message, context);
      },
      onError: (error) => this.#options.onError?.(error, connectionId),
      onClose: () => this.#connections.delete(connectionId),
    });

    this.#connections.set(connectionId, { socket, transport });
    if (!accepted) {
      authenticationTimeout = setTimeout(() => {
        closingUnauthenticated = true;
        socket.destroy();
      }, this.#options.acceptAuthenticationTimeoutMs ?? AGENC_DAEMON_SOCKET_ACCEPT_AUTH_TIMEOUT_MS);
    }
    socket.once("close", () => {
      clearAuthenticationTimeout();
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

export async function resolveAgenCPrivateUnixSocketOwnerUid(
  socketPath: string,
): Promise<number | null> {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    return null;
  }
  const expectedUid = process.getuid();
  const socketDir = await lstat(dirname(socketPath));
  const socketInfo = await lstat(socketPath);
  if (
    socketDir.uid !== expectedUid ||
    socketInfo.uid !== expectedUid ||
    (socketDir.mode & 0o777) !== AGENC_DAEMON_SOCKET_DIR_MODE ||
    (socketInfo.mode & 0o777) !== AGENC_DAEMON_SOCKET_MODE
  ) {
    return null;
  }
  return expectedUid;
}

function resolveAgenCUnixSocketPeerUid(
  socket: Socket,
  nativePeerCredentialBinding: AgenCNativePeerCredentialBinding | null,
): number | null {
  if (nativePeerCredentialBinding === null) return null;
  const fd = getSocketFd(socket);
  if (fd === null) return null;
  try {
    const parsed = nativePeerCredentialBinding.getPeerUid(fd);
    if (
      typeof parsed !== "number" ||
      !Number.isSafeInteger(parsed) ||
      parsed < 0
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getSocketFd(socket: Socket): number | null {
  const maybeSocket = socket as Socket & {
    readonly _handle?: { readonly fd?: unknown };
  };
  return typeof maybeSocket._handle?.fd === "number"
    ? maybeSocket._handle.fd
    : null;
}

export async function canConnectToUnixSocket(
  socketPath: string,
): Promise<boolean> {
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
