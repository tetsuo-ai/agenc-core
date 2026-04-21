/**
 * T6 gap #119 seam: `attachMcpManagerToSession` must install the
 * session-bound `MCPCallObserver` on the manager BEFORE `manager.start()`
 * so every bridge created thereafter emits `mcp_tool_call_*` events
 * into the session event log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCPManager } from "../mcp-client/manager.js";
import { createMCPConnection } from "../mcp-client/connection.js";
import { createToolBridge } from "../mcp-client/tool-bridge.js";
import { createResourceBridge } from "../mcp-client/resource-bridge.js";
import { createPromptBridge } from "../mcp-client/prompt-bridge.js";
import type { MCPCallObserver } from "../mcp-client/tool-bridge.js";
import {
  attachMcpManagerToSession,
  createSessionMcpManager,
  createSessionMcpManagerFromEnv,
  createSessionMcpService,
  getMcpConfigFromEnv,
  startMcpManagerForSession,
} from "./mcp-startup.js";
import type { Session } from "./session.js";

vi.mock("../mcp-client/connection.js", () => ({
  createMCPConnection: vi.fn(),
}));
vi.mock("../mcp-client/tool-bridge.js", () => ({
  createToolBridge: vi.fn(),
}));
vi.mock("../mcp-client/resource-bridge.js", () => ({
  createResourceBridge: vi.fn(),
}));
vi.mock("../mcp-client/prompt-bridge.js", () => ({
  createPromptBridge: vi.fn(),
}));

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);
const mockCreateResourceBridge = vi.mocked(createResourceBridge);
const mockCreatePromptBridge = vi.mocked(createPromptBridge);

function stubManager() {
  const setCallObserver = vi.fn();
  return {
    manager: { setCallObserver } as unknown as MCPManager,
    setCallObserver,
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
    session: { emit, nextInternalSubId } as unknown as Session,
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
    const { manager, setCallObserver } = stubManager();
    const { session } = stubSession();

    attachMcpManagerToSession(manager, session);

    expect(setCallObserver).toHaveBeenCalledOnce();
    const observer = setCallObserver.mock.calls[0]![0]!;
    expect(typeof observer.onBegin).toBe("function");
    expect(typeof observer.onEnd).toBe("function");
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
