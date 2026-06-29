/**
 * Ports the app-server websocket acceptor shape onto AgenC's daemon
 * JSON-RPC transport primitives.
 *
 * Why this lives here:
 *   - F-03o owns server-side websocket upgrade, JSON payload dispatch,
 *     health probes, and connection cleanup. Daemon startup policy and hosted
 *     remote-control enrollment are separate product concerns.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Hosted remote-control enrollment, backend URL normalization, and virtual
 *     client stream replay depend on a hosted control service AgenC does not
 *     ship in this runtime.
 *   - Signed bearer auth and capability-token generation are deferred to
 *     F-03p, which owns the daemon transport auth decision.
 *
 * Reference anchors are tracked in parity evidence, not runtime comments.
 */

import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { JsonObject, JsonValue } from "../protocol/index.js";
import {
  daemonOverloadErrorResponse,
  isDaemonControlMessage,
  maxQueuedRequestsFromOptions,
} from "../overload.js";
import { isRecord } from "../../utils/record.js";

export const AGENC_WEBSOCKET_DEFAULT_HOST = "127.0.0.1";
export const AGENC_WEBSOCKET_DEFAULT_PATH = "/";
export const AGENC_WEBSOCKET_HEALTH_PATH = "/healthz";
export const AGENC_WEBSOCKET_READY_PATH = "/readyz";
export const AGENC_WEBSOCKET_DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
// gaphunt3 #47: mirror the Unix socket accept-auth teardown window so an
// accepted ws peer that never authenticates is reaped instead of pinning a
// #connections slot (and its dispatcher connection object) indefinitely.
export const AGENC_WEBSOCKET_DEFAULT_ACCEPT_AUTH_TIMEOUT_MS = 5000;

export interface AgenCWebSocketListenAddress {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly url: string;
  readonly healthUrl: string;
  readonly readyUrl: string;
}

export interface AgenCWebSocketMessageContext {
  readonly connectionId: number;
  readonly requestUrl: string;
  readonly remoteAddress: string | undefined;
  send(message: JsonValue): Promise<void>;
  close(code?: number, reason?: string): void;
}

export interface AgenCWebSocketServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly maxPayloadBytes?: number;
  readonly ready?: () => boolean;
  readonly validateOrigin?: (
    origin: string | undefined,
    request: IncomingMessage,
  ) => boolean;
  // gaphunt3 #47: when supplied, an accepted connection must produce a message
  // that the authenticator approves within `acceptAuthenticationTimeoutMs` or
  // the socket is terminated and its #connections entry reaped. Mirrors the
  // Unix socket transport's accept-auth gate; when undefined, behavior is
  // unchanged (no teardown timer is armed).
  readonly acceptAuthenticator?: (
    message: JsonObject,
    context: AgenCWebSocketMessageContext,
  ) => boolean | Promise<boolean>;
  readonly acceptAuthenticationTimeoutMs?: number;
  readonly maxQueuedRequests?: number;
  readonly onAuthenticationFailed?: (
    message: JsonObject,
    context: AgenCWebSocketMessageContext,
  ) => void | Promise<void>;
  readonly onMessage: (
    message: JsonObject,
    context: AgenCWebSocketMessageContext,
  ) => void | Promise<void>;
  readonly onError?: (error: Error, connectionId: number | null) => void;
  readonly onConnectionClosed?: (connectionId: number) => void;
}

interface ActiveWebSocketConnection {
  readonly socket: WebSocket;
  readonly pendingMessages: Set<Promise<void>>;
  // Per-connection dispatch chain. Pipelined, order-dependent requests on a
  // single connection are handed to onMessage in arrival order rather than
  // racing as fire-and-forget promises. Each connection owns its own chain so
  // cross-connection concurrency is preserved.
  dispatchChain: Promise<void>;
  // gaphunt3 #47: accept-auth teardown state. `accepted` is true once an
  // authenticator-approved message is seen (or when no authenticator is
  // configured). `authTimeout` is the armed teardown timer; it is cleared on
  // success, failure, or socket close. `closingUnauthenticated` short-circuits
  // any in-flight/queued messages once the connection is being torn down.
  accepted: boolean;
  closingUnauthenticated: boolean;
  authTimeout: ReturnType<typeof setTimeout> | undefined;
  // Serializes the auth decision across line-batched messages that race the
  // dispatch chain, mirroring the Unix socket transport.
  authResolution: Promise<void>;
  queuedNormalMessages: number;
}

// gaphunt3 #47: sentinel for "no auth decision in flight" on a connection.
// Identity equality against it marks the first message that should claim the
// auth slot (mirrors the Unix socket transport's `resolvedAuth`).
const resolvedWebSocketAuth: Promise<void> = Promise.resolve();

export class AgenCWebSocketServer {
  readonly #options: AgenCWebSocketServerOptions;
  readonly #connections = new Map<number, ActiveWebSocketConnection>();
  #server: HttpServer | null = null;
  #webSocketServer: WebSocketServer | null = null;
  #listenAddress: AgenCWebSocketListenAddress | null = null;
  #nextConnectionId = 1;

  constructor(options: AgenCWebSocketServerOptions) {
    this.#options = options;
  }

  get host(): string {
    return this.#options.host ?? AGENC_WEBSOCKET_DEFAULT_HOST;
  }

  get port(): number {
    return this.#options.port ?? 0;
  }

  get path(): string {
    return normalizeWebSocketPath(this.#options.path);
  }

  get listenAddress(): AgenCWebSocketListenAddress | null {
    return this.#listenAddress;
  }

  async listen(): Promise<AgenCWebSocketListenAddress> {
    if (this.#server !== null || this.#webSocketServer !== null) {
      throw new Error("AgenC websocket transport is already listening");
    }

    const httpServer = createServer((request, response) => {
      this.#handleHttpRequest(request, response);
    });
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload:
        this.#options.maxPayloadBytes ??
        AGENC_WEBSOCKET_DEFAULT_MAX_PAYLOAD_BYTES,
    });
    this.#server = httpServer;
    this.#webSocketServer = webSocketServer;

    httpServer.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
    httpServer.on("error", (error) => {
      this.#options.onError?.(error, null);
    });
    webSocketServer.on("connection", (socket, request) => {
      this.#acceptConnection(socket, request);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off("error", onError);
          reject(error);
        };
        httpServer.once("error", onError);
        httpServer.listen(this.port, this.host, () => {
          httpServer.off("error", onError);
          resolve();
        });
      });
      this.#listenAddress = listenAddressFor(httpServer, this.host, this.path);
      return this.#listenAddress;
    } catch (error) {
      this.#server = null;
      this.#webSocketServer = null;
      this.#listenAddress = null;
      webSocketServer.close();
      httpServer.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const webSocketServer = this.#webSocketServer;
    const httpServer = this.#server;
    this.#webSocketServer = null;
    this.#server = null;
    this.#listenAddress = null;

    const activeConnections = [...this.#connections.values()];
    const closed = activeConnections.map((connection) =>
      waitForWebSocketClose(connection.socket),
    );
    for (const connection of activeConnections) {
      if (connection.socket.readyState !== WebSocket.CLOSED) {
        connection.socket.terminate();
      }
    }
    await Promise.allSettled(closed);
    await Promise.allSettled(
      activeConnections.flatMap((connection) => [
        ...connection.pendingMessages,
      ]),
    );
    this.#connections.clear();

    if (webSocketServer !== null) {
      await closeWebSocketServer(webSocketServer);
    }
    if (httpServer !== null) {
      await closeHttpServer(httpServer);
    }
  }

  #handleHttpRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void {
    if (request.method !== "GET") {
      writePlainResponse(response, 405, "method not allowed\n");
      return;
    }

    const path = requestPathname(request);
    if (path === AGENC_WEBSOCKET_HEALTH_PATH) {
      writePlainResponse(response, 200, "ok\n");
      return;
    }
    if (path === AGENC_WEBSOCKET_READY_PATH) {
      const ready = this.#options.ready?.() ?? true;
      writePlainResponse(response, ready ? 200 : 503, ready ? "ok\n" : "not ready\n");
      return;
    }

    writePlainResponse(response, 404, "not found\n");
  }

  #handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (requestPathname(request) !== this.path) {
      rejectHttpUpgrade(socket, 404, "not found\n");
      return;
    }

    const origin = singleHeader(request.headers.origin);
    const validateOrigin =
      this.#options.validateOrigin ?? rejectBrowserOriginHeaders;
    if (!validateOrigin(origin, request)) {
      rejectHttpUpgrade(socket, 403, "origin rejected\n");
      return;
    }

    const webSocketServer = this.#webSocketServer;
    if (webSocketServer === null) {
      rejectHttpUpgrade(socket, 503, "not ready\n");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  }

  #acceptConnection(socket: WebSocket, request: IncomingMessage): void {
    const connectionId = this.#nextConnectionId;
    this.#nextConnectionId += 1;

    const active: ActiveWebSocketConnection = {
      socket,
      pendingMessages: new Set(),
      dispatchChain: Promise.resolve(),
      // gaphunt3 #47: only require auth when an authenticator is configured;
      // otherwise the connection is accepted immediately (legacy behavior).
      accepted: this.#options.acceptAuthenticator === undefined,
      closingUnauthenticated: false,
      authTimeout: undefined,
      authResolution: resolvedWebSocketAuth,
      queuedNormalMessages: 0,
    };
    this.#connections.set(connectionId, active);

    const context: AgenCWebSocketMessageContext = {
      connectionId,
      requestUrl: request.url ?? this.path,
      remoteAddress: request.socket.remoteAddress,
      send: (message) => sendJsonPayload(socket, message),
      close: (code, reason) => {
        socket.close(code, reason);
      },
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.#handleMessage(data, active, context);
    });
    socket.once("close", () => {
      // gaphunt3 #47: cancel the teardown timer so a closed connection never
      // leaves an armed setTimeout (or fires terminate() on a dead socket).
      this.#clearAuthTimeout(active);
      this.#connections.delete(connectionId);
      this.#options.onConnectionClosed?.(connectionId);
    });
    socket.once("error", (error) => {
      this.#options.onError?.(asError(error), connectionId);
    });

    // gaphunt3 #47: arm the accept-auth teardown timer. A peer that completes
    // the upgrade but never sends an authenticator-approved message is reaped
    // instead of holding a #connections slot (and dispatcher connection)
    // indefinitely, matching the Unix socket transport's accept-auth window.
    if (!active.accepted) {
      active.authTimeout = armWebSocketAcceptAuthTimeout(
        active,
        this.#options.acceptAuthenticationTimeoutMs ??
          AGENC_WEBSOCKET_DEFAULT_ACCEPT_AUTH_TIMEOUT_MS,
        () => {
          this.#connections.delete(connectionId);
        },
      );
    }
  }

  #clearAuthTimeout(active: ActiveWebSocketConnection): void {
    if (active.authTimeout !== undefined) {
      clearTimeout(active.authTimeout);
      active.authTimeout = undefined;
    }
  }

  // gaphunt3 #47: resolve the accept-auth decision for one inbound message.
  // Returns true when the message may proceed to dispatch. The first message
  // on a not-yet-accepted connection claims the auth slot and runs the
  // authenticator; siblings (line-batched messages) await that decision so a
  // legitimately-authenticated connection is not rejected on its second line.
  async #resolveAcceptance(
    message: JsonObject,
    active: ActiveWebSocketConnection,
    context: AgenCWebSocketMessageContext,
  ): Promise<boolean> {
    if (active.accepted) {
      return !active.closingUnauthenticated;
    }
    const authenticator = this.#options.acceptAuthenticator;
    if (authenticator === undefined) {
      active.accepted = true;
      return true;
    }
    const inFlight = active.authResolution;
    if (inFlight !== resolvedWebSocketAuth) {
      await inFlight;
      return active.accepted && !active.closingUnauthenticated;
    }
    let release: (() => void) | undefined;
    active.authResolution = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (active.closingUnauthenticated) return false;
      let authenticated = false;
      try {
        authenticated = (await authenticator(message, context)) === true;
      } catch (error) {
        this.#clearAuthTimeout(active);
        active.closingUnauthenticated = true;
        this.#options.onError?.(asError(error), context.connectionId);
        this.#connections.delete(context.connectionId);
        if (active.socket.readyState !== WebSocket.CLOSED) {
          active.socket.terminate();
        }
        return false;
      }
      if (!authenticated) {
        active.closingUnauthenticated = true;
        this.#clearAuthTimeout(active);
        try {
          await this.#options.onAuthenticationFailed?.(message, context);
        } finally {
          context.close();
        }
        return false;
      }
      active.accepted = true;
      this.#clearAuthTimeout(active);
      return true;
    } finally {
      release?.();
    }
  }

  #handleMessage(
    data: RawData,
    active: ActiveWebSocketConnection,
    context: AgenCWebSocketMessageContext,
  ): void {
    const payload = decodeWebSocketText(data);
    let message: JsonObject;
    try {
      message = parseJsonObjectPayload(payload);
    } catch (error) {
      this.#options.onError?.(asError(error), context.connectionId);
      return;
    }

    if (isDaemonControlMessage(message)) {
      // Control messages (request.cancel) must NOT queue behind the in-flight
      // long request they target, or cancellation can never run. They carry no
      // ordering dependency on normal requests (they reference a target by
      // requestId, not by arrival position), so dispatch them off-chain. The
      // promise is still tracked in pendingMessages so close() drains it.
      //
      // gaphunt3 #47: a control message cannot itself satisfy the accept-auth
      // gate (it is not an `initialize`), so on a not-yet-accepted connection
      // it must not run — it is dropped until the connection authenticates.
      const pending = Promise.resolve()
        .then(async () => {
          if (active.accepted && !active.closingUnauthenticated) {
            await this.#options.onMessage(message, context);
          }
        })
        .catch((error) => {
          this.#options.onError?.(asError(error), context.connectionId);
        });
      active.pendingMessages.add(pending);
      pending.finally(() => {
        active.pendingMessages.delete(pending);
      });
      return;
    }

    const maxQueuedRequests = maxQueuedRequestsFromOptions({
      maxQueuedRequests: this.#options.maxQueuedRequests,
    });
    if (active.queuedNormalMessages >= maxQueuedRequests) {
      void context
        .send(
          daemonOverloadErrorResponse(message, "TOO_MANY_QUEUED_REQUESTS", {
            maxQueuedRequests,
          }),
        )
        .catch((error) => {
          this.#options.onError?.(asError(error), context.connectionId);
        });
      return;
    }
    active.queuedNormalMessages += 1;

    const pending = (active.dispatchChain = active.dispatchChain.then(
      async () => {
        try {
          // gaphunt3 #47: gate dispatch on the accept-auth decision so an
          // accepted-but-unauthenticated connection cannot drive the dispatcher.
          const proceed = await this.#resolveAcceptance(message, active, context);
          if (!proceed) return;
          await this.#options.onMessage(message, context);
        } finally {
          active.queuedNormalMessages = Math.max(
            0,
            active.queuedNormalMessages - 1,
          );
        }
      },
    ).catch((error) => {
      this.#options.onError?.(asError(error), context.connectionId);
    }));
    active.pendingMessages.add(pending);
    pending.finally(() => {
      active.pendingMessages.delete(pending);
    });
  }
}

export function parseJsonObjectPayload(payload: string): JsonObject {
  if (payload.trim().length === 0) {
    throw new SyntaxError("AgenC websocket transport received an empty payload");
  }
  const value = JSON.parse(payload) as JsonValue;
  if (!isJsonObject(value)) {
    throw new TypeError("AgenC websocket transport expected a JSON object");
  }
  return value;
}

export function encodeJsonPayload(message: JsonValue): string {
  const encoded = JSON.stringify(message);
  if (encoded === undefined) {
    throw new TypeError("AgenC websocket transport can only send JSON values");
  }
  return encoded;
}

export function rejectBrowserOriginHeaders(origin: string | undefined): boolean {
  return origin === undefined;
}

function normalizeWebSocketPath(path?: string): string {
  const trimmed = path?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return AGENC_WEBSOCKET_DEFAULT_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function requestPathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
}

function listenAddressFor(
  server: HttpServer,
  host: string,
  path: string,
): AgenCWebSocketListenAddress {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AgenC websocket transport did not bind a TCP address");
  }
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  const base = `http://${formattedHost}:${address.port}`;
  return {
    host,
    port: address.port,
    path,
    url: `ws://${formattedHost}:${address.port}${path}`,
    healthUrl: `${base}${AGENC_WEBSOCKET_HEALTH_PATH}`,
    readyUrl: `${base}${AGENC_WEBSOCKET_READY_PATH}`,
  };
}

function decodeWebSocketText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function sendJsonPayload(
  socket: WebSocket,
  message: JsonValue,
): Promise<void> {
  const payload = encodeJsonPayload(message);
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(
      new Error("AgenC websocket transport connection is not open"),
    );
  }
  return new Promise((resolve, reject) => {
    socket.send(payload, { binary: false }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function writePlainResponse(
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  response.end(body);
}

function rejectHttpUpgrade(
  socket: Duplex,
  statusCode: number,
  body: string,
): void {
  const reason = statusReason(statusCode);
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${reason}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
}

function statusReason(statusCode: number): string {
  switch (statusCode) {
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function waitForWebSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Pure-control messages that must bypass the per-connection dispatch FIFO.
 *
 * `request.cancel` references its target by requestId and has no ordering
 * dependency on normal requests, so queuing it behind a long-running request
 * would let that request starve the very cancellation meant to abort it. The
 * dispatcher handles it synchronously up to `controller.abort()`, so running it
 * off-chain is concurrency-safe. Extend this predicate to the other side-effect
 * free aborts (`session.cancelTurn`, `tool.cancel`, `commandExec.terminate`)
 * only if they prove starved as well — never to anything with ordering or
 * mutating side effects, which must stay strictly FIFO.
 */
/**
 * gaphunt3 #47: a socket that can be force-closed after the accept-auth window
 * lapses. Structural so the teardown path is unit-testable without a live ws.
 */
export interface WebSocketAcceptAuthTarget {
  readonly readyState: number;
  terminate(): void;
}

/**
 * gaphunt3 #47: connection-local accept-auth state mutated by the teardown
 * timer. Kept structural (a subset of ActiveWebSocketConnection) so tests can
 * drive the reaper directly with fake timers and a mock socket.
 */
export interface WebSocketAcceptAuthState {
  readonly socket: WebSocketAcceptAuthTarget;
  closingUnauthenticated: boolean;
  authTimeout: ReturnType<typeof setTimeout> | undefined;
}

/**
 * gaphunt3 #47: arm the accept-auth teardown timer. When it fires (no
 * authenticator-approved message arrived in time) it marks the connection
 * unauthenticated, runs `onReap` (which removes the #connections entry), and
 * terminates the socket unless it is already closed. Returns the timer handle
 * so the caller can clear it on success/failure/close.
 */
export function armWebSocketAcceptAuthTimeout(
  active: WebSocketAcceptAuthState,
  timeoutMs: number,
  onReap: () => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    active.authTimeout = undefined;
    active.closingUnauthenticated = true;
    onReap();
    if (active.socket.readyState !== WebSocket.CLOSED) {
      active.socket.terminate();
    }
  }, timeoutMs);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return isRecord(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
