import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sourcePath } from "../helpers/source-path.ts";
import {
  bootstrapLocalRuntimeSession,
  type LocalRuntimeBootstrap,
} from "./bootstrap.js";
import type { Event } from "../session/event-log.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMTool,
  LLMToolCall,
} from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
import { runCommand } from "../utils/process.js";

const FIXTURE_PATH = sourcePath("mcp-client/test-fixtures/stdio-pid-server.cjs");
const MCP_SERVER_NAME = "live";
const MCP_TOOL_NAME = `mcp.${MCP_SERVER_NAME}.ping`;
const UNTRUSTED_TOOL_RESULT_BOUNDARY =
  "===== AGENC UNTRUSTED TOOL RESULT DATA =====";

const tempDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

async function readPid(pidFile: string): Promise<number> {
  const raw = await readFile(pidFile, "utf8");
  return Number.parseInt(raw.trim(), 10);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function response(content: string, toolCalls: LLMToolCall[] = []): LLMResponse {
  return {
    content,
    toolCalls,
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    },
    model: "test-model",
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

function toolNames(tools: ReadonlyArray<LLMTool> | undefined): string[] {
  return tools?.map((tool) => tool.function.name) ?? [];
}

function cloneMessages(messages: readonly LLMMessage[]): LLMMessage[] {
  return JSON.parse(JSON.stringify(messages)) as LLMMessage[];
}

function makeProviderRecorder(params: {
  readonly seenToolNamesByCall: string[][];
  readonly seenMessagesByCall: LLMMessage[][];
}): LLMProvider {
  let callCount = 0;
  return {
    name: "stub-live-mcp",
    chat: async () => response("unused"),
    chatStream: async (messages, _onChunk, options) => {
      params.seenMessagesByCall.push(cloneMessages(messages));
      params.seenToolNamesByCall.push(toolNames(options?.tools));
      callCount += 1;

      if (callCount === 1) {
        return response("", [
          {
            id: "search-live-mcp",
            name: "system.searchTools",
            arguments: JSON.stringify({
              query: "ping",
              select: MCP_TOOL_NAME,
              source: "mcp",
              maxResults: 5,
            }),
          },
        ]);
      }

      if (callCount === 2) {
        return response("", [
          {
            id: "call-live-mcp",
            name: MCP_TOOL_NAME,
            arguments: "{}",
          },
        ]);
      }

      return response("MCP ping complete.");
    },
    healthCheck: async () => true,
  };
}

function makeBuiltinDiscoveryProvider(params: {
  readonly seenToolNamesByCall: string[][];
  readonly workspace: string;
}): LLMProvider {
  let callCount = 0;
  return {
    name: "stub-builtins",
    chat: async () => response("unused"),
    chatStream: async (_messages, _onChunk, options) => {
      params.seenToolNamesByCall.push(toolNames(options?.tools));
      callCount += 1;

      if (callCount === 1) {
        return response("", [
          {
            id: "search-git-status",
            name: "system.searchTools",
            arguments: JSON.stringify({
              query: "git status",
              select: "system.gitStatus",
              maxResults: 5,
            }),
          },
        ]);
      }

      if (callCount === 2) {
        return response("", [
          {
            id: "call-git-status",
            name: "system.gitStatus",
            arguments: JSON.stringify({ path: params.workspace }),
          },
        ]);
      }

      return response("git status complete.");
    },
    healthCheck: async () => true,
  };
}

async function collectEvents(
  iterable: AsyncIterable<PhaseEvent>,
): Promise<PhaseEvent[]> {
  const events: PhaseEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function expectLiveMcpEndToEnd(params: {
  readonly home: string;
  readonly workspace: string;
  readonly pidFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
}): Promise<void> {
  const seenToolNamesByCall: string[][] = [];
  const seenMessagesByCall: LLMMessage[][] = [];
  const provider = makeProviderRecorder({
    seenToolNamesByCall,
    seenMessagesByCall,
  });
  const providerMod = await import("../llm/provider.js");
  const createProviderSpy = vi
    .spyOn(providerMod, "createProvider")
    .mockReturnValue(provider as never);

  let boot: LocalRuntimeBootstrap | null = null;
  let pid: number | undefined;
  try {
    boot = await bootstrapLocalRuntimeSession({
      apiKey: "test-key",
      env: params.env,
      ...(params.argv !== undefined ? { argv: [...params.argv] } : {}),
      // The explicit cwd now beats AGENC_WORKSPACE (bug-audit #2), so the
      // session cwd must be the real workspace; the precedence itself is
      // guarded in bootstrap.test.ts.
      cwd: params.env.AGENC_WORKSPACE as string,
    });

    pid = await readPid(params.pidFile);
    expect(isPidAlive(pid)).toBe(true);
    expect(boot.mcpManager.getConnectedServers()).toEqual([MCP_SERVER_NAME]);
    expect(boot.mcpManager.getTools().map((tool) => tool.name)).toContain(
      MCP_TOOL_NAME,
    );
    expect(boot.registry.tools.map((tool) => tool.name)).toContain(
      MCP_TOOL_NAME,
    );

    const constructorToolNames = toolNames(
      createProviderSpy.mock.calls[0]?.[1].tools,
    );
    expect(constructorToolNames).toContain("system.searchTools");
    expect(constructorToolNames).not.toContain(MCP_TOOL_NAME);
    expect(
      boot.registry.toLLMTools().map((tool) => tool.function.name),
    ).not.toContain(MCP_TOOL_NAME);

    const emitted: Event[] = [];
    const unsubscribe = boot.session.eventLog.subscribe((event) => {
      emitted.push(event);
    });
    try {
      const phaseEvents = await collectEvents(
        boot.session.runTurn("find and run the live MCP ping tool", {
          ctx: boot.ctx,
        }),
      );

      expect(seenToolNamesByCall).toHaveLength(3);
      expect(seenToolNamesByCall[0]).toContain("system.searchTools");
      expect(seenToolNamesByCall[0]).not.toContain(MCP_TOOL_NAME);
      expect(seenToolNamesByCall[1]).toContain(MCP_TOOL_NAME);
      expect(seenToolNamesByCall[2]).toContain(MCP_TOOL_NAME);
      expect(boot.registry.getDiscoveredToolNames?.().has(MCP_TOOL_NAME)).toBe(
        true,
      );

      const mcpToolResult = phaseEvents.find(
        (event): event is Extract<PhaseEvent, { type: "tool_result" }> =>
          event.type === "tool_result" && event.toolCall.name === MCP_TOOL_NAME,
      );
      expect(mcpToolResult?.result.content).toBe("pong");
      expect(mcpToolResult?.result.isError).toBe(false);

      expect(
        emitted.some(
          (event) =>
            event.msg.type === "mcp_tool_call_begin" &&
            event.msg.payload.server === MCP_SERVER_NAME &&
            event.msg.payload.toolName === "ping",
        ),
      ).toBe(true);
      expect(
        emitted.some(
          (event) =>
            event.msg.type === "mcp_tool_call_end" &&
            event.msg.payload.result === "pong" &&
            event.msg.payload.isError === false,
        ),
      ).toBe(true);
      expect(seenMessagesByCall[2]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            toolCallId: "call-live-mcp",
            content: expect.stringContaining(
              `untrusted external data from ${MCP_TOOL_NAME}`,
            ),
          }),
        ]),
      );
      const modelFacingMcpResult = seenMessagesByCall[2]?.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "call-live-mcp",
      );
      expect(modelFacingMcpResult?.content).toContain(
        UNTRUSTED_TOOL_RESULT_BOUNDARY,
      );
      expect(modelFacingMcpResult?.content).toContain("pong");
    } finally {
      unsubscribe();
    }
  } finally {
    await boot?.shutdown().catch(() => {
      /* best effort */
    });
    if (pid !== undefined) {
      await waitFor(
        () => !isPidAlive(pid),
        `stdio MCP child ${pid} to exit after bootstrap shutdown`,
      );
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    Array.from(tempDirs).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
      tempDirs.delete(dir);
    }),
  );
});

describe("bootstrapLocalRuntimeSession live MCP integration", () => {
  it("starts a real stdio MCP server, discovers its deferred tool, and dispatches it during a turn", async () => {
    const home = await makeTempDir("agenc-live-mcp-home-");
    const workspace = await makeTempDir("agenc-live-mcp-ws-");
    const pidFile = join(home, "mcp", "live.pid");
    const mcpServers: MCPServerConfig[] = [
      {
        name: MCP_SERVER_NAME,
        transport: "stdio",
        command: process.execPath,
        args: [FIXTURE_PATH, pidFile],
        timeout: 10_000,
      },
    ];

    await expectLiveMcpEndToEnd({
      home,
      workspace,
      pidFile,
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        AGENC_MCP_SERVERS: JSON.stringify(mcpServers),
        HOME: home,
      },
      argv: ["node", "agenc", "--yolo"],
    });
  });

  it("starts a real stdio MCP server from config.toml mcp_servers", async () => {
    const home = await makeTempDir("agenc-live-mcp-home-");
    const workspace = await makeTempDir("agenc-live-mcp-ws-");
    const pidFile = join(home, "mcp", "live.pid");
    await writeFile(
      join(home, "config.toml"),
      `
[mcp_servers.${MCP_SERVER_NAME}]
transport = "stdio"
command = ${tomlString(process.execPath)}
args = [${tomlString(FIXTURE_PATH)}, ${tomlString(pidFile)}]
timeout = 10000
      `,
      "utf8",
    );

    await expectLiveMcpEndToEnd({
      home,
      workspace,
      pidFile,
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        AGENC_MCP_SERVERS: "",
        HOME: home,
      },
      argv: ["node", "agenc", "--yolo"],
    });
  });

  it("starts a real stdio MCP server from project .mcp.json in yolo mode", async () => {
    const home = await makeTempDir("agenc-live-mcp-home-");
    const workspace = await makeTempDir("agenc-live-mcp-ws-");
    const pidFile = join(home, "mcp", "live.pid");
    await writeFile(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "stdio",
            command: process.execPath,
            args: [FIXTURE_PATH, pidFile],
          },
        },
      }),
      "utf8",
    );

    await expectLiveMcpEndToEnd({
      home,
      workspace,
      pidFile,
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        AGENC_MCP_SERVERS: "",
        HOME: home,
      },
      argv: ["node", "agenc", "--yolo"],
    });
  });
});

describe("bootstrapLocalRuntimeSession deferred built-in tool discovery", () => {
  it("loads a deferred built-in tool through searchTools selection for the follow-up turn", async () => {
    const home = await makeTempDir("agenc-builtins-home-");
    const workspace = await makeTempDir("agenc-builtins-ws-");
    await writeFile(join(workspace, "README.md"), "# demo\n", "utf8");
    await runCommand("git", ["init"], { cwd: workspace });

    const seenToolNamesByCall: string[][] = [];
    const provider = makeBuiltinDiscoveryProvider({ seenToolNamesByCall, workspace });
    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockReturnValue(provider as never);

    let boot: LocalRuntimeBootstrap | null = null;
    try {
      boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        // This integration test intentionally executes host git. Declare the
        // same explicit operator boundary as the live MCP cases above.
        argv: ["node", "agenc", "--yolo"],
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_MCP_SERVERS: "",
          HOME: home,
        },
        // Explicit cwd beats AGENC_WORKSPACE since bug-audit #2.
        cwd: workspace,
      });

      expect(boot.registry.tools.map((tool) => tool.name)).toContain(
        "system.gitStatus",
      );
      expect(boot.registry.toLLMTools().map((tool) => tool.function.name)).not.toContain(
        "system.gitStatus",
      );

      const phaseEvents = await collectEvents(
        boot.session.runTurn("load and run git status", {
          ctx: boot.ctx,
        }),
      );

      expect(seenToolNamesByCall).toHaveLength(3);
      expect(seenToolNamesByCall[0]).toContain("system.searchTools");
      expect(seenToolNamesByCall[0]).not.toContain("system.gitStatus");
      expect(seenToolNamesByCall[1]).toContain("system.gitStatus");
      expect(seenToolNamesByCall[2]).toContain("system.gitStatus");
      expect(boot.registry.getDiscoveredToolNames?.().has("system.gitStatus")).toBe(
        true,
      );

      const gitToolResult = phaseEvents.find(
        (event): event is Extract<PhaseEvent, { type: "tool_result" }> =>
          event.type === "tool_result" &&
          event.toolCall.name === "system.gitStatus",
      );
      expect(gitToolResult?.result.isError).toBe(false);
      expect(JSON.parse(gitToolResult?.result.content ?? "{}")).toMatchObject({
        repoRoot: workspace,
      });
    } finally {
      await boot?.shutdown().catch(() => {
        /* best effort */
      });
    }
  });
});
