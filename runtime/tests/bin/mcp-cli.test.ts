import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import type { LLMTool } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { Tool } from "../tools/types.js";
import {
  formatMcpSseServeUrl,
  formatAgenCMcpCliHelpText,
  parseAgenCMcpCliArgs,
  parseMcpServeArgs,
  resolveMcpServeDefaults,
  runAgenCMcpCli,
  startMcpSseServe,
  type AgenCMcpCliIo,
} from "./mcp-cli.js";

const SAMPLE_TOOL: Tool = {
  name: "sample.echo",
  description: "Echo text back to the caller.",
  isReadOnly: true,
  metadata: { mutating: false },
  requiresApproval: false,
  recoveryCategory: "idempotent",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
  },
  async execute(args) {
    return {
      content: `echo:${String(args.text ?? "")}`,
      codeModeResult: { tool: "sample.echo" },
    };
  },
};

const MUTATING_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.write",
  description: "Mutates state.",
  isReadOnly: false,
  metadata: { mutating: true },
  recoveryCategory: "side-effecting",
};

const CONTRADICTORY_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.contradictory",
  description: "Claims read-only while declaring a mutation.",
  metadata: { mutating: true },
};

const RUNTIME_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const AGENC_MCP_STDIO_ROUTE_TIMEOUT_MS = 15_000;

function request(id: number, method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  } as const;
}

function createToolRegistry(): ToolRegistry {
  return {
    tools: [SAMPLE_TOOL, MUTATING_TOOL, CONTRADICTORY_TOOL],
    toLLMTools(): LLMTool[] {
      return [];
    },
    async dispatch(toolCall): Promise<ToolDispatchResult> {
      return {
        content: `echo:${JSON.parse(toolCall.arguments).text}`,
        codeModeResult: { tool: toolCall.name },
      };
    },
  };
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
    close(): void {
      reader.close();
    },
  };
}

function createWritableCapture(): Writable & { readonly text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return Object.assign(stream, { text: () => text });
}

function createIo(
  stdin: Readable = Readable.from([]),
  stdout: Writable = createWritableCapture(),
  stderr: Writable = createWritableCapture(),
): AgenCMcpCliIo {
  return { stdin, stdout, stderr };
}

function streamablePostHeaders(sessionId?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
  };
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

function parseSseData(frame: string): string {
  return frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
}

function runAgencMainForMcpServe(): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const loaderDir = mkdtempSync(join(tmpdir(), "agenc-mcp-route-"));
  const loaderPath = join(loaderDir, "bun-bundle-loader.mjs");
  writeFileSync(
    loaderPath,
    [
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier === 'bun:bundle') {",
      "    return {",
      "      url: 'data:text/javascript,export function feature(){return false}',",
      "      shortCircuit: true,",
      "    };",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "export async function load(url, context, nextLoad) {",
      "  if (url.endsWith('.md')) {",
      "    const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL(url), 'utf8'));",
      "    return {",
      "      format: 'module',",
      "      source: `export default ${JSON.stringify(source)};`,",
      "      shortCircuit: true,",
      "    };",
      "  }",
      "  return nextLoad(url, context);",
      "}",
      "",
    ].join("\n"),
  );
  const script = [
    "process.argv = [process.execPath, '/opt/agenc/bin/agenc.js', 'mcp', 'serve', '--transport', 'stdio'];",
    "const { main } = await import('./src/bin/agenc.ts');",
    "process.exit(await main());",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--loader",
    loaderPath,
    "--import",
    "tsx",
    "--eval",
    script,
  ], {
    cwd: RUNTIME_ROOT,
    env: {
      ...process.env,
      AGENC_CLI_ENTRY_DISABLE: "1",
      NODE_NO_WARNINGS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rmSync(loaderDir, { recursive: true, force: true });
      reject(
        new Error(
          [
            `agenc mcp stdio route timed out after ${AGENC_MCP_STDIO_ROUTE_TIMEOUT_MS}ms`,
            stdout.trim().length > 0 ? `stdout:\n${stdout}` : "stdout: <empty>",
            stderr.trim().length > 0 ? `stderr:\n${stderr}` : "stderr: <empty>",
          ].join("\n"),
        ),
      );
    }, AGENC_MCP_STDIO_ROUTE_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rmSync(loaderDir, { recursive: true, force: true });
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      rmSync(loaderDir, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

describe("AgenC MCP CLI", () => {
  test("parses the mcp serve command", () => {
    expect(parseAgenCMcpCliArgs(["hello"])).toBeNull();
    expect(parseAgenCMcpCliArgs(["mcp"])).toEqual({
      kind: "help",
      text: formatAgenCMcpCliHelpText(),
    });
    expect(parseAgenCMcpCliArgs(["mcp", "serve"])).toEqual({
      kind: "serve",
      transport: "stdio",
      host: "127.0.0.1",
      port: 3334,
    });
    expect(
      parseAgenCMcpCliArgs([
        "mcp",
        "serve",
        "--transport=sse",
      ]),
    ).toEqual({
      kind: "serve",
      transport: "sse",
      host: "127.0.0.1",
      port: 3334,
    });
  });

  test("uses mcp.server config defaults for mcp serve", () => {
    const config = {
      mcp: {
        server: {
          enabled: true,
          transport: "sse" as const,
          host: "localhost",
          port: 4444,
        },
      },
    };

    expect(resolveMcpServeDefaults(config.mcp.server)).toEqual({
      enabled: true,
      transport: "sse",
      host: "localhost",
      port: 4444,
    });
    expect(parseAgenCMcpCliArgs(["mcp", "serve"], config)).toEqual({
      kind: "serve",
      transport: "sse",
      host: "localhost",
      port: 4444,
    });
    expect(
      parseMcpServeArgs(["--transport", "stdio"], config),
    ).toEqual({
      kind: "serve",
      transport: "stdio",
      host: "localhost",
      port: 4444,
    });
  });

  test("falls back to safe mcp.server defaults for malformed raw config values", () => {
    expect(
      resolveMcpServeDefaults({
        enabled: true,
        transport: "http" as never,
        host: "   ",
        port: -1,
      }),
    ).toEqual({
      enabled: true,
      transport: "stdio",
      host: "127.0.0.1",
      port: 3334,
    });
  });

  test("reports invalid mcp serve arguments", () => {
    expect(parseAgenCMcpCliArgs(["mcp", "run"])).toEqual({
      kind: "error",
      message: "unknown mcp command: run",
    });
    expect(parseAgenCMcpCliArgs(["mcp", "serve", "--transport=http"]))
      .toEqual({
        kind: "error",
        message: "--transport must be 'stdio' or 'sse'",
      });
    expect(parseAgenCMcpCliArgs(["mcp", "serve", "--host", "localhost"]))
      .toEqual({
        kind: "error",
        message: "mcp serve only accepts --transport",
      });
    expect(parseAgenCMcpCliArgs(["mcp", "serve", "--port=3335"]))
      .toEqual({
        kind: "error",
        message: "mcp serve only accepts --transport",
      });
    expect(parseAgenCMcpCliArgs(["mcp", "serve", "--port="])).toEqual({
      kind: "error",
      message: "mcp serve only accepts --transport",
    });
  });

  test("formats SSE URLs for loopback-only non-IPv4 hosts", () => {
    expect(formatMcpSseServeUrl("::1", 3334)).toBe("http://[::1]:3334/mcp");
    expect(formatMcpSseServeUrl("localhost", 3334)).toBe(
      "http://localhost:3334/mcp",
    );
    expect(() => formatMcpSseServeUrl("0.0.0.0", 3334)).toThrow(
      "only binds to loopback hosts",
    );
  });

  test("runs help and error commands against supplied IO", async () => {
    const helpStdout = createWritableCapture();
    await expect(
      runAgenCMcpCli(
        { kind: "help", text: "mcp help" },
        { io: createIo(undefined, helpStdout) },
      ),
    ).resolves.toBe(0);
    expect(helpStdout.text()).toBe("mcp help\n");

    const errorStderr = createWritableCapture();
    await expect(
      runAgenCMcpCli(
        { kind: "error", message: "bad args" },
        { io: createIo(undefined, undefined, errorStderr) },
      ),
    ).resolves.toBe(1);
    expect(errorStderr.text()).toContain("agenc: bad args\n");
    expect(errorStderr.text()).toContain("agenc mcp serve");
  });

  test("routes the actual agenc entrypoint to mcp stdio serve", async () => {
    await expect(runAgencMainForMcpServe()).resolves.toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("exits stdio serve without materializing tools when stdin closes", async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    const registry: ToolRegistry = {
      get tools(): readonly Tool[] {
        throw new Error("tool registry should not be materialized before MCP requests");
      },
      toLLMTools(): LLMTool[] {
        throw new Error("tool registry should not be materialized before MCP requests");
      },
      async dispatch(): Promise<ToolDispatchResult> {
        throw new Error("tool registry should not be materialized before MCP requests");
      },
    };

    await expect(
      runAgenCMcpCli(
        {
          kind: "serve",
          transport: "stdio",
          host: "127.0.0.1",
          port: 3334,
        },
        {
          io: createIo(Readable.from([]), stdout, stderr),
          toolRegistry: registry,
        },
      ),
    ).resolves.toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("");
  });

  test("serves MCP over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = createWritableCapture();
    const lines = createOutputLines(output);
    const result = runAgenCMcpCli(
      {
        kind: "serve",
        transport: "stdio",
        host: "127.0.0.1",
        port: 3334,
      },
      {
        io: createIo(input, output, stderr),
        toolRegistry: createToolRegistry(),
      },
    );

    input.write(`${JSON.stringify(request(1, "initialize"))}\n`);
    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({
          serverInfo: expect.objectContaining({
            name: "agenc-mcp-server",
          }),
        }),
      }),
    );

    input.write(`${JSON.stringify(request(2, "tools/list"))}\n`);
    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: SAMPLE_TOOL.name,
            description: SAMPLE_TOOL.description,
            inputSchema: SAMPLE_TOOL.inputSchema,
          },
        ],
        nextCursor: null,
      },
    });

    input.write(
      `${JSON.stringify(
        request(3, "tools/call", {
          name: "sample.echo",
          arguments: { text: "hello" },
        }),
      )}\n`,
    );
    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: "echo:hello" }],
        structuredContent: { tool: "sample.echo" },
      },
    });

    input.write(
      `${JSON.stringify(
        request(4, "tools/call", {
          name: CONTRADICTORY_TOOL.name,
          arguments: {},
        }),
      )}\n`,
    );
    await expect(lines.nextLine().then(JSON.parse)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: {
        content: [
          {
            type: "text",
            text: expect.stringContaining(
              "only explicitly read-only, non-mutating, idempotent tools",
            ),
          },
        ],
        isError: true,
      },
    });

    input.end();
    await expect(withTimeout(result)).resolves.toBe(0);
    expect(stderr.text()).toBe("");
    lines.close();
  });

  test("pins foreground stdio workspace before lazy tool creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-mcp-pinned-stdio-"));
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    writeFileSync(join(workspaceA, "only-a.txt"), "a");
    writeFileSync(join(workspaceB, "only-b.txt"), "b");
    const originalCwd = process.cwd();
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = createWritableCapture();
    const lines = createOutputLines(output);
    let result: Promise<number> | undefined;
    try {
      process.chdir(workspaceA);
      result = runAgenCMcpCli(
        {
          kind: "serve",
          transport: "stdio",
          host: "127.0.0.1",
          port: 3334,
        },
        { io: createIo(input, output, stderr) },
      );
      process.chdir(workspaceB);

      input.write(`${JSON.stringify(request(1, "initialize"))}\n`);
      await lines.nextLine();
      input.write(
        `${JSON.stringify(
          request(2, "tools/call", {
            name: "system.listDir",
            arguments: { path: workspaceA },
          }),
        )}\n`,
      );
      expect(await lines.nextLine()).toContain("only-a.txt");
      input.write(
        `${JSON.stringify(
          request(3, "tools/call", {
            name: "system.listDir",
            arguments: { path: workspaceB },
          }),
        )}\n`,
      );
      expect(await lines.nextLine()).toContain(
        "Path is outside allowed directories",
      );
      input.end();
      await expect(result).resolves.toBe(0);
      expect(stderr.text()).toBe("");
    } finally {
      input.end();
      await result?.catch(() => {});
      lines.close();
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("starts an MCP streamable HTTP server for SSE transport", async () => {
    const started = await startMcpSseServe(
      {
        kind: "serve",
        transport: "sse",
        host: "127.0.0.1",
        port: 0,
      },
      { toolRegistry: createToolRegistry() },
    );
    try {
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const response = await fetch(started.url, {
        method: "POST",
        headers: streamablePostHeaders(),
        body: JSON.stringify(request(1, "initialize")),
      });
      expect(response.status).toBe(200);
      const sessionId = response.headers.get("mcp-session-id");
      expect(sessionId).toEqual(expect.any(String));
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ jsonrpc: "2.0", id: 1 }),
      );

      const toolResponse = await fetch(started.url, {
        method: "POST",
        headers: streamablePostHeaders(sessionId ?? undefined),
        body: JSON.stringify(
          request(2, "tools/call", {
            name: "sample.echo",
            arguments: { text: "hello" },
          }),
        ),
      });
      expect(toolResponse.status).toBe(200);
      expect(toolResponse.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const toolMessage = JSON.parse(parseSseData(await toolResponse.text()));
      expect(toolMessage).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: "echo:hello" }],
          structuredContent: { tool: "sample.echo" },
        },
      });

      const deniedResponse = await fetch(started.url, {
        method: "POST",
        headers: streamablePostHeaders(sessionId ?? undefined),
        body: JSON.stringify(
          request(3, "tools/call", {
            name: MUTATING_TOOL.name,
            arguments: {},
          }),
        ),
      });
      expect(deniedResponse.status).toBe(200);
      const deniedMessage = JSON.parse(
        parseSseData(await deniedResponse.text()),
      );
      expect(deniedMessage).toEqual({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                "Environment overrides are not authorization",
              ),
            },
          ],
          isError: true,
        },
      });
    } finally {
      await started.close();
    }
  });
});
