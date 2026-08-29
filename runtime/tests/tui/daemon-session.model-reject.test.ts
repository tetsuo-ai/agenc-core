import { describe, expect, it } from "vitest";

import {
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "../../src/tui/daemon-session.js";
import { createDaemonTuiSessionFixture as createDaemonTuiSession } from "../helpers/daemon-tui-session.js";
import type {
  AgenCDaemonInternalMethod,
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  SessionPartialCompactFromMessageResult,
  SessionRewindConversationToMessageResult,
} from "../../src/app-server/protocol/index.js";

function createBaseSession(): AgenCTuiBridgeSession {
  return {
    conversationId: "local_session",
    sessionConfiguration: {
      provider: { slug: "grok" },
      collaborationMode: { model: "grok-4.5" },
    },
    services: {
      permissionModeRegistry: {
        current: () =>
          ({
            mode: "default",
            plan: null,
            network: null,
          }) as never,
      },
    },
  };
}

interface FakeClient extends AgenCDaemonTuiClient {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod | AgenCDaemonInternalMethod;
    readonly params?: JsonObject;
  }>;
  /** Per-method canned results keyed by method name. */
  results: Map<string, JsonObject>;
  connectionState: AgenCDaemonConnectionState | null;
  emit(sessionId: string, event: JsonObject): void;
}

function createClient(): FakeClient {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  const requests: FakeClient["requests"] = [];
  const results = new Map<string, JsonObject>();
  return {
    requests,
    results,
    connectionState: null,
    async request(
      method: AgenCDaemonMethod | AgenCDaemonInternalMethod,
      params?: JsonObject,
    ): Promise<
      | AgenCDaemonResultByMethod[AgenCDaemonMethod]
      | SessionPartialCompactFromMessageResult
      | SessionRewindConversationToMessageResult
    > {
      requests.push({ method, ...(params !== undefined ? { params } : {}) });
      const canned = results.get(method);
      if (canned !== undefined) {
        return canned as AgenCDaemonResultByMethod[AgenCDaemonMethod];
      }
      return {} as AgenCDaemonResultByMethod[AgenCDaemonMethod];
    },
    subscribeToSessionEvents: (sessionId, cb) => {
      let sessionListeners = listeners.get(sessionId);
      if (sessionListeners === undefined) {
        sessionListeners = new Set();
        listeners.set(sessionId, sessionListeners);
      }
      sessionListeners.add(cb);
      return () => {
        sessionListeners?.delete(cb);
      };
    },
    getConnectionState() {
      return this.connectionState;
    },
    emit: (sessionId, event) => {
      for (const listener of listeners.get(sessionId) ?? []) {
        listener(event);
      }
    },
  };
}

describe("daemon-backed /model switch surfaces the daemon's authoritative outcome", () => {
  it("returns a daemon rejection directly instead of optimistic success", async () => {
    const client = createClient();
    client.results.set("session.setModel", {
      sessionId: "session_1",
      applied: false,
      provider: "grok",
      model: "grok-4.5",
      runtimeSettingsEventId: "test-runtime-settings:initial",
      summary:
        "Model switch to \"opus\" blocked: history incompatible with target model",
    });
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const result = await session.applyProviderModelSelection?.({
      provider: "anthropic",
      model: "opus",
    });

    expect(result).toMatchObject({
      applied: false,
      provider: "grok",
      model: "grok-4.5",
      summary: expect.stringContaining("history incompatible"),
    });
    expect(client.requests.filter((r) => r.method === "session.setModel"))
      .toHaveLength(1);
  });

  it("rejects a disconnected daemon mutation and never reports success", async () => {
    const client = createClient();
    client.request = async (method, params) => {
      client.requests.push({ method, ...(params !== undefined ? { params } : {}) });
      if (method === "session.setModel") {
        throw new Error("daemon disconnected");
      }
      return {} as never;
    };
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await expect(
      session.applyProviderModelSelection?.({
        provider: "anthropic",
        model: "opus",
      }),
    ).rejects.toThrow("daemon disconnected");
  });
});

describe("daemon-owned MCP addServer has no local connection mirror", () => {
  it("reports daemon success without invoking an inherited local manager", async () => {
    const client = createClient();
    client.results.set("session.mcp.addServer", {
      sessionId: "session_1",
      serverName: "audit-ping",
      success: true,
      toolCount: 3,
    });
    client.results.set("session.mcp.status", {
      sessionId: "session_1",
      revision: 1,
      servers: [],
      tools: [],
    });
    const baseSession = createBaseSession();
    let localAddCalled = false;
    baseSession.services.mcpManager = {
      addServer: async () => {
        localAddCalled = true;
        return {
          serverName: "audit-ping",
          success: false,
          error: "inherited manager must not be invoked",
        };
      },
    };

    const session = createDaemonTuiSession({
      baseSession,
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const result = await (
      session.services.mcpManager as {
        addServer(config: unknown): Promise<{
          success: boolean;
          serverName: string;
          toolCount?: number;
          error?: string;
        }>;
      }
    ).addServer({
      name: "audit-ping",
      transport: "stdio",
      command: "node",
      args: ["/tmp/audit-ping.mjs"],
    });

    expect(localAddCalled).toBe(false);
    expect(result.success).toBe(true);
    expect(result.serverName).toBe("audit-ping");
    expect(result.toolCount).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it("reports the daemon's failure when the daemon add itself failed", async () => {
    const client = createClient();
    client.results.set("session.mcp.addServer", {
      sessionId: "session_1",
      serverName: "audit-ping",
      success: false,
      error: "daemon refused: duplicate name",
    });
    client.results.set("session.mcp.status", {
      sessionId: "session_1",
      revision: 1,
      servers: [],
      tools: [],
    });
    let localAddCalled = false;
    const baseSession = createBaseSession();
    baseSession.services.mcpManager = {
      addServer: async () => {
        localAddCalled = true;
        return { serverName: "audit-ping", success: true, toolCount: 1 };
      },
    };

    const session = createDaemonTuiSession({
      baseSession,
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const result = await (
      session.services.mcpManager as {
        addServer(config: unknown): Promise<{
          success: boolean;
          error?: string;
        }>;
      }
    ).addServer({
      name: "audit-ping",
      transport: "stdio",
      command: "node",
      args: ["/tmp/audit-ping.mjs"],
    });

    expect(localAddCalled).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toBe("daemon refused: duplicate name");
  });
});
