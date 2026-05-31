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

export const AGENC_WEBSOCKET_DEFAULT_HOST = "127.0.0.1";
export const AGENC_WEBSOCKET_DEFAULT_PATH = "/";
export const AGENC_WEBSOCKET_HEALTH_PATH = "/healthz";
export const AGENC_WEBSOCKET_READY_PATH = "/readyz";
export const AGENC_WEBSOCKET_DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

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
}

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
      this.#connections.delete(connectionId);
      this.#options.onConnectionClosed?.(connectionId);
    });
    socket.once("error", (error) => {
      this.#options.onError?.(asError(error), connectionId);
    });
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

    if (isControlMessage(message)) {
      // Control messages (request.cancel) must NOT queue behind the in-flight
      // long request they target, or cancellation can never run. They carry no
      // ordering dependency on normal requests (they reference a target by
      // requestId, not by arrival position), so dispatch them off-chain. The
      // promise is still tracked in pendingMessages so close() drains it.
      const pending = Promise.resolve(
        this.#options.onMessage(message, context),
      ).catch((error) => {
        this.#options.onError?.(asError(error), context.connectionId);
      });
      active.pendingMessages.add(pending);
      pending.finally(() => {
        active.pendingMessages.delete(pending);
      });
      return;
    }

    const pending = (active.dispatchChain = active.dispatchChain.then(() =>
      Promise.resolve(this.#options.onMessage(message, context)).catch(
        (error) => {
          this.#options.onError?.(asError(error), context.connectionId);
        },
      ),
    ));
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
function isControlMessage(message: JsonObject): boolean {
  return message.method === "request.cancel";
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
