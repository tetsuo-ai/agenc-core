import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";

import { MCP_ERROR_PARSE } from "./types.js";
import { McpServerFramework } from "./framework.js";
import {
  AGENC_MCP_STDIO_DEFAULT_MAX_LINE_BYTES,
  McpStdioServerTransport,
  encodeMcpJsonLine,
} from "./stdio.js";
import { McpToolRegistry } from "./tools.js";
import type { McpCallToolResult } from "./types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function request(id: number, method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  } as const;
}

function createOutputLines(stream: PassThrough) {
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
    terminal: false,
  });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  reader.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
      return;
    }
    lines.push(line);
  });

  return {
    nextLine(): Promise<string> {
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    queuedCount(): number {
      return lines.length;
    },
    close(): void {
      reader.close();
    },
  };
}

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function withTimeout<T>(promise: Promise<T>, ms = 250): Promise<T> {
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

describe("MCP stdio server transport", () => {
  test("encodes one compact JSON-RPC message per newline", () => {
    const line = encodeMcpJsonLine({
      jsonrpc: "2.0",
      id: 1,
      result: { text: "hello\nworld" },
    });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { text: "hello\nworld" },
    });
  });

  test("reads stdin JSON-RPC lines through the framework and writes stdout lines", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = createOutputLines(output);
    const transport = new McpStdioServerTransport({
      input,
      output,
      server: new McpServerFramework({ serverInfo: { version: "1.0.0" } }),
    });
    transport.start();

    input.write(`${JSON.stringify(request(1, "initialize"))}\n`);

    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual({
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

    await transport.close();
    lines.close();
  });

  test("reports malformed JSON lines and continues with later valid messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = createOutputLines(output);
    const transport = new McpStdioServerTransport({
      input,
      output,
      server: new McpServerFramework(),
    });
    transport.start();

    input.write("{not-json\n");
    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: MCP_ERROR_PARSE,
        message: "invalid JSON-RPC message",
      },
    });

    input.write(`${JSON.stringify(request(2, "initialize"))}\n`);
    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual(
      expect.objectContaining({ jsonrpc: "2.0", id: 2 }),
    );

    await transport.close();
    lines.close();
  });

  test("keeps client responses flowing while a tool call is in flight", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = createOutputLines(output);
    const registry = new McpToolRegistry();
    const server = new McpServerFramework({ toolProvider: registry });
    let transport: McpStdioServerTransport;
    registry.registerTool({
      definition: {
        name: "interactive.echo",
        description: "Waits for a client response.",
        inputSchema: { type: "object" },
      },
      async call() {
        const clientResponse = new Promise((resolve) => {
          const requestToClient = server.createServerRequest(
            "elicitation/create",
            { prompt: "continue?" },
            resolve,
          );
          void transport.send(requestToClient);
        });
        const response = await clientResponse;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response),
            },
          ],
        } satisfies McpCallToolResult;
      },
    });
    transport = new McpStdioServerTransport({
      input,
      output,
      server,
    });
    transport.start();

    input.write(`${JSON.stringify(request(1, "initialize"))}\n`);
    await lines.nextLine();
    input.write(
      `${JSON.stringify(
        request(2, "tools/call", { name: "interactive.echo", arguments: {} }),
      )}\n`,
    );

    const clientRequest = await withTimeout(lines.nextLine().then(JSON.parse));
    expect(clientRequest).toEqual({
      jsonrpc: "2.0",
      id: 0,
      method: "elicitation/create",
      params: { prompt: "continue?" },
    });
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        result: { accepted: true },
      })}\n`,
    );

    const toolResponse = await withTimeout(lines.nextLine().then(JSON.parse));
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

    await transport.close();
    lines.close();
  });

  test("tears down the connection when an unterminated line exceeds the cap", async () => {
    // A peer that streams bytes without a newline must not grow the readline
    // buffer (and MCP server memory) unbounded; the reader destroys input and
    // surfaces a RangeError once the cap is tripped.
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const destroyed = new Promise<void>((resolve) => {
      input.once("close", () => resolve());
    });
    const transport = new McpStdioServerTransport({
      input,
      output,
      server: new McpServerFramework(),
      maxLineBytes: 64,
      onError: (error) => {
        errors.push(error);
      },
    });
    transport.start();

    // 200 bytes with no newline must trip the 64-byte bound.
    input.write("x".repeat(200));

    await destroyed;
    expect(input.destroyed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
    expect(errors[0]?.message).toMatch(/64 bytes without a newline/);

    await transport.close();
  });

  test("does not trip the cap when newlines keep lines bounded", async () => {
    // Prior valid behavior: newline-terminated frames under the cap keep
    // flowing without tripping the bound.
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = createOutputLines(output);
    const errors: Error[] = [];
    const transport = new McpStdioServerTransport({
      input,
      output,
      server: new McpServerFramework({ serverInfo: { version: "1.0.0" } }),
      maxLineBytes: 256,
      onError: (error) => {
        errors.push(error);
      },
    });
    transport.start();

    input.write(`${JSON.stringify(request(1, "initialize"))}\n`);
    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual(
      expect.objectContaining({ jsonrpc: "2.0", id: 1 }),
    );

    await delay(20);
    expect(errors).toHaveLength(0);
    expect(input.destroyed).toBe(false);

    await transport.close();
    lines.close();
  });

  test("exposes a default max line bound matching the app-server cap", () => {
    expect(AGENC_MCP_STDIO_DEFAULT_MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
  });

  test("notifies close after queued work drains", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = createOutputLines(output);
    const closeEvents: string[] = [];
    const transport = new McpStdioServerTransport({
      input,
      output,
      server: new McpServerFramework(),
      onClose: () => {
        closeEvents.push("closed");
      },
    });
    transport.start();

    input.write(`${JSON.stringify(request(1, "initialize"))}\n`);
    input.end();

    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual(
      expect.objectContaining({ jsonrpc: "2.0", id: 1 }),
    );
    await flushMacrotask();

    expect(closeEvents).toEqual(["closed"]);
    await transport.close();
    expect(closeEvents).toEqual(["closed"]);
    lines.close();
  });
});
