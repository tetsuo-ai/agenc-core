import { describe, expect, it } from "vitest";

import {
  createDaemonTuiSession,
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "../../src/tui/daemon-session.js";
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

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("daemon-backed /model switch surfaces the daemon's authoritative outcome", () => {
  it("surfaces a provider_switch_rejected warning when the daemon REJECTS the switch", async () => {
    // GAP #2: setPendingProviderSwitch previously fired session.setModel
    // fire-and-forget and swallowed SessionSetModelResult.applied, so a
    // daemon rejection (history-incompat / staged-turn) was hidden behind
    // the command's optimistic "Model switched" line. The daemon is the
    // authority: when it reports applied=false the rejection must reach
    // the user.
    const client = createClient();
    client.results.set("session.setModel", {
      sessionId: "session_1",
      applied: false,
      summary:
        "Model switch to \"opus\" blocked: history incompatible with target model",
    });
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const received: JsonObject[] = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });

    session.setPendingProviderSwitch?.({ provider: "anthropic", model: "opus" });
    await flush();
    unsubscribe();

    // The RPC was awaited (forwarded), and the daemon's rejection summary
    // reached the transcript as an allow-listed, user-visible warning.
    expect(
      client.requests.some((r) => r.method === "session.setModel"),
    ).toBe(true);
    const rejection = received.find(
      (event) =>
        (event as { type?: unknown }).type === "warning" &&
        (event as { payload?: { cause?: unknown } }).payload?.cause ===
          "provider_switch_rejected",
    );
    expect(rejection).toBeDefined();
    expect(
      (rejection as { payload: { message: string } }).payload.message,
    ).toContain("history incompatible");
  });

  it("does NOT surface a rejection warning when the daemon APPLIES the switch", async () => {
    const client = createClient();
    client.results.set("session.setModel", {
      sessionId: "session_1",
      applied: true,
      summary: "Model switched to \"opus\" on \"anthropic\".",
    });
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const received: JsonObject[] = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });

    session.setPendingProviderSwitch?.({ provider: "anthropic", model: "opus" });
    await flush();
    unsubscribe();

    const rejection = received.find(
      (event) =>
        (event as { payload?: { cause?: unknown } }).payload?.cause ===
        "provider_switch_rejected",
    );
    expect(rejection).toBeUndefined();
  });

  it("stays responsive: a disconnected daemon socket is swallowed, not thrown", async () => {
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

    // Synchronous void mutator must not throw even though the round-trip
    // rejects; the next snapshot / turn surfaces the disconnection.
    expect(() =>
      session.setPendingProviderSwitch?.({
        provider: "anthropic",
        model: "opus",
      }),
    ).not.toThrow();
    await flush();
  });
});

describe("daemon-mirrored MCP addServer reports the daemon's outcome, not the mirror's", () => {
  it("does NOT report failure when the daemon add succeeded but the local mirror failed", async () => {
    // GAP #13b: the daemon owns the REAL MCP connection. A failure of the
    // best-effort local mirror must not be reported as the overall result
    // when the daemon already added the server.
    const client = createClient();
    client.results.set("session.mcp.addServer", {
      sessionId: "session_1",
      serverName: "audit-ping",
      success: true,
      toolCount: 3,
    });
    const baseSession = createBaseSession();
    let localAddCalled = false;
    baseSession.services.mcpManager = {
      addServer: async () => {
        localAddCalled = true;
        // Local mirror fails for a reason unrelated to "already
        // configured" — e.g. the client-side projection can't spawn the
        // stdio child. The daemon connection is nonetheless live.
        return {
          serverName: "audit-ping",
          success: false,
          error: "spawn ENOENT (local mirror cannot launch child)",
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

    expect(localAddCalled).toBe(true);
    // Authoritative daemon outcome, NOT the local mirror's failure.
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

    // Daemon add failed: do not even touch the local mirror, and report
    // the daemon failure.
    expect(localAddCalled).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toBe("daemon refused: duplicate name");
  });
});
