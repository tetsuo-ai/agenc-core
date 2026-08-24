/**
 * T6 gap #119 seam: `attachMcpManagerToSession` must install the
 * session-bound `MCPCallObserver` on the manager BEFORE `manager.start()`
 * so every bridge created thereafter emits `mcp_tool_call_*` events
 * into the session event log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { ScopedMcpServerConfig } from "../services/mcp/types.js";
import { loadPluginMcpServerRegistrations } from "../plugins/registration/mcp-plugin-integration.js";
import { approveProjectMcpServerSync } from "../permissions/trust/project-trust.js";
import { projectMcpServerApprovalDigest } from "../services/mcp/utils.js";
import {
  attachMcpManagerToSession,
  createSessionMcpManager,
  createSessionMcpManagerFromAuthority,
  createSessionMcpSamplingHandlers,
  createSessionMcpService,
  refreshMcpManagerFromAuthority,
  requiredMcpServerNames,
  resolveSessionMcpConfig,
  startMcpManagerForSession,
} from "./mcp-startup.js";
import type { Session } from "./session.js";
import { ConfigStore } from "../config/store.js";
import type { CanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";

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
vi.mock("../plugins/registration/mcp-plugin-integration.js", () => ({
  loadPluginMcpServerRegistrations: vi.fn(),
}));

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);
const mockCreateResourceBridge = vi.mocked(createResourceBridge);
const mockCreatePromptBridge = vi.mocked(createPromptBridge);
const mockLoadPluginMcpServerRegistrations = vi.mocked(
  loadPluginMcpServerRegistrations,
);
const UNUSED_AUTHORITY = {} as CanonicalSettingsAuthority;
const TEST_SERVICE_OPTIONS = Object.freeze({
  authority: UNUSED_AUTHORITY,
  environment: Object.freeze({}),
});

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
  mockLoadPluginMcpServerRegistrations.mockResolvedValue([]);
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
      services: {
        provider: { chat: providerChat },
        admissionRequired: false,
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
        accountedInputTokens: 677,
        contextWindowTokens: 1_000_000,
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
      services: {
        provider: { chat: providerChat },
        admissionRequired: false,
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
      services: {
        provider: { chat: providerChat },
        admissionRequired: false,
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

async function createMcpAuthorityFixture(options: {
  readonly user?: readonly string[];
  readonly project?: readonly string[];
  readonly managed?: readonly string[];
} = {}): Promise<{
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly store: ConfigStore;
  cleanup(): void;
}> {
  const root = mkdtempSync(join(tmpdir(), "agenc-mcp-authority-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(home, "config.toml"),
    ["config_version = 2", ...(options.user ?? []), ""].join("\n"),
    "utf8",
  );
  if (options.project !== undefined) {
    mkdirSync(join(cwd, ".agenc"), { recursive: true });
    writeFileSync(
      join(cwd, ".agenc", "config.toml"),
      ["config_version = 2", ...options.project, ""].join("\n"),
      "utf8",
    );
  }
  const managedConfigPath = join(root, "managed.toml");
  if (options.managed !== undefined) {
    writeFileSync(
      managedConfigPath,
      ["config_version = 2", ...options.managed, ""].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  const store = new ConfigStore({
    home,
    cwd,
    projectRoot: cwd,
    projectTrusted: true,
    env: { AGENC_HOME: home, HOME: root },
    managedConfigPath,
    managedDropInDir: join(root, "missing-managed.d"),
  });
  await store.reload();
  return {
    root,
    home,
    cwd,
    store,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

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

  it("constructs the real manager from the policy-aware authority", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.github]",
        'transport = "stdio"',
        'command = "github-mcp"',
        'args = ["--stdio"]',
        "required = true",
      ],
    });
    try {
      const manager = await createSessionMcpManagerFromAuthority(
        fixture.store,
        {},
      );
      expect(manager).toBeInstanceOf(MCPManager);
      expect(manager.getConfiguredServers()).toEqual([
        expect.objectContaining({
          name: "github",
          command: "github-mcp",
          args: ["--stdio"],
          required: true,
          origin: { scope: "user" },
        }),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("treats an explicit managed mcp_servers table as exclusive even when empty", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.user_docs]", 'command = "user-docs"'],
      managed: ["[mcp_servers]"],
    });
    try {
      await expect(resolveSessionMcpConfig(fixture.store, {})).resolves.toEqual(
        [],
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("starts a project server only while its exact definition is approved", async () => {
    const fixture = await createMcpAuthorityFixture({
      project: [
        "[mcp_servers.project_docs]",
        'command = "node"',
        'args = ["project-server.js"]',
      ],
    });
    try {
      await expect(resolveSessionMcpConfig(fixture.store, {})).resolves.toEqual(
        [],
      );
      const approved: ScopedMcpServerConfig = {
        scope: "project",
        type: "stdio",
        command: "node",
        args: ["project-server.js"],
      };
      approveProjectMcpServerSync(
        "project_docs",
        projectMcpServerApprovalDigest(approved),
        { agencHome: fixture.home, projectRoot: fixture.cwd },
      );
      await expect(resolveSessionMcpConfig(fixture.store, {})).resolves.toEqual([
        expect.objectContaining({
          name: "project_docs",
          origin: { scope: "project" },
        }),
      ]);

      writeFileSync(
        join(fixture.cwd, ".agenc", "config.toml"),
        [
          "config_version = 2",
          "[mcp_servers.project_docs]",
          'command = "node"',
          'args = ["changed-server.js"]',
          "",
        ].join("\n"),
        "utf8",
      );
      await fixture.store.reload();
      await expect(resolveSessionMcpConfig(fixture.store, {})).resolves.toEqual(
        [],
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("applies managed allow and deny policy before manager construction", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.allowed]",
        'command = "allowed-bin"',
        "[mcp_servers.denied]",
        'command = "denied-bin"',
        "[mcp_servers.other]",
        'command = "other-bin"',
      ],
      managed: [
        'allowedMcpServers = [{ serverName = "allowed" }, { serverName = "denied" }]',
        'deniedMcpServers = [{ serverName = "denied" }]',
      ],
    });
    try {
      const configs = await resolveSessionMcpConfig(fixture.store, {});
      expect(configs.map((config) => config.name)).toEqual(["allowed"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("uses only the captured environment for interpolation", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.environment]",
        'command = "${MCP_BINARY}"',
        'args = ["${MCP_ARGUMENT:-fallback}"]',
      ],
    });
    const ambient = process.env.MCP_BINARY;
    process.env.MCP_BINARY = "ambient-binary";
    try {
      await expect(
        resolveSessionMcpConfig(fixture.store, {
          MCP_BINARY: "captured-binary",
          MCP_ARGUMENT: "captured-argument",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          command: "captured-binary",
          args: ["captured-argument"],
        }),
      ]);
    } finally {
      if (ambient === undefined) delete process.env.MCP_BINARY;
      else process.env.MCP_BINARY = ambient;
      fixture.cleanup();
    }
  });

  it("deduplicates plugin servers against canonical manual definitions", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.manual]",
        'command = "node"',
        'args = ["same-server.js"]',
      ],
    });
    mockLoadPluginMcpServerRegistrations.mockResolvedValueOnce([
      {
        name: "plugin:sample:duplicate",
        pluginName: "sample",
        pluginSource: "sample@registry",
        serverName: "duplicate",
        server: {
          transport: "stdio",
          command: "node",
          args: ["same-server.js"],
        },
      },
    ]);
    try {
      const configs = await resolveSessionMcpConfig(fixture.store, {});
      expect(configs.map((config) => config.name)).toEqual(["manual"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("allows only plugin MCP servers under plugin-only policy", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.manual]", 'command = "manual-bin"'],
      managed: ['strictPluginOnlyCustomization = ["mcp"]'],
    });
    mockLoadPluginMcpServerRegistrations.mockResolvedValueOnce([
      {
        name: "plugin:sample:goal",
        pluginName: "sample",
        pluginSource: "sample@registry",
        serverName: "goal",
        server: { transport: "stdio", command: "plugin-bin" },
      },
    ]);
    try {
      await expect(resolveSessionMcpConfig(fixture.store, {})).resolves.toEqual([
        expect.objectContaining({
          name: "plugin:sample:goal",
          origin: expect.objectContaining({
            scope: "plugin",
            pluginSource: "sample@registry",
          }),
        }),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("has no direct snapshot or plugin-loader startup authority", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "session", "mcp-startup.ts"),
      "utf8",
    );
    expect(source).not.toContain(".mcp.json");
    expect(source).not.toMatch(/\.current\(\)\.mcp_servers/u);
    expect(source).not.toContain("loadPluginMcpServers");
    expect(source).not.toContain("pluginMcpServerSource");
    expect(source).not.toContain("resolveSessionMcpConfigFromSources");
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

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);

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

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);
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
      getTools: vi.fn(() => [{ name: "mcp.github.search" }]),
      getToolsByServer: vi.fn((name: string) =>
        name === "github" ? [{ name: "mcp.github.search" }] : [],
      ),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);

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
    expect(service.getTools?.()).toEqual([{ name: "mcp.github.search" }]);
    expect(service.getToolsByServer?.("github")).toEqual([
      { name: "mcp.github.search" },
    ]);
  });

  it("keeps an admitted session server and its enabled override across authority refreshes", async () => {
    const fixture = await createMcpAuthorityFixture();
    const manager = await createSessionMcpManagerFromAuthority(
      fixture.store,
      {},
    );
    const service = createSessionMcpService(manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({
          name: "local",
          command: "local-mcp",
          required: false,
        }),
      ).resolves.toMatchObject({
        serverName: "local",
        success: true,
      });
      expect(service.getConfiguredServers?.()).toEqual([
        expect.objectContaining({
          name: "local",
          required: false,
          origin: { scope: "session" },
        }),
      ]);

      await expect(service.disableServer?.("local")).resolves.toMatchObject({
        success: true,
      });
      await service.refreshFromAuthority?.();
      expect(service.getConfiguredServers?.()).toEqual([
        expect.objectContaining({
          name: "local",
          enabled: false,
          required: false,
        }),
      ]);
      expect(service.getConnectionState?.("local")).toEqual({
        type: "disabled",
      });
    } finally {
      await manager.stop();
      fixture.cleanup();
    }
  });

  it("rejects session additions excluded by managed MCP authority", async () => {
    const fixture = await createMcpAuthorityFixture({ managed: ["[mcp_servers]"] });
    const manager = await createSessionMcpManagerFromAuthority(
      fixture.store,
      {},
    );
    const service = createSessionMcpService(manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "blocked", command: "blocked-mcp" }),
      ).resolves.toEqual({
        serverName: "blocked",
        success: false,
        toolCount: 0,
        error: 'MCP server "blocked" is blocked by canonical MCP policy.',
      });
      expect(service.getConfiguredServers?.()).toEqual([]);
    } finally {
      await manager.stop();
      fixture.cleanup();
    }
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

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);
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
    expect(
      (effective.get("filesystem") as
        | { instructions?: string }
        | undefined)?.instructions,
    ).toBeUndefined();
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

  it("refreshes the live manager from the authority and enforces required servers", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.github]",
        'command = "github-mcp"',
        "required = true",
        "[mcp_servers.filesystem]",
        'command = "fs-mcp"',
      ],
    });
    const refreshServers = vi.fn().mockResolvedValue(undefined);
    const manager = {
      refreshServers,
    } as unknown as MCPManager;
    try {
      const result = await refreshMcpManagerFromAuthority({
        manager,
        authority: fixture.store,
        environment: {},
      });

      expect(refreshServers).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: "github",
            command: "github-mcp",
            required: true,
            origin: { scope: "user" },
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
    } finally {
      fixture.cleanup();
    }
  });

  it("authority refresh retains policy-admitted plugin servers", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.github]", 'command = "github-mcp"'],
    });
    mockLoadPluginMcpServerRegistrations.mockResolvedValueOnce([
      {
        name: "plugin:sample:goal",
        pluginName: "sample",
        pluginSource: "sample@registry",
        serverName: "goal",
        server: {
          transport: "stdio",
          command: "node",
          args: ["goal-server.mjs"],
        },
      },
    ]);
    const refreshServers = vi.fn().mockResolvedValue(undefined);
    const manager = {
      refreshServers,
    } as unknown as MCPManager;
    try {
      const result = await refreshMcpManagerFromAuthority({
        manager,
        authority: fixture.store,
        environment: {},
      });

      expect(refreshServers).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: "plugin:sample:goal",
            origin: expect.objectContaining({ scope: "plugin" }),
          }),
          expect.objectContaining({ name: "github" }),
        ],
        {},
      );
      expect(result.configuredServers).toEqual([
        "plugin:sample:goal",
        "github",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("service refresh rereads the canonical authority", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.configOnly]",
        'command = "config-mcp"',
        "required = true",
      ],
    });
    const refreshServers = vi.fn().mockResolvedValue(undefined);
    const getConfiguredServers = vi.fn(() => [
      {
        name: "configOnly",
        command: "config-mcp",
        required: true,
        origin: { scope: "user" as const },
      },
    ]);
    const manager = {
      refreshServers,
      getConfiguredServers,
    } as unknown as MCPManager;
    const service = createSessionMcpService(manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      const result = await service.refreshFromAuthority?.();

      expect(refreshServers).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: "configOnly",
            command: "config-mcp",
          }),
        ],
        { requiredServers: ["configOnly"] },
      );
      expect(result).toEqual({
        configuredServers: ["configOnly"],
        requiredServers: ["configOnly"],
      });
    } finally {
      fixture.cleanup();
    }
  });
});
