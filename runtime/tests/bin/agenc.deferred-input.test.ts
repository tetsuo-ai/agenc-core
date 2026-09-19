import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __createDeferredDaemonPromptTuiSessionForTest,
  __wrapDaemonTuiSessionWithPromptPreparationForTest,
  sessionConfigurationFromAgenCConfig,
} from "./agenc-main.js";
import { ConfigStore } from "../config/store.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { DaemonEventReplayGapError } from "../../src/tui/daemon-event-replay.js";
import type {
  SessionSubmitOptions,
} from "../session/autonomous-mode.js";
import type {
  IdleInputAdmission,
  IdleInputOwnership,
  McpManager,
  McpSurfaceSnapshot,
} from "../session/session.js";
import type {
  SessionShellExecuteResult,
} from "../app-server/protocol/index.js";

interface DeferredInputSession {
  readonly services: {
    readonly mcpManager: McpManager;
  };
  subscribeToEvents(cb: (event: unknown) => void): () => void;
  submit(message: string, opts?: SessionSubmitOptions): Promise<void>;
  enqueueIdleInput(input: unknown, ownership?: IdleInputOwnership): number;
  enqueueIdleInputBatch(
    inputs: readonly unknown[],
    ownership?: IdleInputOwnership,
  ): number;
  enqueueIdleInputBatchOwned(
    inputs: readonly unknown[],
    ownership?: IdleInputOwnership,
  ): IdleInputAdmission;
  rollbackIdleInputAdmission(token: string): boolean;
  commitIdleInputAdmission(token: string): boolean;
  applyDaemonConfig(params: {
    readonly profile?: string;
    readonly reload?: boolean;
  }): Promise<{
    readonly sessionId: string;
    readonly applied: boolean;
    readonly summary: string;
  }>;
  executeShellCommand(params: {
    readonly command: string;
    readonly commandId: string;
    readonly signal?: AbortSignal;
  }): Promise<SessionShellExecuteResult>;
  mcpSurfaceSnapshot(): McpSurfaceSnapshot;
  refreshMcpSurface(): Promise<McpSurfaceSnapshot>;
  subscribeToMcpSurface(
    cb: (snapshot: McpSurfaceSnapshot) => void,
  ): () => void;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createDeferredInputSession(
  options: {
    readonly baseSession?: unknown;
    readonly configStore?: ConfigStore;
    readonly deps?: unknown;
    readonly preparePrompt?: (
      params: Readonly<{ message: string }>,
    ) => Promise<string | null>;
  } = {},
): Promise<DeferredInputSession> {
  const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
    baseSession: withConfigStore(options.baseSession, options.configStore),
    deps: (options.deps ?? {}) as never,
    agencHome: process.cwd(),
    env: {},
    cwd: process.cwd(),
    clientId: "deferred-input-test",
    ...(options.preparePrompt !== undefined
      ? { preparePrompt: options.preparePrompt }
      : {}),
  });
  cleanups.push(deferred.close);
  return deferred.session as DeferredInputSession;
}

function withConfigStore(
  baseSession: unknown = {},
  configStore = new ConfigStore({ env: {} }),
): Record<string, unknown> {
  const base =
    typeof baseSession === "object" && baseSession !== null
      ? (baseSession as Record<string, unknown>)
      : {};
  const services =
    typeof base.services === "object" && base.services !== null
      ? (base.services as Record<string, unknown>)
      : {};
  const existingSessionConfiguration =
    typeof base.sessionConfiguration === "object" &&
    base.sessionConfiguration !== null
      ? (base.sessionConfiguration as Record<string, unknown>)
      : {};
  const workspaceRoot =
    typeof existingSessionConfiguration.cwd === "string"
      ? existingSessionConfiguration.cwd
      : process.cwd();
  const config = configStore.current();
  return {
    ...base,
    sessionConfiguration: {
      ...sessionConfigurationFromAgenCConfig({
        config,
        workspaceRoot,
        model: config.model,
      }),
      ...existingSessionConfiguration,
    },
    services: {
      permissionModeRegistry: new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      ),
      ...services,
      configStore,
    },
  };
}

function queuedText(text: string): {
  readonly role: "user";
  readonly content: string;
} {
  return { role: "user", content: text };
}

function daemonRuntimeSettings() {
  return {
    permissionMode: "default" as const,
    prePlanMode: null,
    autoModeActive: false,
    autoModeAvailable: true,
    bypassPermissionsModeAvailable: false,
    bypassPermissionsWorkspace: null,
    bypassPermissionsConsentWorkspace: null,
    model: "grok-4.5",
    provider: "grok",
    profile: null,
    reasoningEffort: null,
    modelVerbosity: null,
    serviceTier: null,
    hooksDisabled: false,
  };
}

function daemonHarness(
  options: {
    readonly rejectFirstAttach?: boolean;
    readonly rejectMessageStream?: boolean;
    readonly rejectShellExecute?: boolean;
    readonly withMcpSurface?: boolean;
    readonly initialSessionEvent?: unknown;
  } = {},
) {
  let attachAttempts = 0;
  let mcpRevision = 1;
  const mcpServers: Array<{
    readonly name: string;
    readonly transport: "stdio";
    readonly enabled: boolean;
    readonly required: boolean;
    readonly state: "connected";
    readonly displayTarget: string;
    readonly toolCount: number;
  }> = options.withMcpSurface === true
    ? [
        {
          name: "alpha",
          transport: "stdio",
          enabled: true,
          required: false,
          state: "connected",
          displayTarget: "alpha-server",
          toolCount: 1,
        },
      ]
    : [];
  const mcpTools: Array<{
    readonly serverName: string;
    readonly name: string;
  }> = options.withMcpSurface === true
    ? [
        {
          serverName: "alpha",
          name: "mcp.alpha.read",
        },
      ]
    : [];
  const requests: Array<{
    readonly method: string;
    readonly params: Record<string, unknown> | undefined;
  }> = [];
  const client = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "agent.attach") {
        attachAttempts += 1;
        if (options.rejectFirstAttach === true && attachAttempts === 1) {
          throw new Error("intentional attach rejection");
        }
        const agentId =
          typeof params?.agentId === "string" ? params.agentId : "agent-1";
        return {
          agentId,
          attachmentId: `attachment-${attachAttempts}`,
          sessionIds: [`session-${attachAttempts}`],
          runtimeSessionId: agentId,
          runtimeSettings: daemonRuntimeSettings(),
          runtimeSettingsEventId: `settings-${attachAttempts}`,
        };
      }
      if (method === "message.stream") {
        if (options.rejectMessageStream === true) {
          throw new Error(
            "AgenC daemon session not found or closed: session-1",
          );
        }
        return {};
      }
      if (method === "session.shell.execute") {
        if (options.rejectShellExecute === true) {
          throw Object.assign(new Error("shell outcome is ambiguous"), {
            code: "AGENT_NOT_FOUND",
          });
        }
        return {
          commandId: String(params?.commandId),
          content: "deferred shell output",
          stdout: "deferred shell output",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
          isError: false,
        };
      }
      if (method === "agent.stop") {
        return {
          agentId:
            typeof params?.agentId === "string" ? params.agentId : "agent-1",
          stopped: true,
        };
      }
      if (method === "daemon.reload") {
        return { reloaded: true };
      }
      if (method === "session.mcp.status") {
        return {
          sessionId: String(params?.sessionId ?? "session-1"),
          revision: mcpRevision,
          servers: mcpServers,
          tools: mcpTools,
        };
      }
      if (method === "session.mcp.addServer") {
        const config = params?.config as
          | { readonly name?: unknown; readonly command?: unknown }
          | undefined;
        const serverName =
          typeof config?.name === "string" ? config.name : "added";
        mcpRevision += 1;
        mcpServers.push({
          name: serverName,
          transport: "stdio",
          enabled: true,
          required: false,
          state: "connected",
          displayTarget:
            typeof config?.command === "string" ? config.command : "node",
          toolCount: 1,
        });
        mcpTools.push({
          serverName,
          name: `mcp.${serverName}.ping`,
        });
        return {
          sessionId: String(params?.sessionId ?? "session-1"),
          serverName,
          success: true,
          toolCount: 1,
        };
      }
      return {};
    }),
    subscribeToSessionEvents: vi.fn(
      (_sessionId: string, cb: (event: never) => void) => {
        if (options.initialSessionEvent !== undefined) {
          cb(options.initialSessionEvent as never);
        }
        return () => undefined;
      },
    ),
    subscribeToConnectionState: vi.fn(() => () => undefined),
    getConnectionState: vi.fn(() => ({ status: "connected" as const })),
    close: vi.fn(async () => undefined),
  };
  let nextAgent = 0;
  const startPromptAgent = vi.fn(async (_params: unknown) => {
    nextAgent += 1;
    return { agentId: `agent-${nextAgent}` };
  });
  return {
    baseSession: {
      activeTurn: { unsafePeek: () => null },
      conversationId: "deferred-input-base",
      services: {},
      sessionConfiguration: { cwd: process.cwd() },
    },
    client,
    deps: {
      startPromptAgent,
      stopPromptAgent: vi.fn(async () => undefined),
      createConnectedTuiClient: vi.fn(async () => client),
    },
    requests,
    startPromptAgent,
  };
}

describe("deferred daemon input ownership", () => {
  it("keeps cold status-line rendering unavailable without creating an agent or control client", async () => {
    const harness = daemonHarness();
    const session = await createDeferredInputSession({ baseSession: harness.baseSession, deps: harness.deps });
    const statusSession = session as typeof session & Pick<
      import("../../src/tui/daemon-session.js").AgenCTuiBridgeSession, "executeDaemonStatusLine"
    >;
    await expect(statusSession.executeDaemonStatusLine?.({})).resolves.toEqual({
      status: "unavailable", reason: "session_not_ready",
    });
    expect(harness.startPromptAgent).not.toHaveBeenCalled();
    expect(harness.deps.createConnectedTuiClient).not.toHaveBeenCalled();
    expect(harness.requests).toHaveLength(0);
  });

  it("reports the live daemon session id once the first turn activates it", async () => {
    // `/status` reads `session.conversationId` off this outer wrapper. It used
    // to keep the synthetic idle placeholder for the life of the TUI, so the
    // dashboard said "(idle — assigned when you send your first message)"
    // after dozens of turns.
    const harness = daemonHarness();
    const session = await createDeferredInputSession({ baseSession: harness.baseSession, deps: harness.deps });
    const idSession = session as typeof session & { readonly conversationId: string };
    expect(idSession.conversationId).toBe("deferred-input-base");
    await session.submit("first turn");
    expect(idSession.conversationId).toBe("agent-1");
  });

  it("forwards status-line requests after live activation without another model turn", async () => {
    const harness = daemonHarness();
    const session = await createDeferredInputSession({ baseSession: harness.baseSession, deps: harness.deps });
    await session.submit("first turn");
    const messageRequestsBefore = harness.requests.filter(request => request.method === "message.send" || request.method === "message.stream").length;
    const statusSession = session as typeof session & Pick<
      import("../../src/tui/daemon-session.js").AgenCTuiBridgeSession, "executeDaemonStatusLine"
    >;
    const controller = new AbortController();
    await statusSession.executeDaemonStatusLine?.({}, controller.signal);
    expect(harness.client.request).toHaveBeenLastCalledWith("session.statusLine.execute", {
      sessionId: "session-1", presentation: {},
    }, { signal: controller.signal });
    expect(harness.startPromptAgent).toHaveBeenCalledOnce();
    expect(harness.requests.filter(request => request.method === "message.send" || request.method === "message.stream")).toHaveLength(messageRequestsBefore);
  });

  it.each([
    {
      decision: { kind: "approved" },
      method: "tool.approve",
      outcome: { scope: "once" },
    },
    {
      decision: { kind: "denied" },
      method: "tool.deny",
      outcome: { reason: "denied" },
    },
  ] as const)(
    "bridges an immediate permission request through $method",
    async ({ decision, method, outcome }) => {
      const harness = daemonHarness({
        initialSessionEvent: {
          jsonrpc: "2.0",
          method: "event.permission_request",
          params: {
            sessionId: "session-1",
            eventId: "call-1",
            requestId: "call-1",
            toolName: "Bash",
            turnId: "turn-1",
            permissions: ["tool.use"],
            input: { command: "pwd" },
          },
        },
      });
      const session = await createDeferredInputSession({
        baseSession: harness.baseSession,
        deps: harness.deps,
      });
      const resolver = {
        request: vi.fn(async () => decision),
      };
      (
        session.services as unknown as {
          approvalResolver?: typeof resolver;
        }
      ).approvalResolver = resolver;

      await session.submit("check permissions");

      await vi.waitFor(() => {
        expect(resolver.request).toHaveBeenCalledTimes(1);
        expect(harness.requests).toContainEqual({
          method,
          params: {
            sessionId: "session-1",
            requestId: "call-1",
            ...outcome,
          },
        });
      });
      const unsubscribe = session.subscribeToEvents(() => undefined);
      await Promise.resolve();
      expect(resolver.request).toHaveBeenCalledTimes(1);
      unsubscribe();
    },
  );

  it("replaces bootstrap MCP authority with an inert pre-attach facade", async () => {
    const harness = daemonHarness();
    const inheritedAdd = vi.fn(async (config: { readonly name: string }) => ({
      serverName: config.name,
      success: true,
      toolCount: 99,
    }));
    const inheritedManager = {
      effectiveServers: vi.fn(async () => new Map()),
      toolPluginProvenance: vi.fn(async () => undefined),
      addServer: inheritedAdd,
    } satisfies McpManager;
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore({
        ...harness.baseSession,
        services: { mcpManager: inheritedManager },
      }),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-mcp-cold-test",
    });
    cleanups.push(deferred.close);
    const session = deferred.session as DeferredInputSession;

    expect(session.services.mcpManager).not.toBe(inheritedManager);
    expect("listMcpClients" in session).toBe(false);
    expect("listMcpTools" in session).toBe(false);
    expect(session.mcpSurfaceSnapshot()).toEqual({
      revision: 0,
      servers: [],
      tools: [],
    });
    await expect(session.refreshMcpSurface()).resolves.toEqual({
      revision: 0,
      servers: [],
      tools: [],
    });
    await expect(
      session.services.mcpManager.effectiveServers({}, undefined),
    ).rejects.toThrow(/no live daemon session/i);
    await expect(
      session.services.mcpManager.addServer?.({
        name: "cold",
        transport: "stdio",
        command: "node",
      }),
    ).rejects.toThrow(/no live daemon session/i);
    await expect(
      session.services.mcpManager.refreshFromAuthority?.(),
    ).rejects.toThrow(/no live daemon session/i);
    expect(inheritedManager.effectiveServers).not.toHaveBeenCalled();
    expect(inheritedAdd).not.toHaveBeenCalled();
    expect(harness.startPromptAgent).not.toHaveBeenCalled();
  });

  it("forwards MCP reads, mutations, and surface subscriptions after attach", async () => {
    const harness = daemonHarness({ withMcpSurface: true });
    const inheritedAdd = vi.fn(async (config: { readonly name: string }) => ({
      serverName: config.name,
      success: true,
      toolCount: 99,
    }));
    const inheritedManager = {
      effectiveServers: vi.fn(async () => new Map()),
      toolPluginProvenance: vi.fn(async () => undefined),
      addServer: inheritedAdd,
    } satisfies McpManager;
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore({
        ...harness.baseSession,
        services: { mcpManager: inheritedManager },
      }),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-mcp-live-test",
      preparePrompt: async ({ message }) => message,
    });
    cleanups.push(deferred.close);
    const session = deferred.session as DeferredInputSession;
    const observedRevisions: number[] = [];
    const unsubscribe = session.subscribeToMcpSurface((snapshot) => {
      observedRevisions.push(snapshot.revision);
    });

    await session.submit("start daemon MCP authority");
    await vi.waitFor(() => {
      expect(session.mcpSurfaceSnapshot()).toMatchObject({
        revision: 1,
        servers: [expect.objectContaining({ name: "alpha" })],
        tools: [expect.objectContaining({ name: "mcp.alpha.read" })],
      });
      expect(observedRevisions).toContain(1);
    });
    const effectiveServers =
      await session.services.mcpManager.effectiveServers({}, undefined);
    expect([...effectiveServers.keys()]).toEqual(["alpha"]);
    await expect(
      session.services.mcpManager.addServer?.({
        name: "beta",
        transport: "stdio",
        command: "beta-server",
        enabled: true,
      }),
    ).resolves.toEqual({
      serverName: "beta",
      success: true,
      toolCount: 1,
    });

    expect("listMcpClients" in session).toBe(false);
    expect("listMcpTools" in session).toBe(false);
    expect(session.mcpSurfaceSnapshot()).toMatchObject({
      revision: 2,
      servers: expect.arrayContaining([
        expect.objectContaining({ name: "alpha" }),
        expect.objectContaining({ name: "beta" }),
      ]),
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "mcp.alpha.read" }),
        expect.objectContaining({ name: "mcp.beta.ping" }),
      ]),
    });
    expect(observedRevisions).toContain(2);
    expect(harness.requests).toContainEqual({
      method: "session.mcp.addServer",
      params: {
        sessionId: "session-1",
        config: {
          name: "beta",
          transport: "stdio",
          command: "beta-server",
          enabled: true,
        },
      },
    });
    expect(inheritedAdd).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("reloads daemon-global config before the first turn without starting an agent", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-editor-consent-test",
    });
    const session = deferred.session as DeferredInputSession;

    await expect(
      session.applyDaemonConfig({ reload: true }),
    ).resolves.toMatchObject({
      sessionId: "pending",
      applied: false,
      summary: expect.stringMatching(/next|future|first conversation/i),
    });
    expect(harness.requests).toEqual([{ method: "daemon.reload", params: {} }]);
    expect(harness.startPromptAgent).not.toHaveBeenCalled();

    await deferred.close();
    expect(harness.client.close).toHaveBeenCalledOnce();
  });

  it("stops and closes a daemon agent whose live connection resolves during teardown", async () => {
    const client = {
      request: vi.fn(
        async (method: string, params?: Record<string, unknown>) => {
          if (method === "agent.stop") {
            return {
              agentId: String(params?.agentId ?? "agent-closing"),
              stopped: true,
            };
          }
          if (method === "agent.attach") {
            throw new Error("attach must not run after deferred close");
          }
          return {};
        },
      ),
      subscribeToSessionEvents: vi.fn(() => () => undefined),
      subscribeToNotifications: vi.fn(() => () => undefined),
      subscribeToConnectionState: vi.fn(() => () => undefined),
      getConnectionState: vi.fn(() => ({ status: "connected" as const })),
      close: vi.fn(async () => undefined),
    };
    let resolveConnection!: (value: typeof client) => void;
    const connection = new Promise<typeof client>((resolve) => {
      resolveConnection = resolve;
    });
    const startPromptAgent = vi.fn(async () => ({
      agentId: "agent-closing",
    }));
    const createConnectedTuiClient = vi.fn(() => connection);
    const stopPromptAgent = vi.fn(async () => undefined);
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(),
      deps: {
        startPromptAgent,
        stopPromptAgent,
        createConnectedTuiClient,
      } as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-live-close-race-test",
      preparePrompt: async ({ message }) => message,
    });
    const session = deferred.session as DeferredInputSession;
    const submitting = session.submit("start while closing");
    await vi.waitFor(() =>
      expect(createConnectedTuiClient).toHaveBeenCalledOnce(),
    );

    const closing = deferred.close();
    resolveConnection(client);

    await expect(submitting).rejects.toThrow("already closed");
    await closing;
    await expect(session.submit("late submit")).rejects.toThrow(
      "already closed",
    );
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("agent.stop", {
      agentId: "agent-closing",
      reason: "tui_startup_failed",
    });
    expect(client.close).toHaveBeenCalledOnce();
    expect(stopPromptAgent).not.toHaveBeenCalled();
  });

  it("runs a cold shell command once without consuming the first Agent turn", async () => {
    const harness = daemonHarness();
    const session = await createDeferredInputSession({
      baseSession: harness.baseSession,
      deps: harness.deps,
    });

    await expect(
      session.executeShellCommand({
        command: "printf deferred-shell",
        commandId: "deferred-shell-1",
      }),
    ).resolves.toMatchObject({
      commandId: "deferred-shell-1",
      stdout: "deferred shell output",
      exitCode: 0,
      isError: false,
    });

    expect(harness.startPromptAgent).toHaveBeenCalledOnce();
    expect(harness.startPromptAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "AgenC Editor workspace",
        deferInitialTurn: true,
      }),
    );
    expect(harness.startPromptAgent.mock.calls[0]?.[0]).not.toHaveProperty(
      "initialContent",
    );
    expect(
      harness.requests.filter(
        ({ method }) => method === "session.shell.execute",
      ),
    ).toEqual([
      {
        method: "session.shell.execute",
        params: {
          sessionId: "session-1",
          commandId: "deferred-shell-1",
          command: "printf deferred-shell",
        },
      },
    ]);

    await session.submit("first Agent turn after shell");
    expect(harness.startPromptAgent).toHaveBeenCalledOnce();
    expect(harness.requests).toContainEqual({
      method: "message.stream",
      params: expect.objectContaining({
        sessionId: "session-1",
        content: "first Agent turn after shell",
      }),
    });
  });

  it("never replays an ambiguous deferred shell request", async () => {
    const harness = daemonHarness({ rejectShellExecute: true });
    const session = await createDeferredInputSession({
      baseSession: harness.baseSession,
      deps: harness.deps,
    });

    await expect(
      session.executeShellCommand({
        command: "touch side-effect",
        commandId: "ambiguous-shell-1",
      }),
    ).rejects.toThrow("shell outcome is ambiguous");

    expect(harness.startPromptAgent).toHaveBeenCalledOnce();
    expect(
      harness.requests.filter(
        ({ method }) => method === "session.shell.execute",
      ),
    ).toHaveLength(1);

    await session.submit("first Agent turn after ambiguous shell");
    expect(harness.startPromptAgent).toHaveBeenCalledOnce();
    expect(harness.requests).toContainEqual({
      method: "message.stream",
      params: expect.objectContaining({
        sessionId: "session-1",
        content: "first Agent turn after ambiguous shell",
      }),
    });
  });

  it("bounds queued records atomically and rolls back only the owned batch", async () => {
    const session = await createDeferredInputSession();
    const first = session.enqueueIdleInputBatchOwned([queuedText("first")]);
    const remainder = session.enqueueIdleInputBatchOwned(
      Array.from({ length: 511 }, (_, index) =>
        queuedText(`remainder-${index}`),
      ),
    );

    expect(() =>
      session.enqueueIdleInputBatchOwned([queuedText("overflow")]),
    ).toThrow("Session mailbox is full");
    expect(session.rollbackIdleInputAdmission(first.token)).toBe(true);

    const replacement = session.enqueueIdleInputBatchOwned([
      queuedText("replacement"),
    ]);
    expect(() =>
      session.enqueueIdleInputBatchOwned([queuedText("still-full")]),
    ).toThrow("Session mailbox is full");
    expect(session.commitIdleInputAdmission(remainder.token)).toBe(true);
    expect(session.commitIdleInputAdmission(replacement.token)).toBe(true);
  });

  it("rejects an oversized batch without advancing admission state", async () => {
    const session = await createDeferredInputSession();
    const oversized = "x".repeat(16 * 1_024 * 1_024);

    expect(() =>
      session.enqueueIdleInputBatchOwned([queuedText(oversized)]),
    ).toThrow("Session mailbox is full");

    const accepted = session.enqueueIdleInputBatchOwned([
      queuedText("accepted"),
    ]);
    expect(accepted).toMatchObject({
      firstSequence: 1,
      lastSequence: 1,
      count: 1,
    });
    expect(session.rollbackIdleInputAdmission(accepted.token)).toBe(true);
  });

  it("rejects a blocked first prompt so its owned context can roll back", async () => {
    const session = await createDeferredInputSession({
      preparePrompt: async () => null,
    });
    const admission = session.enqueueIdleInputBatchOwned([
      queuedText("owned attachment"),
    ]);

    await expect(session.submit("blocked prompt")).rejects.toThrow(
      "pending input was not consumed",
    );
    expect(session.rollbackIdleInputAdmission(admission.token)).toBe(true);
  });

  it("rejects a blocked live prompt instead of resolving without submission", async () => {
    const submit = vi.fn(async () => undefined);
    const wrapped = __wrapDaemonTuiSessionWithPromptPreparationForTest(
      withConfigStore({ submit }),
      {
        agencHome: process.cwd(),
        cwd: process.cwd(),
        env: {},
        stderr: process.stderr,
        preparePrompt: async () => null,
      },
    );

    await expect(wrapped.submit?.("blocked prompt")).rejects.toThrow(
      "pending input was not consumed",
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("serializes prompt preparation before admitting any later context", async () => {
    let releasePreparation!: () => void;
    const preparationReleased = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let markPreparationEntered!: () => void;
    const preparationEntered = new Promise<void>((resolve) => {
      markPreparationEntered = resolve;
    });
    const startPromptAgent = vi.fn(async (_params: unknown) => {
      throw new Error("intentional startup stop");
    });
    const session = await createDeferredInputSession({
      deps: { startPromptAgent },
      preparePrompt: async ({ message }) => {
        markPreparationEntered();
        await preparationReleased;
        return message;
      },
    });
    const first = session.enqueueIdleInputBatchOwned([
      queuedText("admitted before preparation"),
    ]);
    const submission = session.submit("first prompt");

    await preparationEntered;
    expect(() =>
      session.enqueueIdleInputBatchOwned([
        queuedText("must not join in-flight startup"),
      ]),
    ).toThrow("Deferred session startup is in progress");
    releasePreparation();
    await expect(submission).rejects.toThrow("intentional startup stop");

    expect(startPromptAgent).toHaveBeenCalledTimes(1);
    expect(startPromptAgent.mock.calls[0]?.[0]).toMatchObject({
      initialContent: [
        { type: "text", text: "admitted before preparation" },
        { type: "text", text: "first prompt" },
      ],
    });
    expect(session.rollbackIdleInputAdmission(first.token)).toBe(true);
  });

  it("rolls back exact pre-start context after attach failure and excludes it from retry", async () => {
    const harness = daemonHarness({ rejectFirstAttach: true });
    const session = await createDeferredInputSession({
      baseSession: harness.baseSession,
      deps: harness.deps,
    });
    const admission = session.enqueueIdleInputBatchOwned([
      queuedText("stale attachment"),
    ]);

    await expect(session.submit("first prompt")).rejects.toThrow(
      "intentional attach rejection",
    );
    expect(session.rollbackIdleInputAdmission(admission.token)).toBe(true);

    await session.submit("retry prompt");
    expect(harness.startPromptAgent).toHaveBeenCalledTimes(2);
    expect(harness.startPromptAgent.mock.calls[0]?.[0]).toMatchObject({
      initialContent: [
        { type: "text", text: "stale attachment" },
        { type: "text", text: "first prompt" },
      ],
    });
    expect(harness.startPromptAgent.mock.calls[1]?.[0]).toMatchObject({
      initialContent: "retry prompt",
    });
  });

  it("binds live proxy tokens to their origin and never retries text alone after daemon loss", async () => {
    const harness = daemonHarness({ rejectMessageStream: true });
    const session = await createDeferredInputSession({
      baseSession: harness.baseSession,
      deps: harness.deps,
    });
    await session.submit("initial prompt");

    const admission = session.enqueueIdleInputBatchOwned([
      queuedText("live attachment"),
    ]);
    expect(admission.token).toMatch(/^deferred-live:/);
    expect(() =>
      session.enqueueIdleInputBatchOwned([queuedText("second live bundle")]),
    ).toThrow("already pending");

    await expect(session.submit("follow-up prompt")).rejects.toThrow(
      "session not found or closed",
    );
    expect(harness.startPromptAgent).toHaveBeenCalledTimes(1);
    const streamRequest = harness.requests.find(
      ({ method }) => method === "message.stream",
    );
    expect(streamRequest?.params).toMatchObject({
      content: [
        { type: "text", text: "live attachment" },
        { type: "text", text: "follow-up prompt" },
      ],
    });
    expect(session.rollbackIdleInputAdmission(admission.token)).toBe(true);

    const afterRollback = session.enqueueIdleInputBatchOwned([
      queuedText("new-session attachment"),
    ]);
    expect(session.rollbackIdleInputAdmission(afterRollback.token)).toBe(true);
  });
});
