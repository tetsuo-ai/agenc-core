import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";

import { MCP_ERROR_NOT_INITIALIZED, MCP_ERROR_PARSE } from "./types.js";
import { McpHttpSseServerTransport, encodeSseEvent } from "./http-sse.js";
import { McpServerFramework } from "./framework.js";
import { McpToolRegistry } from "./tools.js";
import type { McpCallToolResult } from "./types.js";

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
  return openSseRequest(url, { method: "GET", headers: { accept: "text/event-stream" } });
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
      serverFactory: () =>
        new McpServerFramework({ serverInfo: { version: "1.0.0" } }),
    });
    const server = await startServer(transport);
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
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    try {
      const missingAccept = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
        headers: { "mcp-session-id": sessionId! },
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
      serverFactory: () => new McpServerFramework(),
    });
    const server = await startServer(transport);
    try {
      const missing = await fetch(`${server.baseUrl}/mcp`, {
        headers: { accept: "text/event-stream" },
      });
      expect(missing.status).toBe(400);
      await expect(missing.text()).resolves.toContain(
        "MCP HTTP/SSE session id is required",
      );

      const unknown = await fetch(`${server.baseUrl}/mcp?sessionId=missing`, {
        headers: { accept: "text/event-stream" },
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
        body: JSON.stringify(request(1, "initialize")),
      });
      await withTimeout(sse.nextEvent());

      await fetch(messageUrl, {
        method: "POST",
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
});
