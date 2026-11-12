import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";

import { MCP_ERROR_NOT_INITIALIZED, MCP_ERROR_PARSE } from "./types.js";
import { McpHttpSseServerTransport, encodeSseEvent } from "./http-sse.js";
import { McpServerFramework } from "./framework.js";
import { McpToolRegistry } from "./tools.js";
import type { McpCallToolResult } from "./types.js";

const TOKEN = "http-sse-test-token-0123456789";
const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` } as const;

function request(id: number, method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  } as const;
}

async function startServer(transport: McpHttpSseServerTransport): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}> {
  const server = transport.createNodeServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

interface ParsedSseEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

interface SseClient {
  readonly response: IncomingMessage;
  nextEvent(): Promise<ParsedSseEvent>;
  close(): void;
}

function openSse(url: string): Promise<SseClient> {
  return openSseRequest(url, {
    method: "GET",
    headers: { accept: "text/event-stream", ...AUTHORIZATION },
  });
}

function openSsePost(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<SseClient> {
  return openSseRequest(url, { method: "POST", headers, body });
}

function openSseRequest(
  url: string,
  options: {
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: options.method, headers: options.headers },
      (response) => {
        let buffer = "";
        const events: ParsedSseEvent[] = [];
        const waiters: Array<(event: ParsedSseEvent) => void> = [];

        response.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let frameEnd = buffer.indexOf("\n\n");
          while (frameEnd >= 0) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            const event = parseSseFrame(frame);
            const waiter = waiters.shift();
            if (waiter !== undefined) {
              waiter(event);
            } else {
              events.push(event);
            }
            frameEnd = buffer.indexOf("\n\n");
          }
        });
        response.once("error", reject);
        resolve({
          response,
          nextEvent(): Promise<ParsedSseEvent> {
            const event = events.shift();
            if (event !== undefined) return Promise.resolve(event);
            return new Promise((eventResolve) => {
              waiters.push(eventResolve);
            });
          },
          close(): void {
            request.destroy();
            response.destroy();
          },
        });
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

function parseSseFrame(frame: string): ParsedSseEvent {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("id:")) {
      id = line.slice("id:".length).trimStart();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return { event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
}

function withTimeout<T>(promise: Promise<T>, ms = 500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function streamablePostHeaders(
  sessionId?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...AUTHORIZATION,
    ...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
    ...extra,
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  ms = 500,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe("MCP HTTP/SSE server transport", () => {
  test("encodes SSE events with one data field per line", () => {
    expect(
      encodeSseEvent({
        id: "7",
        event: "message",
        data: "first\nsecond",
      }),
    ).toBe("id: 7\nevent: message\ndata: first\ndata: second\n\n");
  });

  test("HTTP POST dispatches JSON-RPC and preserves session state", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () =>
        new McpServerFramework({ serverInfo: { version: "1.0.0" } }),
    });
    const server = await startServer(transport);
    // The port is known only now. A loopback origin is no longer admitted by
    // default, so this origin is listed exactly.
    transport.replaceAllowedOrigins([server.baseUrl]);
    try {
      const initialize = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(undefined, { origin: server.baseUrl }),
        body: JSON.stringify(request(1, "initialize")),
      });
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).toEqual(expect.any(String));
      await expect(initialize.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: {
            name: "agenc-mcp-server",
            title: "AgenC",
            version: "1.0.0",
          },
          instructions: null,
        },
      });

      const ping = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(sessionId!),
        body: JSON.stringify(request(2, "ping")),
      });
      await expect(ping.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {},
      });
    } finally {
      await server.close();
    }
  });

  test("HTTP POST returns parse errors and 202 for notifications", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    try {
      const invalid = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: "{not-json",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: MCP_ERROR_PARSE,
          message: "invalid JSON-RPC message",
        },
      });

      const initialize = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify(request(1, "initialize")),
      });
      const sessionId = initialize.headers.get("mcp-session-id");
      const notification = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(sessionId!),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      expect(notification.status).toBe(202);
      await expect(notification.text()).resolves.toBe("");
    } finally {
      await server.close();
    }
  });

  test("HTTP POST does not create sessions before initialize", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    try {
      const ping = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify(request(1, "ping")),
      });
      expect(ping.status).toBe(400);
      expect(ping.headers.get("mcp-session-id")).toBeNull();
      await expect(ping.text()).resolves.toContain(
        "MCP HTTP/SSE session id is required",
      );
      expect(transport.snapshots()).toHaveLength(0);

      const invalid = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: "{not-json",
      });
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("mcp-session-id")).toBeNull();
      await expect(invalid.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: MCP_ERROR_PARSE,
          message: "invalid JSON-RPC message",
        },
      });
      expect(transport.snapshots()).toHaveLength(0);

      const invalidInitialize = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify(
          request(2, "initialize", { protocolVersion: 1 }),
        ),
      });
      expect(invalidInitialize.status).toBe(400);
      expect(invalidInitialize.headers.get("mcp-session-id")).toBeNull();
      await expect(invalidInitialize.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: -32602,
          message: "initialize protocolVersion must be a string",
        },
      });
      expect(transport.snapshots()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test("streamable HTTP rejects malformed and sessionless non-initialize messages", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    try {
      const malformedNotification = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: { invalid: true },
          method: "notifications/initialized",
        }),
      });
      expect(malformedNotification.status).toBe(400);
      await expect(malformedNotification.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "invalid JSON-RPC id",
        },
      });

      const validNotificationWithoutSession = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      expect(validNotificationWithoutSession.status).toBe(400);
      await expect(validNotificationWithoutSession.text()).resolves.toContain(
        "MCP HTTP/SSE session id is required",
      );
      expect(transport.snapshots()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test("streamable HTTP rejects invalid headers and origins", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    try {
      const missingAccept = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTHORIZATION },
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(missingAccept.status).toBe(406);

      const badVersion = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(undefined, {
          "mcp-protocol-version": "1999-01-01",
        }),
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(badVersion.status).toBe(400);

      const badOrigin = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(undefined, {
          origin: "https://203.0.113.10",
        }),
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(badOrigin.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  test("legacy SSE exposes a message endpoint and streams responses", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    const sse = await openSse(`${server.baseUrl}/sse`);
    try {
      expect(sse.response.statusCode).toBe(200);
      expect(sse.response.headers["content-type"]).toContain("text/event-stream");

      const endpoint = await withTimeout(sse.nextEvent());
      expect(endpoint.event).toBe("endpoint");
      const messageUrl = new URL(endpoint.data, server.baseUrl);
      expect(messageUrl.pathname).toBe("/message");
      expect(messageUrl.searchParams.get("sessionId")).toEqual(expect.any(String));

      const post = await fetch(messageUrl, {
        method: "POST",
        headers: AUTHORIZATION,
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(post.status).toBe(202);
      await expect(withTimeout(sse.nextEvent()).then((event) => JSON.parse(event.data))).resolves.toEqual(
        expect.objectContaining({ jsonrpc: "2.0", id: 1 }),
      );
    } finally {
      sse.close();
      await server.close();
    }
  });

  test("legacy SSE sessions are removed after disconnect", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    const sse = await openSse(`${server.baseUrl}/sse`);
    try {
      const endpoint = await withTimeout(sse.nextEvent());
      const messageUrl = new URL(endpoint.data, server.baseUrl);
      expect(transport.snapshots()).toHaveLength(1);

      sse.close();
      await waitFor(
        () => transport.snapshots().length === 0,
        "legacy SSE session to be removed after disconnect",
      );

      expect(transport.snapshots()).toHaveLength(0);
      const postAfterClose = await fetch(messageUrl, {
        method: "POST",
        headers: AUTHORIZATION,
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(postAfterClose.status).toBe(404);
    } finally {
      sse.close();
      await server.close();
    }
  });

  test("streamable /mcp SSE reconnects and DELETE terminates the session", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    let stream: SseClient | null = null;
    try {
      const initialize = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify(request(1, "initialize")),
      });
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).toEqual(expect.any(String));

      stream = await openSse(`${server.baseUrl}/mcp?sessionId=${sessionId}`);
      expect(stream.response.statusCode).toBe(200);
      await transport.send(sessionId!, {
        jsonrpc: "2.0",
        id: 99,
        method: "elicitation/create",
        params: { prompt: "from GET" },
      });

      await expect(withTimeout(stream.nextEvent()).then((event) => JSON.parse(event.data))).resolves.toEqual({
        jsonrpc: "2.0",
        id: 99,
        method: "elicitation/create",
        params: { prompt: "from GET" },
      });
      await expect(
        transport.send(sessionId!, {
          jsonrpc: "2.0",
          id: 100,
          result: { notAllowed: true },
        }),
      ).rejects.toThrow("GET stream cannot carry JSON-RPC responses");

      stream.close();
      await waitFor(
        () => transport.snapshots()[0]?.hasSseStream === false,
        "streamable SSE stream to detach after disconnect",
      );
      expect(transport.snapshots()).toEqual([
        { id: sessionId, hasSseStream: false, initialized: true },
      ]);

      const ping = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(sessionId!),
        body: JSON.stringify(request(2, "ping")),
      });
      await expect(ping.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {},
      });

      stream = await openSse(`${server.baseUrl}/mcp?sessionId=${sessionId}`);
      await transport.send(sessionId!, {
        jsonrpc: "2.0",
        id: 100,
        method: "elicitation/create",
        params: { prompt: "after reconnect" },
      });
      await expect(withTimeout(stream.nextEvent()).then((event) => JSON.parse(event.data))).resolves.toEqual({
        jsonrpc: "2.0",
        id: 100,
        method: "elicitation/create",
        params: { prompt: "after reconnect" },
      });

      const deleted = await fetch(`${server.baseUrl}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId!, ...AUTHORIZATION },
      });
      expect(deleted.status).toBe(204);
      expect(transport.snapshots()).toHaveLength(0);
    } finally {
      stream?.close();
      await server.close();
    }
  });

  test("streamable /mcp supports simultaneous GET streams without broadcasting", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    let first: SseClient | null = null;
    let second: SseClient | null = null;
    try {
      const initialize = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify(request(1, "initialize")),
      });
      const sessionId = initialize.headers.get("mcp-session-id")!;

      first = await openSse(`${server.baseUrl}/mcp?sessionId=${sessionId}`);
      second = await openSse(`${server.baseUrl}/mcp?sessionId=${sessionId}`);
      expect(transport.snapshots()).toEqual([
        { id: sessionId, hasSseStream: true, initialized: true },
      ]);

      await transport.send(sessionId, {
        jsonrpc: "2.0",
        id: 10,
        method: "elicitation/create",
        params: { stream: "first" },
      });
      await transport.send(sessionId, {
        jsonrpc: "2.0",
        id: 11,
        method: "elicitation/create",
        params: { stream: "second" },
      });

      await expect(withTimeout(first.nextEvent()).then((event) => JSON.parse(event.data))).resolves.toEqual({
        jsonrpc: "2.0",
        id: 10,
        method: "elicitation/create",
        params: { stream: "first" },
      });
      await expect(withTimeout(second.nextEvent()).then((event) => JSON.parse(event.data))).resolves.toEqual({
        jsonrpc: "2.0",
        id: 11,
        method: "elicitation/create",
        params: { stream: "second" },
      });
    } finally {
      first?.close();
      second?.close();
      await server.close();
    }
  });

  test("streamable /mcp SSE rejects missing and unknown sessions", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    try {
      const missing = await fetch(`${server.baseUrl}/mcp`, {
        headers: { accept: "text/event-stream", ...AUTHORIZATION },
      });
      expect(missing.status).toBe(400);
      await expect(missing.text()).resolves.toContain(
        "MCP HTTP/SSE session id is required",
      );

      const unknown = await fetch(`${server.baseUrl}/mcp?sessionId=missing`, {
        headers: { accept: "text/event-stream", ...AUTHORIZATION },
      });
      expect(unknown.status).toBe(404);
      await expect(unknown.text()).resolves.toContain(
        "MCP HTTP/SSE session not found",
      );
    } finally {
      await server.close();
    }
  });

  test("server-originated SSE requests resolve from later client responses", async () => {
    let activeSessionId = "";
    let transport: McpHttpSseServerTransport;
    transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => {
        const registry = new McpToolRegistry();
        const server = new McpServerFramework({ toolProvider: registry });
        registry.registerTool({
          definition: {
            name: "interactive.echo",
            description: "Waits for a remote response.",
            inputSchema: { type: "object" },
          },
          async call() {
            const clientResponse = new Promise((resolve) => {
              const requestToClient = server.createServerRequest(
                "elicitation/create",
                { prompt: "continue?" },
                resolve,
              );
              void transport.send(activeSessionId, requestToClient);
            });
            const response = await clientResponse;
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            } satisfies McpCallToolResult;
          },
        });
        return server;
      },
    });
    const server = await startServer(transport);
    const sse = await openSse(`${server.baseUrl}/sse`);
    try {
      const endpoint = await withTimeout(sse.nextEvent());
      const messageUrl = new URL(endpoint.data, server.baseUrl);
      activeSessionId = messageUrl.searchParams.get("sessionId")!;

      await fetch(messageUrl, {
        method: "POST",
        headers: AUTHORIZATION,
        body: JSON.stringify(request(1, "initialize")),
      });
      await withTimeout(sse.nextEvent());

      await fetch(messageUrl, {
        method: "POST",
        headers: AUTHORIZATION,
        body: JSON.stringify(
          request(2, "tools/call", {
            name: "interactive.echo",
            arguments: {},
          }),
        ),
      });
      const requestToClient = await withTimeout(sse.nextEvent()).then((event) =>
        JSON.parse(event.data),
      );
      expect(requestToClient).toEqual({
        jsonrpc: "2.0",
        id: 0,
        method: "elicitation/create",
        params: { prompt: "continue?" },
      });

      await fetch(messageUrl, {
        method: "POST",
        headers: AUTHORIZATION,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          result: { accepted: true },
        }),
      });
      const toolResponse = await withTimeout(sse.nextEvent()).then((event) =>
        JSON.parse(event.data),
      );
      expect(toolResponse).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                result: { accepted: true },
              }),
            },
          ],
        },
      });
    } finally {
      sse.close();
      await server.close();
    }
  });

  test("concurrent streamable POST SSE calls keep request-bound streams separate", async () => {
    let activeSessionId = "";
    let transport: McpHttpSseServerTransport;
    transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => {
        const registry = new McpToolRegistry();
        const server = new McpServerFramework({ toolProvider: registry });
        registry.registerTool({
          definition: {
            name: "interactive.http",
            description: "Waits for a request-bound response.",
            inputSchema: { type: "object" },
          },
          async call(_params, context) {
            const clientResponse = new Promise((resolve) => {
              const requestToClient = server.createServerRequest(
                "elicitation/create",
                { requestId: context.requestId },
                resolve,
              );
              void transport.sendForRequest(
                activeSessionId,
                context.requestId,
                requestToClient,
              );
            });
            const resolved = await clientResponse;
            return {
              content: [{ type: "text", text: JSON.stringify(resolved) }],
            } satisfies McpCallToolResult;
          },
        });
        return server;
      },
    });
    const server = await startServer(transport);
    let postStream: SseClient | null = null;
    try {
      const initialize = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify(request(1, "initialize")),
      });
      activeSessionId = initialize.headers.get("mcp-session-id")!;

      postStream = await openSsePost(
        `${server.baseUrl}/mcp`,
        JSON.stringify(
          request(2, "tools/call", {
            name: "interactive.http",
            arguments: {},
          }),
        ),
        streamablePostHeaders(activeSessionId),
      );
      const secondPostStream = await openSsePost(
        `${server.baseUrl}/mcp`,
        JSON.stringify(
          request(3, "tools/call", {
            name: "interactive.http",
            arguments: {},
          }),
        ),
        streamablePostHeaders(activeSessionId),
      );
      expect(postStream.response.headers["content-type"]).toContain(
        "text/event-stream",
      );
      const firstRequestToClient = await withTimeout(postStream.nextEvent()).then(
        (event) => JSON.parse(event.data),
      );
      const secondRequestToClient = await withTimeout(secondPostStream.nextEvent()).then(
        (event) => JSON.parse(event.data),
      );
      expect(firstRequestToClient).toEqual({
        jsonrpc: "2.0",
        id: 0,
        method: "elicitation/create",
        params: { requestId: 2 },
      });
      expect(secondRequestToClient).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "elicitation/create",
        params: { requestId: 3 },
      });

      const clientResponse = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(activeSessionId),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          result: { accepted: true },
        }),
      });
      expect(clientResponse.status).toBe(202);
      const secondClientResponse = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(activeSessionId),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { accepted: "second" },
        }),
      });
      expect(secondClientResponse.status).toBe(202);

      const finalResponse = await withTimeout(postStream.nextEvent()).then(
        (event) => JSON.parse(event.data),
      );
      const secondFinalResponse = await withTimeout(secondPostStream.nextEvent()).then(
        (event) => JSON.parse(event.data),
      );
      expect(finalResponse).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                result: { accepted: true },
              }),
            },
          ],
        },
      });
      expect(secondFinalResponse).toEqual({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { accepted: "second" },
              }),
            },
          ],
        },
      });
      secondPostStream.close();
    } finally {
      postStream?.close();
      await server.close();
    }
  });

  test("close ends live streams, is idempotent, and refuses later connects", async () => {
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => new McpServerFramework(),
      streamableIdleMs: 60_000,
    });
    const server = await startServer(transport);
    const legacy = await openSse(`${server.baseUrl}/sse`);
    await withTimeout(legacy.nextEvent());
    const initialize = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: streamablePostHeaders(),
      body: JSON.stringify(request(1, "initialize")),
    });
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toEqual(expect.any(String));
    const streamable = await openSse(
      `${server.baseUrl}/mcp?sessionId=${sessionId}`,
    );
    try {
      expect(legacy.response.statusCode).toBe(200);
      expect(streamable.response.statusCode).toBe(200);
      expect(transport.snapshots()).toHaveLength(2);

      transport.close();
      transport.close();
      expect(transport.snapshots()).toHaveLength(0);

      const refusedLegacy = await fetch(`${server.baseUrl}/sse`, {
        headers: AUTHORIZATION,
      });
      expect(refusedLegacy.status).toBe(503);
      await expect(refusedLegacy.text()).resolves.toContain("shutting down");

      const refusedInit = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify(request(2, "initialize")),
      });
      expect(refusedInit.status).toBe(503);
    } finally {
      legacy.close();
      streamable.close();
      await server.close();
    }
  });
});

describe("MCP HTTP/SSE server transport admission", () => {
  function countingTransport(
    options: {
      readonly allowedOrigins?: readonly string[];
      readonly maxBodyBytes?: number;
    } = {},
  ): { readonly transport: McpHttpSseServerTransport; readonly created: () => number } {
    let created = 0;
    const transport = new McpHttpSseServerTransport({
      token: TOKEN,
      serverFactory: () => {
        created += 1;
        return new McpServerFramework();
      },
      ...options,
    });
    return { transport, created: () => created };
  }

  async function initializeSession(baseUrl: string): Promise<string> {
    const initialize = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: streamablePostHeaders(),
      body: JSON.stringify(request(1, "initialize")),
    });
    expect(initialize.status).toBe(200);
    await initialize.json();
    const sessionId = initialize.headers.get("mcp-session-id");
    if (sessionId === null) throw new Error("missing MCP session id");
    return sessionId;
  }

  test("refuses to be constructed without a non-empty token", () => {
    const serverFactory = () => new McpServerFramework();
    for (const token of ["", "   ", "\t\n"]) {
      expect(
        () => new McpHttpSseServerTransport({ serverFactory, token }),
      ).toThrow("requires a non-empty bearer token");
    }
    expect(
      () =>
        new McpHttpSseServerTransport({ serverFactory } as unknown as {
          serverFactory: () => McpServerFramework;
          token: string;
        }),
    ).toThrow("requires a non-empty bearer token");
  });

  test("answers 401 on every route and method without the header, and creates no session", async () => {
    const { transport, created } = countingTransport();
    const server = await startServer(transport);
    try {
      const json = { "content-type": "application/json" };
      const accept = { accept: "application/json, text/event-stream" };
      const attempts: ReadonlyArray<{
        readonly name: string;
        readonly path: string;
        readonly init: RequestInit;
      }> = [
        {
          name: "streamable POST initialize",
          path: "/mcp",
          init: {
            method: "POST",
            headers: { ...json, ...accept },
            body: JSON.stringify(request(1, "initialize")),
          },
        },
        {
          name: "streamable POST for a session",
          path: "/mcp",
          init: {
            method: "POST",
            headers: { ...json, ...accept, "mcp-session-id": "any-session" },
            body: JSON.stringify(request(2, "resources/list")),
          },
        },
        {
          name: "streamable GET stream",
          path: "/mcp?sessionId=any-session",
          init: { method: "GET", headers: { accept: "text/event-stream" } },
        },
        {
          name: "streamable DELETE",
          path: "/mcp",
          init: { method: "DELETE", headers: { "mcp-session-id": "any-session" } },
        },
        {
          name: "legacy SSE stream",
          path: "/sse",
          init: { method: "GET", headers: { accept: "text/event-stream" } },
        },
        {
          name: "legacy message POST",
          path: "/message?sessionId=any-session",
          init: {
            method: "POST",
            body: JSON.stringify(request(3, "initialize")),
          },
        },
        { name: "unknown route", path: "/elsewhere", init: { method: "GET" } },
        { name: "preflight", path: "/mcp", init: { method: "OPTIONS" } },
      ];
      for (const attempt of attempts) {
        const response = await fetch(`${server.baseUrl}${attempt.path}`, attempt.init);
        const body = await response.text();
        expect(response.status, attempt.name).toBe(401);
        expect(response.headers.get("www-authenticate"), attempt.name).toBe("Bearer");
        expect(response.headers.get("mcp-session-id"), attempt.name).toBeNull();
        expect(body, attempt.name).not.toContain(TOKEN);
        expect(transport.snapshots(), attempt.name).toHaveLength(0);
      }
      expect(created()).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("decides 401 before the request target, headers or body are judged", async () => {
    const { transport, created } = countingTransport({ maxBodyBytes: 16 });
    const server = await startServer(transport);
    try {
      // With the token these are answered 406 and 415, so a 401 here shows
      // that the token is checked before either.
      const missingAccept = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request(1, "ping")),
      } as const;
      const wrongContentType = {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "text/plain",
        },
        body: "{not-json",
      } as const;
      for (const [init, statusWithToken] of [
        [missingAccept, 406],
        [wrongContentType, 415],
      ] as const) {
        const refused = await fetch(`${server.baseUrl}/mcp`, init);
        expect(refused.status).toBe(401);
        const judged = await fetch(`${server.baseUrl}/mcp`, {
          ...init,
          headers: { ...init.headers, ...AUTHORIZATION },
        });
        expect(judged.status).toBe(statusWithToken);
      }

      // Far past the 16-byte body limit, and still not read.
      const oversized = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(request(1, "initialize", { pad: "x".repeat(4096) })),
      });
      expect(oversized.status).toBe(401);

      // A request target with no URL form used to escape the handler.
      const malformedTarget = await fetch(`${server.baseUrl}//`);
      expect(malformedTarget.status).toBe(401);
      const malformedTargetWithToken = await fetch(`${server.baseUrl}//`, {
        headers: AUTHORIZATION,
      });
      expect(malformedTargetWithToken.status).toBe(400);
      await expect(malformedTargetWithToken.text()).resolves.toContain(
        "request target is invalid",
      );

      expect(created()).toBe(0);
      expect(transport.snapshots()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test("does not reveal or touch an existing session without the header", async () => {
    const { transport } = countingTransport();
    const server = await startServer(transport);
    try {
      const sessionId = await initializeSession(server.baseUrl);
      const before = transport.snapshots();
      expect(before).toHaveLength(1);

      const read = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify(request(2, "ping")),
      });
      expect(read.status).toBe(401);
      const stream = await fetch(`${server.baseUrl}/mcp?sessionId=${sessionId}`, {
        headers: { accept: "text/event-stream" },
      });
      expect(stream.status).toBe(401);
      const deleted = await fetch(`${server.baseUrl}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
      });
      expect(deleted.status).toBe(401);
      expect(transport.snapshots()).toEqual(before);

      // The session still answers its owner.
      const ping = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(sessionId),
        body: JSON.stringify(request(3, "ping")),
      });
      expect(ping.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  test("answers 401 for a wrong token and for one that differs only in length", async () => {
    const { transport, created } = countingTransport();
    const server = await startServer(transport);
    try {
      const rejected: ReadonlyArray<readonly [string, string]> = [
        ["wrong token of the same length", `Bearer ${"x".repeat(TOKEN.length)}`],
        ["one character short", `Bearer ${TOKEN.slice(0, -1)}`],
        ["one character long", `Bearer ${TOKEN}x`],
        ["leading character dropped", `Bearer ${TOKEN.slice(1)}`],
        ["token repeated", `Bearer ${TOKEN}${TOKEN}`],
        ["empty credential", "Bearer "],
        ["token without a scheme", TOKEN],
        ["scheme without a separator", `Bearer${TOKEN}`],
        ["another scheme", `Basic ${TOKEN}`],
        ["token sent as a Basic password", `Basic ${btoa(`agenc:${TOKEN}`)}`],
      ];
      for (const [name, authorization] of rejected) {
        const response = await fetch(`${server.baseUrl}/mcp`, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization,
          },
          body: JSON.stringify(request(1, "initialize")),
        });
        expect(response.status, name).toBe(401);
        expect(response.headers.get("www-authenticate"), name).toBe("Bearer");
        expect(await response.text(), name).not.toContain(TOKEN);
      }
      // A query-string token is never read.
      const queryToken = await fetch(
        `${server.baseUrl}/mcp?token=${TOKEN}&access_token=${TOKEN}`,
        {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(request(1, "initialize")),
        },
      );
      expect(queryToken.status).toBe(401);
      expect(created()).toBe(0);
      expect(transport.snapshots()).toHaveLength(0);

      // The scheme name is case-insensitive; the token is not.
      const lowerScheme = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(undefined, {
          authorization: `bearer ${TOKEN}`,
        }),
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(lowerScheme.status).toBe(200);
      const upperToken = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(undefined, {
          authorization: `Bearer ${TOKEN.toUpperCase()}`,
        }),
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(upperToken.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("refuses every origin by default, loopback origins included", async () => {
    const { transport, created } = countingTransport();
    const server = await startServer(transport);
    try {
      for (const origin of [
        "http://localhost",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://[::1]:5173",
        server.baseUrl,
        "https://203.0.113.10",
        "https://attacker.example",
        "null",
        "",
      ]) {
        const response = await fetch(`${server.baseUrl}/mcp`, {
          method: "POST",
          headers: streamablePostHeaders(undefined, { origin }),
          body: JSON.stringify(request(1, "initialize")),
        });
        expect(response.status, JSON.stringify(origin)).toBe(403);
        await expect(response.text()).resolves.toContain("origin is not allowed");
      }
      const legacy = await fetch(`${server.baseUrl}/sse`, {
        headers: {
          accept: "text/event-stream",
          origin: "http://localhost:5173",
          ...AUTHORIZATION,
        },
      });
      expect(legacy.status).toBe(403);
      expect(created()).toBe(0);
      expect(transport.snapshots()).toHaveLength(0);

      // The same client without an Origin header is admitted on the token.
      await expect(initializeSession(server.baseUrl)).resolves.toEqual(
        expect.any(String),
      );
    } finally {
      await server.close();
    }
  });

  test("admits exactly the configured origin, and only with the token", async () => {
    const allowed = "http://localhost:5173";
    const { transport } = countingTransport({ allowedOrigins: [allowed] });
    const server = await startServer(transport);
    try {
      const admitted = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(undefined, { origin: allowed }),
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(admitted.status).toBe(200);
      const sessionId = admitted.headers.get("mcp-session-id");
      expect(sessionId).toEqual(expect.any(String));

      for (const origin of [
        "http://localhost:5174",
        "http://localhost",
        "https://localhost:5173",
        "http://LOCALHOST:5173",
        "http://localhost:5173/",
        "http://127.0.0.1:5173",
        "http://localhost:5173.attacker.example",
        "https://attacker.example",
        `${allowed}, https://attacker.example`,
        "null",
      ]) {
        const response = await fetch(`${server.baseUrl}/mcp`, {
          method: "POST",
          headers: streamablePostHeaders(sessionId!, { origin }),
          body: JSON.stringify(request(2, "ping")),
        });
        expect(response.status, origin).toBe(403);
      }

      const withoutToken = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin: allowed,
        },
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(withoutToken.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  test("replacing the origin allowlist revokes sessions and takes effect at once", async () => {
    const first = "http://localhost:5173";
    const second = "https://app.example";
    const { transport } = countingTransport({ allowedOrigins: [first] });
    const server = await startServer(transport);
    const attempt = async (origin: string): Promise<number> => {
      const response = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: streamablePostHeaders(undefined, { origin }),
        body: JSON.stringify(request(1, "initialize")),
      });
      await response.text();
      return response.status;
    };
    try {
      await expect(attempt(first)).resolves.toBe(200);
      await expect(attempt(second)).resolves.toBe(403);
      expect(transport.snapshots()).toHaveLength(1);

      expect(() => transport.replaceAllowedOrigins(["https://app.example/"])).toThrow(
        "allowed origin",
      );
      await expect(attempt(first)).resolves.toBe(200);
      expect(transport.snapshots()).toHaveLength(2);

      expect(transport.replaceAllowedOrigins([second])).toBe(2);
      expect(transport.snapshots()).toHaveLength(0);
      await expect(attempt(first)).resolves.toBe(403);
      await expect(attempt(second)).resolves.toBe(200);

      expect(transport.replaceAllowedOrigins([])).toBe(1);
      await expect(attempt(second)).resolves.toBe(403);
    } finally {
      await server.close();
    }
  });

  test("refuses to be constructed with an entry that is not an exact origin", () => {
    const serverFactory = () => new McpServerFramework();
    for (const origin of ["*", "null", "localhost:5173", "http://localhost:5173/"]) {
      expect(
        () =>
          new McpHttpSseServerTransport({
            serverFactory,
            token: TOKEN,
            allowedOrigins: [origin],
          }),
      ).toThrow("allowed origin");
    }
  });
});
