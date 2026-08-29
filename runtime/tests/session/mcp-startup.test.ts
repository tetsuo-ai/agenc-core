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
import {
  MCPManager,
  type MCPConnectionState,
  type MCPManagerStartOpts,
} from "../mcp-client/manager.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
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
import { getAllMcpConfigs } from "../services/mcp/config.js";
import {
  attachMcpManagerToSession,
  createSessionMcpManager,
  createSessionMcpSamplingHandlers,
  createSessionMcpService as createRuntimeSessionMcpService,
  requiredMcpServerNames,
  resolveSessionMcpConfig as resolveRuntimeSessionMcpConfig,
  startMcpManagerForSession,
} from "./mcp-startup.js";
import type { Session } from "./session.js";
import { ConfigStore } from "../config/store.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  getCanonicalSettingsAuthority,
  type CanonicalSettingsAuthority,
} from "../utils/settings/canonicalAuthority.js";

vi.mock("../mcp-client/connection.js", () => ({
  createMCPConnection: vi.fn(),
}));
vi.mock("../mcp-client/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp-client/tools.js")>()),
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
const UNUSED_AUTHORITY = {
  subscribe: () => () => {},
} as unknown as CanonicalSettingsAuthority;
const TEST_PLUGIN_STORAGE_ROOT = join(tmpdir(), "agenc-mcp-plugin-storage");
const TEST_SERVICE_OPTIONS = Object.freeze({
  authority: UNUSED_AUTHORITY,
  environment: Object.freeze({}),
});

function createSessionMcpService(
  manager: Parameters<typeof createRuntimeSessionMcpService>[0],
  options: Omit<
    Parameters<typeof createRuntimeSessionMcpService>[1],
    "pluginStorageRoot"
  > & { readonly pluginStorageRoot?: string },
) {
  return createRuntimeSessionMcpService(manager, {
    ...options,
    pluginStorageRoot: options.pluginStorageRoot ?? TEST_PLUGIN_STORAGE_ROOT,
  });
}

function resolveSessionMcpConfig(
  authority: Parameters<typeof resolveRuntimeSessionMcpConfig>[0],
  environment: Parameters<typeof resolveRuntimeSessionMcpConfig>[1],
  sessionServers: Parameters<typeof resolveRuntimeSessionMcpConfig>[3] = {},
) {
  return resolveRuntimeSessionMcpConfig(
    authority,
    environment,
    TEST_PLUGIN_STORAGE_ROOT,
    sessionServers,
  );
}

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
          contents: [],
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

async function createMcpAuthorityFixture(
  options: {
    readonly user?: readonly string[];
    readonly project?: readonly string[];
    readonly managed?: readonly string[];
    readonly base?: AgenCConfig;
  } = {},
): Promise<{
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly userConfigPath: string;
  readonly localConfigPath: string;
  readonly managedConfigPath: string;
  readonly store: ConfigStore;
  cleanup(): void;
}> {
  const root = mkdtempSync(join(tmpdir(), "agenc-mcp-authority-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, ".agenc"), { recursive: true });
  const userConfigPath = join(home, "config.toml");
  writeFileSync(
    userConfigPath,
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
  const localConfigPath = join(cwd, ".agenc", "config.local.toml");
  if (options.managed !== undefined) {
    writeFileSync(
      managedConfigPath,
      ["config_version = 2", ...options.managed, ""].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  const store = new ConfigStore({
    home,
    ...(options.base !== undefined ? { base: options.base } : {}),
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
    userConfigPath,
    localConfigPath,
    managedConfigPath,
    store,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeCanonicalFixtureConfig(
  path: string,
  lines: readonly string[],
): void {
  writeFileSync(path, ["config_version = 2", ...lines, ""].join("\n"), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TransactionalRefreshHook = (
  configs: readonly MCPServerConfig[],
  opts: MCPManagerStartOpts,
  callIndex: number,
) => Promise<void> | void;

function createTransactionalManager(hook?: TransactionalRefreshHook) {
  let configured: readonly MCPServerConfig[] = [];
  const states = new Map<string, MCPConnectionState>();
  let callIndex = 0;
  let activeRefreshes = 0;
  let maxActiveRefreshes = 0;

  const refreshServers = vi.fn(
    async (
      nextConfigs: ReadonlyArray<MCPServerConfig>,
      opts: MCPManagerStartOpts = {},
    ): Promise<void> => {
      const copied = nextConfigs.map((config) => ({
        ...config,
        ...(config.args !== undefined ? { args: [...config.args] } : {}),
      }));
      const currentCall = callIndex;
      callIndex += 1;
      activeRefreshes += 1;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      try {
        await hook?.(copied, opts, currentCall);
        configured = copied;
        states.clear();
        for (const config of configured) {
          states.set(config.name, {
            type: config.enabled === false ? "disabled" : "connected",
          });
        }
      } finally {
        activeRefreshes -= 1;
      }
    },
  );
  const stop = vi.fn(async (): Promise<void> => {
    configured = [];
    states.clear();
  });
  const stopStrict = vi.fn(async (): Promise<void> => stop());
  const clearServersStrict = vi.fn(async (): Promise<void> => stop());
  const manager = {
    refreshServers,
    stop,
    stopStrict,
    clearServersStrict,
    getConfiguredServers: () => configured,
    getServerConfig: (name: string) =>
      configured.find((config) => config.name === name),
    getConnectionState: (name: string) => states.get(name),
    getTools: () =>
      configured.flatMap((config) =>
        states.get(config.name)?.type === "connected"
          ? [{ name: `mcp.${config.name}.tool` }]
          : [],
      ),
    getToolsByServer: (name: string) =>
      states.get(name)?.type === "connected"
        ? [{ name: `mcp.${name}.tool` }]
        : [],
    getConnectedServers: () =>
      configured
        .filter((config) => states.get(config.name)?.type === "connected")
        .map((config) => config.name),
    isConnected: (name: string) => states.get(name)?.type === "connected",
  } as unknown as MCPManager;

  return {
    manager,
    refreshServers,
    stop,
    stopStrict,
    clearServersStrict,
    get configured(): readonly MCPServerConfig[] {
      return configured;
    },
    get maxActiveRefreshes(): number {
      return maxActiveRefreshes;
    },
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

  it("configures the real manager through the policy-aware session service", async () => {
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
      const manager = createSessionMcpManager([]);
      const service = createSessionMcpService(manager, {
        authority: fixture.store,
        environment: {},
      });
      await service.refreshFromAuthority?.();
      expect(mockLoadPluginMcpServerRegistrations).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginStorageRoot: TEST_PLUGIN_STORAGE_ROOT,
        }),
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

  it("lets an allowed lower-precedence definition survive a blocked shadow", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.shared]", 'command = "blocked-user-bin"'],
      managed: [
        'allowedMcpServers = [{ serverCommand = ["allowed-session-bin"] }]',
      ],
    });
    try {
      await expect(
        resolveSessionMcpConfig(fixture.store, {}, {
          shared: { name: "shared", command: "allowed-session-bin" },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          name: "shared",
          command: "allowed-session-bin",
          origin: { scope: "session" },
        }),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("continues canonical policy resolution when plugin discovery fails", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.allowed]",
        'command = "allowed-bin"',
        "[mcp_servers.denied]",
        'command = "denied-bin"',
      ],
      managed: ['deniedMcpServers = [{ serverName = "denied" }]'],
    });
    mockLoadPluginMcpServerRegistrations.mockRejectedValueOnce(
      new Error("plugin registry unavailable"),
    );
    try {
      const result = await getAllMcpConfigs(
        fixture.store,
        { pluginStorageRoot: TEST_PLUGIN_STORAGE_ROOT },
        {},
        {},
        new Map(),
      );
      expect(Object.keys(result.servers)).toEqual(["allowed"]);
      expect(result.errors).toContainEqual({
        type: "generic-error",
        source: "MCP plugin discovery",
        error: "plugin registry unavailable",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("reports malformed canonical definitions instead of inventing commands", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.broken]", "enabled = true"],
    });
    try {
      const result = await getAllMcpConfigs(
        fixture.store,
        { pluginStorageRoot: TEST_PLUGIN_STORAGE_ROOT },
        {},
        {},
        new Map(),
      );
      expect(result.servers).toEqual({});
      expect(result.errors).toEqual([
        expect.objectContaining({
          type: "generic-error",
          source: expect.stringContaining("mcpServers.broken"),
        }),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a session stdio definition without an explicit command", async () => {
    const fixture = await createMcpAuthorityFixture();
    try {
      await expect(
        resolveSessionMcpConfig(fixture.store, {}, {
          node: { name: "node" },
        }),
      ).rejects.toThrow('MCP server "node" is missing its stdio command');
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

  it("deduplicates plugins against the final manual precedence winner", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.shared]",
        'command = "node"',
        'args = ["user-server.js"]',
      ],
    });
    mockLoadPluginMcpServerRegistrations.mockResolvedValueOnce([
      {
        name: "plugin:sample:session-duplicate",
        pluginName: "sample",
        pluginSource: "sample@registry",
        serverName: "session-duplicate",
        server: {
          transport: "stdio",
          command: "node",
          args: ["session-server.js"],
        },
      },
    ]);
    try {
      const configs = await resolveSessionMcpConfig(fixture.store, {}, {
        shared: {
          name: "shared",
          command: "node",
          args: ["session-server.js"],
        },
      });
      expect(configs).toEqual([
        expect.objectContaining({
          name: "plugin:sample:session-duplicate",
          origin: expect.objectContaining({ scope: "plugin" }),
        }),
        expect.objectContaining({
          name: "shared",
          args: ["user-server.js"],
          origin: { scope: "user" },
        }),
      ]);
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

  it("retains repository plugin defaults under plugin-only policy", async () => {
    const fixture = await createMcpAuthorityFixture({
      base: {
        mcp_servers: {
          bundled: { command: "bundled-plugin-server" },
        },
      },
      user: ["[mcp_servers.manual]", 'command = "manual-bin"'],
      managed: ['strictPluginOnlyCustomization = ["mcp"]'],
    });
    try {
      await expect(resolveSessionMcpConfig(fixture.store, {})).resolves.toEqual(
        [
          expect.objectContaining({
            name: "bundled",
            command: "bundled-plugin-server",
            origin: { scope: "plugin" },
          }),
        ],
      );
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

  it("forwards read-only MCP manager operations", async () => {
    const manager = {
      getTools: vi.fn(() => [{ name: "mcp.github.search" }]),
      getToolsByServer: vi.fn((name: string) =>
        name === "github" ? [{ name: "mcp.github.search" }] : [],
      ),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);

    expect(service.getTools?.()).toEqual([{ name: "mcp.github.search" }]);
    expect(service.getToolsByServer?.("github")).toEqual([
      { name: "mcp.github.search" },
    ]);
  });

  it("forwards admitted tool calls and rejects them after the session service closes", async () => {
    const manager = makeManager();
    const expectedResult = {
      content: "canonical result",
      metadata: { source: "canonical-manager" },
    };
    const callTool = vi
      .spyOn(manager, "callTool")
      .mockResolvedValue(expectedResult);
    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    const callOptions = { signal, callId: "admitted-call", onProgress };

    await expect(
      service.callTool?.(
        "alpha",
        "summarize",
        { topic: "AgenC" },
        callOptions,
      ),
    ).resolves.toBe(expectedResult);
    expect(callTool).toHaveBeenCalledWith(
      "alpha",
      "summarize",
      { topic: "AgenC" },
      callOptions,
    );

    await service.dispose?.();
    await expect(
      service.callTool?.("alpha", "summarize", {}, callOptions),
    ).rejects.toThrow("MCP session service is closed");
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("keeps session-facade tool calls on the replacement bridge after reconnect", async () => {
    const firstBridge = makeMockBridge("alpha");
    const replacementBridge = makeMockBridge("alpha");
    const firstExecute = vi.mocked(firstBridge.tools[0]!.execute);
    const replacementExecute = vi.mocked(replacementBridge.tools[0]!.execute);
    firstExecute.mockResolvedValue({ content: "before reconnect" });
    replacementExecute.mockResolvedValue({ content: "after reconnect" });
    mockCreateToolBridge
      .mockResolvedValueOnce(firstBridge as never)
      .mockResolvedValueOnce(replacementBridge as never);
    const manager = makeManager();
    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);

    try {
      await manager.start();
      expect(service.callTool).toBeTypeOf("function");
      await expect(
        service.callTool?.(
          "alpha",
          "echo",
          { phase: "before" },
          { callId: "before-reconnect" },
        ),
      ).resolves.toEqual({ content: "before reconnect" });

      await expect(manager.reconnectServer("alpha")).resolves.toMatchObject({
        serverName: "alpha",
        success: true,
        toolCount: 1,
      });
      await expect(
        service.callTool?.(
          "alpha",
          "echo",
          { phase: "after" },
          { callId: "after-reconnect" },
        ),
      ).resolves.toEqual({ content: "after reconnect" });

      expect(firstExecute).toHaveBeenCalledOnce();
      expect(replacementExecute).toHaveBeenCalledOnce();
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
      expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
    } finally {
      await service.dispose?.();
    }
  });

  it("forwards resources and prompts through the real manager's existing bridges", async () => {
    const resourceSignal = new AbortController().signal;
    const promptSignal = new AbortController().signal;
    const resources = [
      {
        serverName: "alpha",
        uri: "resource://guide",
        namespacedName: "mcp.alpha.resource://guide",
        name: "Guide",
      },
    ];
    const resourceContent = {
      contents: [
        {
          uri: "resource://guide",
          text: "canonical resource",
          truncated: false,
          bytesReturned: 18,
        },
      ],
      truncated: false,
      bytesReturned: 18,
    };
    const prompts = [
      {
        serverName: "alpha",
        name: "summarize",
        namespacedName: "mcp.alpha.summarize",
      },
    ];
    const renderedPrompt = {
      promptName: "summarize",
      messages: [{ role: "user" as const, text: "Summarize AgenC" }],
    };
    const listResources = vi.fn(
      async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return resources;
      },
    );
    const readResource = vi.fn(
      async (_uri: string, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return resourceContent;
      },
    );
    const listPrompts = vi.fn(async () => prompts);
    const renderPrompt = vi.fn(
      async (
        _name: string,
        _args?: Record<string, unknown>,
        signal?: AbortSignal,
      ) => {
        signal?.throwIfAborted();
        return renderedPrompt;
      },
    );
    mockCreateResourceBridge.mockResolvedValueOnce({
      serverName: "alpha",
      listResources,
      readResource,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    mockCreatePromptBridge.mockResolvedValueOnce({
      serverName: "alpha",
      listPrompts,
      renderPrompt,
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const manager = makeManager();
    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);
    await manager.start();
    const connectionCount = mockCreateMCPConnection.mock.calls.length;

    await expect(service.getResources?.(resourceSignal)).resolves.toEqual(
      resources,
    );
    await expect(
      service.getResourcesByServer?.("alpha", resourceSignal),
    ).resolves.toEqual(resources);
    await expect(
      service.readResource?.("mcp.alpha.resource://guide", resourceSignal),
    ).resolves.toEqual(resourceContent);
    await expect(service.listPrompts?.()).resolves.toEqual(prompts);
    await expect(service.listPromptsByServer?.("alpha")).resolves.toEqual(
      prompts,
    );
    await expect(
      service.renderPrompt?.(
        "mcp.alpha.summarize",
        { topic: "AgenC" },
        promptSignal,
      ),
    ).resolves.toEqual(renderedPrompt);

    expect(listResources).toHaveBeenNthCalledWith(1, resourceSignal);
    expect(listResources).toHaveBeenNthCalledWith(2, resourceSignal);
    expect(readResource).toHaveBeenCalledWith(
      "resource://guide",
      resourceSignal,
    );
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(renderPrompt).toHaveBeenCalledWith(
      "summarize",
      { topic: "AgenC" },
      promptSignal,
    );
    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(connectionCount);
    expect(mockCreateResourceBridge).toHaveBeenCalledOnce();
    expect(mockCreatePromptBridge).toHaveBeenCalledOnce();

    const abortReason = new Error("caller cancelled MCP read");
    const aborted = new AbortController();
    aborted.abort(abortReason);
    await expect(service.getResources?.(aborted.signal)).rejects.toBe(
      abortReason,
    );
    await expect(
      service.renderPrompt?.("mcp.alpha.summarize", {}, aborted.signal),
    ).rejects.toBe(abortReason);

    await service.dispose?.();
  });

  it("rejects resource and prompt operations after the session service closes", async () => {
    const manager = makeManager();
    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);
    await manager.start();
    await service.dispose?.();

    await expect(service.getResources?.()).rejects.toThrow(
      "MCP session service is closed",
    );
    await expect(service.getResourcesByServer?.("alpha")).rejects.toThrow(
      "MCP session service is closed",
    );
    await expect(
      service.readResource?.("mcp.alpha.resource://guide"),
    ).rejects.toThrow("MCP session service is closed");
    await expect(service.listPrompts?.()).rejects.toThrow(
      "MCP session service is closed",
    );
    await expect(service.listPromptsByServer?.("alpha")).rejects.toThrow(
      "MCP session service is closed",
    );
    await expect(
      service.renderPrompt?.("mcp.alpha.summarize"),
    ).rejects.toThrow("MCP session service is closed");
  });

  it("never projects raw MCP connection errors or endpoint credentials", () => {
    const manager = {
      getConfiguredServers: vi.fn(() => [
        {
          name: "remote",
          transport: "http" as const,
          endpoint:
            "https://operator:hunter2@example.test/private?token=hunter2",
        },
      ]),
      getConnectionState: vi.fn(() => ({
        type: "failed" as const,
        error:
          "authentication failed for https://operator:hunter2@example.test/private?token=hunter2",
      })),
      getToolsByServer: vi.fn(() => []),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);
    const snapshot = service.mcpSurfaceSnapshot?.();

    expect(snapshot).toEqual({
      revision: 0,
      servers: [
        {
          name: "remote",
          transport: "http",
          enabled: true,
          required: false,
          state: "failed",
          displayTarget: "https://example.test",
          toolCount: 0,
        },
      ],
      tools: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
    expect(JSON.stringify(snapshot)).not.toContain("operator");
  });

  it("omits an empty stdio display target instead of publishing an invalid DTO", () => {
    const manager = {
      getConfiguredServers: vi.fn(() => [
        { name: "local", transport: "stdio" as const, command: "/opt/mcp/" },
      ]),
      getConnectionState: vi.fn(() => ({ type: "pending" as const })),
      getToolsByServer: vi.fn(() => []),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);

    expect(service.mcpSurfaceSnapshot?.()).toEqual({
      revision: 0,
      servers: [
        {
          name: "local",
          transport: "stdio",
          enabled: true,
          required: false,
          state: "pending",
          toolCount: 0,
        },
      ],
      tools: [],
    });
  });

  it("uses a safe fallback for unsupported remote endpoint schemes", () => {
    const manager = {
      getConfiguredServers: vi.fn(() => [
        {
          name: "remote",
          transport: "http" as const,
          endpoint: "ftp://operator:hunter2@example.test/private",
        },
      ]),
      getConnectionState: vi.fn(() => ({ type: "failed" as const })),
      getToolsByServer: vi.fn(() => []),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);

    expect(service.mcpSurfaceSnapshot?.()).toMatchObject({
      servers: [
        {
          name: "remote",
          displayTarget: "remote endpoint",
        },
      ],
    });
    expect(JSON.stringify(service.mcpSurfaceSnapshot?.())).not.toContain(
      "hunter2",
    );
  });

  it("uses a safe fallback instead of truncating an overlong URL origin", () => {
    const manager = {
      getConfiguredServers: vi.fn(() => [
        {
          name: "remote",
          transport: "http" as const,
          endpoint: `https://${"a".repeat(500)}.example.test/mcp`,
        },
      ]),
      getConnectionState: vi.fn(() => ({ type: "failed" as const })),
      getToolsByServer: vi.fn(() => []),
    } as unknown as MCPManager;

    const service = createSessionMcpService(manager, TEST_SERVICE_OPTIONS);

    expect(service.mcpSurfaceSnapshot?.()).toMatchObject({
      servers: [{ name: "remote", displayTarget: "remote endpoint" }],
    });
  });

  it("never publishes a candidate MCP surface while a failed add rolls back", async () => {
    const fixture = await createMcpAuthorityFixture();
    const candidateConnectStarted = deferred();
    const releaseCandidateConnect = deferred();
    mockCreateMCPConnection.mockImplementationOnce(async () => {
      candidateConnectStarted.resolve(undefined);
      await releaseCandidateConnect.promise;
      throw new Error("candidate connect failed");
    });
    const manager = createSessionMcpManager([]);
    const service = createSessionMcpService(manager, {
      authority: fixture.store,
      environment: {},
    });
    const baseline = service.mcpSurfaceSnapshot?.();
    const revisions: number[] = [];
    const unsubscribe = service.subscribeMcpSurfaceInvalidations?.((revision) => {
      revisions.push(revision);
    });
    try {
      const add = service.addServer?.({
        name: "candidate",
        command: "candidate-mcp",
      });
      await candidateConnectStarted.promise;

      expect(manager.getConfiguredServers().map((config) => config.name)).toEqual([
        "candidate",
      ]);
      expect(manager.getConnectionState("candidate")).toEqual({
        type: "pending",
      });
      expect(service.mcpSurfaceSnapshot?.()).toBe(baseline);
      expect(revisions).toEqual([]);

      releaseCandidateConnect.resolve(undefined);
      await expect(add).resolves.toMatchObject({
        success: false,
        error: "candidate connect failed",
      });
      expect(manager.getConfiguredServers()).toEqual([]);
      expect(service.mcpSurfaceSnapshot?.()).toBe(baseline);
      expect(revisions).toEqual([]);
    } finally {
      releaseCandidateConnect.resolve(undefined);
      unsubscribe?.();
      await service.dispose?.();
      await manager.stopStrict();
      fixture.cleanup();
    }
  });

  it("publishes only committed session mutations and later manager-originated changes", async () => {
    const fixture = await createMcpAuthorityFixture();
    const manager = createSessionMcpManager([]);
    const service = createSessionMcpService(manager, {
      authority: fixture.store,
      environment: {},
    });
    const revisions: number[] = [];
    const unsubscribe = service.subscribeMcpSurfaceInvalidations?.((revision) => {
      revisions.push(revision);
    });
    try {
      await expect(
        service.addServer?.({ name: "local", command: "local-mcp" }),
      ).resolves.toMatchObject({ success: true });

      expect(revisions).toEqual([1]);
      expect(service.mcpSurfaceSnapshot?.()).toMatchObject({
        revision: 1,
        servers: [
          expect.objectContaining({
            name: "local",
            state: "connected",
            displayTarget: "local-mcp",
          }),
        ],
        tools: [expect.objectContaining({ serverName: "local" })],
      });

      await manager.stopStrict();
      await vi.waitFor(() => {
        expect(service.mcpSurfaceSnapshot?.()).toMatchObject({
          revision: 2,
          servers: [expect.objectContaining({ name: "local", state: "pending" })],
          tools: [],
        });
      });
      expect(revisions).toEqual([1, 2]);

      await service.dispose?.();
      const terminalSnapshot = service.mcpSurfaceSnapshot?.();
      expect(terminalSnapshot).toMatchObject({
        revision: 3,
        servers: [],
        tools: [],
      });
      await manager.refreshServers([
        { name: "outside", command: "outside-mcp" },
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(service.mcpSurfaceSnapshot?.()).toBe(terminalSnapshot);
      expect(revisions).toEqual([1, 2]);
    } finally {
      unsubscribe?.();
      await service.dispose?.();
      await manager.stopStrict();
      fixture.cleanup();
    }
  });

  it("keeps an admitted session server and its enabled override across authority refreshes", async () => {
    const fixture = await createMcpAuthorityFixture();
    const manager = createSessionMcpManager([]);
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
    const manager = createSessionMcpManager([]);
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
      const service = createSessionMcpService(manager, {
        authority: fixture.store,
        environment: {},
      });
      const result = await service.refreshFromAuthority?.();

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
        expect.objectContaining({ requiredServers: ["github"] }),
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
      const service = createSessionMcpService(manager, {
        authority: fixture.store,
        environment: {},
      });
      const result = await service.refreshFromAuthority?.();

      expect(refreshServers).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: "plugin:sample:goal",
            origin: expect.objectContaining({ scope: "plugin" }),
          }),
          expect.objectContaining({ name: "github" }),
        ],
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
        expect.objectContaining({ requiredServers: ["configOnly"] }),
      );
      expect(result).toEqual({
        configuredServers: ["configOnly"],
        requiredServers: ["configOnly"],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("automatically revokes and reconciles after a canonical reload", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.before]", 'command = "before"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      expect(fixture.store.subscriberCount()).toBe(0);
      await service.refreshFromAuthority?.();
      expect(fixture.store.subscriberCount()).toBe(1);
      expect(harness.configured.map((config) => config.name)).toEqual([
        "before",
      ]);

      writeCanonicalFixtureConfig(fixture.userConfigPath, [
        "[mcp_servers.after]",
        'command = "after"',
      ]);
      await fixture.store.reload();

      await vi.waitFor(() => {
        expect(harness.configured).toEqual([
          expect.objectContaining({ name: "after", command: "after" }),
        ]);
      });
      await expect(service.refreshFromAuthority?.()).resolves.toEqual({
        configuredServers: ["after"],
        requiredServers: [],
      });
      expect(harness.refreshServers).toHaveBeenCalledTimes(2);
      await service.refreshFromAuthority?.();
      expect(harness.refreshServers).toHaveBeenCalledTimes(3);
      expect(harness.clearServersStrict).not.toHaveBeenCalled();
    } finally {
      await service.dispose?.();
      expect(fixture.store.subscriberCount()).toBe(0);
      fixture.cleanup();
    }
  });

  it("does not satisfy a joined refresh handshake with an older authority generation", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.before]", 'command = "before"'],
    });
    const oldApplyStarted = deferred();
    const emitOldDeferral = deferred();
    const oldDeferralEmitted = deferred();
    const releaseOldApply = deferred();
    const newDeferralEmitted = deferred();
    const releaseNewApply = deferred();
    const harness = createTransactionalManager(
      async (_configs, opts, call) => {
        if (call === 1) {
          oldApplyStarted.resolve();
          await emitOldDeferral.promise;
          opts.onSandboxRefreshDeferred?.();
          oldDeferralEmitted.resolve();
          await releaseOldApply.promise;
        }
        if (call === 2) {
          opts.onSandboxRefreshDeferred?.();
          newDeferralEmitted.resolve();
          await releaseNewApply.promise;
        }
      },
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    const joinedHandshake = vi.fn();
    try {
      await service.refreshFromAuthority?.();
      const oldRefresh = service.refreshFromAuthority?.();
      await oldApplyStarted.promise;

      writeCanonicalFixtureConfig(fixture.userConfigPath, [
        "[mcp_servers.after]",
        'command = "after"',
      ]);
      await fixture.store.reload();
      const joinedRefresh = service.refreshFromAuthority?.({
        onSandboxRefreshDeferred: joinedHandshake,
      });

      emitOldDeferral.resolve();
      await oldDeferralEmitted.promise;
      expect(joinedHandshake).not.toHaveBeenCalled();

      releaseOldApply.resolve();
      await newDeferralEmitted.promise;
      expect(joinedHandshake).toHaveBeenCalledOnce();

      releaseNewApply.resolve();
      await expect(Promise.all([oldRefresh, joinedRefresh])).resolves.toEqual([
        {
          configuredServers: ["after"],
          requiredServers: [],
        },
        {
          configuredServers: ["after"],
          requiredServers: [],
        },
      ]);
      expect(harness.configured.map((config) => config.name)).toEqual([
        "after",
      ]);
    } finally {
      emitOldDeferral.resolve();
      releaseOldApply.resolve();
      releaseNewApply.resolve();
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("removes refresh-deferral observers after failure, success, and disposal", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.only]", 'command = "only"'],
    });
    const failureStarted = deferred();
    const releaseFailure = deferred();
    const disposeStarted = deferred();
    const releaseDispose = deferred();
    let emitFailedDeferral: (() => void) | undefined;
    let emitDisposedDeferral: (() => void) | undefined;
    const harness = createTransactionalManager(
      async (_configs, opts, call) => {
        if (call === 1) {
          emitFailedDeferral = opts.onSandboxRefreshDeferred;
          failureStarted.resolve();
          await releaseFailure.promise;
          throw new Error("injected refresh failure before deferral");
        }
        if (call === 2) {
          opts.onSandboxRefreshDeferred?.();
        }
        if (call === 3) {
          emitDisposedDeferral = opts.onSandboxRefreshDeferred;
          disposeStarted.resolve();
          await releaseDispose.promise;
        }
      },
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    const failedObserver = vi.fn();
    const successfulObserver = vi.fn();
    const disposedObserver = vi.fn();
    try {
      await service.refreshFromAuthority?.();

      const failedRefresh = service.refreshFromAuthority?.({
        onSandboxRefreshDeferred: failedObserver,
      });
      const failedExpectation = expect(failedRefresh).rejects.toThrow(
        /session was fail-closed/u,
      );
      await failureStarted.promise;
      releaseFailure.resolve();
      await failedExpectation;
      emitFailedDeferral?.();
      expect(failedObserver).not.toHaveBeenCalled();

      await expect(
        service.refreshFromAuthority?.({
          onSandboxRefreshDeferred: successfulObserver,
        }),
      ).resolves.toEqual({
        configuredServers: ["only"],
        requiredServers: [],
      });
      expect(successfulObserver).toHaveBeenCalledOnce();
      expect(failedObserver).not.toHaveBeenCalled();

      const disposedRefresh = service.refreshFromAuthority?.({
        onSandboxRefreshDeferred: disposedObserver,
      });
      const disposedExpectation = expect(disposedRefresh).rejects.toThrow(
        /disposed|closed/u,
      );
      await disposeStarted.promise;
      const disposal = service.dispose?.();
      releaseDispose.resolve();
      await disposedExpectation;
      await disposal;
      emitDisposedDeferral?.();
      expect(disposedObserver).not.toHaveBeenCalled();
      expect(successfulObserver).toHaveBeenCalledOnce();
    } finally {
      releaseFailure.resolve();
      releaseDispose.resolve();
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("cancels slow plugin discovery and revokes stale connections on reload", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.stale]", 'command = "stale"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    const discoveryStarted = deferred();
    const releaseDiscovery = deferred();
    let discoveryFinished = false;
    try {
      await service.refreshFromAuthority?.();
      mockLoadPluginMcpServerRegistrations.mockImplementationOnce(async () => {
        discoveryStarted.resolve(undefined);
        await releaseDiscovery.promise;
        discoveryFinished = true;
        return [];
      });

      const inFlightRefresh = service.refreshFromAuthority?.();
      await discoveryStarted.promise;
      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        'deniedMcpServers = [{ serverName = "stale" }]',
      ]);
      await fixture.store.reload();

      await vi.waitFor(() => expect(harness.configured).toEqual([]));
      expect(discoveryFinished).toBe(false);
      releaseDiscovery.resolve(undefined);
      await expect(inFlightRefresh).resolves.toEqual({
        configuredServers: [],
        requiredServers: [],
      });
      expect(harness.configured).toEqual([]);
    } finally {
      releaseDiscovery.resolve(undefined);
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("lets an in-flight refresh satisfy the notified authority generation once", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.before]", 'command = "before"'],
    });
    const harness = createTransactionalManager(
      async (_configs, _opts, call) => {
        if (call !== 0) return;
        writeCanonicalFixtureConfig(fixture.userConfigPath, [
          "[mcp_servers.after]",
          'command = "after"',
        ]);
        await fixture.store.reload();
      },
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(service.refreshFromAuthority?.()).resolves.toEqual({
        configuredServers: ["after"],
        requiredServers: [],
      });
      expect(harness.refreshServers).toHaveBeenCalledTimes(2);
      expect(harness.configured).toEqual([
        expect.objectContaining({ name: "after", command: "after" }),
      ]);
    } finally {
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("disposes during slow resolution without allowing a late restart", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.live]", 'command = "live"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    const discoveryStarted = deferred();
    const releaseDiscovery = deferred();
    try {
      await service.refreshFromAuthority?.();
      mockLoadPluginMcpServerRegistrations.mockImplementationOnce(async () => {
        discoveryStarted.resolve(undefined);
        await releaseDiscovery.promise;
        return [];
      });
      const inFlightRefresh = service.refreshFromAuthority?.();
      await discoveryStarted.promise;

      await expect(service.dispose?.()).resolves.toBeUndefined();
      expect(harness.configured).toEqual([]);
      releaseDiscovery.resolve(undefined);
      await expect(inFlightRefresh).rejects.toThrow(
        "MCP session service is closed",
      );
      await expect(service.refreshFromAuthority?.()).rejects.toThrow(
        "MCP session service is closed",
      );
      expect(harness.configured).toEqual([]);
    } finally {
      releaseDiscovery.resolve(undefined);
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("performs a final strict stop after an in-flight manager apply drains", async () => {
    const fixture = await createMcpAuthorityFixture();
    const applyStarted = deferred();
    const releaseApply = deferred();
    const harness = createTransactionalManager(
      async (_configs, _opts, call) => {
        if (call !== 0) return;
        applyStarted.resolve(undefined);
        await releaseApply.promise;
      },
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      const add = service.addServer?.({ name: "late", command: "late" });
      await applyStarted.promise;
      const disposal = service.dispose?.();
      releaseApply.resolve(undefined);

      await expect(add).resolves.toMatchObject({ success: false });
      await expect(disposal).resolves.toBeUndefined();
      expect(harness.stop).toHaveBeenCalledTimes(2);
      expect(harness.clearServersStrict).toHaveBeenCalledOnce();
      expect(harness.configured).toEqual([]);
      expect(harness.manager.isConnected("late")).toBe(false);
    } finally {
      releaseApply.resolve(undefined);
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("retries strict projection cleanup after a failed disposal attempt", async () => {
    const fixture = await createMcpAuthorityFixture();
    const harness = createTransactionalManager();
    harness.clearServersStrict.mockRejectedValueOnce(
      new Error("retained owner still closing"),
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();

      await expect(service.dispose?.()).rejects.toThrow(
        "retained owner still closing",
      );
      await expect(service.dispose?.()).resolves.toBeUndefined();

      expect(harness.clearServersStrict).toHaveBeenCalledTimes(2);
      expect(harness.configured).toEqual([]);
    } finally {
      await service.dispose?.();
      fixture.cleanup();
    }
  });
});

describe("session MCP mutation transactions", () => {
  it("rejects malformed session additions before touching the manager", async () => {
    const fixture = await createMcpAuthorityFixture();
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "bad name", command: "node" }),
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("Invalid MCP server name"),
      });
      await expect(
        service.addServer?.({ name: "missing_command" }),
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("missing its stdio command"),
      });
      expect(harness.refreshServers).not.toHaveBeenCalled();
      expect(mockCreateMCPConnection).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("allows a session definition to shadow a repository plugin default", async () => {
    const fixture = await createMcpAuthorityFixture({
      base: {
        mcp_servers: {
          shared: { command: "plugin-default" },
        },
      },
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([
        expect.objectContaining({
          name: "shared",
          command: "plugin-default",
          origin: { scope: "plugin" },
        }),
      ]);

      await expect(
        service.addServer?.({ name: "shared", command: "session" }),
      ).resolves.toMatchObject({ success: true });
      expect(harness.configured).toEqual([
        expect.objectContaining({
          name: "shared",
          command: "session",
          origin: { scope: "session" },
        }),
      ]);
    } finally {
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("serializes concurrent session additions without losing either overlay", async () => {
    const fixture = await createMcpAuthorityFixture();
    const firstRefresh = deferred();
    const harness = createTransactionalManager(async (_configs, _opts, call) => {
      if (call === 0) await firstRefresh.promise;
    });
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      const first = service.addServer?.({ name: "alpha", command: "alpha" });
      await vi.waitFor(() => expect(harness.refreshServers).toHaveBeenCalledTimes(1));
      const second = service.addServer?.({ name: "beta", command: "beta" });
      await Promise.resolve();
      expect(harness.refreshServers).toHaveBeenCalledTimes(1);

      firstRefresh.resolve(undefined);
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ serverName: "alpha", success: true }),
        expect.objectContaining({ serverName: "beta", success: true }),
      ]);
      expect(harness.configured.map((config) => config.name)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(harness.maxActiveRefreshes).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("serializes authority refresh behind an in-flight session addition", async () => {
    const fixture = await createMcpAuthorityFixture();
    const firstRefresh = deferred();
    const harness = createTransactionalManager(async (_configs, _opts, call) => {
      if (call === 0) await firstRefresh.promise;
    });
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      const add = service.addServer?.({ name: "session", command: "session" });
      await vi.waitFor(() => expect(harness.refreshServers).toHaveBeenCalledTimes(1));
      writeCanonicalFixtureConfig(fixture.userConfigPath, [
        "[mcp_servers.durable]",
        'command = "durable"',
      ]);
      await fixture.store.reload();
      const refresh = service.refreshFromAuthority?.();

      firstRefresh.resolve(undefined);
      await expect(add).resolves.toMatchObject({ success: true });
      await expect(refresh).resolves.toEqual({
        configuredServers: ["session", "durable"],
        requiredServers: [],
      });
      expect(harness.configured.map((config) => config.name)).toEqual([
        "session",
        "durable",
      ]);
      expect(harness.maxActiveRefreshes).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("expires an enabled override when the exact definition changes", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.target]", 'command = "target-v1"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      await expect(service.disableServer?.("target")).resolves.toMatchObject({
        success: true,
      });
      expect(harness.configured[0]).toMatchObject({
        command: "target-v1",
        enabled: false,
      });

      writeCanonicalFixtureConfig(fixture.userConfigPath, [
        "[mcp_servers.target]",
        'command = "target-v2"',
      ]);
      await fixture.store.reload();
      await service.refreshFromAuthority?.();
      expect(harness.configured[0]).toMatchObject({
        command: "target-v2",
      });
      expect(harness.configured[0]?.enabled).toBeUndefined();
      expect(harness.manager.getConnectionState("target")).toEqual({
        type: "connected",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("does not carry a user override onto a managed replacement", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.target]", 'command = "user-target"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      await service.disableServer?.("target");
      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        "[mcp_servers.target]",
        'command = "managed-target"',
      ]);
      await fixture.store.reload();
      await service.refreshFromAuthority?.();

      expect(harness.configured).toEqual([
        expect.objectContaining({
          name: "target",
          command: "managed-target",
          origin: { scope: "managed" },
        }),
      ]);
      expect(harness.configured[0]?.enabled).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects managed toggles while reconciling canonical state", async () => {
    const fixture = await createMcpAuthorityFixture({
      managed: ["[mcp_servers.locked]", 'command = "managed-mcp"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      await expect(service.disableServer?.("locked")).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("controlled by canonical managed policy"),
      });
      await expect(service.enableServer?.("locked")).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("controlled by canonical managed policy"),
      });
      expect(harness.configured[0]).toMatchObject({
        name: "locked",
        origin: { scope: "managed" },
      });
      expect(harness.configured[0]?.enabled).toBeUndefined();
      expect(harness.refreshServers).toHaveBeenCalledTimes(3);
    } finally {
      fixture.cleanup();
    }
  });

  it("rolls back a failed session add and allows the same name to be retried", async () => {
    const fixture = await createMcpAuthorityFixture();
    const harness = createTransactionalManager(async (_configs, _opts, call) => {
      if (call === 0) throw new Error("candidate apply failed");
    });
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "retry", command: "missing" }),
      ).resolves.toEqual({
        serverName: "retry",
        success: false,
        toolCount: 0,
        error: "candidate apply failed",
      });
      expect(harness.configured).toEqual([]);

      await expect(
        service.addServer?.({ name: "retry", command: "working" }),
      ).resolves.toMatchObject({ serverName: "retry", success: true });
      expect(harness.configured).toEqual([
        expect.objectContaining({ name: "retry", command: "working" }),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("fail-closes when candidate application and rollback both fail", async () => {
    const fixture = await createMcpAuthorityFixture();
    const harness = createTransactionalManager(async (_configs, _opts, call) => {
      if (call === 0) throw new Error("candidate failed");
      if (call === 1) throw new Error("rollback failed");
    });
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "unsafe", command: "unsafe" }),
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("rollback failed"),
      });
      expect(harness.refreshServers).toHaveBeenCalledTimes(2);
      expect(harness.clearServersStrict).toHaveBeenCalledOnce();
      expect(harness.configured).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("retries strict clear after fail-closed cleanup initially fails", async () => {
    const fixture = await createMcpAuthorityFixture();
    const harness = createTransactionalManager(
      async (_configs, _opts, call) => {
        if (call === 0) throw new Error("candidate failed");
        if (call === 1) throw new Error("rollback failed");
      },
    );
    harness.clearServersStrict.mockRejectedValueOnce(
      new Error("cleanup ownership still retained"),
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "unsafe", command: "unsafe" }),
      ).resolves.toMatchObject({ success: false });

      expect(harness.clearServersStrict).toHaveBeenCalledTimes(2);
      expect(harness.stopStrict).toHaveBeenCalledOnce();
      expect(harness.configured).toEqual([]);
    } finally {
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("invalidates a committed generation when postcondition rollback fail-closes", async () => {
    const fixture = await createMcpAuthorityFixture();
    const harness = createTransactionalManager(
      async (_configs, _opts, call) => {
        if (call === 0) await fixture.store.reload();
        if (call === 2) throw new Error("rollback failed");
      },
    );
    vi.spyOn(harness.manager, "getConnectionState").mockReturnValue({
      type: "failed",
      error: "candidate postcondition failed",
    });
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "candidate", command: "candidate" }),
      ).resolves.toMatchObject({ success: false });

      await vi.waitFor(() =>
        expect(harness.refreshServers).toHaveBeenCalledTimes(4),
      );
      await expect(service.refreshFromAuthority?.()).resolves.toEqual({
        configuredServers: [],
        requiredServers: [],
      });
      expect(harness.configured).toEqual([]);
    } finally {
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("automatically fail-closes a failed authority refresh instead of preserving stale configs", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.stale]", 'command = "stale"'],
    });
    const harness = createTransactionalManager(async (_configs, _opts, call) => {
      if (call === 1) throw new Error("authority apply failed");
    });
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      expect(harness.configured.map((config) => config.name)).toEqual(["stale"]);

      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        'deniedMcpServers = [{ serverName = "stale" }]',
      ]);
      await fixture.store.reload();
      await vi.waitFor(() => {
        expect(harness.refreshServers).toHaveBeenCalledTimes(2);
        expect(harness.clearServersStrict).toHaveBeenCalledOnce();
        expect(harness.configured).toEqual([]);
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("retains a plugin disable across transient discovery failure", async () => {
    const fixture = await createMcpAuthorityFixture();
    const registration = {
      name: "plugin:sample:goal",
      pluginName: "sample",
      pluginSource: "sample@registry",
      serverName: "goal",
      server: {
        transport: "stdio" as const,
        command: "node",
        args: ["goal-server.mjs"],
      },
    };
    mockLoadPluginMcpServerRegistrations.mockResolvedValue([registration]);
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      await expect(
        service.disableServer?.("plugin:sample:goal"),
      ).resolves.toMatchObject({ success: true });
      expect(harness.configured[0]).toMatchObject({
        name: "plugin:sample:goal",
        enabled: false,
      });

      mockLoadPluginMcpServerRegistrations.mockRejectedValueOnce(
        new Error("temporary plugin registry failure"),
      );
      await expect(service.refreshFromAuthority?.()).resolves.toEqual({
        configuredServers: [],
        requiredServers: [],
      });
      expect(harness.configured).toEqual([]);

      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([
        expect.objectContaining({
          name: "plugin:sample:goal",
          enabled: false,
        }),
      ]);
      expect(harness.manager.getConnectionState("plugin:sample:goal")).toEqual({
        type: "disabled",
      });
    } finally {
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("retains a plugin disable when discovery is only partially complete", async () => {
    const fixture = await createMcpAuthorityFixture();
    const registration = {
      name: "plugin:sample:goal",
      pluginName: "sample",
      pluginSource: "sample@registry",
      serverName: "goal",
      server: {
        transport: "stdio" as const,
        command: "node",
        args: ["goal-server.mjs"],
      },
    };
    mockLoadPluginMcpServerRegistrations.mockResolvedValue([registration]);
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      await service.disableServer?.("plugin:sample:goal");

      mockLoadPluginMcpServerRegistrations.mockImplementationOnce(
        async (options) => {
          options.errors?.push({
            type: "manifest",
            plugin: "sample",
            source: "sample@registry",
            message: "manifest temporarily unreadable",
          });
          return [];
        },
      );
      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([]);

      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([
        expect.objectContaining({
          name: "plugin:sample:goal",
          enabled: false,
        }),
      ]);
    } finally {
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("restores a shadowed session definition with its exact override intact", async () => {
    const fixture = await createMcpAuthorityFixture();
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.addServer?.({ name: "shared", command: "session-shared" });
      await service.disableServer?.("shared");

      writeCanonicalFixtureConfig(fixture.userConfigPath, [
        "[mcp_servers.shared]",
        'command = "durable-shared"',
      ]);
      await fixture.store.reload();
      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([
        expect.objectContaining({
          name: "shared",
          command: "durable-shared",
          origin: { scope: "user" },
        }),
      ]);

      writeCanonicalFixtureConfig(fixture.userConfigPath, []);
      await fixture.store.reload();
      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([
        expect.objectContaining({
          name: "shared",
          command: "session-shared",
          enabled: false,
          origin: { scope: "session" },
        }),
      ]);
      expect(harness.manager.getConnectionState("shared")).toEqual({
        type: "disabled",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["managed exclusivity", ["[mcp_servers]"]],
    ["plugin-only policy", ['strictPluginOnlyCustomization = ["mcp"]']],
    [
      "deny policy",
      ['deniedMcpServers = [{ serverName = "ephemeral" }]'],
    ],
  ])(
    "purges session definitions blocked by %s so they cannot reappear",
    async (_label, managedLines) => {
      const fixture = await createMcpAuthorityFixture();
      const harness = createTransactionalManager();
      const service = createSessionMcpService(harness.manager, {
        authority: fixture.store,
        environment: {},
      });
      try {
        await service.addServer?.({
          name: "ephemeral",
          command: "ephemeral",
        });
        writeCanonicalFixtureConfig(fixture.managedConfigPath, managedLines);
        await fixture.store.reload();
        await service.refreshFromAuthority?.();
        expect(harness.configured).toEqual([]);

        rmSync(fixture.managedConfigPath, { force: true });
        await fixture.store.reload();
        await service.refreshFromAuthority?.();
        expect(harness.configured).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("purges a blocked session definition even when authority application fails", async () => {
    const fixture = await createMcpAuthorityFixture();
    const harness = createTransactionalManager(
      async (_configs, _opts, call) => {
        if (call === 1) throw new Error("blocked authority apply failed");
      },
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "ephemeral", command: "ephemeral" }),
      ).resolves.toMatchObject({ success: true });

      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        'deniedMcpServers = [{ serverName = "ephemeral" }]',
      ]);
      await fixture.store.reload();
      await vi.waitFor(() => {
        expect(harness.refreshServers).toHaveBeenCalledTimes(2);
        expect(harness.clearServersStrict).toHaveBeenCalledOnce();
        expect(harness.configured).toEqual([]);
      });

      rmSync(fixture.managedConfigPath, { force: true });
      await fixture.store.reload();
      await vi.waitFor(() => {
        expect(harness.refreshServers).toHaveBeenCalledTimes(3);
        expect(harness.configured).toEqual([]);
      });
    } finally {
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("does not resurrect a purged session definition when authority churns during apply", async () => {
    const fixture = await createMcpAuthorityFixture();
    const blockedApplyStarted = deferred();
    const releaseBlockedApply = deferred();
    const harness = createTransactionalManager(
      async (_configs, _opts, call) => {
        if (call !== 1) return;
        blockedApplyStarted.resolve(undefined);
        await releaseBlockedApply.promise;
      },
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "ephemeral", command: "ephemeral" }),
      ).resolves.toMatchObject({ success: true });

      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        'deniedMcpServers = [{ serverName = "ephemeral" }]',
      ]);
      await fixture.store.reload();
      await blockedApplyStarted.promise;

      rmSync(fixture.managedConfigPath, { force: true });
      await fixture.store.reload();
      releaseBlockedApply.resolve(undefined);

      await vi.waitFor(() => {
        expect(harness.refreshServers).toHaveBeenCalledTimes(3);
        expect(harness.configured).toEqual([]);
      });
    } finally {
      releaseBlockedApply.resolve(undefined);
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("does not resurrect a revoked server from a stale rollback baseline", async () => {
    const fixture = await createMcpAuthorityFixture();
    const mutationBaselineStarted = deferred();
    const releaseMutationBaseline = deferred();
    const rollbackResolutionStarted = deferred();
    const releaseRollbackResolution = deferred();
    let pluginLoadCall = 0;
    mockLoadPluginMcpServerRegistrations.mockImplementation(async () => {
      const call = pluginLoadCall;
      pluginLoadCall += 1;
      if (call === 2) {
        mutationBaselineStarted.resolve(undefined);
        await releaseMutationBaseline.promise;
      }
      if (call === 5) {
        rollbackResolutionStarted.resolve(undefined);
        await releaseRollbackResolution.promise;
      }
      return [];
    });
    const harness = createTransactionalManager(
      async (_configs, _opts, call) => {
        if (call === 1) throw new Error("candidate failed");
      },
    );
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await expect(
        service.addServer?.({ name: "ephemeral", command: "ephemeral" }),
      ).resolves.toMatchObject({ success: true });

      const trigger = service.addServer?.({
        name: "trigger",
        command: "trigger",
      });
      await mutationBaselineStarted.promise;
      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        'deniedMcpServers = [{ serverName = "ephemeral" }]',
      ]);
      await fixture.store.reload();
      releaseMutationBaseline.resolve(undefined);

      await rollbackResolutionStarted.promise;
      rmSync(fixture.managedConfigPath, { force: true });
      await fixture.store.reload();
      releaseRollbackResolution.resolve(undefined);

      await expect(trigger).resolves.toMatchObject({
        serverName: "trigger",
        success: false,
        error: expect.stringContaining("candidate failed"),
      });
      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([]);
      expect(
        harness.manager.getConfiguredServers().map((config) => config.name),
      ).not.toContain("ephemeral");
    } finally {
      releaseMutationBaseline.resolve(undefined);
      releaseRollbackResolution.resolve(undefined);
      await service.dispose?.();
      fixture.cleanup();
    }
  });

  it("revokes denied servers even when plugin discovery fails", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.revoked]", 'command = "revoked"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        'deniedMcpServers = [{ serverName = "revoked" }]',
      ]);
      await fixture.store.reload();
      mockLoadPluginMcpServerRegistrations.mockRejectedValueOnce(
        new Error("plugin registry unavailable"),
      );

      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reconciles current authority before returning a failed mutation", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.retired]", 'command = "retired"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        'deniedMcpServers = [{ serverName = "retired" }]',
      ]);
      await fixture.store.reload();

      await expect(service.enableServer?.("retired")).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("not configured"),
      });
      expect(harness.configured).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reconciles revocation before reconnecting a stale server", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.retired]", 'command = "retired"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      writeCanonicalFixtureConfig(fixture.managedConfigPath, [
        'deniedMcpServers = [{ serverName = "retired" }]',
      ]);
      await fixture.store.reload();

      await expect(service.reconnectServer?.("retired")).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("not configured"),
      });
      expect(harness.configured).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("applies enabled overrides before plugin duplicate suppression", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: [
        "[mcp_servers.manual]",
        'command = "node"',
        'args = ["same-server.js"]',
      ],
    });
    mockLoadPluginMcpServerRegistrations.mockResolvedValue([
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
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      expect(harness.configured.map((config) => config.name)).toEqual([
        "manual",
      ]);

      await expect(service.disableServer?.("manual")).resolves.toMatchObject({
        success: true,
      });
      expect(harness.configured).toEqual([
        expect.objectContaining({
          name: "plugin:sample:duplicate",
          origin: expect.objectContaining({ scope: "plugin" }),
        }),
        expect.objectContaining({ name: "manual", enabled: false }),
      ]);

      await expect(service.enableServer?.("manual")).resolves.toMatchObject({
        success: true,
      });
      expect(harness.configured).toEqual([
        expect.objectContaining({ name: "manual", enabled: true }),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not retain an add that becomes shadowed during admission", async () => {
    const fixture = await createMcpAuthorityFixture();
    const candidateResolutionStarted = deferred();
    const releaseCandidateResolution = deferred();
    let pluginLoad = 0;
    mockLoadPluginMcpServerRegistrations.mockImplementation(async () => {
      const call = pluginLoad;
      pluginLoad += 1;
      if (call === 1) {
        candidateResolutionStarted.resolve(undefined);
        await releaseCandidateResolution.promise;
      }
      return [];
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      const add = service.addServer?.({ name: "raced", command: "session" });
      await candidateResolutionStarted.promise;
      writeCanonicalFixtureConfig(fixture.userConfigPath, [
        "[mcp_servers.raced]",
        'command = "durable"',
      ]);
      await fixture.store.reload();
      releaseCandidateResolution.resolve(undefined);

      await expect(add).resolves.toMatchObject({ success: false });
      expect(harness.configured).toEqual([
        expect.objectContaining({ name: "raced", command: "durable" }),
      ]);

      writeCanonicalFixtureConfig(fixture.userConfigPath, []);
      await fixture.store.reload();
      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not retain a toggle when the winning definition changes", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.raced]", 'command = "user"'],
    });
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: fixture.store,
      environment: {},
    });
    try {
      await service.refreshFromAuthority?.();
      const candidateResolutionStarted = deferred();
      const releaseCandidateResolution = deferred();
      let pluginLoad = 0;
      mockLoadPluginMcpServerRegistrations.mockImplementation(async () => {
        const call = pluginLoad;
        pluginLoad += 1;
        if (call === 1) {
          candidateResolutionStarted.resolve(undefined);
          await releaseCandidateResolution.promise;
        }
        return [];
      });

      const disable = service.disableServer?.("raced");
      await candidateResolutionStarted.promise;
      writeCanonicalFixtureConfig(fixture.localConfigPath, [
        "[mcp_servers.raced]",
        'command = "local"',
      ]);
      await fixture.store.reload();
      releaseCandidateResolution.resolve(undefined);

      await expect(disable).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("changed during mutation"),
      });
      expect(harness.configured).toEqual([
        expect.objectContaining({ name: "raced", command: "local" }),
      ]);

      rmSync(fixture.localConfigPath, { force: true });
      await fixture.store.reload();
      await service.refreshFromAuthority?.();
      expect(harness.configured).toEqual([
        expect.objectContaining({ name: "raced", command: "user" }),
      ]);
      expect(harness.configured[0]?.enabled).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps plugin discovery on one captured authority generation", async () => {
    const fixture = await createMcpAuthorityFixture({
      user: ["[mcp_servers.snapshot]", 'command = "generation-a"'],
    });
    const loaderStarted = deferred();
    const releaseLoader = deferred();
    let beforeAwait: ReturnType<CanonicalSettingsAuthority["current"]> | undefined;
    let afterAwait: ReturnType<CanonicalSettingsAuthority["current"]> | undefined;
    mockLoadPluginMcpServerRegistrations.mockImplementationOnce(async () => {
      beforeAwait = getCanonicalSettingsAuthority()?.current();
      loaderStarted.resolve(undefined);
      await releaseLoader.promise;
      afterAwait = getCanonicalSettingsAuthority()?.current();
      return [];
    });
    try {
      const resolution = getAllMcpConfigs(
        fixture.store,
        { pluginStorageRoot: TEST_PLUGIN_STORAGE_ROOT },
        {},
        {},
        new Map(),
      );
      await loaderStarted.promise;
      writeCanonicalFixtureConfig(fixture.userConfigPath, [
        "[mcp_servers.snapshot]",
        'command = "generation-b"',
      ]);
      await fixture.store.reload();
      releaseLoader.resolve(undefined);

      const result = await resolution;
      expect(beforeAwait).toBeDefined();
      expect(afterAwait).toBe(beforeAwait);
      expect(result.authoritySnapshot).toBe(beforeAwait);
      expect(result.servers.snapshot).toMatchObject({
        command: "generation-a",
      });
      expect(fixture.store.current()).not.toBe(result.authoritySnapshot);
    } finally {
      fixture.cleanup();
    }
  });

  it("bounds repeated authority churn and fail-closes the queue", async () => {
    const fixture = await createMcpAuthorityFixture();
    let snapshotReads = 0;
    const nextSnapshot = (): ReturnType<CanonicalSettingsAuthority["current"]> => {
      snapshotReads += 1;
      return Object.freeze({ ...fixture.store.current() });
    };
    const churningAuthority: CanonicalSettingsAuthority = {
      authoritySnapshot: () => Object.freeze({
        config: nextSnapshot(),
        layers: fixture.store.authoritySnapshot().layers,
      }),
      current: nextSnapshot,
      sources: fixture.store.sources.bind(fixture.store),
      projectRoot: fixture.store.projectRoot,
      homeContext: fixture.store.homeContext,
      stateRepository: fixture.store.stateRepository,
      reload: fixture.store.reload.bind(fixture.store),
      subscribe: fixture.store.subscribe.bind(fixture.store),
    };
    const harness = createTransactionalManager();
    const service = createSessionMcpService(harness.manager, {
      authority: churningAuthority,
      environment: {},
    });
    try {
      await expect(service.refreshFromAuthority?.()).rejects.toThrow(
        "Canonical MCP refresh failed and the session was fail-closed",
      );
      expect(snapshotReads).toBeGreaterThanOrEqual(10);
      expect(snapshotReads).toBeLessThan(20);
      expect(harness.refreshServers).not.toHaveBeenCalled();
      expect(harness.clearServersStrict).toHaveBeenCalledOnce();
      expect(harness.configured).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
