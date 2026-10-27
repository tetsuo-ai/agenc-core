import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __createDeferredDaemonPromptTuiSessionForTest,
  sessionConfigurationFromAgenCConfig,
} from "./agenc-main.js";
import { ConfigStore } from "../config/store.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";

// The TUI provisions its turn-deferred daemon session while the user types the
// first prompt, so Enter only has to start a turn. These tests pin that the
// first prompt then reuses that session (no second agent.create on the
// critical path), and that every way the speculative session can be wrong or
// unavailable falls back to the cold path the prompt took before.

type PrewarmSession = {
  submit(message: string): Promise<void>;
  subscribeToEvents(cb: (event: unknown) => void): () => void;
  setPendingProviderSwitch(pending: { provider: string; model: string } | null): void;
  executeShellCommand(params: {
    readonly command: string;
    readonly commandId: string;
  }): Promise<unknown>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function runtimeSettings() {
  return {
    permissionMode: "default" as const,
    prePlanMode: null,
    autoModeActive: false,
    autoModeAvailable: true,
    bypassPermissionsModeAvailable: false,
    bypassPermissionsWorkspace: null,
    bypassPermissionsConsentWorkspace: null,
    model: "deepseek-flash",
    provider: "deepseek",
    profile: null,
    reasoningEffort: null,
    modelVerbosity: null,
    serviceTier: null,
    hooksDisabled: false,
  };
}

type ConnectionListener = (state: { status: string; message?: string }) => void;

function harness() {
  const requests: Array<{ readonly method: string; readonly params: Record<string, unknown> | undefined }> = [];
  let attachAttempts = 0;
  const connectionListeners: ConnectionListener[] = [];
  const client = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "agent.attach") {
        attachAttempts += 1;
        const agentId = typeof params?.agentId === "string" ? params.agentId : "agent-1";
        return {
          agentId,
          attachmentId: `attachment-${attachAttempts}`,
          sessionIds: [`session-${attachAttempts}`],
          runtimeSessionId: agentId,
          runtimeSettings: runtimeSettings(),
          runtimeSettingsEventId: `settings-${attachAttempts}`,
        };
      }
      if (method === "session.shell.execute") {
        return {
          commandId: String(params?.commandId), content: "ok", stdout: "ok", stderr: "",
          exitCode: 0, timedOut: false, truncated: false, isError: false,
        };
      }
      if (method === "agent.stop") {
        return { agentId: String(params?.agentId), stopped: true };
      }
      return {};
    }),
    subscribeToSessionEvents: vi.fn(() => () => undefined),
    subscribeToConnectionState: vi.fn((listener: ConnectionListener) => {
      connectionListeners.push(listener);
      return () => {
        const index = connectionListeners.indexOf(listener);
        if (index >= 0) connectionListeners.splice(index, 1);
      };
    }),
    getConnectionState: vi.fn(() => ({ status: "connected" as const })),
    close: vi.fn(async () => undefined),
  };
  /** The daemon went away under the client (a restart, for one). */
  const dropConnection = (order: "subscription" | "reverse" = "subscription"): void => {
    const listeners = [...connectionListeners];
    if (order === "reverse") listeners.reverse();
    for (const listener of listeners) {
      listener({ status: "disconnected", message: "Daemon connection closed" });
    }
  };
  let nextAgent = 0;
  const startPromptAgent = vi.fn(async (_params: Record<string, unknown>) => {
    nextAgent += 1;
    return { agentId: `agent-${nextAgent}` };
  });
  return {
    client,
    requests,
    startPromptAgent,
    dropConnection,
    deps: {
      startPromptAgent,
      stopPromptAgent: vi.fn(async () => undefined),
      createConnectedTuiClient: vi.fn(async () => client),
    },
  };
}

async function deferredSession(h: ReturnType<typeof harness>) {
  const configStore = new ConfigStore({ env: {} });
  const config = configStore.current();
  const deferred = await __createDeferredDaemonPromptTuiSessionForTest({
    baseSession: {
      activeTurn: { unsafePeek: () => null },
      conversationId: "prewarm-base",
      sessionConfiguration: sessionConfigurationFromAgenCConfig({
        config,
        workspaceRoot: process.cwd(),
        model: config.model,
      }),
      services: {
        permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext()),
        configStore,
      },
    },
    deps: h.deps as never,
    agencHome: process.cwd(),
    env: {},
    cwd: process.cwd(),
    clientId: "prewarm-test",
    preparePrompt: async ({ message }) => message,
  });
  cleanups.push(deferred.close);
  return { deferred, session: deferred.session as PrewarmSession };
}

function messageStreams(h: ReturnType<typeof harness>) {
  return h.requests.filter(({ method }) => method === "message.stream");
}

function stops(h: ReturnType<typeof harness>) {
  return h.requests.filter(({ method }) => method === "agent.stop");
}

/** What the TUI shows when a session's daemon connection drops or cannot come back. */
function isConnectionNotice(event: unknown): boolean {
  const record = event as { id?: unknown; type?: unknown; payload?: { cause?: unknown } } | null;
  return (
    record !== null &&
    typeof record === "object" &&
    ((record.type === "warning" && record.payload?.cause === "daemon_connection_state") ||
      (typeof record.id === "string" && record.id.startsWith("daemon-runtime-settings-authority-failed-")))
  );
}

describe("speculative TUI session provisioning", () => {
  it("starts the first prompt's turn on the prewarmed session", async () => {
    const h = harness();
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    expect(h.startPromptAgent).toHaveBeenCalledOnce();
    expect(h.startPromptAgent).toHaveBeenCalledWith(expect.objectContaining({
      deferInitialTurn: true,
      prompt: "Interactive session",
    }));
    expect(messageStreams(h)).toHaveLength(0);

    await session.submit("fix the failing tests");

    expect(h.startPromptAgent).toHaveBeenCalledOnce();
    expect(messageStreams(h)).toHaveLength(1);
    expect(messageStreams(h)[0]!.params).toMatchObject({
      sessionId: "session-1",
      content: "fix the failing tests",
    });
  });

  it("makes a prompt submitted during provisioning wait for that session", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.startPromptAgent.mockImplementationOnce(async () => {
      await gate;
      return { agentId: "agent-1" };
    });
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.startPromptAgent).toHaveBeenCalledOnce());
    const submitted = session.submit("early prompt");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messageStreams(h)).toHaveLength(0);
    release();
    await submitted;

    expect(h.startPromptAgent).toHaveBeenCalledOnce();
    expect(messageStreams(h)).toHaveLength(1);
    expect(messageStreams(h)[0]!.params).toMatchObject({ content: "early prompt" });
  });

  it("keeps a failed provisioning invisible and creates the session on the first prompt", async () => {
    const h = harness();
    h.startPromptAgent.mockRejectedValueOnce(new Error("provider not ready"));
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.startPromptAgent).toHaveBeenCalledOnce());
    await session.submit("first prompt");

    expect(h.startPromptAgent).toHaveBeenCalledTimes(2);
    const coldStart = h.startPromptAgent.mock.calls[1]![0];
    expect(coldStart).toMatchObject({ initialContent: "first prompt" });
    expect(coldStart).not.toHaveProperty("deferInitialTurn");
    expect(messageStreams(h)).toHaveLength(0);
  });

  it("retires a session still provisioning when a startup choice is staged", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.startPromptAgent.mockImplementationOnce(async () => {
      await gate;
      return { agentId: "agent-1" };
    });
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.startPromptAgent).toHaveBeenCalledOnce());
    session.setPendingProviderSwitch({ provider: "deepseek", model: "deepseek-pro" });
    release();
    await session.submit("prompt for the staged model");

    expect(stops(h)).toEqual([
      { method: "agent.stop", params: { agentId: "agent-1", reason: "tui_prewarm_unused" } },
    ]);
    expect(h.startPromptAgent).toHaveBeenCalledTimes(2);
    expect(h.startPromptAgent.mock.calls[1]![0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-pro",
      initialContent: "prompt for the staged model",
    });
  });

  it("retires a ready, unused session when a startup choice is staged", async () => {
    const h = harness();
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    session.setPendingProviderSwitch({ provider: "deepseek", model: "deepseek-pro" });
    await session.submit("prompt for the staged model");

    expect(stops(h).map(({ params }) => params)).toEqual([
      { agentId: "agent-1", reason: "tui_prewarm_unused" },
    ]);
    expect(h.startPromptAgent.mock.calls[1]![0]).toMatchObject({
      model: "deepseek-pro",
      initialContent: "prompt for the staged model",
    });
  });

  it("serves a cold shell command from the session being provisioned", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.startPromptAgent.mockImplementationOnce(async () => {
      await gate;
      return { agentId: "agent-1" };
    });
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.startPromptAgent).toHaveBeenCalledOnce());
    const shell = session.executeShellCommand({ command: "pwd", commandId: "cmd-1" });
    release();
    await shell;

    expect(h.startPromptAgent).toHaveBeenCalledOnce();
    expect(h.requests.filter(({ method }) => method === "session.shell.execute")).toHaveLength(1);
  });

  it("treats a session a shell command used as the ordinary deferred session", async () => {
    const h = harness();
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    await session.executeShellCommand({ command: "pwd", commandId: "cmd-1" });

    // The same answer a shell-created deferred session gives: no silent retire.
    expect(() =>
      session.setPendingProviderSwitch({ provider: "deepseek", model: "deepseek-pro" }),
    ).toThrow(/applyProviderModelSelection/);
    expect(stops(h)).toHaveLength(0);
  });

  it("retires the unused session quietly when the daemon restarts, and the first prompt creates its own", async () => {
    const h = harness();
    // The restarting daemon cannot take the stop yet.
    h.deps.stopPromptAgent.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const { deferred, session } = await deferredSession(h);
    const seen: unknown[] = [];
    session.subscribeToEvents((event) => seen.push(event));

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    h.dropConnection();
    await vi.waitFor(() => expect(h.deps.stopPromptAgent).toHaveBeenCalledOnce());
    expect(h.client.close).toHaveBeenCalled();

    await session.submit("first prompt after the restart");

    expect(h.startPromptAgent).toHaveBeenCalledTimes(2);
    expect(h.startPromptAgent.mock.calls[1]![0]).toMatchObject({
      initialContent: "first prompt after the restart",
    });
    expect(h.startPromptAgent.mock.calls[1]![0]).not.toHaveProperty("deferInitialTurn");
    expect(messageStreams(h)).toHaveLength(0);
    // No reconnect notice and no "quit and continue" guidance reached the TUI.
    expect(seen.filter(isConnectionNotice)).toEqual([]);
    // The stop the restarting daemon missed goes out on the next session.
    await vi.waitFor(() =>
      expect(stops(h).map(({ params }) => params)).toContainEqual({
        agentId: "agent-1",
        reason: "tui_prewarm_unused",
      }),
    );
  });

  it("hides the unused session's connection notices whichever listener hears the drop first", async () => {
    const h = harness();
    const { deferred, session } = await deferredSession(h);
    const seen: unknown[] = [];
    session.subscribeToEvents((event) => seen.push(event));

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    h.dropConnection("reverse");
    await vi.waitFor(() => expect(h.deps.stopPromptAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", reason: "tui_prewarm_unused" }),
    ));

    expect(seen.filter(isConnectionNotice)).toEqual([]);
  });

  it("leaves a session the first prompt used to the ordinary reconnect path", async () => {
    const h = harness();
    const { deferred, session } = await deferredSession(h);
    const seen: unknown[] = [];
    session.subscribeToEvents((event) => seen.push(event));

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    await session.submit("fix the failing tests");
    h.dropConnection();

    expect(h.deps.stopPromptAgent).not.toHaveBeenCalled();
    expect(stops(h)).toHaveLength(0);
    expect(seen.filter(isConnectionNotice).length).toBeGreaterThan(0);
  });

  it("retires a speculative agent whose attach failed without holding up the first prompt", async () => {
    const h = harness();
    const request = h.client.request.getMockImplementation()!;
    let failedAttach = false;
    h.client.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "agent.attach" && !failedAttach) {
        failedAttach = true;
        h.requests.push({ method, params });
        throw new Error("Daemon connection closed");
      }
      return request(method, params);
    });
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(failedAttach).toBe(true));
    await session.submit("first prompt");

    expect(h.startPromptAgent).toHaveBeenCalledTimes(2);
    expect(h.startPromptAgent.mock.calls[1]![0]).toMatchObject({ initialContent: "first prompt" });
    await vi.waitFor(() =>
      expect(stops(h).map(({ params }) => params)).toContainEqual({
        agentId: "agent-1",
        reason: "tui_prewarm_unused",
      }),
    );
  });

  it("stops the unused session when the TUI closes before any prompt", async () => {
    const h = harness();
    const { deferred } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    await deferred.close();

    expect(stops(h).map(({ params }) => params)).toEqual([
      { agentId: "agent-1", reason: "tui_prewarm_unused" },
    ]);
  });

  it("retires the unused session when the terminal goes away, and the close stops nothing more", async () => {
    const h = harness();
    const { deferred } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    await deferred.retireUnusedOnTerminalLoss();

    expect(stops(h).map(({ params }) => params)).toEqual([
      { agentId: "agent-1", reason: "tui_prewarm_unused" },
    ]);
    await deferred.close();
    expect(stops(h)).toHaveLength(1);
  });

  it("leaves a used session to the daemon when the terminal goes away", async () => {
    const h = harness();
    const { deferred, session } = await deferredSession(h);

    deferred.prewarm();
    await vi.waitFor(() => expect(h.requests.some(({ method }) => method === "agent.attach")).toBe(true));
    await session.submit("fix the failing tests");
    await deferred.retireUnusedOnTerminalLoss();

    expect(h.deps.stopPromptAgent).not.toHaveBeenCalled();
    expect(stops(h)).toHaveLength(0);
  });
});
