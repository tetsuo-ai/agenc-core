/**
 * T6 gap #119 seam: `attachMcpManagerToSession` must install the
 * session-bound `MCPCallObserver` on the manager BEFORE `manager.start()`
 * so every bridge created thereafter emits `mcp_tool_call_*` events
 * into the session event log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPManager } from "../mcp-client/manager.js";
import {
  projectMcpManagerToConnections,
  type McpManagerLike,
} from "../mcp-client/tui-connections.js";
import { createMCPConnection } from "../mcp-client/connection.js";
import { createToolBridge } from "../mcp-client/tools.js";
import { createResourceBridge } from "../mcp-client/resources.js";
import { createPromptBridge } from "../mcp-client/prompts.js";
import type { MCPCallObserver } from "../mcp-client/tools.js";
import type { MCPServerConnection } from "../services/mcp/types.js";
import {
  attachMcpManagerToSession,
  createSessionMcpManager,
  createSessionMcpManagerFromConfig,
  createSessionMcpManagerFromEnv,
  createSessionMcpManagerFromSources,
  createSessionMcpSamplingHandlers,
  createSessionMcpService,
  getMcpConfigFromConfig,
  getMcpConfigFromEnv,
  refreshMcpManagerFromConfig,
  requiredMcpServerNames,
  resolveSessionMcpConfig,
  resolveSessionMcpConfigFromSources,
  startMcpManagerForSession,
} from "./mcp-startup.js";
import type { Session } from "./session.js";

vi.mock("../mcp-client/connection.js", () => ({
  createMCPConnection: vi.fn(),
}));
vi.mock("../mcp-client/tools.js", () => ({
  createToolBridge: vi.fn(),
}));
vi.mock("../mcp-client/resources.js", () => ({
  createResourceBridge: vi.fn(),
}));
vi.mock("../mcp-client/prompts.js", () => ({
  createPromptBridge: vi.fn(),
}));

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);
const mockCreateResourceBridge = vi.mocked(createResourceBridge);
const mockCreatePromptBridge = vi.mocked(createPromptBridge);

function stubManager() {
  const setCallObserver = vi.fn();
  const setElicitationHandlers = vi.fn();
  const setSamplingHandlers = vi.fn();
  return {
    manager: {
      setCallObserver,
      setElicitationHandlers,
      setSamplingHandlers,
    } as unknown as MCPManager,
    setCallObserver,
    setElicitationHandlers,
    setSamplingHandlers,
  };
}

function makeManager() {
  return new MCPManager([{ name: "alpha", command: "alpha-cmd" }]);
}

function makeMockBridge(serverName: string, slotObserver?: MCPCallObserver) {
  return {
    serverName,
    tools: [
      {
        name: `mcp.${serverName}.echo`,
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        execute: vi.fn(async (args: Record<string, unknown>) => {
          const callId = `${serverName}-call`;
          slotObserver?.onBegin?.({
            callId,
            server: serverName,
            toolName: "echo",
            args: JSON.stringify(args),
          });
          slotObserver?.onEnd?.({
            callId,
            server: serverName,
            toolName: "echo",
            result: "ok",
            isError: false,
            durationMs: 1,
          });
          return { content: "ok", isError: false };
        }),
      },
    ],
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function stubSession() {
  const emit = vi.fn();
  const nextInternalSubId = vi.fn(() => "sub-0");
  return {
    session: {
      emit,
      nextInternalSubId,
      sessionConfiguration: { approvalPolicy: { value: "never" } },
    } as unknown as Session,
    emit,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateMCPConnection.mockResolvedValue({} as never);
  mockCreateToolBridge.mockImplementation(
    async (_client, serverName, _logger, options) =>
      makeMockBridge(serverName, options?.callObserver) as never,
  );
  mockCreateResourceBridge.mockImplementation(
    async (_client, serverName) =>
      ({
        serverName,
        listResources: vi.fn().mockResolvedValue([]),
        readResource: vi.fn().mockResolvedValue({
          uri: "",
          truncated: false,
          bytesReturned: 0,
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
      }) as never,
  );
  mockCreatePromptBridge.mockImplementation(
    async (_client, serverName) =>
      ({
        serverName,
        listPrompts: vi.fn().mockResolvedValue([]),
        renderPrompt: vi.fn().mockResolvedValue({
          promptName: "",
          messages: [],
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
      }) as never,
  );
});

describe("mcp-startup.attachMcpManagerToSession", () => {
  it("installs a call observer on the manager", () => {
    const {
      manager,
      setCallObserver,
      setElicitationHandlers,
      setSamplingHandlers,
    } = stubManager();
    const { session } = stubSession();

    attachMcpManagerToSession(manager, session);

    expect(setCallObserver).toHaveBeenCalledOnce();
    expect(setElicitationHandlers).toHaveBeenCalledOnce();
    expect(setSamplingHandlers).toHaveBeenCalledOnce();
    const observer = setCallObserver.mock.calls[0]![0]!;
    expect(typeof observer.onBegin).toBe("function");
    expect(typeof observer.onEnd).toBe("function");
  });

  it("routes MCP sampling requests through the session provider", async () => {
    const providerChat = vi.fn(async () => ({
      content: "sampled response",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "grok-4.3",
      finishReason: "stop" as const,
    }));
    const session = {
      provider: {
        chat: providerChat,
      },
      emit: vi.fn(),
      nextInternalSubId: vi.fn(() => "sub-0"),
      sessionConfiguration: { approvalPolicy: { value: "never" } },
    } as unknown as Session;
    const handlers = createSessionMcpSamplingHandlers(session);

    const result = await handlers.createMessage({
      serverName: "srv",
      requestId: 7,
      request: {
        id: 7,
        method: "sampling/createMessage",
        params: {
          messages: [
            {
              role: "user",
              content: { type: "text", text: "Summarize this" },
            },
          ],
          modelPreferences: {
            hints: [{ name: "grok-4.3-mini" }],
            costPriority: 0.7,
            speedPriority: 0.3,
            intelligencePriority: 0.5,
          },
          systemPrompt: "Be brief",
          includeContext: "thisServer",
          temperature: 0.2,
          maxTokens: 32,
          stopSequences: ["END"],
          tools: [
            {
              name: "lookup",
              description: "Look up context.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
          toolChoice: { mode: "none" },
          metadata: { trace: "sampling-test" },
        },
      } as never,
    });

    expect(providerChat).toHaveBeenCalledWith(
      [{ role: "user", content: "Summarize this" }],
      {
        model: "grok-4.3-mini",
        systemPrompt: "Be brief",
        maxOutputTokens: 32,
        temperature: 0.2,
        stopSequences: ["END"],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up context.",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          },
        ],
        toolChoice: "none",
      },
    );
    const beginEvent = (session.emit as ReturnType<typeof vi.fn>).mock.calls[0]
      ?.[0].msg;
    expect(JSON.parse(beginEvent.payload.args)).toMatchObject({
      messageCount: 1,
      hasSystemPrompt: true,
      maxTokens: 32,
      temperature: 0.2,
      stopSequenceCount: 1,
      includeContext: "thisServer",
      modelHint: "grok-4.3-mini",
      modelPreferences: {
        costPriority: 0.7,
        speedPriority: 0.3,
        intelligencePriority: 0.5,
      },
      toolCount: 1,
      toolChoice: "none",
      hasMetadata: true,
    });
    const emittedTypes = (
      session.emit as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[0].msg.type);
    expect(emittedTypes).toEqual([
      "mcp_tool_call_begin",
      "token_count",
      "mcp_tool_call_end",
    ]);
    expect(result).toEqual({
      role: "assistant",
      model: "grok-4.3",
      stopReason: "endTurn",
      content: {
        type: "text",
        text: "sampled response",
      },
    });
  });

  it("denies MCP sampling unless the session allows unattended provider calls", async () => {
    const providerChat = vi.fn();
    const session = {
      provider: {
        chat: providerChat,
      },
      emit: vi.fn(),
      nextInternalSubId: vi.fn(() => "sub-0"),
      sessionConfiguration: { approvalPolicy: { value: "on_request" } },
    } as unknown as Session;
    const handlers = createSessionMcpSamplingHandlers(session);

    const result = await handlers.createMessage({
      serverName: "srv",
      requestId: 7,
      request: {
        id: 7,
        method: "sampling/createMessage",
        params: {
          messages: [
            {
              role: "user",
              content: { type: "text", text: "Summarize this" },
            },
          ],
          maxTokens: 32,
        },
      } as never,
    });

    expect(providerChat).not.toHaveBeenCalled();
    expect(result.model).toBe("agenc-host");
    expect(
      (session.emit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].msg,
    ).toMatchObject({
      type: "warning",
      payload: {
        cause: "mcp_sampling_denied",
      },
    });
  });

  it("returns provider tool calls as MCP sampling tool-use blocks", async () => {
    const providerChat = vi.fn(async () => ({
      content: "Need a lookup.",
      toolCalls: [
        {
          id: "call-1",
          name: "lookup",
          arguments: "{\"query\":\"AgenC\"}",
        },
      ],
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      model: "grok-4.3",
      finishReason: "tool_calls" as const,
    }));
    const session = {
      provider: {
        chat: providerChat,
      },
      emit: vi.fn(),
      nextInternalSubId: vi.fn(() => "sub-0"),
      sessionConfiguration: { approvalPolicy: { value: "never" } },
    } as unknown as Session;
    const handlers = createSessionMcpSamplingHandlers(session);

    const result = await handlers.createMessage({
      serverName: "srv",
      requestId: 8,
      request: {
        id: 8,
        method: "sampling/createMessage",
        params: {
          messages: [
            {
              role: "user",
              content: { type: "text", text: "Use lookup" },
            },
          ],
          maxTokens: 32,
          tools: [
            {
              name: "lookup",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
          ],
        },
      } as never,
    });

    expect(result).toEqual({
      role: "assistant",
      model: "grok-4.3",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Need a lookup." },
        {
          type: "tool_use",
          id: "call-1",
          name: "lookup",
          input: { query: "AgenC" },
        },
      ],
    });
  });

  it("passes session granular MCP elicitation policy into handlers", async () => {
    const { manager, setElicitationHandlers } = stubManager();
    const { session } = stubSession();
    (session as unknown as {
      services: { granularApprovalConfig: { mcp_elicitations: boolean } };
      sessionConfiguration: { approvalPolicy: { value: "granular" } };
      requestMcpElicitation: ReturnType<typeof vi.fn>;
    }).services = {
      granularApprovalConfig: { mcp_elicitations: false },
    };
    (session as unknown as {
      sessionConfiguration: { approvalPolicy: { value: "granular" } };
    }).sessionConfiguration = {
      approvalPolicy: { value: "granular" },
    };
    (session as unknown as {
      requestMcpElicitation: ReturnType<typeof vi.fn>;
    }).requestMcpElicitation = vi.fn();

    attachMcpManagerToSession(manager, session);
    const handlers = setElicitationHandlers.mock.calls[0]?.[0];
    await expect(
      handlers?.handleRequest({
        serverName: "srv",
        requestId: "mcp-1",
        request: {
          mode: "form",
          message: "Confirm",
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    ).resolves.toEqual({ action: "decline" });
  });

  it("must run before manager.start() so the first bridge captures the observer", async () => {
    const manager = makeManager();
    const { session, emit } = stubSession();

    attachMcpManagerToSession(manager, session);
    await manager.start();
    await manager.getTools()[0]!.execute({ ping: true });

    expect(mockCreateToolBridge.mock.calls[0]?.[3]?.callObserver).toBeDefined();
    expect(emit.mock.calls.map(([event]) => event.msg.type)).toEqual([
      "mcp_tool_call_begin",
      "mcp_tool_call_end",
    ]);
    expect(emit.mock.calls[0]?.[0].msg.payload.callId).toBe("alpha-call");
    expect(emit.mock.calls[1]?.[0].msg.payload.callId).toBe("alpha-call");

    await manager.stop();
  });

  it("does not retrofit already-started bridges when attached after start", async () => {
    const manager = makeManager();
    await manager.start();

    const { session, emit } = stubSession();
    attachMcpManagerToSession(manager, session);
    await manager.getTools()[0]!.execute({ ping: true });

    expect(mockCreateToolBridge.mock.calls[0]?.[3]?.callObserver).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();

    await manager.stop();
  });

  it("rethrows + logs when setCallObserver fails", () => {
    const manager = {
      setCallObserver: () => {
        throw new Error("observer install failed");
      },
    } as unknown as MCPManager;
    const { session, emit } = stubSession();

    expect(() => attachMcpManagerToSession(manager, session)).toThrow(
      /observer install failed/,
    );
    expect(emit).toHaveBeenCalled();
    const emitted = emit.mock.calls[0]![0];
    expect(emitted.msg.type).toBe("error");
  });

  it("startMcpManagerForSession attaches before start", async () => {
    const manager = makeManager();
    const { session, emit } = stubSession();
    const startSpy = vi.spyOn(manager, "start");

    await startMcpManagerForSession(manager, session);
    await manager.getTools()[0]!.execute({ ping: true });

    expect(startSpy).toHaveBeenCalledOnce();
    expect(mockCreateToolBridge.mock.calls[0]?.[3]?.callObserver).toBeDefined();
    expect(emit.mock.calls.map(([event]) => event.msg.type)).toEqual([
      "mcp_tool_call_begin",
      "mcp_tool_call_end",
    ]);

    await manager.stop();
  });

  it("startMcpManagerForSession enforces required servers declared in config", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const manager = {
      setCallObserver: vi.fn(),
      getConfiguredServers: vi.fn(() => [
        { name: "required", command: "required-cmd", required: true },
        { name: "optional", command: "optional-cmd" },
      ]),
      start,
    } as unknown as MCPManager;
    const { session } = stubSession();

    await startMcpManagerForSession(manager, session);

    expect(start).toHaveBeenCalledWith({ requiredServers: ["required"] });
  });

  it("startMcpManagerForSession preserves explicit requiredServers opts", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const manager = {
      setCallObserver: vi.fn(),
      getConfiguredServers: vi.fn(() => [
        { name: "configured", command: "configured-cmd", required: true },
      ]),
      start,
    } as unknown as MCPManager;
    const { session } = stubSession();

    await startMcpManagerForSession(manager, session, {
      requiredServers: ["explicit"],
    });

    expect(start).toHaveBeenCalledWith({ requiredServers: ["explicit"] });
  });
});

describe("mcp-startup session-owned manager helpers", () => {
  it("constructs the real manager from explicit configs", () => {
    const manager = createSessionMcpManager([
      { name: "alpha", command: "alpha-cmd" },
    ]);

    expect(manager).toBeInstanceOf(MCPManager);
    expect(manager.getConfiguredServers()).toEqual([
      expect.objectContaining({ name: "alpha", command: "alpha-cmd" }),
    ]);
  });

  it("constructs the real manager from AGENC_MCP_SERVERS", () => {
    const manager = createSessionMcpManagerFromEnv({
      AGENC_MCP_SERVERS: JSON.stringify([
        { name: "github", command: "github-mcp" },
      ]),
    } as NodeJS.ProcessEnv);

    expect(manager).toBeInstanceOf(MCPManager);
    expect(manager.getConfiguredServers()).toEqual([
      expect.objectContaining({ name: "github", command: "github-mcp" }),
    ]);
  });

  it("constructs the real manager from loaded config mcp_servers", () => {
    const manager = createSessionMcpManagerFromConfig(
      {
        mcp_servers: {
          github: {
            command: "github-mcp",
            args: ["--stdio"],
            env: { GH_TOKEN: "test-token" },
            timeout: 5_000,
            required: true,
          },
        },
      },
      {} as NodeJS.ProcessEnv,
    );

    expect(manager).toBeInstanceOf(MCPManager);
    expect(manager.getConfiguredServers()).toEqual([
      expect.objectContaining({
        name: "github",
        command: "github-mcp",
        args: ["--stdio"],
        env: { GH_TOKEN: "test-token" },
        timeout: 5_000,
        required: true,
      }),
    ]);
  });

  it("loads project .mcp.json servers when bypass-mode startup opts in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-project-mcp-"));
    const serverCwd = join(cwd, "mcp-server");
    try {
      writeFileSync(
        join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            audit: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
              env: { AUDIT_TOKEN: "test-token" },
              env_vars: ["PATH", "HOME"],
              cwd: serverCwd,
              timeout: 1_234,
              required: true,
              enabled: true,
              default_tools_approval_mode: "on-request",
              enabled_tools: ["read"],
              disabled_tools: ["write"],
              tools: {
                read: { default_permission_mode: "never" },
              },
              pinnedCatalogSha256: "a".repeat(64),
              supplyChain: { catalogSha256: "b".repeat(64) },
            },
          },
        }),
        "utf8",
      );

      await expect(
        resolveSessionMcpConfigFromSources(
          undefined,
          {} as NodeJS.ProcessEnv,
          {
            cwd,
            includeProjectMcpServers: true,
          },
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          name: "audit",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { AUDIT_TOKEN: "test-token" },
          env_vars: ["PATH", "HOME"],
          cwd: serverCwd,
          timeout: 1_234,
          required: true,
          enabled: true,
          default_tools_approval_mode: "on-request",
          enabled_tools: ["read"],
          disabled_tools: ["write"],
          tools: {
            read: { default_permission_mode: "never" },
          },
          pinnedCatalogSha256: "a".repeat(64),
          supplyChain: { catalogSha256: "b".repeat(64) },
        }),
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps AGENC_MCP_SERVERS as a complete override over project .mcp.json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-project-mcp-"));
    try {
      writeFileSync(
        join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            project: {
              type: "stdio",
              command: "project-mcp",
            },
          },
        }),
        "utf8",
      );

      const manager = await createSessionMcpManagerFromSources(
        undefined,
        {
          AGENC_MCP_SERVERS: JSON.stringify([
            { name: "env", command: "env-mcp" },
          ]),
        } as NodeJS.ProcessEnv,
        {
          cwd,
          includeProjectMcpServers: true,
        },
      );

      expect(manager.getConfiguredServers()).toEqual([
        expect.objectContaining({ name: "env", command: "env-mcp" }),
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("exposes runtime readiness and routing off the real manager", () => {
    const manager = {
      isConnected: vi.fn((name: string) => name === "github"),
      resolveMcpToolInfo: vi.fn((toolName: string) => ({
        serverName: "github",
        toolName,
      })),
      getServerForTool: vi.fn(() => "github"),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager);

    expect(service.isConnected?.("github")).toBe(true);
    expect(service.isConnected?.("filesystem")).toBe(false);
    expect(service.resolveMcpToolInfo?.("mcp.github.search")).toEqual({
      serverName: "github",
      toolName: "mcp.github.search",
    });
    expect(service.getServerForTool?.("mcp.github.search")).toBe("github");
  });

  it("exposes TUI MCP projection methods through the session service facade", () => {
    const connected = {
      type: "connected",
      name: "github",
      config: { type: "stdio", command: "github-mcp", args: [], scope: "user" },
      capabilities: { tools: {} },
      client: { setNotificationHandler: vi.fn() },
      cleanup: vi.fn(),
    } as MCPServerConnection;
    const manager = {
      getConfiguredServers: vi.fn(() => [
        { name: "github", command: "github-mcp" },
        { name: "files", command: "missing-files-mcp" },
      ]),
      isConnected: vi.fn((name: string) => name === "github"),
      getConnectionState: vi.fn((name: string) =>
        name === "github"
          ? { type: "connected" }
          : { type: "failed", error: "spawn ENOENT" },
      ),
      getConnectedConnection: vi.fn((name: string) =>
        name === "github" ? connected : undefined,
      ),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager);
    const projected = projectMcpManagerToConnections(
      service as unknown as McpManagerLike,
    );

    expect(projected).toEqual([
      connected,
      expect.objectContaining({
        name: "files",
        type: "failed",
        error: "spawn ENOENT",
      }),
    ]);
  });

  it("forwards live slash command MCP manager controls", async () => {
    const manager = {
      reconnectServer: vi.fn(async (name: string) => ({
        serverName: name,
        success: true,
        toolCount: 2,
      })),
      enableServer: vi.fn(async (name: string) => ({
        serverName: name,
        success: true,
        toolCount: 1,
      })),
      disableServer: vi.fn(async (name: string) => ({
        serverName: name,
        success: true,
        toolCount: 0,
      })),
      addServer: vi.fn(async (config: { readonly name: string }) => ({
        serverName: config.name,
        success: true,
        toolCount: 1,
      })),
      getTools: vi.fn(() => [{ name: "mcp.github.search" }]),
      getToolsByServer: vi.fn((name: string) =>
        name === "github" ? [{ name: "mcp.github.search" }] : [],
      ),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager);

    await expect(service.reconnectServer?.("github")).resolves.toMatchObject({
      success: true,
      toolCount: 2,
    });
    await expect(service.enableServer?.("github")).resolves.toMatchObject({
      success: true,
      toolCount: 1,
    });
    await expect(service.disableServer?.("github")).resolves.toMatchObject({
      success: true,
      toolCount: 0,
    });
    await expect(
      service.addServer?.({ name: "local", command: "node" }),
    ).resolves.toMatchObject({
      serverName: "local",
      success: true,
    });
    expect(service.getTools?.()).toEqual([{ name: "mcp.github.search" }]);
    expect(service.getToolsByServer?.("github")).toEqual([
      { name: "mcp.github.search" },
    ]);
  });

  it("surfaces effective connected-server instructions instead of an empty stub", async () => {
    const manager = {
      getConnectedServers: vi.fn(() => ["github"]),
      getConfiguredServers: vi.fn(() => [
        {
          name: "github",
          command: "github-mcp",
          instructions: "Use for repo search.",
        },
        {
          name: "filesystem",
          command: "fs-mcp",
          instructions: "Local files only.",
        },
      ]),
      getServerConfig: vi.fn((name: string) =>
        name === "github"
          ? {
              name: "github",
              command: "github-mcp",
              instructions: "Use for repo search.",
            }
          : undefined,
      ),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager);
    const effective = await service.effectiveServers({}, null);

    expect(effective.get("github")).toEqual(
      expect.objectContaining({
        enabled: true,
        command: "github-mcp",
        instructions: "Use for repo search.",
      }),
    );
    expect(effective.get("filesystem")).toEqual(
      expect.objectContaining({
        enabled: false,
        command: "fs-mcp",
      }),
    );
    expect((effective.get("filesystem") as { instructions?: string } | undefined)?.instructions).toBeUndefined();
  });

  it("derives required server names from config metadata", () => {
    expect(
      requiredMcpServerNames([
        { name: "alpha", command: "alpha-cmd", required: true },
        { name: "beta", command: "beta-cmd" },
        { name: "gamma", command: "gamma-cmd", required: false },
      ]),
    ).toEqual(["alpha"]);
  });

  it("refreshes the live manager from config and enforces required servers", async () => {
    const refreshServers = vi.fn().mockResolvedValue(undefined);
    const manager = {
      refreshServers,
    } as unknown as MCPManager;

    const result = await refreshMcpManagerFromConfig({
      manager,
      env: {} as NodeJS.ProcessEnv,
      config: {
        mcp_servers: {
          github: { command: "github-mcp", required: true },
          filesystem: { command: "fs-mcp" },
        },
      },
    });

    expect(refreshServers).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          name: "github",
          command: "github-mcp",
          required: true,
        }),
        expect.objectContaining({
          name: "filesystem",
          command: "fs-mcp",
        }),
      ],
      { requiredServers: ["github"] },
    );
    expect(result).toEqual({
      configuredServers: ["github", "filesystem"],
      requiredServers: ["github"],
    });
  });

  it("service refreshFromConfig preserves env override semantics", async () => {
    const refreshServers = vi.fn().mockResolvedValue(undefined);
    const manager = {
      refreshServers,
    } as unknown as MCPManager;
    const service = createSessionMcpService(manager, {
      env: {
        AGENC_MCP_SERVERS: JSON.stringify([
          { name: "envOnly", command: "env-mcp", required: true },
        ]),
      } as NodeJS.ProcessEnv,
    });

    const result = await service.refreshFromConfig?.({
      mcp_servers: {
        configOnly: { command: "config-mcp" },
      },
    });

    expect(refreshServers).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "envOnly", command: "env-mcp" })],
      { requiredServers: ["envOnly"] },
    );
    expect(result).toEqual({
      configuredServers: ["envOnly"],
      requiredServers: ["envOnly"],
    });
  });
});

describe("mcp-startup.getMcpConfigFromEnv", () => {
  it("returns [] for unset env", () => {
    expect(getMcpConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(
      getMcpConfigFromEnv({ AGENC_MCP_SERVERS: "not-json" } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it("returns [] when JSON is not an array", () => {
    expect(
      getMcpConfigFromEnv({
        AGENC_MCP_SERVERS: '{"name":"foo"}',
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it("parses a valid JSON array of MCP configs", () => {
    const env = {
      AGENC_MCP_SERVERS: JSON.stringify([
        { name: "alpha", command: "alpha-cmd" },
        { name: "beta", transport: "sse", endpoint: "http://example/beta" },
        // Invalid entries get filtered out.
        { missingName: true },
        null,
        "string",
      ]),
    } as NodeJS.ProcessEnv;
    const parsed = getMcpConfigFromEnv(env);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.name).toBe("alpha");
    expect(parsed[1]!.name).toBe("beta");
  });
});

describe("mcp-startup config-backed MCP resolution", () => {
  it("returns [] when config has no mcp_servers", () => {
    expect(getMcpConfigFromConfig({})).toEqual([]);
  });

  it("maps keyed config tables to runtime configs with names", () => {
    const parsed = getMcpConfigFromConfig({
      mcp_servers: {
        alpha: {
          command: "alpha-cmd",
          args: ["--stdio"],
          enabled: false,
        },
        beta: {
          transport: "http",
          endpoint: "https://example.test/mcp",
          headers: { Authorization: "Bearer token" },
          required: true,
        },
      },
    });

    expect(parsed).toEqual([
      expect.objectContaining({
        name: "alpha",
        command: "alpha-cmd",
        args: ["--stdio"],
        enabled: false,
      }),
      expect.objectContaining({
        name: "beta",
        transport: "http",
        endpoint: "https://example.test/mcp",
        headers: { Authorization: "Bearer token" },
        required: true,
      }),
    ]);
  });

  it("lets AGENC_MCP_SERVERS completely override config mcp_servers", () => {
    const resolved = resolveSessionMcpConfig(
      {
        mcp_servers: {
          configOnly: { command: "config-cmd" },
        },
      },
      {
        AGENC_MCP_SERVERS: JSON.stringify([
          { name: "envOnly", command: "env-cmd" },
        ]),
      } as NodeJS.ProcessEnv,
    );

    expect(resolved).toEqual([
      expect.objectContaining({ name: "envOnly", command: "env-cmd" }),
    ]);
  });
});
