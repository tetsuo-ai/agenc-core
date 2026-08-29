import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __createDeferredDaemonPromptTuiSessionForTest,
  __wrapDaemonTuiSessionWithPromptPreparationForTest,
  sessionConfigurationFromAgenCConfig,
} from "./agenc-main.js";
import { ConfigStore } from "../config/store.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type {
  SessionEditorInteraction,
  SessionSubmitOptions,
} from "../session/autonomous-mode.js";
import type {
  IdleInputAdmission,
  IdleInputOwnership,
  McpManager,
  McpSurfaceSnapshot,
} from "../session/session.js";
import type {
  WorkspaceEditorAcquireParams,
  WorkspaceEditorCancelPredictionResult,
  WorkspaceEditorCancelPredictionSessionParams,
  WorkspaceEditorChangesListParams,
  WorkspaceEditorChangesListResult,
  WorkspaceEditorHeartbeatParams,
  WorkspaceEditorLeaseResult,
  WorkspaceEditorPredictSessionParams,
  WorkspaceEditorPredictionFeedbackResult,
  WorkspaceEditorPredictionFeedbackSessionParams,
  WorkspaceEditorPredictionResult,
  WorkspaceEditorProposalApplyParams,
  WorkspaceEditorProposalApplyResult,
  WorkspaceEditorProposalDiscardResult,
  WorkspaceEditorProposalParams,
  WorkspaceEditorProposalResult,
  WorkspaceEditorProposalStatusParams,
  WorkspaceEditorProposalStatusResult,
  WorkspaceEditorReleaseParams,
  WorkspaceEditorReleaseResult,
  WorkspaceEditorSyncParams,
  WorkspaceEditorSyncResult,
  WorkspaceEditorTopologyCompleteParams,
  WorkspaceEditorTopologyCompleteResult,
  WorkspaceEditorTopologyFinalizeParams,
  WorkspaceEditorTopologyReleaseResult,
  WorkspaceEditorTopologyReserveParams,
  WorkspaceEditorTopologyReserveResult,
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
  acquireWorkspaceEditor(
    params: WorkspaceEditorAcquireParams,
  ): Promise<WorkspaceEditorLeaseResult>;
  syncWorkspaceEditor(
    params: WorkspaceEditorSyncParams,
  ): Promise<WorkspaceEditorSyncResult>;
  heartbeatWorkspaceEditor(
    params: WorkspaceEditorHeartbeatParams,
  ): Promise<WorkspaceEditorLeaseResult>;
  releaseWorkspaceEditor(
    params: WorkspaceEditorReleaseParams,
  ): Promise<WorkspaceEditorReleaseResult>;
  reserveWorkspaceEditorTopology(
    params: WorkspaceEditorTopologyReserveParams,
  ): Promise<WorkspaceEditorTopologyReserveResult>;
  completeWorkspaceEditorTopology(
    params: WorkspaceEditorTopologyCompleteParams,
  ): Promise<WorkspaceEditorTopologyCompleteResult>;
  releaseWorkspaceEditorTopology(
    params: WorkspaceEditorTopologyFinalizeParams,
  ): Promise<WorkspaceEditorTopologyReleaseResult>;
  getWorkspaceEditorProposal(
    params: WorkspaceEditorProposalParams,
  ): Promise<WorkspaceEditorProposalResult>;
  getWorkspaceEditorProposalStatus(
    params: WorkspaceEditorProposalStatusParams,
  ): Promise<WorkspaceEditorProposalStatusResult>;
  applyWorkspaceEditorProposal(
    params: WorkspaceEditorProposalApplyParams,
  ): Promise<WorkspaceEditorProposalApplyResult>;
  discardWorkspaceEditorProposal(
    params: WorkspaceEditorProposalParams,
  ): Promise<WorkspaceEditorProposalDiscardResult>;
  listWorkspaceEditorChanges(
    params: WorkspaceEditorChangesListParams,
  ): Promise<WorkspaceEditorChangesListResult>;
  predictEditorCode(
    params: WorkspaceEditorPredictSessionParams,
  ): Promise<WorkspaceEditorPredictionResult>;
  cancelEditorPrediction(
    params: WorkspaceEditorCancelPredictionSessionParams,
  ): Promise<WorkspaceEditorCancelPredictionResult>;
  reportEditorPredictionFeedback(
    params: WorkspaceEditorPredictionFeedbackSessionParams,
  ): Promise<WorkspaceEditorPredictionFeedbackResult>;
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

function editorInteraction(interactionId: string): SessionEditorInteraction {
  return {
    interactionId,
    kind: "explain",
    policy: "read_only",
    editorInstanceId: "editor-lifecycle",
    bufferHandle: 12,
    changedtick: 4,
    contentSha256: "f".repeat(64),
    path: "src/lifecycle.ts",
    range: {
      start: { line: 1, column: 0 },
      end: { line: 2, column: 3 },
    },
    selectionMode: "character",
  };
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
    readonly rejectFirstEditorPrediction?: boolean;
    readonly rejectShellExecute?: boolean;
    readonly withMcpSurface?: boolean;
    readonly initialSessionEvent?: unknown;
  } = {},
) {
  let attachAttempts = 0;
  let predictionAttempts = 0;
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
      if (method === "workspace.editor.predict") {
        predictionAttempts += 1;
        if (
          options.rejectFirstEditorPrediction === true &&
          predictionAttempts === 1
        ) {
          throw Object.assign(new Error("prediction session disappeared"), {
            code: "AGENT_NOT_FOUND",
          });
        }
        return {
          status: "completed",
          requestId: String(params?.requestId),
          generation: Number(params?.generation),
          changedtick: Number(params?.changedtick),
          text: "recovered prediction",
          provider: "grok",
          model: "grok-4.5",
          latencyMs: 5,
          cached: false,
        };
      }
      if (method === "agent.stop") {
        return {
          agentId:
            typeof params?.agentId === "string" ? params.agentId : "agent-1",
          stopped: true,
        };
      }
      if (
        method === "workspace.editor.acquire" ||
        method === "workspace.editor.heartbeat"
      ) {
        return {
          workspaceRoot: String(params?.workspaceRoot ?? process.cwd()),
          editorInstanceId: String(params?.editorInstanceId ?? "editor-1"),
          leaseToken: "lease-1",
          epoch: 1,
          sequence: 0,
          expiresAt: 1_000,
        };
      }
      if (method === "workspace.editor.sync") {
        return {
          accepted: true,
          sequence: Number(params?.sequence ?? 0),
          expiresAt: 1_000,
          dirtyPaths: [],
          stalePaths: [],
        };
      }
      if (method === "workspace.editor.release") {
        return { released: true, stalePaths: [] };
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

  it("exposes cold Editor authority through one lazy sessionless control client", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-editor-authority-test",
    });
    const session = deferred.session as DeferredInputSession;
    const workspaceRoot = process.cwd();
    const acquireParams: WorkspaceEditorAcquireParams = {
      workspaceRoot,
      editorInstanceId: "editor-cold",
      requireUnprotectedWorkspace: true,
    };

    expect(session.acquireWorkspaceEditor).toBeTypeOf("function");
    expect(session.syncWorkspaceEditor).toBeTypeOf("function");
    expect(session.heartbeatWorkspaceEditor).toBeTypeOf("function");
    expect(session.releaseWorkspaceEditor).toBeTypeOf("function");
    expect(session.reserveWorkspaceEditorTopology).toBeTypeOf("function");
    expect(session.completeWorkspaceEditorTopology).toBeTypeOf("function");
    expect(session.releaseWorkspaceEditorTopology).toBeTypeOf("function");
    expect(session.getWorkspaceEditorProposal).toBeTypeOf("function");
    expect(session.getWorkspaceEditorProposalStatus).toBeTypeOf("function");
    expect(session.applyWorkspaceEditorProposal).toBeTypeOf("function");
    expect(session.discardWorkspaceEditorProposal).toBeTypeOf("function");
    expect(session.listWorkspaceEditorChanges).toBeTypeOf("function");
    expect(session.predictEditorCode).toBeTypeOf("function");
    expect(session.cancelEditorPrediction).toBeTypeOf("function");
    expect(session.reportEditorPredictionFeedback).toBeTypeOf("function");

    await expect(
      session.acquireWorkspaceEditor(acquireParams),
    ).resolves.toEqual({
      workspaceRoot,
      editorInstanceId: "editor-cold",
      leaseToken: "lease-1",
      epoch: 1,
      sequence: 0,
      expiresAt: 1_000,
    });
    await expect(
      session.syncWorkspaceEditor({
        workspaceRoot,
        editorInstanceId: "editor-cold",
        leaseToken: "lease-1",
        epoch: 1,
        sequence: 1,
        buffers: [],
      }),
    ).resolves.toMatchObject({ accepted: true, sequence: 1 });
    await expect(
      session.releaseWorkspaceEditor({
        workspaceRoot,
        editorInstanceId: "editor-cold",
        leaseToken: "lease-1",
        epoch: 1,
      }),
    ).resolves.toEqual({ released: true, stalePaths: [] });

    expect(harness.startPromptAgent).not.toHaveBeenCalled();
    expect(harness.deps.createConnectedTuiClient).toHaveBeenCalledOnce();
    expect(harness.requests).toEqual([
      { method: "workspace.editor.acquire", params: acquireParams },
      {
        method: "workspace.editor.sync",
        params: {
          workspaceRoot,
          editorInstanceId: "editor-cold",
          leaseToken: "lease-1",
          epoch: 1,
          sequence: 1,
          buffers: [],
        },
      },
      {
        method: "workspace.editor.release",
        params: {
          workspaceRoot,
          editorInstanceId: "editor-cold",
          leaseToken: "lease-1",
          epoch: 1,
        },
      },
    ]);

    await deferred.close();
    expect(harness.client.close).toHaveBeenCalledOnce();
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

  it("closes a lazy Editor control connection that resolves during teardown", async () => {
    const client = {
      request: vi.fn(async () => ({})),
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
    const startPromptAgent = vi.fn(async () => ({ agentId: "unused" }));
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(),
      deps: {
        startPromptAgent,
        stopPromptAgent: vi.fn(async () => undefined),
        createConnectedTuiClient: vi.fn(() => connection),
      } as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-editor-close-race-test",
    });
    const session = deferred.session as DeferredInputSession;
    const acquiring = session.acquireWorkspaceEditor({
      workspaceRoot: process.cwd(),
      editorInstanceId: "editor-closing",
    });
    const closing = deferred.close();

    resolveConnection(client);
    await expect(acquiring).rejects.toThrow("already closed");
    await closing;

    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    expect(startPromptAgent).not.toHaveBeenCalled();
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

  it("stops a prediction-only daemon session when the TUI closes before submit", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-prediction-close-test",
    });
    const session = deferred.session as DeferredInputSession;

    await session.predictEditorCode({
      requestId: "prediction-close",
      editorInstanceId: "editor-close",
      bufferHandle: 2,
      generation: 1,
      changedtick: 3,
      path: "src/close.ts",
      fileBytes: 4,
      cursor: { line: 1, byteColumn: 2 },
      prefix: "cl",
      suffix: "ose",
    });
    expect(harness.startPromptAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "AgenC Editor workspace",
        deferInitialTurn: true,
      }),
    );

    await deferred.close();

    expect(harness.requests).toContainEqual({
      method: "agent.stop",
      params: {
        agentId: "agent-1",
        reason: "tui_closed_before_submit",
      },
    });
    expect(harness.client.close).toHaveBeenCalledOnce();
    expect(harness.deps.stopPromptAgent).not.toHaveBeenCalled();
  });

  it("replaces one lost deferred prediction session across concurrent retry", async () => {
    const harness = daemonHarness({ rejectFirstEditorPrediction: true });
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-prediction-recovery-test",
    });
    const session = deferred.session as DeferredInputSession;
    const prediction = (
      requestId: string,
    ): WorkspaceEditorPredictSessionParams => ({
      requestId,
      editorInstanceId: "editor-recovery",
      bufferHandle: 2,
      generation: 1,
      changedtick: 3,
      path: "src/recovery.ts",
      fileBytes: 8,
      cursor: { line: 1, byteColumn: 4 },
      prefix: "reco",
      suffix: "very",
    });

    await expect(
      session.predictEditorCode(prediction("prediction-lost")),
    ).resolves.toEqual({
      status: "suppressed",
      requestId: "prediction-lost",
      generation: 1,
      changedtick: 3,
      reason: "stale",
    });
    expect(harness.startPromptAgent).toHaveBeenCalledOnce();
    expect(harness.client.close).toHaveBeenCalledOnce();

    const [firstRetry, secondRetry] = await Promise.all([
      session.predictEditorCode(prediction("prediction-retry-1")),
      session.predictEditorCode(prediction("prediction-retry-2")),
    ]);

    expect(firstRetry).toMatchObject({
      status: "completed",
      requestId: "prediction-retry-1",
      text: "recovered prediction",
    });
    expect(secondRetry).toMatchObject({
      status: "completed",
      requestId: "prediction-retry-2",
      text: "recovered prediction",
    });
    expect(harness.startPromptAgent).toHaveBeenCalledTimes(2);
    expect(harness.deps.createConnectedTuiClient).toHaveBeenCalledTimes(2);
    expect(
      harness.requests.filter(({ method }) => method === "agent.attach"),
    ).toHaveLength(2);

    await deferred.close();
  });

  it("does not replace an activated Agent session from prediction routing", async () => {
    const harness = daemonHarness({ rejectFirstEditorPrediction: true });
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "activated-prediction-routing-test",
    });
    const session = deferred.session as DeferredInputSession;
    const prediction: WorkspaceEditorPredictSessionParams = {
      requestId: "activated-prediction",
      editorInstanceId: "editor-activated",
      bufferHandle: 2,
      generation: 1,
      changedtick: 3,
      path: "src/activated.ts",
      fileBytes: 8,
      cursor: { line: 1, byteColumn: 4 },
      prefix: "acti",
      suffix: "vated",
    };

    await session.submit("activate ordinary Agent lifecycle");
    await expect(session.predictEditorCode(prediction)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });

    expect(harness.startPromptAgent).toHaveBeenCalledOnce();
    expect(harness.deps.createConnectedTuiClient).toHaveBeenCalledOnce();
    expect(harness.client.close).not.toHaveBeenCalled();
    await expect(
      session.predictEditorCode({
        ...prediction,
        requestId: "activated-prediction-retry",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      requestId: "activated-prediction-retry",
    });
    expect(harness.startPromptAgent).toHaveBeenCalledOnce();

    await deferred.close();
  });

  it("stops a prediction-started daemon after an Editor-only submission", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-prediction-editor-close-test",
    });
    const session = deferred.session as DeferredInputSession;

    await session.predictEditorCode({
      requestId: "prediction-editor-close",
      editorInstanceId: "editor-lifecycle",
      bufferHandle: 12,
      generation: 1,
      changedtick: 4,
      path: "src/lifecycle.ts",
      fileBytes: 8,
      cursor: { line: 1, byteColumn: 4 },
      prefix: "life",
      suffix: "cycle",
    });
    await session.submit("Explain the selected code", {
      editorInteraction: editorInteraction("prediction-editor-close"),
    });

    await deferred.close();

    expect(harness.requests).toContainEqual({
      method: "agent.stop",
      params: {
        agentId: "agent-1",
        reason: "tui_closed_editor_only",
      },
    });
  });

  it("stops a daemon started directly by a cold Editor-only submission", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-direct-editor-close-test",
    });
    const session = deferred.session as DeferredInputSession;
    const interaction = editorInteraction("direct-editor-close");

    await session.submit("Explain the selected code", {
      editorInteraction: interaction,
    });
    expect(harness.startPromptAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEditorInteraction: interaction,
      }),
    );

    await deferred.close();

    expect(harness.requests).toContainEqual({
      method: "agent.stop",
      params: {
        agentId: "agent-1",
        reason: "tui_closed_editor_only",
      },
    });
  });

  it("keeps a daemon alive after Editor mode activates through an ordinary Agent submission", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-editor-agent-close-test",
    });
    const session = deferred.session as DeferredInputSession;

    await session.submit("Explain the selected code", {
      editorInteraction: editorInteraction("editor-before-agent-close"),
    });
    await session.submit("Now continue in the Agent workspace");
    await deferred.close();

    expect(harness.requests).not.toContainEqual({
      method: "agent.stop",
      params: expect.anything(),
    });
  });

  it("retains Editor-only teardown ownership when Agent activation fails", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-editor-failed-agent-close-test",
    });
    const session = deferred.session as DeferredInputSession;

    await session.submit("Explain the selected code", {
      editorInteraction: editorInteraction("editor-before-failed-agent"),
    });
    harness.client.request.mockRejectedValueOnce(
      new Error("intentional Agent activation failure"),
    );

    await expect(
      session.submit("Now continue in the Agent workspace"),
    ).rejects.toThrow("intentional Agent activation failure");
    await deferred.close();

    expect(harness.requests).toContainEqual({
      method: "agent.stop",
      params: {
        agentId: "agent-1",
        reason: "tui_closed_editor_only",
      },
    });
  });

  it("preserves pre-prediction queued input when reusing the cold session for the first turn", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-prediction-mailbox-test",
      preparePrompt: async ({ message }) => message,
    });
    const session = deferred.session as DeferredInputSession;
    const admission = session.enqueueIdleInputBatchOwned([
      queuedText("startup context"),
    ]);

    await session.predictEditorCode({
      requestId: "prediction-mailbox",
      editorInstanceId: "editor-mailbox",
      bufferHandle: 3,
      generation: 1,
      changedtick: 1,
      path: "src/mailbox.ts",
      fileBytes: 7,
      cursor: { line: 1, byteColumn: 3 },
      prefix: "sta",
      suffix: "rtup",
    });
    await session.submit("first agent turn");

    expect(harness.startPromptAgent).toHaveBeenCalledOnce();
    expect(harness.requests).toContainEqual({
      method: "message.stream",
      params: expect.objectContaining({
        sessionId: "session-1",
        content: [
          { type: "text", text: "startup context" },
          { type: "text", text: "first agent turn" },
        ],
      }),
    });
    expect(session.commitIdleInputAdmission(admission.token)).toBe(true);

    await deferred.close();
    expect(harness.requests).not.toContainEqual({
      method: "agent.stop",
      params: expect.anything(),
    });
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

  it("keeps cold and live Editor attachments out of Agent turns and migrates them exactly once", async () => {
    const harness = daemonHarness();
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore(harness.baseSession),
      deps: harness.deps as never,
      agencHome: process.cwd(),
      env: {},
      cwd: process.cwd(),
      clientId: "deferred-editor-owned-mailbox-test",
      preparePrompt: async ({ message }) => message,
    });
    const session = deferred.session as DeferredInputSession;
    const interaction = editorInteraction("editor-owned-mailbox");
    const ownership: IdleInputOwnership = {
      workspaceView: "editor",
      editorInteractionId: interaction.interactionId,
    };
    const coldAdmission = session.enqueueIdleInputBatchOwned(
      [queuedText("cold Editor attachment")],
      ownership,
    );

    await session.predictEditorCode({
      requestId: "prediction-editor-owned-mailbox",
      editorInstanceId: interaction.editorInstanceId,
      bufferHandle: interaction.bufferHandle,
      generation: 1,
      changedtick: interaction.changedtick,
      path: interaction.path ?? "src/lifecycle.ts",
      fileBytes: 7,
      cursor: { line: 1, byteColumn: 3 },
      prefix: "sta",
      suffix: "rtup",
    });
    const liveAdmission = session.enqueueIdleInputBatchOwned(
      [queuedText("live Editor attachment")],
      ownership,
    );

    await session.submit("first Agent prompt");
    await session.submit("Explain this selection", {
      editorInteraction: interaction,
    });
    expect(session.commitIdleInputAdmission(coldAdmission.token)).toBe(true);
    void session.commitIdleInputAdmission(liveAdmission.token);
    await session.submit("next Agent prompt");

    const streams = harness.requests.filter(
      ({ method }) => method === "message.stream",
    );
    expect(streams).toHaveLength(3);
    expect(streams[0]?.params?.content).toBe("first Agent prompt");
    const editorContent = streams[1]?.params?.content;
    expect(editorContent).toEqual([
      { type: "text", text: "live Editor attachment" },
      { type: "text", text: "cold Editor attachment" },
      { type: "text", text: "Explain this selection" },
    ]);
    expect(streams[1]?.params).toMatchObject({
      metadata: {
        editorInteraction: {
          interactionId: interaction.interactionId,
        },
      },
    });
    expect(streams[2]?.params?.content).toBe("next Agent prompt");
    const allStreamText = JSON.stringify(
      streams.map(({ params }) => params?.content),
    );
    expect(allStreamText.match(/cold Editor attachment/g)).toHaveLength(1);
    expect(allStreamText.match(/live Editor attachment/g)).toHaveLength(1);

    await deferred.close();
  });

  it("keeps proposal control stable and activates prediction forwarding across live-session replacement", async () => {
    const workspaceRoot = process.cwd();
    const proposal: WorkspaceEditorProposalResult = {
      proposalId: "proposal-1",
      workspaceRoot,
      path: "src/example.ts",
      beforeText: "before",
      afterText: "after",
      baseContentSha256: "base-sha",
      baseChangedtick: 4,
      bufferHandle: 7,
      source: "EditorProposal",
    };
    const calls = {
      control: [] as Array<{ method: string; params: unknown }>,
      live1: [] as Array<{ method: string; params: unknown }>,
      live2: [] as Array<{ method: string; params: unknown }>,
    };
    const makeClient = (
      bucket: Array<{ method: string; params: unknown }>,
      request: (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>,
    ) => ({
      request: vi.fn(
        async (method: string, params?: Record<string, unknown>) => {
          bucket.push({ method, params });
          return request(method, params);
        },
      ),
      subscribeToSessionEvents: vi.fn(() => () => undefined),
      subscribeToNotifications: vi.fn(() => () => undefined),
      subscribeToConnectionState: vi.fn(() => () => undefined),
      getConnectionState: vi.fn(() => ({ status: "connected" as const })),
      close: vi.fn(async () => undefined),
    });
    const controlClient = makeClient(calls.control, async (method) => {
      if (method === "workspace.editor.proposal.get") return proposal;
      if (method === "daemon.reload") return { reloaded: true };
      return {};
    });
    const predictionResult = (
      params: Record<string, unknown> | undefined,
      model: string,
    ): WorkspaceEditorPredictionResult => ({
      status: "completed",
      requestId: String(params?.requestId),
      generation: Number(params?.generation),
      changedtick: Number(params?.changedtick),
      text: `prediction from ${model}`,
      provider: "grok",
      model,
      latencyMs: 5,
      cached: false,
    });
    let live1MessageStreams = 0;
    const liveClient1 = makeClient(calls.live1, async (method, params) => {
      if (method === "agent.attach") {
        return {
          agentId: "agent-1",
          attachmentId: "attachment-1",
          sessionIds: ["session-1"],
          runtimeSessionId: "agent-1",
          runtimeSettings: daemonRuntimeSettings(),
          runtimeSettingsEventId: "settings-1",
        };
      }
      if (method === "workspace.editor.predict") {
        return predictionResult(params, "model-1");
      }
      if (method === "workspace.editor.cancelPrediction") {
        return { requestId: params?.requestId, cancelled: true };
      }
      if (method === "workspace.editor.predictionFeedback") {
        return { recorded: true };
      }
      if (method === "message.stream") {
        live1MessageStreams += 1;
        if (live1MessageStreams > 1) {
          throw new Error(
            "AgenC daemon session not found or closed: session-1",
          );
        }
        return {};
      }
      return {};
    });
    const liveClient2 = makeClient(calls.live2, async (method, params) => {
      if (method === "agent.attach") {
        return {
          agentId: "agent-2",
          attachmentId: "attachment-2",
          sessionIds: ["session-2"],
          runtimeSessionId: "agent-2",
          runtimeSettings: daemonRuntimeSettings(),
          runtimeSettingsEventId: "settings-2",
        };
      }
      if (method === "workspace.editor.predict") {
        return predictionResult(params, "model-2");
      }
      if (method === "workspace.editor.cancelPrediction") {
        return { requestId: params?.requestId, cancelled: true };
      }
      if (method === "workspace.editor.predictionFeedback") {
        return { recorded: true };
      }
      return {};
    });
    const clients = [liveClient1, controlClient, liveClient2];
    let nextAgent = 0;
    const startPromptAgent = vi.fn(async () => {
      nextAgent += 1;
      return { agentId: `agent-${nextAgent}` };
    });
    const createConnectedTuiClient = vi.fn(async () => {
      const client = clients.shift();
      if (client === undefined) throw new Error("unexpected daemon client");
      return client;
    });
    const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
      baseSession: withConfigStore({
        activeTurn: { unsafePeek: () => null },
        conversationId: "deferred-editor-dynamic",
        services: {},
        sessionConfiguration: { cwd: workspaceRoot },
      }),
      deps: {
        startPromptAgent,
        stopPromptAgent: vi.fn(async () => undefined),
        createConnectedTuiClient,
      } as never,
      agencHome: workspaceRoot,
      env: {},
      cwd: workspaceRoot,
      clientId: "deferred-editor-dynamic-test",
      preparePrompt: async ({ message }) => message,
    });
    const session = deferred.session as DeferredInputSession;
    const predictionParams: WorkspaceEditorPredictSessionParams = {
      requestId: "prediction-1",
      editorInstanceId: "editor-1",
      bufferHandle: 7,
      generation: 1,
      changedtick: 4,
      path: "src/example.ts",
      fileBytes: 12,
      cursor: { line: 1, byteColumn: 0 },
      prefix: "bef",
      suffix: "ore",
    };
    const proposalParams: WorkspaceEditorProposalParams = {
      workspaceRoot,
      editorInstanceId: "editor-1",
      leaseToken: "lease-1",
      epoch: 1,
      proposalId: "proposal-1",
    };

    await expect(session.predictEditorCode(predictionParams)).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        model: "model-1",
      }),
    );
    expect(startPromptAgent).toHaveBeenCalledOnce();
    expect(startPromptAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "AgenC Editor workspace",
        deferInitialTurn: true,
        metadata: { mode: "tui" },
      }),
    );
    await expect(
      session.getWorkspaceEditorProposal(proposalParams),
    ).resolves.toEqual(proposal);

    await session.submit("first agent turn");
    expect(startPromptAgent).toHaveBeenCalledOnce();
    expect(calls.live1).toContainEqual({
      method: "message.stream",
      params: expect.objectContaining({
        sessionId: "session-1",
        content: "first agent turn",
      }),
    });
    await expect(session.predictEditorCode(predictionParams)).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        model: "model-1",
      }),
    );
    await expect(
      session.cancelEditorPrediction({
        editorInstanceId: "editor-1",
        requestId: "prediction-1",
      }),
    ).resolves.toEqual({
      requestId: "prediction-1",
      cancelled: true,
    });
    await expect(
      session.reportEditorPredictionFeedback({
        editorInstanceId: "editor-1",
        requestId: "prediction-1",
        kind: "displayed",
        latencyMs: 5,
      }),
    ).resolves.toEqual({ recorded: true });
    expect(calls.live1).toContainEqual({
      method: "workspace.editor.predict",
      params: { ...predictionParams, sessionId: "session-1" },
    });
    expect(calls.live1).toContainEqual({
      method: "workspace.editor.cancelPrediction",
      params: {
        editorInstanceId: "editor-1",
        requestId: "prediction-1",
        sessionId: "session-1",
      },
    });
    expect(calls.live1).toContainEqual({
      method: "workspace.editor.predictionFeedback",
      params: {
        editorInstanceId: "editor-1",
        requestId: "prediction-1",
        kind: "displayed",
        latencyMs: 5,
        sessionId: "session-1",
      },
    });

    await session.submit("replace missing live session");
    expect(startPromptAgent).toHaveBeenCalledTimes(2);
    await expect(
      session.getWorkspaceEditorProposal(proposalParams),
    ).resolves.toEqual(proposal);
    await expect(session.predictEditorCode(predictionParams)).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        model: "model-2",
      }),
    );
    expect(calls.control).toEqual([
      { method: "workspace.editor.proposal.get", params: proposalParams },
      { method: "workspace.editor.proposal.get", params: proposalParams },
    ]);
    expect(calls.live2).toContainEqual({
      method: "workspace.editor.predict",
      params: { ...predictionParams, sessionId: "session-2" },
    });

    await deferred.close();
    expect(controlClient.close).toHaveBeenCalledOnce();
    expect(liveClient1.close).toHaveBeenCalledOnce();
    expect(liveClient2.close).toHaveBeenCalledOnce();
  });

  it("preserves the exact first-turn Editor interaction when lazily starting the agent", async () => {
    const harness = daemonHarness();
    const preparePrompt = vi.fn(
      async ({ message }: { readonly message: string }) =>
        `MUTATING-HOOK:${message}`,
    );
    const interaction: SessionEditorInteraction = {
      interactionId: "interaction-cold-1",
      kind: "fix",
      policy: "proposal_only",
      editorInstanceId: "editor-cold-1",
      bufferHandle: 9,
      changedtick: 12,
      contentSha256: "d".repeat(64),
      path: "src/cold.ts",
      range: {
        start: { line: 2, column: 1 },
        end: { line: 4, column: 8 },
      },
      selectionMode: "character",
    };
    const session = await createDeferredInputSession({
      baseSession: harness.baseSession,
      deps: harness.deps,
      preparePrompt,
    });

    await session.submit("fix the selected code", {
      displayUserMessage: "Fix selection",
      editorInteraction: interaction,
    });

    expect(harness.startPromptAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "fix the selected code",
        initialContent: "fix the selected code",
        initialDisplayUserMessage: "Fix selection",
        initialEditorInteraction: interaction,
        metadata: { mode: "tui" },
      }),
    );
    expect(preparePrompt).not.toHaveBeenCalled();
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

  it("submits a live Editor interaction without slash routing or prompt hooks", async () => {
    const submit = vi.fn(async () => undefined);
    const preparePrompt = vi.fn(async () => "MUTATING-HOOK");
    const interaction: SessionEditorInteraction = {
      interactionId: "interaction-live-ask",
      kind: "ask",
      policy: "read_only",
      editorInstanceId: "editor-live",
      bufferHandle: 11,
      changedtick: 3,
      contentSha256: "e".repeat(64),
      path: "src/live.ts",
      range: {
        start: { line: 1, column: 0 },
        end: { line: 1, column: 4 },
      },
    };
    const wrapped = __wrapDaemonTuiSessionWithPromptPreparationForTest(
      withConfigStore({ submit }),
      {
        agencHome: process.cwd(),
        cwd: process.cwd(),
        env: {},
        stderr: process.stderr,
        preparePrompt,
      },
    );

    await wrapped.submit?.("/clear is untrusted Editor prompt data", {
      displayUserMessage: "Ask about selection",
      editorInteraction: interaction,
    });

    expect(preparePrompt).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(
      "/clear is untrusted Editor prompt data",
      {
        displayUserMessage: "Ask about selection",
        editorInteraction: interaction,
      },
    );
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
