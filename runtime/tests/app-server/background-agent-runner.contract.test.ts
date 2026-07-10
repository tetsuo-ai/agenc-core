import { describe, expect, it, vi } from "vitest";

import {
  AgenCDelegateBackgroundAgentRunner,
  daemonEventFromUnboundSessionEvent,
  notificationFromDaemonEvent,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
} from "./background-agent-runner.js";
import type { AgentStatus } from "../agents/status.js";
import type { AuthBackend } from "../auth/backend.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";

function makeStubConversationThreadManager(opts: {
  readonly threadId: string;
  readonly agentPath?: string;
  readonly submit?: ReturnType<typeof vi.fn>;
  readonly shutdown?: ReturnType<typeof vi.fn>;
  readonly initialStatus?: AgentStatus;
}) {
  let listeners: ((status: AgentStatus) => void)[] = [];
  let currentStatus: AgentStatus =
    opts.initialStatus ??
    ({
      status: "running",
      turnId: "turn-stub",
      startedAtMs: 0,
    } as AgentStatus);
  const submit = opts.submit ?? vi.fn(async () => opts.threadId);
  const shutdown = opts.shutdown ?? vi.fn(async () => {});
  const managedThread = {
    threadId: opts.threadId,
    agentPath: opts.agentPath ?? "/root",
    kind: "root" as const,
    status: () => currentStatus,
    subscribeStatus: (cb: (status: AgentStatus) => void) => {
      cb(currentStatus);
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((listener) => listener !== cb);
      };
    },
    submit,
    appendMessage: vi.fn(async () => opts.threadId),
    shutdown,
    totalTokenUsage: () => ({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
    configSnapshot: () => ({}),
  };
  return {
    hasThread: (id: string) => id === opts.threadId,
    getThread: (id: string) => {
      if (id !== opts.threadId) {
        throw new Error(`stub conversationThreadManager has no thread ${id}`);
      }
      return managedThread;
    },
    removeThread: vi.fn(() => managedThread),
    pushStatus(next: AgentStatus) {
      currentStatus = next;
      for (const cb of [...listeners]) cb(next);
    },
    thread: managedThread,
  };
}

function makeAuthBackend(
  kind: NonNullable<AuthBackend["kind"]>,
  apiKey: string,
): AuthBackend {
  return {
    kind,
    login: vi.fn(() => ({ authenticated: true, provider: kind })),
    logout: vi.fn(() => ({ authenticated: false })),
    whoami: vi.fn(() => ({ authenticated: true, provider: kind })),
    vendKey: vi.fn((provider, sessionId) => ({
      provider: String(provider),
      sessionId,
      apiKey,
    })),
    inferAgencModel: vi.fn(() => ({
      provider: "agenc",
      model: "agenc:grok",
    })),
    getSubscriptionTier: vi.fn(() => "pro"),
  };
}

function makeTopLevelRunner(opts: {
  readonly conversationId: string;
  readonly bootstrapShutdown?: ReturnType<typeof vi.fn>;
  readonly authBackend?: AuthBackend;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: () => string;
}) {
  const shutdown = opts.bootstrapShutdown ?? vi.fn(async () => {});
  const permissionUpdates: ToolPermissionContext[] = [];
  const permissionModeRegistry = {
    current: () => createEmptyToolPermissionContext(),
    update: vi.fn(async (context: ToolPermissionContext) => {
      permissionUpdates.push(context);
    }),
  };
  const stub = makeStubConversationThreadManager({
    threadId: opts.conversationId,
  });
  const phaseSubscribers: Array<(phase: unknown) => void> = [];
  const eventLogSubscribers: Array<(event: unknown) => void> = [];
  const session = {
    conversationId: opts.conversationId,
    permissionModeRegistry,
    abortAllTasks: vi.fn(async () => {}),
    eventLog: {
      subscribe: (listener: (event: unknown) => void) => {
        eventLogSubscribers.push(listener);
        return () => {
          const index = eventLogSubscribers.indexOf(listener);
          if (index >= 0) eventLogSubscribers.splice(index, 1);
        };
      },
    },
    subscribeToEvents: (listener: (phase: unknown) => void) => {
      phaseSubscribers.push(listener);
      return () => {
        const index = phaseSubscribers.indexOf(listener);
        if (index >= 0) phaseSubscribers.splice(index, 1);
      };
    },
    emitPhaseEvent: (phase: unknown) => {
      for (const listener of [...phaseSubscribers]) listener(phase);
    },
    emitSessionEvent: (event: unknown) => {
      for (const listener of [...eventLogSubscribers]) listener(event);
    },
    emit: vi.fn((event: unknown) => {
      for (const listener of [...eventLogSubscribers]) listener(event);
    }),
    services: { conversationThreadManager: stub },
  };
  const control = {
    shutdown: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    interrupt: vi.fn(),
    openThreadSpawnChildren: vi.fn(() => []),
    clearConversationHistory: vi.fn(async () => {}),
  };
  const bootstrap = vi.fn(async () => ({
    session,
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: vi.fn(),
    },
    shutdown,
  })) as unknown as ReturnType<typeof vi.fn> & AgenCBootstrapFunction;
  const runner = new AgenCDelegateBackgroundAgentRunner({
    ...(opts.authBackend !== undefined ? { authBackend: opts.authBackend } : {}),
    bootstrap,
    ensureAgentControl: vi.fn(() => ({
      control,
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.argv !== undefined ? { argv: opts.argv } : {}),
    now: opts.now ?? (() => "2026-05-09T00:00:00.000Z"),
  });
  return {
    runner,
    session,
    control,
    stub,
    shutdown,
    bootstrap,
    permissionUpdates,
    permissionModeRegistry,
  };
}

describe("AgenC delegate background-agent runner", () => {
  it("preserves the trusted Ledger clientAction through the session-event bridge", () => {
    const clientAction = {
      type: "ledger_solana_transfer_v1",
      source: "agenc-core",
      targetCapability: "portal.ledger.solana.sign.v1",
      network: "mainnet-beta",
      intentId: "ledger-action-1",
      responseNonce: "response-nonce-ledger-action-1",
      to: "11111111111111111111111111111111",
      lamports: "1",
      expiresAt: "2026-07-10T10:10:00.000Z",
    };
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      id: "ledger-event",
      msg: {
        type: "request_user_input",
        payload: {
          requestId: "ledger-request",
          callId: "ledger-call",
          turnId: "ledger-turn",
          questions: [],
          clientAction,
        },
      },
    });

    expect(daemonEvent).toMatchObject({
      type: "request_user_input",
      payload: { clientAction },
    });
    expect(
      notificationFromDaemonEvent("session-1", "agent-1", daemonEvent!),
    ).toMatchObject({
      method: "event.user_input_request",
      params: { sessionId: "session-1", clientAction },
    });
  });

  it("bridges collab subagent lifecycle session events into daemon session notifications", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        id: "spawn-begin",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            prompt: "inspect /tmp",
            model: "qwen3.6-27b-fp8",
          },
        },
      }),
    ).toEqual({
      id: "spawn-begin",
      type: "collab_agent_spawn_begin",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        prompt: "inspect /tmp",
        model: "qwen3.6-27b-fp8",
      },
    });

    expect(
      daemonEventFromUnboundSessionEvent({
        id: "spawn-end",
        msg: {
          type: "collab_agent_spawn_end",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            status: {
              status: "errored",
              turnId: "call-agent",
              error: "task_name is required",
            },
          },
        },
      }),
    ).toEqual({
      id: "spawn-end",
      type: "collab_agent_spawn_end",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        status: {
          status: "errored",
          turnId: "call-agent",
          error: "task_name is required",
        },
      },
    });

    expect(
      daemonEventFromUnboundSessionEvent({
        id: "agent-status",
        msg: {
          type: "collab_agent_status",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            threadId: "thread-agent",
            agentNickname: "Librarian",
            status: "completed",
          },
        },
      }),
    ).toEqual({
      id: "agent-status",
      type: "collab_agent_status",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        threadId: "thread-agent",
        agentNickname: "Librarian",
        status: "completed",
      },
    });
  });

  it("bridges tool_progress session events for live daemon snapshots", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        id: "progress-1",
        msg: {
          type: "tool_progress",
          payload: {
            callId: "tool-1",
            toolName: "Bash",
            chunk: "output\n",
            stream: "stdout",
          },
        },
      }),
    ).toEqual({
      id: "progress-1",
      type: "tool_progress",
      payload: {
        callId: "tool-1",
        toolName: "Bash",
        chunk: "output\n",
        stream: "stdout",
      },
    });
  });

  it("starts agent.create through the managed-thread path and keeps it alive", async () => {
    const { runner, bootstrap, permissionUpdates, permissionModeRegistry, shutdown } =
      makeTopLevelRunner({
        conversationId: "parent-session",
        argv: ["/usr/bin/node", "/opt/agenc/bin/agenc.js"],
        env: { AGENC_HOME: "/tmp/agenc-home" },
        now: () => "2026-05-01T12:00:00.500Z",
      });

    await expect(
      runner.startAgent({
        objective: "compile the daemon",
        cwd: "/workspace",
        model: "grok-4",
        metadata: { ticket: "F-06a" },
        unattendedAllow: ["FileRead", "Grep"],
        unattendedDeny: ["exec_command"],
      }),
    ).resolves.toEqual({
      agentId: "parent-session",
      agentPath: "/root",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running",
    });

    expect(bootstrap).toHaveBeenCalledWith({
      env: { AGENC_HOME: "/tmp/agenc-home" },
      argv: [
        "/usr/bin/node",
        "/opt/agenc/bin/agenc.js",
        "--model",
        "grok-4",
        "--autonomous",
      ],
      cwd: "/workspace",
    });
    expect(permissionModeRegistry.update).toHaveBeenCalledTimes(1);
    expect(permissionUpdates[0]).toMatchObject({
      mode: "unattended",
      unattendedPolicy: {
        allowlist: ["FileRead", "Grep"],
        denylist: ["system.bash"],
      },
    });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("setAgentPermissionMode mutates the real session permission registry", async () => {
    const { runner, permissionModeRegistry, permissionUpdates } =
      makeTopLevelRunner({
        conversationId: "parent-session",
        argv: ["node", "agenc"],
      });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });
    permissionUpdates.length = 0;
    (permissionModeRegistry.update as ReturnType<typeof vi.fn>).mockClear();

    const result = await runner.setAgentPermissionMode("parent-session", {
      sessionId: "session_1",
      mode: "plan",
    });

    expect(result).toEqual({
      applied: true,
      previousMode: "default",
      mode: "plan",
    });
    // The genuine daemon registry — the one the tool evaluator reads — is
    // updated to the new mode.
    expect(permissionModeRegistry.update).toHaveBeenCalledTimes(1);
    expect(permissionUpdates[0]).toMatchObject({ mode: "plan" });
  });

  it("getAgentHooksStatus maps the daemon session's real hooks runtime snapshot", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    // Augment the fake session.services with a hooks runtime exposing the
    // genuine ConfiguredHooksRuntime read API the runner consults.
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => false,
          issues: () => [{ level: "warning", message: "heads up" }],
          listHooks: () => [
            {
              event: "PreToolUse",
              matcher: "Read",
              command: {
                type: "command",
                command: "printf ok",
                timeout_ms: 5000,
              },
              source: "config",
              sourcePath: "/home/agent/.agenc/config.toml",
              enabled: true,
              index: 0,
            },
          ],
          latestDiagnostics: () => [],
          setDisabled: vi.fn(),
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const status = await runner.getAgentHooksStatus("parent-session");
    expect(status.available).toBe(true);
    expect(status.sourcePath).toBe("/home/agent/.agenc/config.toml");
    expect(status.disabled).toBe(false);
    expect(status.issues).toEqual([{ level: "warning", message: "heads up" }]);
    expect(status.hooks).toHaveLength(1);
    expect(status.hooks[0]).toMatchObject({
      event: "PreToolUse",
      matcher: "Read",
      index: 0,
      command: { type: "command", command: "printf ok", timeout_ms: 5000 },
    });
  });

  it("getAgentHooksStatus reports available:false when no hooks runtime is present", async () => {
    const { runner } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const status = await runner.getAgentHooksStatus("parent-session");
    expect(status).toEqual({
      available: false,
      sourcePath: "",
      disabled: true,
      issues: [],
      hooks: [],
      diagnostics: [],
    });
  });

  it("setAgentHooksDisabled toggles the daemon session's real hooks runtime", async () => {
    const setDisabled = vi.fn();
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => false,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled,
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.setAgentHooksDisabled("parent-session", {
      disabled: true,
    });
    expect(result).toEqual({ applied: true, disabled: true });
    expect(setDisabled).toHaveBeenCalledWith(true);
  });

  it("applyAgentConfig applies reasoning effort and stages a profile switch", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });

    // Augment the fake session with the config-apply surfaces the real
    // in-process Session exposes: a ConfigStore with a "fast" profile, a
    // mutable sessionConfiguration, and the typed switch mutator.
    const stateObject = {
      sessionConfiguration: {
        collaborationMode: { model: "base-model", reasoningEffort: "medium" },
      },
    };
    const stagedSwitches: Array<{
      provider: string;
      model: string;
      profile?: string;
    }> = [];
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({
            model: "base-model",
            model_provider: "openai",
            profiles: {
              fast: {
                model: "fast-model",
                model_provider: "openai",
                reasoning_effort: "high",
              },
            },
          }),
        },
      },
      setPendingProviderSwitch: (spec: {
        provider: string;
        model: string;
        profile?: string;
      }) => {
        stagedSwitches.push(spec);
      },
      state: {
        with: async (fn: (state: unknown) => void) => {
          fn(stateObject);
        },
      },
    });

    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.applyAgentConfig("parent-session", {
      sessionId: "session_1",
      profile: "fast",
    });

    expect(result.applied).toBe(true);
    expect(result.summary).toContain("profile fast");
    expect(result.summary).toContain("reasoning effort ->high");
    // Model/provider delta staged through the genuine switch seam, with the
    // profile threaded so consumePendingProviderSwitch re-resolves it.
    expect(stagedSwitches).toEqual([
      { provider: "openai", model: "fast-model", profile: "fast" },
    ]);
    // Reasoning effort written onto the live sessionConfiguration — the piece
    // the model-switch seam alone cannot do.
    expect(
      stateObject.sessionConfiguration.collaborationMode.reasoningEffort,
    ).toBe("high");
  });

  it("applyAgentConfig reloads config from disk when requested", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    const reload = vi.fn(async () => ({}));
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({ model: "base-model", model_provider: "openai" }),
          reload,
        },
      },
      setPendingProviderSwitch: () => {},
      state: { with: async (fn: (state: unknown) => void) => fn({}) },
    });

    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.applyAgentConfig("parent-session", {
      sessionId: "session_1",
      reload: true,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.summary).toContain("config reloaded from disk");
  });

  it("setAgentPermissionMode rejects internal-only modes", async () => {
    const { runner } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    await expect(
      runner.setAgentPermissionMode("parent-session", {
        sessionId: "session_1",
        mode: "unattended",
      }),
    ).rejects.toThrow(/internal-only/);
  });

  it("passes the daemon AuthBackend into delegate bootstrap", async () => {
    const authBackend = makeAuthBackend("local", "managed-key");
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "parent-session",
      authBackend,
      argv: ["node", "agenc"],
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    const bootstrapOptions = vi.mocked(bootstrap).mock.calls[0]?.[0];
    expect(bootstrapOptions).toMatchObject({
      argv: ["node", "agenc", "--autonomous"],
    });
    expect(bootstrapOptions?.authBackend).not.toBe(authBackend);
    await expect(
      bootstrapOptions?.authBackend?.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({
      provider: "grok",
      sessionId: "daemon-session",
      apiKey: "managed-key",
    });
    expect(authBackend.vendKey).toHaveBeenCalledWith("grok", "daemon-session");
  });

  it("updateRuntimeConfig resets active daemon runtime provider-key cache after auth reload", async () => {
    const initialAuthBackend = makeAuthBackend("local", "managed-key-before");
    const reloadedAuthBackend = makeAuthBackend("remote", "managed-key-after");
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "parent-session",
      authBackend: initialAuthBackend,
      argv: ["node", "agenc"],
    });

    await runner.startAgent({
      objective: "before auth reload",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const firstRuntimeAuthBackend = vi.mocked(bootstrap).mock.calls[0]?.[0]
      .authBackend;
    if (firstRuntimeAuthBackend === undefined) {
      throw new Error("expected first daemon runtime auth backend");
    }
    expect(firstRuntimeAuthBackend.kind).toBe("local");
    await expect(
      firstRuntimeAuthBackend.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-before" });

    runner.updateRuntimeConfig({ authBackend: reloadedAuthBackend });

    await expect(
      firstRuntimeAuthBackend.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-after" });

    await runner.startAgent({
      objective: "after auth reload",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const secondRuntimeAuthBackend = vi.mocked(bootstrap).mock.calls[1]?.[0]
      .authBackend;
    expect(secondRuntimeAuthBackend?.kind).toBe("remote");
    await expect(
      secondRuntimeAuthBackend?.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-after" });
  });

  it("[managed-thread] returns conversationId as agentId with no delegate fork", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-storm-fix",
    });

    const result = await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(result.agentId).toBe("session-storm-fix");
    expect(result.status).toBe("running");
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "user_input",
      input: "hi",
    });
    const submittedInput = stub.thread.submit.mock.calls[0]?.[0];
    expect(JSON.stringify(submittedInput)).not.toContain(
      "You are a subagent spawned",
    );
  });

  it("[managed-thread] passes multimodal initialContent through submit verbatim", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-multimodal",
    });

    await runner.startAgent({
      objective: "ignored when initialContent is set",
      initialContent: [
        { type: "text", text: "hello" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBOR" },
        },
      ],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(stub.thread.submit).toHaveBeenCalledTimes(1);
    expect(stub.thread.submit.mock.calls[0]?.[0]).toEqual({
      type: "user_input",
      input: [
        { type: "text", text: "hello" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBOR" },
        },
      ],
    });
  });

  it("[managed-thread] empty initialContent provisions a passive agent with no turn-1 submit", async () => {
    // The channel gateway (task 34) relies on this contract: agent.create
    // with `initialContent: []` bootstraps a live, runnable agent WITHOUT
    // submitting the objective as a first turn — zero LLM calls until the
    // first real message arrives via message.send.
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-passive-gateway",
    });

    const result = await runner.startAgent({
      objective: "gateway session",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(result.agentId).toBe("session-passive-gateway");
    expect(result.status).toBe("running");
    expect(stub.thread.submit).not.toHaveBeenCalled();
  });

  it("[managed-thread] emits visible user message before routing attached input", async () => {
    const { runner, control } = makeTopLevelRunner({
      conversationId: "session-user-order",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-user-order", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;
    control.sendInput.mockImplementation(async () => {
      expect(emitted[0]).toMatchObject({
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "session-user-order",
          eventId: "message_1",
          acceptedAt: "2026-05-01T12:00:01.000Z",
          event: {
            id: "message_1",
            type: "user_message",
            messageId: "message_1",
            streamId: "stream_1",
            acceptedAt: "2026-05-01T12:00:01.000Z",
            payload: {
              message: "continue",
              displayText: "continue",
            },
          },
        },
      });
    });

    await runner.submitAgentMessage("session-user-order", {
      sessionId: "session_1",
      content: "continue",
      originalContent: "continue",
      messageId: "message_1",
      streamId: "stream_1",
      acceptedAt: "2026-05-01T12:00:01.000Z",
    });

    expect(control.sendInput).toHaveBeenCalledWith(
      "session-user-order",
      "continue",
    );
    expect(emitted).toHaveLength(1);
  });

  it("[managed-thread] persists daemon-visible user prompts without duplicate live rows", async () => {
    const { runner, control, session } = makeTopLevelRunner({
      conversationId: "session-user-durable",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "first visible prompt",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(session.emit).toHaveBeenCalledWith({
      id: "user-initial-session-user-durable",
      msg: {
        type: "user_message",
        payload: {
          message: "first visible prompt",
          displayText: "first visible prompt",
        },
      },
    });

    await runner.attachAgentSessionEvents("session-user-durable", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(
      emitted.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { readonly params?: { readonly event?: { type?: string } } })
            .params?.event?.type === "user_message",
      ),
    ).toHaveLength(1);

    emitted.length = 0;
    control.sendInput.mockImplementationOnce(async () => {
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "session-user-durable",
          eventId: "message_2",
          event: {
            id: "message_2",
            type: "user_message",
            messageId: "message_2",
            streamId: "stream_2",
            acceptedAt: "2026-05-01T12:00:02.000Z",
            payload: {
              message: "second visible prompt",
              displayText: "second visible prompt",
            },
          },
        },
      });
    });

    await runner.submitAgentMessage("session-user-durable", {
      sessionId: "session_1",
      content: "second visible prompt",
      originalContent: "second visible prompt",
      messageId: "message_2",
      streamId: "stream_2",
      acceptedAt: "2026-05-01T12:00:02.000Z",
    });

    expect(control.sendInput).toHaveBeenCalledWith(
      "session-user-durable",
      "second visible prompt",
    );
    expect(emitted).toHaveLength(1);
    expect(session.emit).toHaveBeenCalledWith({
      id: "message_2",
      msg: {
        type: "user_message",
        payload: {
          message: "second visible prompt",
          displayText: "second visible prompt",
          messageId: "message_2",
          streamId: "stream_2",
          acceptedAt: "2026-05-01T12:00:02.000Z",
        },
      },
    });
  });

  it("[managed-thread] forwards durable queued prompt events to attached clients", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-queued-user-event",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-queued-user-event", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitSessionEvent({
      id: "queued-1",
      msg: {
        type: "user_message",
        payload: {
          message: "<system-reminder>wrapped</system-reminder>",
          displayText: "visible queued prompt",
          queuedCommandUuid: "queued-1",
        },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            sessionId: "session_1",
            agentId: "session-queued-user-event",
            eventId: "queued-1",
            event: expect.objectContaining({
              id: "queued-1",
              type: "user_message",
              payload: expect.objectContaining({
                displayText: "visible queued prompt",
                queuedCommandUuid: "queued-1",
              }),
            }),
          }),
        }),
      );
    });
  });

  it("[managed-thread] replays objective-only first prompts to attached clients", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-objective-first-prompt",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "audit first prompt",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "user_input",
      input: "audit first prompt",
    });

    await runner.attachAgentSessionEvents("session-objective-first-prompt", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(emitted).toContainEqual(
      expect.objectContaining({
        method: "event.session_event",
        params: expect.objectContaining({
          sessionId: "session_1",
          agentId: "session-objective-first-prompt",
          event: expect.objectContaining({
            type: "user_message",
            payload: expect.objectContaining({
              message: "audit first prompt",
              displayText: "audit first prompt",
            }),
          }),
        }),
      }),
    );
  });

  it("[managed-thread] reports max-turn terminal phases as errored status", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-max-turns",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-max-turns", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "partial output",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "max_turns",
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "error",
            runStatus: "errored",
            message: "Agent exceeded maxTurns",
          }),
        }),
      );
    });
  });

  it("[managed-thread] reports interrupted thread status as idle reusable status", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-interrupted-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-interrupted-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    stub.pushStatus({
      status: "interrupted",
      turnId: "turn-interrupted",
      endedAtMs: 123,
      reason: "user_cancel",
    } as AgentStatus);

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            turnId: "turn-interrupted",
            message: "user_cancel",
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-interrupted-status"),
    ).resolves.toMatchObject({ status: "idle" });
  });

  it("[managed-thread] records cancelled turn phases as idle and accepts follow-up messages", async () => {
    const { runner, session, control } = makeTopLevelRunner({
      conversationId: "session-cancelled-turn-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-cancelled-turn-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "cancelled",
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "cancelled",
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-cancelled-turn-status"),
    ).resolves.toMatchObject({ status: "idle" });

    await expect(
      runner.submitAgentMessage("session-cancelled-turn-status", {
        sessionId: "session_1",
        content: "continue after cancel",
        originalContent: "continue after cancel",
        messageId: "message-after-cancel",
        streamId: "stream-after-cancel",
        acceptedAt: "2026-05-09T00:00:01.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(control.sendInput).toHaveBeenCalledWith(
      "session-cancelled-turn-status",
      "continue after cancel",
    );
  });

  it("[managed-thread] closes active tool rows when a turn is interrupted", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-interrupted-tool",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-interrupted-tool", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "tool_call",
      toolCall: {
        id: "call_1",
        name: "exec_command",
        arguments: '{"cmd":"sleep 120"}',
      },
    });
    session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "cancelled",
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            event: expect.objectContaining({
              type: "tool_call_completed",
              payload: expect.objectContaining({
                callId: "call_1",
                isError: true,
                metadata: { cause: "user_interrupted" },
              }),
            }),
          }),
        }),
      );
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "cancelled",
          }),
        }),
      );
    });
  });

  it("[managed-thread] records completed turn phases as idle snapshots", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-completed-turn-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-completed-turn-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "done",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "completed",
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "done",
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-completed-turn-status"),
    ).resolves.toMatchObject({ status: "idle" });
  });

  it("[managed-thread] interruptAgentTurn aborts the active session and submits interrupt op on managed thread", async () => {
    const { runner, session, stub } = makeTopLevelRunner({
      conversationId: "session-interrupt",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.thread.submit.mockClear();

    const interrupted = await runner.interruptAgentTurn(
      "session-interrupt",
      "user_cancel",
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(interrupted).toBe(true);
    expect(session.abortAllTasks).toHaveBeenCalledWith("interrupted");
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "interrupt",
      reason: "user_cancel",
    });
  });

  it("[managed-thread] interruptAgentTurn cascades cancellation to live child agents", async () => {
    const { runner, stub, control } = makeTopLevelRunner({
      conversationId: "session-interrupt-subtree",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    control.openThreadSpawnChildren.mockReturnValue([
      [
        "child-agent",
        {
          agentId: "child-agent",
          agentPath: "/root/worker",
          depth: 1,
        },
      ],
    ]);
    stub.thread.submit.mockClear();

    const interrupted = await runner.interruptAgentTurn(
      "session-interrupt-subtree",
      "user_cancel",
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(interrupted).toBe(true);
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "interrupt",
      reason: "user_cancel",
    });
    expect(control.openThreadSpawnChildren).toHaveBeenCalledWith(
      "session-interrupt-subtree",
    );
    expect(control.interrupt).toHaveBeenCalledWith("child-agent", "user_cancel");
  });

  it("[managed-thread] stopAgent shuts down the managed thread", async () => {
    const { runner, stub, control } = makeTopLevelRunner({
      conversationId: "session-stop",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    await runner.stopAgent("session-stop", "user_stopped");

    expect(stub.thread.shutdown).toHaveBeenCalledWith("user_stopped");
    expect(control.shutdown).not.toHaveBeenCalled();
  });
});
