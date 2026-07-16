/**
 * Extends donor `mcp-server/src/lib.rs` JSON-RPC server processing with
 * AgenC-owned HTTP/SSE framing for remote MCP clients.
 *
 * Why this lives here:
 *   - MS-04 owns server-side remote transport only. CLI binding, auth, and
 *     permission integration are later MS-* items.
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  McpServerFramework,
  ensureMcpOutgoingSerializable,
} from "./framework.js";
import type { McpOutgoingMessage, McpRequestId } from "./types.js";

const DEFAULT_HTTP_PATH = "/mcp";
const DEFAULT_SSE_PATH = "/sse";
const DEFAULT_LEGACY_MESSAGE_PATH = "/message";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
// gaphunt3 #22: idle grace before a stream-less streamable-http session is
// evicted, so a client between POSTs (no open GET stream) is not dropped while
// a client that disconnected without a DELETE is still reaped.
const DEFAULT_STREAMABLE_IDLE_MS = 5 * 60 * 1000;
const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);

export interface McpHttpSseServerTransportOptions {
  readonly serverFactory: () => McpServerFramework;
  readonly httpPath?: string;
  readonly ssePath?: string;
  readonly legacyMessagePath?: string;
  readonly maxBodyBytes?: number;
  readonly validateOrigin?: (origin: string | null) => boolean;
  readonly onError?: (error: Error) => void;
  // gaphunt3 #22: idle grace (ms) before a stream-less streamable-http session
  // is evicted on disconnect. 0 defers eviction to the next event-loop tick.
  readonly streamableIdleMs?: number;
}

export interface McpHttpSseSessionSnapshot {
  readonly id: string;
  readonly hasSseStream: boolean;
  readonly initialized: boolean;
}

interface McpHttpSseSession {
  readonly id: string;
  readonly kind: "legacy-sse" | "streamable-http";
  readonly server: McpServerFramework;
  readonly getStreams: Map<string, SseStream>;
  readonly postStreams: Map<string, SseStream>;
  readonly requestPostStreams: Map<string, string>;
  nextGetStreamIndex: number;
  // gaphunt3 #22: pending idle-expiry reaper for a stream-less streamable-http
  // session; armed on disconnect, cancelled when a stream re-attaches.
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface SseStream {
  readonly id: string;
  readonly response: ServerResponse;
  writeQueue: Promise<void>;
}

interface SseEvent {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
}

type JsonRpcBodyKind =
  | { readonly kind: "request"; readonly method: string; readonly id: McpRequestId }
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "response" }
  | { readonly kind: "invalid" };

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class McpHttpSseServerTransport {
  readonly #options: {
    readonly httpPath: string;
    readonly ssePath: string;
    readonly legacyMessagePath: string;
    readonly maxBodyBytes: number;
    readonly validateOrigin: (origin: string | null) => boolean;
    readonly onError?: (error: Error) => void;
    readonly streamableIdleMs: number;
  };
  #serverFactory: () => McpServerFramework;
  readonly #sessions = new Map<string, McpHttpSseSession>();

  constructor(options: McpHttpSseServerTransportOptions) {
    this.#serverFactory = options.serverFactory;
    this.#options = {
      httpPath: options.httpPath ?? DEFAULT_HTTP_PATH,
      ssePath: options.ssePath ?? DEFAULT_SSE_PATH,
      legacyMessagePath:
        options.legacyMessagePath ?? DEFAULT_LEGACY_MESSAGE_PATH,
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      validateOrigin: options.validateOrigin ?? isLocalOrMissingOrigin,
      onError: options.onError,
      streamableIdleMs:
        options.streamableIdleMs ?? DEFAULT_STREAMABLE_IDLE_MS,
    };
  }

  snapshots(): readonly McpHttpSseSessionSnapshot[] {
    return [...this.#sessions.values()].map((session) => ({
      id: session.id,
      hasSseStream: session.getStreams.size > 0 || session.postStreams.size > 0,
      initialized: session.server.snapshot().initialized,
    }));
  }

  /**
   * Atomically changes the factory used for future sessions and revokes every
   * session admitted under the previous factory. The swap happens before the
   * synchronous revocation loop, so a future session cannot acquire the
   * previous workspace context. Requests already executing keep the context
   * under which they were admitted.
   */
  replaceServerFactory(serverFactory: () => McpServerFramework): number {
    const sessionIds = [...this.#sessions.keys()];
    this.#serverFactory = serverFactory;
    for (const sessionId of sessionIds) {
      this.closeSession(sessionId);
    }
    return sessionIds.length;
  }

  createNodeServer(): Server {
    return createServer((request, response) => {
      void this.handleRequest(request, response).then((handled) => {
        if (!handled && !response.headersSent) {
          writeTextResponse(response, 404, "not found");
        }
      });
    });
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const url = requestUrl(request);
    try {
      this.#validateOrigin(request);
      if (request.method === "POST" && url.pathname === this.#options.httpPath) {
        await this.#handleHttpPost(request, response);
        return true;
      }
      if (request.method === "GET" && url.pathname === this.#options.httpPath) {
        this.#openStreamableSse(request, response, url);
        return true;
      }
      if (request.method === "DELETE" && url.pathname === this.#options.httpPath) {
        this.#deleteHttpSession(request, response, url);
        return true;
      }
      if (request.method === "GET" && url.pathname === this.#options.ssePath) {
        this.#openLegacySse(response);
        return true;
      }
      if (
        request.method === "POST" &&
        url.pathname === this.#options.legacyMessagePath
      ) {
        await this.#handleLegacySsePost(request, response, url);
        return true;
      }
      return false;
    } catch (error) {
      const err = asError(error);
      this.#options.onError?.(err);
      if (!response.headersSent) {
        writeTextResponse(
          response,
          error instanceof HttpError ? error.statusCode : 500,
          err.message,
        );
      } else {
        response.end();
      }
      return true;
    }
  }

  async send(sessionId: string, message: McpOutgoingMessage): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`MCP HTTP/SSE session not found: ${sessionId}`);
    }
    if (isJsonRpcResponseMessage(message)) {
      const postStream = firstStream(session.postStreams);
      if (postStream !== null) {
        await this.#writeSseMessage(postStream, message);
        return;
      }
      if (session.kind === "legacy-sse") {
        await this.#writeGetSseMessage(session, message);
        return;
      }
      throw new Error(
        "MCP Streamable HTTP GET stream cannot carry JSON-RPC responses",
      );
    }
    const postStream = firstStream(session.postStreams);
    if (postStream !== null) {
      await this.#writeSseMessage(postStream, message);
      return;
    }
    await this.#writeGetSseMessage(session, message);
  }

  async sendForRequest(
    sessionId: string,
    requestId: McpRequestId,
    message: McpOutgoingMessage,
  ): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`MCP HTTP/SSE session not found: ${sessionId}`);
    }
    const streamId = session.requestPostStreams.get(requestIdKey(requestId));
    if (streamId === undefined) {
      await this.send(sessionId, message);
      return;
    }
    const stream = session.postStreams.get(streamId);
    if (stream === undefined) {
      await this.send(sessionId, message);
      return;
    }
    await this.#writeSseMessage(stream, message);
  }

  closeSession(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return false;
    // gaphunt3 #22: cancel any pending idle reaper so it cannot fire after the
    // session has already been removed.
    this.#clearIdleTimer(session);
    for (const stream of session.getStreams.values()) {
      try {
        stream.response.end();
      } catch (error) {
        this.#options.onError?.(asError(error));
      }
    }
    for (const stream of session.postStreams.values()) {
      try {
        stream.response.end();
      } catch (error) {
        this.#options.onError?.(asError(error));
      }
    }
    this.#sessions.delete(sessionId);
    return true;
  }

  #validateOrigin(request: IncomingMessage): void {
    const origin = singleHeader(request.headers.origin);
    if (!this.#options.validateOrigin(origin)) {
      throw new HttpError(403, "MCP HTTP/SSE origin is not allowed");
    }
  }

  #createSession(
    kind: McpHttpSseSession["kind"],
    id = randomUUID(),
  ): McpHttpSseSession {
    const session: McpHttpSseSession = {
      id,
      kind,
      server: this.#serverFactory(),
      getStreams: new Map(),
      postStreams: new Map(),
      requestPostStreams: new Map(),
      nextGetStreamIndex: 0,
      idleTimer: null,
    };
    this.#sessions.set(id, session);
    return session;
  }

  #getSession(id: string): McpHttpSseSession {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      throw new HttpError(404, `MCP HTTP/SSE session not found: ${id}`);
    }
    return session;
  }

  #getHttpSessionForPost(request: IncomingMessage): McpHttpSseSession | null {
    const headerSessionId = singleHeader(request.headers[SESSION_HEADER]);
    if (headerSessionId === null) return null;
    return this.#getSession(headerSessionId);
  }

  async #handleHttpPost(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    validateStreamablePostHeaders(request);
    const raw = await readRequestBody(request, this.#options.maxBodyBytes);
    const parsed = parseJsonRpcBodyKind(raw);
    let session = this.#getHttpSessionForPost(request);
    const shouldCreateSession =
      session === null &&
      parsed.kind === "request" &&
      parsed.method === "initialize";
    if (session === null && !shouldCreateSession && parsed.kind !== "invalid") {
      writeTextResponse(response, 400, "MCP HTTP/SSE session id is required");
      return;
    }
    if (shouldCreateSession) {
      session = this.#createSession("streamable-http");
    }
    const server = session?.server ?? this.#serverFactory();
    if (session !== null && shouldUsePostSse(request, parsed)) {
      const stream = this.#attachPostSseStream(session, response);
      if (parsed.kind === "request") {
        session.requestPostStreams.set(requestIdKey(parsed.id), stream.id);
      }
      void this.#dispatchPostSseBody(session, stream, raw, parsed);
      return;
    }
    const messages = await server.handleRawMessageAsync(raw);
    if (shouldCreateSession && !isInitializeSuccess(messages)) {
      this.#sessions.delete(session!.id);
      session = null;
    }
    if (session !== null) {
      response.setHeader(SESSION_HEADER, session.id);
      // gaphunt3 #22: a non-SSE POST (e.g. `initialize` or a plain request)
      // leaves a streamable-http session with no open stream. Without a stream
      // close event there is nothing to drive disconnect-based cleanup, so a
      // client that POSTs and then walks away (never opening a GET stream, never
      // sending the optional HTTP DELETE) would leak the session forever. Arm /
      // reset the idle reaper on each such POST so liveness is bounded by
      // activity rather than relying on a DELETE.
      if (
        session.kind === "streamable-http" &&
        session.getStreams.size === 0 &&
        session.postStreams.size === 0
      ) {
        this.#scheduleIdleEviction(session);
      }
    }
    if (messages.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    writeJsonResponse(
      response,
      messages.length === 1 ? messages[0] : messages,
      session === null && parsed.kind !== "notification" ? 400 : 200,
    );
  }

  async #dispatchPostSseBody(
    session: McpHttpSseSession,
    stream: SseStream,
    raw: string,
    parsed: JsonRpcBodyKind,
  ): Promise<void> {
    try {
      const messages = await session.server.handleRawMessageAsync(raw);
      for (const message of messages) {
        await this.#writeSseMessage(stream, message);
      }
    } catch (error) {
      this.#options.onError?.(asError(error));
    } finally {
      if (parsed.kind === "request") {
        session.requestPostStreams.delete(requestIdKey(parsed.id));
      }
      session.postStreams.delete(stream.id);
      if (!stream.response.destroyed) {
        stream.response.end();
      }
    }
  }

  async #handleLegacySsePost(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const session = this.#getSession(requiredSessionId(url));
    if (session.getStreams.size === 0) {
      throw new HttpError(410, `MCP HTTP/SSE session has no open stream: ${session.id}`);
    }
    const raw = await readRequestBody(request, this.#options.maxBodyBytes);
    void this.#dispatchSseBody(session, raw);
    response.writeHead(202);
    response.end();
  }

  async #dispatchSseBody(
    session: McpHttpSseSession,
    raw: string,
  ): Promise<void> {
    try {
      const messages = await session.server.handleRawMessageAsync(raw);
      for (const message of messages) {
        await this.#writeGetSseMessage(session, message);
      }
    } catch (error) {
      this.#options.onError?.(asError(error));
    }
  }

  #openLegacySse(response: ServerResponse): void {
    const session = this.#createSession("legacy-sse");
    this.#attachGetSseStream(session, response);
    void this.#writeGetSseEvent(session, {
      event: "endpoint",
      data: `${this.#options.legacyMessagePath}?sessionId=${encodeURIComponent(
        session.id,
      )}`,
    }).catch((error: unknown) => {
      this.#options.onError?.(asError(error));
    });
  }

  #openStreamableSse(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void {
    validateStreamableGetHeaders(request);
    const sessionId =
      url.searchParams.get("sessionId") ?? singleHeader(request.headers[SESSION_HEADER]);
    if (sessionId === null) {
      throw new HttpError(400, "MCP HTTP/SSE session id is required");
    }
    const session = this.#getSession(sessionId);
    if (!session.server.snapshot().initialized) {
      throw new HttpError(409, `MCP HTTP/SSE session is not initialized: ${session.id}`);
    }
    this.#attachGetSseStream(session, response);
  }

  #deleteHttpSession(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void {
    const sessionId =
      url.searchParams.get("sessionId") ?? singleHeader(request.headers[SESSION_HEADER]);
    if (sessionId === null || !this.closeSession(sessionId)) {
      writeTextResponse(response, 404, "MCP HTTP/SSE session not found");
      return;
    }
    response.writeHead(204);
    response.end();
  }

  #attachGetSseStream(
    session: McpHttpSseSession,
    response: ServerResponse,
  ): SseStream {
    const stream: SseStream = {
      id: randomUUID(),
      response,
      writeQueue: Promise.resolve(),
    };
    // gaphunt3 #22: a (re)connecting stream means the session is live again, so
    // cancel any pending idle reaper armed by a previous disconnect.
    this.#clearIdleTimer(session);
    session.getStreams.set(stream.id, stream);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      [SESSION_HEADER]: session.id,
    });
    response.flushHeaders();
    response.on("close", () => {
      session.getStreams.delete(stream.id);
      if (session.getStreams.size === 0 && session.postStreams.size === 0) {
        if (session.kind === "legacy-sse") {
          this.#sessions.delete(session.id);
        } else {
          // gaphunt3 #22: a streamable-http client may disconnect without the
          // optional HTTP DELETE; reap the now-stream-less session after an
          // idle grace so it cannot leak forever.
          this.#scheduleIdleEviction(session);
        }
      }
    });
    return stream;
  }

  #attachPostSseStream(
    session: McpHttpSseSession,
    response: ServerResponse,
  ): SseStream {
    const stream: SseStream = {
      id: randomUUID(),
      response,
      writeQueue: Promise.resolve(),
    };
    // gaphunt3 #22: active POST work keeps the session live; cancel a pending
    // idle reaper.
    this.#clearIdleTimer(session);
    session.postStreams.set(stream.id, stream);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      [SESSION_HEADER]: session.id,
    });
    response.flushHeaders();
    response.on("close", () => {
      session.postStreams.delete(stream.id);
      // gaphunt3 #22: if the POST stream was the last stream of a
      // streamable-http session, arm the idle reaper as well.
      if (
        session.kind === "streamable-http" &&
        session.getStreams.size === 0 &&
        session.postStreams.size === 0
      ) {
        this.#scheduleIdleEviction(session);
      }
    });
    return stream;
  }

  // gaphunt3 #22: arm an unref'd idle timer that evicts a streamable-http
  // session that has been left with no open streams (client disconnected
  // without the optional HTTP DELETE). A grace window avoids dropping a client
  // that is simply between POST requests with no GET stream open.
  #scheduleIdleEviction(session: McpHttpSseSession): void {
    this.#clearIdleTimer(session);
    const delay = Math.max(0, this.#options.streamableIdleMs);
    const timer = setTimeout(() => {
      session.idleTimer = null;
      this.#evictIfIdle(session);
    }, delay);
    timer.unref?.();
    session.idleTimer = timer;
  }

  #evictIfIdle(session: McpHttpSseSession): void {
    if (
      this.#sessions.get(session.id) === session &&
      session.getStreams.size === 0 &&
      session.postStreams.size === 0
    ) {
      this.#sessions.delete(session.id);
    }
  }

  #clearIdleTimer(session: McpHttpSseSession): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  #writeGetSseMessage(
    session: McpHttpSseSession,
    message: McpOutgoingMessage,
  ): Promise<void> {
    const stream = this.#nextGetStream(session);
    return this.#writeSseEvent(stream, {
      event: "message",
      data: ensureMcpOutgoingSerializable(message),
    });
  }

  #writeSseMessage(
    stream: SseStream,
    message: McpOutgoingMessage,
  ): Promise<void> {
    return this.#writeSseEvent(stream, {
      event: "message",
      data: ensureMcpOutgoingSerializable(message),
    });
  }

  #writeGetSseEvent(
    session: McpHttpSseSession,
    event: SseEvent,
  ): Promise<void> {
    const stream = this.#nextGetStream(session);
    return this.#writeSseEvent(stream, event);
  }

  #nextGetStream(session: McpHttpSseSession): SseStream {
    const streams = [...session.getStreams.values()];
    if (streams.length === 0) {
      throw new Error(`MCP HTTP/SSE session has no open event stream: ${session.id}`);
    }
    const index = session.nextGetStreamIndex % streams.length;
    session.nextGetStreamIndex += 1;
    return streams[index]!;
  }

  #writeSseEvent(
    stream: SseStream,
    event: SseEvent,
  ): Promise<void> {
    const write = stream.writeQueue.then(() =>
      writeRaw(stream.response, encodeSseEvent(event)),
    );
    stream.writeQueue = write.catch(() => {});
    return write;
  }
}

export function encodeSseEvent(event: SseEvent): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  for (const line of event.data.split(/\r?\n/)) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBytes) {
      throw new HttpError(413, "MCP HTTP request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requiredSessionId(url: URL): string {
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId === null || sessionId.length === 0) {
    throw new HttpError(400, "MCP HTTP/SSE sessionId is required");
  }
  return sessionId;
}

function parseJsonRpcBodyKind(raw: string): JsonRpcBodyKind {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "invalid" };
    }
    const record = value as Record<string, unknown>;
    if (record.jsonrpc !== "2.0") {
      return { kind: "invalid" };
    }
    if (typeof record.method === "string") {
      if ("id" in record) {
        return isValidRequestId(record.id)
          ? { kind: "request", method: record.method, id: record.id }
          : { kind: "invalid" };
      }
      return { kind: "notification", method: record.method };
    }
    if (
      "id" in record &&
      isValidRequestId(record.id) &&
      ("result" in record || "error" in record)
    ) {
      return { kind: "response" };
    }
    return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function isValidRequestId(value: unknown): value is McpRequestId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value))
  );
}

function requestIdKey(id: McpRequestId): string {
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number") return `n:${id}`;
  return "null";
}

function isInitializeSuccess(
  messages: readonly McpOutgoingMessage[],
): boolean {
  return messages.length === 1 && "result" in messages[0]!;
}

function shouldUsePostSse(
  request: IncomingMessage,
  parsed: JsonRpcBodyKind,
): boolean {
  return (
    parsed.kind === "request" &&
    parsed.method === "tools/call" &&
    headerIncludes(request.headers.accept, "text/event-stream")
  );
}

function isJsonRpcResponseMessage(message: McpOutgoingMessage): boolean {
  return "result" in message || "error" in message;
}

function firstStream(streams: ReadonlyMap<string, SseStream>): SseStream | null {
  return streams.values().next().value ?? null;
}

function validateStreamablePostHeaders(request: IncomingMessage): void {
  if (!headerIncludes(request.headers.accept, "application/json")) {
    throw new HttpError(406, "MCP HTTP POST must accept application/json");
  }
  if (!headerIncludes(request.headers.accept, "text/event-stream")) {
    throw new HttpError(406, "MCP HTTP POST must accept text/event-stream");
  }
  if (!headerIncludes(request.headers["content-type"], "application/json")) {
    throw new HttpError(415, "MCP HTTP POST body must be application/json");
  }
  validateProtocolVersion(request);
}

function validateStreamableGetHeaders(request: IncomingMessage): void {
  if (!headerIncludes(request.headers.accept, "text/event-stream")) {
    throw new HttpError(406, "MCP HTTP GET must accept text/event-stream");
  }
  validateProtocolVersion(request);
}

function validateProtocolVersion(request: IncomingMessage): void {
  const version = singleHeader(request.headers[PROTOCOL_VERSION_HEADER]);
  if (version !== null && !SUPPORTED_PROTOCOL_VERSIONS.has(version)) {
    throw new HttpError(400, `unsupported MCP protocol version: ${version}`);
  }
}

function headerIncludes(
  value: string | readonly string[] | undefined,
  expected: string,
): boolean {
  const header = singleHeader(value);
  if (header === null) return false;
  return header
    .split(",")
    .map((part) => part.split(";")[0]?.trim().toLowerCase())
    .some((part) => part === expected);
}

function isLocalOrMissingOrigin(origin: string | null): boolean {
  if (origin === null || origin.length === 0) return true;
  try {
    const url = new URL(origin);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  return value[0] ?? null;
}

function writeJsonResponse(
  response: ServerResponse,
  body: unknown,
  statusCode = 200,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeTextResponse(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function writeRaw(response: ServerResponse, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    response.write(body, "utf8", (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
