import { describe, expect, it, vi } from "vitest";

import {
  AgenCDelegateBackgroundAgentRunner,
  daemonEventFromUnboundSessionEvent,
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
  const session = {
    conversationId: opts.conversationId,
    permissionModeRegistry,
    subscribeToEvents: () => () => {},
    emitPhaseEvent: () => {},
    services: { conversationThreadManager: stub },
  };
  const control = {
    shutdown: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    interrupt: vi.fn(),
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
        denylist: ["exec_command"],
      },
    });
    expect(shutdown).not.toHaveBeenCalled();
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

  it("[managed-thread] interruptAgentTurn submits interrupt op on managed thread", async () => {
    const { runner, stub } = makeTopLevelRunner({
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
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "interrupt",
      reason: "user_cancel",
    });
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
