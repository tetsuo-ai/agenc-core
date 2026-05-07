import { describe, expect, it, vi } from "vitest";
import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCDelegateFunction,
  type AgenCEnsureAgentControlFunction,
  type AgenCRunAgentFunction,
} from "./background-agent-runner.js";
import { AgentStatusTracker } from "../agents/status.js";
import type { AgentThread } from "../agents/thread.js";
import { Mailbox } from "../agents/mailbox.js";
import { resolveAgentRole } from "../agents/role.js";
import type { AuthBackend } from "../auth/backend.js";
import type { LiveAgent } from "../agents/control.js";
import type { AgentMetadata } from "../agents/registry.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { ABORT, APPROVED } from "../permissions/review-decision.js";
import type { AgentStatus } from "../agents/status.js";
import type { ApprovalResolver } from "../tools/orchestrator.js";
import { JSON_RPC_VERSION, type JsonObject } from "./protocol/index.js";
import {
  createDaemonTuiSession,
  type AgenCDaemonTuiClient,
} from "../tui/daemon-session.js";
import { prepareMessagesForWire } from "../llm/wire/shared.js";
import { RealtimeConversationManager } from "../conversation/realtime/conversation.js";
import { AgenCRealtimeCallClient } from "./realtime-transport.js";

function restoredLiveAgent(
  agentId: string,
  agentPath = `/root/${agentId}`,
): LiveAgent {
  const metadata: AgentMetadata = {
    agentId,
    agentPath,
    agentNickname: agentId,
    agentRole: "default",
    depth: 1,
  };
  return {
    agentId,
    agentPath,
    role: resolveAgentRole(undefined),
    depth: 1,
    nickname: agentId,
    status: new AgentStatusTracker(),
    upInbox: new Mailbox({ threadId: agentId }),
    downInbox: new Mailbox({ threadId: `${agentId}-down` }),
    abortController: new AbortController(),
    metadata,
    messages: [],
    memoryEntries: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function makeRestorePermissionRunner(
  permissionUpdates: ToolPermissionContext[],
): AgenCDelegateBackgroundAgentRunner {
  const permissionModeRegistry = {
    current: () => createEmptyToolPermissionContext(),
    update: vi.fn(async (context: ToolPermissionContext) => {
      permissionUpdates.push(context);
    }),
  };
  const session = {
    conversationId: "session-restore-policy",
    permissionModeRegistry,
    services: {},
  };
  const control = {
    resumeAgentFromRollout: vi.fn(
      async (params: { readonly rootThreadId: string }) => ({
        resumedCount: 1,
        rootLive: restoredLiveAgent(params.rootThreadId),
      }),
    ),
    sendInput: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
  const runAgentFn = async function* () {} as AgenCRunAgentFunction;

  return new AgenCDelegateBackgroundAgentRunner({
    bootstrap: vi.fn(async () => ({
      session,
      registry: {
        tools: [],
        toLLMTools: () => [],
        dispatch: vi.fn(),
      },
      shutdown: vi.fn(async () => {}),
    })) as unknown as AgenCBootstrapFunction,
    ensureAgentControl: vi.fn(() => ({
      control,
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction,
    runAgentFn,
    now: () => "2026-05-01T12:00:00.500Z",
  });
}

describe("AgenC delegate background-agent runner", () => {
  it("starts agent.create through the async delegate path and keeps it alive", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionUpdates: ToolPermissionContext[] = [];
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async (context: ToolPermissionContext) => {
        permissionUpdates.push(context);
      }),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const registry = {};
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as AgentThread;
    const bootstrap = vi.fn(async () => ({
      session,
      shutdown,
    })) as unknown as AgenCBootstrapFunction;
    const ensureAgentControl = vi.fn(() => ({
      control,
      registry,
    })) as unknown as AgenCEnsureAgentControlFunction;
    const delegateFn = vi.fn(async () => ({
      kind: "async_launched",
      thread,
    })) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap,
      delegateFn,
      ensureAgentControl,
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
      agentId: "agent_live",
      agentPath: "/root/agent_live",
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
    expect(ensureAgentControl).toHaveBeenCalledWith(session);
    expect(delegateFn).toHaveBeenCalledWith({
      parent: session,
      parentPath: "/root",
      control,
      registry,
      taskPrompt: "compile the daemon",
      runInBackground: true,
      isolation: "cwd",
      model: "grok-4",
      onProgress: expect.any(Function),
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

  it("passes startup multimodal content into the initial delegate turn", async () => {
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const registry = {};
    const thread = {
      threadId: "agent_image",
      agentPath: "/root/agent_image",
      join: vi.fn(() => new Promise(() => {})),
    } as AgentThread;
    const delegateFn = vi.fn(async () => ({
      kind: "async_launched",
      thread,
    })) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown: vi.fn(async () => {}),
      })) as unknown as AgenCBootstrapFunction,
      delegateFn,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry,
      })) as unknown as AgenCEnsureAgentControlFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });

    await runner.startAgent({
      objective: "describe this",
      initialContent: [
        { type: "text", text: "describe this" },
        {
          type: "image_url",
          image_url: { url: "file:///tmp/cat.png" },
        },
      ],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(delegateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        taskPrompt: "describe this",
        taskContent: [
          { type: "text", text: "describe this" },
          {
            type: "image_url",
            image_url: { url: "file:///tmp/cat.png" },
          },
        ],
      }),
    );
  });

  it("passes non-duplicate startup text content into the initial delegate turn", async () => {
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
    };
    const delegateFn = vi.fn(async () => ({
      kind: "async_launched",
      thread: {
        threadId: "agent_text",
        agentPath: "/root/agent_text",
        join: vi.fn(() => new Promise(() => {})),
      } as AgentThread,
    })) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown: vi.fn(async () => {}),
      })) as unknown as AgenCBootstrapFunction,
      delegateFn,
      ensureAgentControl: vi.fn(() => ({
        control: { shutdown: vi.fn(async () => {}) },
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });

    await runner.startAgent({
      objective: "summarize",
      initialContent: "operator supplied details",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(delegateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        taskPrompt: "summarize",
        taskContent: [{ type: "text", text: "operator supplied details" }],
      }),
    );
  });

  it("restores a recovered live agent through the concrete runner", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "session-restart",
      permissionModeRegistry,
      services: {},
    };
    const live = restoredLiveAgent("run-restart", "/root/restart");
    const resumeAgentFromRollout = vi.fn(async () => ({
      resumedCount: 1,
      rootLive: live,
    }));
    const sendInput = vi.fn(async () => {});
    const control = {
      resumeAgentFromRollout,
      sendInput,
      shutdown: vi.fn(async () => {}),
    };
    const dispatch = vi.fn(async () => ({ content: "should not run" }));
    const execute = vi.fn(async () => ({ content: "file text" }));
    const replayResults: unknown[] = [];
    let runParams: Parameters<AgenCRunAgentFunction>[0] | undefined;
    const runAgentFn = async function* (
      params: Parameters<AgenCRunAgentFunction>[0],
    ) {
      runParams = params;
      params.live.status.markRunning("turn-restored");
      yield { kind: "status", text: "restored" };
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: {
          tools: [
            {
              name: "FileRead",
              description: "Read a file.",
              inputSchema: { type: "object" },
              recoveryCategory: "idempotent",
              isReadOnly: true,
              execute,
            },
          ],
          toLLMTools: () => [],
          dispatch,
        },
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const existingAssistantMessage = {
      role: "assistant" as const,
      content: "",
      toolCalls: [
        {
          id: "tool-existing",
          name: "FileRead",
          arguments: JSON.stringify({ file_path: "already.md" }),
        },
      ],
    };
    const initialMessages = [
      { role: "user" as const, content: "continue" },
      existingAssistantMessage,
    ];

    await expect(
      runner.restoreAgent({
        agentId: "run-restart",
        objective: "recover daemon state",
        cwd: "/workspace",
        currentSessionId: "session-restart",
        initialMessages,
        replayToolCalls: [
          {
            callId: "tool-existing",
            toolName: "FileRead",
            args: { file_path: "already.md" },
          },
          {
            callId: "tool-replay",
            toolName: "FileRead",
            args: { file_path: "README.md" },
          },
        ],
        onReplayToolResult: (result) => {
          replayResults.push(result);
        },
        metadata: {
          agentPath: "/root/restart",
          agentNickname: "restart",
          agentRole: "default",
          unattendedAllow: ["FileRead"],
          unattendedDeny: ["system.bash"],
        },
      }),
    ).resolves.toBe(true);
    expect(resumeAgentFromRollout).toHaveBeenCalledWith({
      rootThreadId: "run-restart",
      parentPath: "/root",
      metadata: expect.objectContaining({
        agentId: "run-restart",
        agentPath: "/root/restart",
        agentNickname: "restart",
      }),
    });
    expect(permissionModeRegistry.update).toHaveBeenCalledTimes(1);
    expect(permissionModeRegistry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "unattended",
        unattendedPolicy: {
          allowlist: ["FileRead"],
          denylist: ["system.bash"],
        },
      }),
    );
    await vi.waitFor(() => expect(replayResults).toHaveLength(2), {
      timeout: 5_000,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ file_path: "README.md" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ file_path: "already.md" }),
    );
    expect(replayResults).toEqual([
      {
        sessionId: "session-restart",
        callId: "tool-existing",
        toolName: "FileRead",
        result: "file text",
        isError: false,
        terminalStatus: "completed",
        recoveryCategory: "idempotent",
      },
      {
        sessionId: "session-restart",
        callId: "tool-replay",
        toolName: "FileRead",
        result: "file text",
        isError: false,
        terminalStatus: "completed",
        recoveryCategory: "idempotent",
      },
    ]);
    const replayedEvents: unknown[] = [];
    await runner.attachAgentSessionEvents("run-restart", {
      sessionId: "session-restart",
      emit: (event) => {
        replayedEvents.push(event);
      },
    });
    expect(replayedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "event.tool_request",
          params: expect.objectContaining({
            requestId: "tool-replay",
            toolName: "FileRead",
            recoveryCategory: "idempotent",
          }),
        }),
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            event: expect.objectContaining({
              type: "tool_call_completed",
              payload: expect.objectContaining({
                callId: "tool-replay",
                result: "file text",
                isError: false,
              }),
            }),
          }),
        }),
      ]),
    );

    const replayAssistantMessage = {
      role: "assistant" as const,
      content: "",
      toolCalls: [
        {
          id: "tool-replay",
          name: "FileRead",
          arguments: JSON.stringify({ file_path: "README.md" }),
        },
      ],
    };
    const replayToolMessage = {
      role: "tool" as const,
      content: "file text",
      toolCallId: "tool-replay",
      toolName: "FileRead",
    };
    const existingToolMessage = {
      role: "tool" as const,
      content: "file text",
      toolCallId: "tool-existing",
      toolName: "FileRead",
    };
    expect(runParams?.initialMessages).toEqual([
      ...initialMessages,
      existingToolMessage,
      replayAssistantMessage,
      replayToolMessage,
    ]);
    expect(
      runParams?.initialMessages.filter(
        (message) =>
          message.role === "assistant" &&
          message.toolCalls?.some(
            (toolCall) => toolCall.id === "tool-existing",
          ),
      ),
    ).toHaveLength(1);
    const wireMessages = prepareMessagesForWire(
      runParams?.initialMessages ?? [],
    );
    expect(wireMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining(replayAssistantMessage),
        expect.objectContaining(replayToolMessage),
        expect.objectContaining(existingToolMessage),
      ]),
    );
    expect(wireMessages.at(-1)).toMatchObject(replayToolMessage);
    await expect(runner.getAgentSnapshot("run-restart")).resolves.toMatchObject(
      {
        status: "running",
        lastActiveAt: "2026-05-01T12:00:00.500Z",
      },
    );
    await expect(
      runner.submitAgentMessage("run-restart", {
        sessionId: "session-restart",
        content: "follow up",
        originalContent: "follow up",
        messageId: "message-restore",
        streamId: "stream-restore",
        acceptedAt: "2026-05-01T12:00:01.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(sendInput).toHaveBeenCalledWith("run-restart", "follow up");
  });

  it("does not replay idempotent recovered calls that still require approval", async () => {
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "session-replay-approval-required",
      permissionModeRegistry,
      services: {},
      eventLog: {
        emit: vi.fn((event) => event),
      },
    };
    const live = restoredLiveAgent("run-replay-approval", "/root/replay");
    const resumeAgentFromRollout = vi.fn(async () => ({
      resumedCount: 1,
      rootLive: live,
    }));
    const execute = vi.fn(async () => ({ content: "should not execute" }));
    const replayResults: unknown[] = [];
    const runAgentFn = async function* () {
      yield { kind: "status", text: "restored" };
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: {
          tools: [
            {
              name: "FileRead",
              description: "Read a file.",
              inputSchema: { type: "object" },
              recoveryCategory: "idempotent",
              requiresApproval: true,
              execute,
            },
          ],
          toLLMTools: () => [],
          dispatch: vi.fn(async () => ({ content: "raw dispatch bypass" })),
        },
        shutdown: async () => {},
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control: {
          resumeAgentFromRollout,
          sendInput: async () => {},
          shutdown: async () => {},
        },
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
    });

    await expect(
      runner.restoreAgent({
        agentId: "run-replay-approval",
        objective: "recover daemon state",
        currentSessionId: "session-replay-approval-required",
        initialMessages: [{ role: "user" as const, content: "continue" }],
        replayToolCalls: [
          {
            callId: "tool-needs-approval",
            toolName: "FileRead",
            args: { file_path: "secret.txt" },
          },
        ],
        onReplayToolResult: (result) => {
          replayResults.push(result);
        },
        metadata: { agentPath: "/root/replay" },
      }),
    ).resolves.toBe(true);

    await vi.waitFor(() => expect(replayResults).toHaveLength(1), {
      timeout: 5_000,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(replayResults[0]).toMatchObject({
      sessionId: "session-replay-approval-required",
      callId: "tool-needs-approval",
      toolName: "FileRead",
      isError: true,
      terminalStatus: "failed",
      recoveryCategory: "idempotent",
    });
  });

  it("restores missing unattended metadata to the default unattended policy", async () => {
    const permissionUpdates: ToolPermissionContext[] = [];
    const runner = makeRestorePermissionRunner(permissionUpdates);

    await expect(
      runner.restoreAgent({
        agentId: "run-default-policy",
        objective: "recover daemon state",
      }),
    ).resolves.toBe(true);

    expect(permissionUpdates[0]).toMatchObject({
      mode: "unattended",
      unattendedPolicy: {
        allowlist: [],
        denylist: [],
      },
    });
  });

  it("restores explicit empty unattended metadata as an empty policy", async () => {
    const permissionUpdates: ToolPermissionContext[] = [];
    const runner = makeRestorePermissionRunner(permissionUpdates);

    await expect(
      runner.restoreAgent({
        agentId: "run-empty-policy",
        objective: "recover daemon state",
        metadata: {
          unattendedAllow: [],
          unattendedDeny: [],
        },
      }),
    ).resolves.toBe(true);

    expect(permissionUpdates[0]).toMatchObject({
      mode: "unattended",
      unattendedPolicy: {
        allowlist: [],
        denylist: [],
      },
    });
  });

  it("poisons recovered replay when the current registry is not idempotent", async () => {
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "session-registry-mismatch",
      permissionModeRegistry,
      services: {},
    };
    const live = restoredLiveAgent("run-registry-mismatch", "/root/mismatch");
    const resumeAgentFromRollout = vi.fn(async () => ({
      resumedCount: 1,
      rootLive: live,
    }));
    const dispatch = vi.fn(async () => ({ content: "should not run" }));
    const replayResults: unknown[] = [];
    let runParams: Parameters<AgenCRunAgentFunction>[0] | undefined;
    const runAgentFn = async function* (
      params: Parameters<AgenCRunAgentFunction>[0],
    ) {
      runParams = params;
      yield { kind: "status", text: "restored" };
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: {
          tools: [{ name: "FileWrite", recoveryCategory: "side-effecting" }],
          toLLMTools: () => [],
          dispatch,
        },
        shutdown: async () => {},
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control: {
          resumeAgentFromRollout,
          sendInput: async () => {},
          shutdown: async () => {},
        },
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
    });
    const initialMessages = [{ role: "user" as const, content: "continue" }];

    await expect(
      runner.restoreAgent({
        agentId: "run-registry-mismatch",
        objective: "recover daemon state",
        currentSessionId: "session-registry-mismatch",
        initialMessages,
        replayToolCalls: [
          {
            callId: "tool-lie",
            toolName: "FileWrite",
            args: { file_path: "a.txt", content: "x" },
          },
        ],
        onReplayToolResult: (result) => {
          replayResults.push(result);
        },
        metadata: { agentPath: "/root/mismatch" },
      }),
    ).resolves.toBe(true);

    expect(dispatch).not.toHaveBeenCalled();
    expect(replayResults).toEqual([
      {
        sessionId: "session-registry-mismatch",
        callId: "tool-lie",
        toolName: "FileWrite",
        result:
          "Recovered tool call tool-lie was not replayed because the current tool registration is missing or not idempotent.",
        isError: true,
        terminalStatus: "poisoned",
        recoveryCategory: "side-effecting",
      },
    ]);
    expect(runParams?.initialMessages).toEqual(initialMessages);
  });

  it("halts a recovered agent when the configured token cap is reached", async () => {
    const session = {
      conversationId: "session-budget-token",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
      services: {},
    };
    const live = restoredLiveAgent("run-budget-token", "/root/budget-token");
    const control = {
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: live,
      })),
      sendInput: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const runAgentFn = async function* (
      params: Parameters<AgenCRunAgentFunction>[0],
    ) {
      params.live.tokenUsage.inputTokens = 8;
      params.live.tokenUsage.outputTokens = 4;
      params.live.tokenUsage.totalTokens = 12;
      yield {
        kind: "run_complete",
        finalMessage: "done",
        toolCallCount: 0,
      };
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
        shutdown: vi.fn(async () => {}),
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
      agentBudget: { token_cap: 10 },
      now: () => "2026-05-01T12:00:10.000Z",
      budgetNowMs: () => Date.parse("2026-05-01T12:00:10.000Z"),
    });

    await expect(
      runner.restoreAgent({
        agentId: "run-budget-token",
        objective: "stay within token cap",
        startedAt: "2026-05-01T12:00:00.000Z",
        currentSessionId: "session-budget-token",
        model: "gpt-5.4",
        provider: "openai",
        metadata: { agentPath: "/root/budget-token" },
      }),
    ).resolves.toBe(true);
    const emitted: unknown[] = [];
    await runner.attachAgentSessionEvents("run-budget-token", {
      sessionId: "session-budget-token",
      emit: (event) => {
        emitted.push(event);
      },
    });

    await vi.waitFor(() =>
      expect(control.shutdown).toHaveBeenCalledWith(
        "run-budget-token",
        expect.stringContaining("token_cap"),
      ),
    );
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "stopped",
            runStatus: "stopped",
            message: expect.stringContaining("token_cap"),
            budgetHalt: expect.objectContaining({
              kind: "token_cap",
              cap: 10,
              observed: 12,
              reason: expect.stringContaining("agent budget token_cap reached"),
              costBasis: "input_output_token_usage",
              tokens: expect.objectContaining({ total: 12 }),
            }),
            budgetUsage: expect.objectContaining({
              totalTokens: 12,
              costBasis: "input_output_token_usage",
            }),
          }),
        }),
      ]),
    );
    await expect(runner.getAgentSnapshot("run-budget-token")).resolves.toEqual(
      expect.objectContaining({
        status: "stopped",
        metadata: {
          budgetHalt: expect.objectContaining({ kind: "token_cap" }),
        },
      }),
    );
    await expect(
      runner.submitAgentMessage("run-budget-token", {
        sessionId: "session-budget-token",
        content: "more work",
        originalContent: "more work",
        messageId: "message-after-budget",
        streamId: "stream-after-budget",
        acceptedAt: "2026-05-01T12:00:11.000Z",
      }),
    ).rejects.toThrow("AgenC daemon agent not running: run-budget-token");
    await expect(
      runner.resolveToolDecision("run-budget-token", {
        requestId: "tool-after-budget",
        decision: APPROVED,
      }),
    ).resolves.toBe(false);
    await expect(
      runner.cancelTool("run-budget-token", {
        requestId: "tool-after-budget",
      }),
    ).resolves.toBe(false);
    await expect(
      runner.respondToElicitation("run-budget-token", {
        requestId: "elicitation-after-budget",
        kind: "accept",
        response: {},
      }),
    ).resolves.toBe(false);
  });

  it("halts a recovered agent when the configured dollar cap is reached", async () => {
    const session = {
      conversationId: "session-budget-dollar",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
      services: {},
    };
    const live = restoredLiveAgent("run-budget-dollar", "/root/budget-dollar");
    const control = {
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: live,
      })),
      sendInput: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const runAgentFn = async function* (
      params: Parameters<AgenCRunAgentFunction>[0],
    ) {
      params.live.tokenUsage.inputTokens = 0;
      params.live.tokenUsage.outputTokens = 10;
      params.live.tokenUsage.totalTokens = 10;
      yield { kind: "status", text: "cost updated" };
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
        shutdown: vi.fn(async () => {}),
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
      agentBudget: { dollar_cap: 0.00001 },
      now: () => "2026-05-01T12:00:10.000Z",
      budgetNowMs: () => Date.parse("2026-05-01T12:00:10.000Z"),
    });

    await expect(
      runner.restoreAgent({
        agentId: "run-budget-dollar",
        objective: "stay within dollar cap",
        startedAt: "2026-05-01T12:00:00.000Z",
        currentSessionId: "session-budget-dollar",
        model: "gpt-5.4",
        provider: "openai",
        metadata: { agentPath: "/root/budget-dollar" },
      }),
    ).resolves.toBe(true);
    const emitted: unknown[] = [];
    await runner.attachAgentSessionEvents("run-budget-dollar", {
      sessionId: "session-budget-dollar",
      emit: (event) => {
        emitted.push(event);
      },
    });

    await vi.waitFor(() =>
      expect(control.shutdown).toHaveBeenCalledWith(
        "run-budget-dollar",
        expect.stringContaining("dollar_cap"),
      ),
    );
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "stopped",
            runStatus: "stopped",
            message: expect.stringContaining("dollar_cap"),
            budgetHalt: expect.objectContaining({
              kind: "dollar_cap",
              cap: 0.00001,
              observed: expect.any(Number),
              costUsd: expect.any(Number),
              costBasis: "input_output_token_usage",
            }),
            budgetUsage: expect.objectContaining({
              totalTokens: 10,
              costBasis: "input_output_token_usage",
            }),
          }),
        }),
      ]),
    );
  });

  it("restores prior budget usage before enforcing caps", async () => {
    const session = {
      conversationId: "session-budget-prior",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
      services: {},
    };
    const live = restoredLiveAgent("run-budget-prior", "/root/budget-prior");
    const control = {
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: live,
      })),
      sendInput: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const runAgentFn = async function* () {
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
        shutdown: vi.fn(async () => {}),
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
      agentBudget: { token_cap: 10 },
      now: () => "2026-05-01T12:00:10.000Z",
      budgetNowMs: () => Date.parse("2026-05-01T12:00:10.000Z"),
    });

    await expect(
      runner.restoreAgent({
        agentId: "run-budget-prior",
        objective: "resume with prior usage",
        startedAt: "2026-05-01T12:00:00.000Z",
        currentSessionId: "session-budget-prior",
        model: "gpt-5.4",
        provider: "openai",
        metadata: {
          agentPath: "/root/budget-prior",
          budgetUsage: {
            inputTokens: 9,
            outputTokens: 1,
            totalTokens: 10,
            costUsd: 0.00002,
          },
        },
      }),
    ).resolves.toBe(true);

    await vi.waitFor(() =>
      expect(control.shutdown).toHaveBeenCalledWith(
        "run-budget-prior",
        expect.stringContaining("token_cap"),
      ),
    );
    const emitted: unknown[] = [];
    await runner.attachAgentSessionEvents("run-budget-prior", {
      sessionId: "session-budget-prior",
      emit: (event) => {
        emitted.push(event);
      },
    });
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            budgetHalt: expect.objectContaining({
              kind: "token_cap",
              observed: 10,
              tokens: expect.objectContaining({
                input: 9,
                output: 1,
                total: 10,
              }),
            }),
            budgetUsage: expect.objectContaining({
              inputTokens: 9,
              outputTokens: 1,
              totalTokens: 10,
              costUsd: 0.00002,
            }),
          }),
        }),
      ]),
    );
  });

  it("still shuts down when budget halt notification delivery fails", async () => {
    const session = {
      conversationId: "session-budget-emit-fail",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
      services: {},
    };
    const live = restoredLiveAgent(
      "run-budget-emit-fail",
      "/root/budget-emit-fail",
    );
    const shutdown = vi.fn(async () => {});
    const control = {
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: live,
      })),
      sendInput: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    let release!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runAgentFn = async function* (
      params: Parameters<AgenCRunAgentFunction>[0],
    ) {
      await progressGate;
      params.live.tokenUsage.inputTokens = 12;
      params.live.tokenUsage.outputTokens = 0;
      params.live.tokenUsage.totalTokens = 12;
      yield {
        kind: "run_complete",
        finalMessage: "done",
        toolCallCount: 0,
      };
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
      agentBudget: { token_cap: 10 },
      now: () => "2026-05-01T12:00:10.000Z",
      budgetNowMs: () => Date.parse("2026-05-01T12:00:10.000Z"),
    });

    await expect(
      runner.restoreAgent({
        agentId: "run-budget-emit-fail",
        objective: "halt despite notification failure",
        currentSessionId: "session-budget-emit-fail",
        metadata: { agentPath: "/root/budget-emit-fail" },
      }),
    ).resolves.toBe(true);
    await runner.attachAgentSessionEvents("run-budget-emit-fail", {
      sessionId: "session-budget-emit-fail",
      emit: vi.fn(async () => {
        throw new Error("broadcast failed");
      }),
    });

    release();

    await vi.waitFor(() =>
      expect(control.shutdown).toHaveBeenCalledWith(
        "run-budget-emit-fail",
        expect.stringContaining("token_cap"),
      ),
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
    await expect(
      runner.submitAgentMessage("run-budget-emit-fail", {
        sessionId: "session-budget-emit-fail",
        content: "more work",
        originalContent: "more work",
        messageId: "message-after-failed-budget-emit",
        streamId: "stream-after-failed-budget-emit",
        acceptedAt: "2026-05-01T12:00:11.000Z",
      }),
    ).rejects.toThrow("AgenC daemon agent not running: run-budget-emit-fail");
  });

  it("halts at the usage update boundary before a queued follow-up turn starts", async () => {
    const session = {
      conversationId: "session-budget-boundary",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
      services: {},
    };
    const live = restoredLiveAgent(
      "run-budget-boundary",
      "/root/budget-boundary",
    );
    const control = {
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: live,
      })),
      sendInput: vi.fn(async () => {}),
      shutdown: vi.fn(async (agentId: string, reason: string) => {
        live.abortController.abort(reason);
        void agentId;
      }),
    };
    let secondTurnStarted = false;
    const runAgentFn = async function* (
      params: Parameters<AgenCRunAgentFunction>[0],
    ) {
      params.live.tokenUsage.inputTokens = 8;
      params.live.tokenUsage.outputTokens = 4;
      params.live.tokenUsage.totalTokens = 12;
      yield {
        kind: "usage_update",
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
      };
      if (params.live.abortController.signal.aborted) {
        return {
          threadId: params.live.agentId,
          durationMs: 1,
          outcome: "interrupted",
          toolCallCount: 0,
        };
      }
      secondTurnStarted = true;
      yield { kind: "status", text: "second provider turn started" };
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
        shutdown: vi.fn(async () => {}),
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
      agentBudget: { token_cap: 10 },
      now: () => "2026-05-01T12:00:10.000Z",
      budgetNowMs: () => Date.parse("2026-05-01T12:00:10.000Z"),
    });

    await expect(
      runner.restoreAgent({
        agentId: "run-budget-boundary",
        objective: "stop before next turn",
        currentSessionId: "session-budget-boundary",
        metadata: { agentPath: "/root/budget-boundary" },
      }),
    ).resolves.toBe(true);

    await vi.waitFor(() =>
      expect(control.shutdown).toHaveBeenCalledWith(
        "run-budget-boundary",
        expect.stringContaining("token_cap"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondTurnStarted).toBe(false);
  });

  it("halts an idle recovered agent when the wall-clock cap timer fires", async () => {
    const startedAtMs = Date.parse("2026-05-01T12:00:00.000Z");
    let nowMs = startedAtMs;
    let timerCallback: (() => void) | undefined;
    const timer = { unref: vi.fn() };
    const clearBudgetTimer = vi.fn();
    const session = {
      conversationId: "session-budget-wall",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
      services: {},
    };
    const live = restoredLiveAgent("run-budget-wall", "/root/budget-wall");
    const control = {
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: live,
      })),
      sendInput: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const runAgentFn = async function* () {
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
        shutdown: vi.fn(async () => {}),
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
      agentBudget: { wall_clock_seconds: 30 },
      now: () => new Date(nowMs).toISOString(),
      budgetNowMs: () => nowMs,
      setBudgetTimer: (callback, delayMs) => {
        expect(delayMs).toBe(30_000);
        timerCallback = callback;
        return timer;
      },
      clearBudgetTimer,
    });

    await expect(
      runner.restoreAgent({
        agentId: "run-budget-wall",
        objective: "stay within wall clock",
        startedAt: "2026-05-01T12:00:00.000Z",
        currentSessionId: "session-budget-wall",
        metadata: { agentPath: "/root/budget-wall" },
      }),
    ).resolves.toBe(true);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    const emitted: unknown[] = [];
    await runner.attachAgentSessionEvents("run-budget-wall", {
      sessionId: "session-budget-wall",
      emit: (event) => {
        emitted.push(event);
      },
    });

    nowMs = startedAtMs + 30_000;
    timerCallback?.();

    await vi.waitFor(() =>
      expect(control.shutdown).toHaveBeenCalledWith(
        "run-budget-wall",
        expect.stringContaining("wall_clock_seconds"),
      ),
    );
    expect(clearBudgetTimer).toHaveBeenCalledWith(timer);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "stopped",
            runStatus: "stopped",
            budgetHalt: expect.objectContaining({
              kind: "wall_clock_seconds",
              cap: 30,
              observed: 30,
            }),
          }),
        }),
      ]),
    );
  });

  it("reschedules wall-clock caps that exceed the Node timer range", async () => {
    const startedAtMs = Date.parse("2026-05-01T12:00:00.000Z");
    let nowMs = startedAtMs;
    const timerCallbacks: Array<() => void> = [];
    const delays: number[] = [];
    const session = {
      conversationId: "session-budget-wall-long",
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
      services: {},
    };
    const live = restoredLiveAgent(
      "run-budget-wall-long",
      "/root/budget-wall-long",
    );
    const control = {
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive: live,
      })),
      sendInput: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const runAgentFn = async function* () {
      await new Promise(() => {});
    } as AgenCRunAgentFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        registry: { tools: [], toLLMTools: () => [], dispatch: vi.fn() },
        shutdown: vi.fn(async () => {}),
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      runAgentFn,
      agentBudget: { wall_clock_seconds: 2_147_484.647 },
      now: () => new Date(nowMs).toISOString(),
      budgetNowMs: () => nowMs,
      setBudgetTimer: (callback, delayMs) => {
        delays.push(delayMs);
        timerCallbacks.push(callback);
        return { unref: vi.fn() };
      },
      clearBudgetTimer: vi.fn(),
    });

    await expect(
      runner.restoreAgent({
        agentId: "run-budget-wall-long",
        objective: "stay within long wall clock",
        startedAt: "2026-05-01T12:00:00.000Z",
        currentSessionId: "session-budget-wall-long",
        metadata: { agentPath: "/root/budget-wall-long" },
      }),
    ).resolves.toBe(true);
    expect(delays[0]).toBe(2_147_483_647);

    nowMs = startedAtMs + 2_147_483_647;
    timerCallbacks[0]?.();
    expect(control.shutdown).not.toHaveBeenCalled();
    expect(delays[1]).toBe(1000);

    nowMs = startedAtMs + 2_147_484_647;
    timerCallbacks[1]?.();
    await vi.waitFor(() =>
      expect(control.shutdown).toHaveBeenCalledWith(
        "run-budget-wall-long",
        expect.stringContaining("wall_clock_seconds"),
      ),
    );
  });

  it("buffers a start-path budget halt before a session is attached", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const live = restoredLiveAgent("agent-budget-start", "/root/budget-start");
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent-budget-start",
      agentPath: "/root/budget-start",
      live,
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      agentBudget: { token_cap: 0 },
      now: () => "2026-05-01T12:00:00.500Z",
      budgetNowMs: () => Date.parse("2026-05-01T12:00:00.500Z"),
    });

    await expect(
      runner.startAgent({
        objective: "halt immediately",
        unattendedAllow: [],
        unattendedDeny: [],
      }),
    ).resolves.toMatchObject({
      agentId: "agent-budget-start",
      status: "running",
    });
    await vi.waitFor(() =>
      expect(control.shutdown).toHaveBeenCalledWith(
        "agent-budget-start",
        expect.stringContaining("token_cap"),
      ),
    );
    expect(shutdown).toHaveBeenCalledTimes(1);

    const replayedEvents: unknown[] = [];
    await runner.attachAgentSessionEvents("agent-budget-start", {
      sessionId: "session-budget-start",
      emit: (event) => {
        replayedEvents.push(event);
      },
    });
    expect(replayedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            sessionId: "session-budget-start",
            status: "stopped",
            runStatus: "stopped",
            message: expect.stringContaining("token_cap"),
            budgetHalt: expect.objectContaining({
              kind: "token_cap",
              cap: 0,
              observed: 0,
              reason: expect.stringContaining("agent budget token_cap reached"),
            }),
          }),
        }),
      ]),
    );
  });

  it("passes the daemon AuthBackend into delegate bootstrap", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as AgentThread;
    const authBackend: AuthBackend = {
      login: vi.fn(() => ({ authenticated: true, provider: "local" })),
      logout: vi.fn(() => ({ authenticated: false })),
      whoami: vi.fn(() => ({ authenticated: true, provider: "local" })),
      vendKey: vi.fn((provider, sessionId) => ({
        provider: String(provider),
        sessionId,
        apiKey: "managed-key",
      })),
      inferAgencModel: vi.fn(() => ({
        provider: "agenc",
        model: "agenc:grok",
      })),
      getSubscriptionTier: vi.fn(() => "pro"),
    };
    const bootstrap = vi.fn(async () => ({
      session,
      shutdown,
    })) as unknown as AgenCBootstrapFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      authBackend,
      bootstrap,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
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

  it("resolves active agent realtime bindings with daemon transport clients", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      conversation: new RealtimeConversationManager(),
      permissionModeRegistry,
    };
    const control = { sendInput: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_realtime",
      agentPath: "/root/agent_realtime",
      join: vi.fn(() => new Promise(() => {})),
    } as AgentThread;
    const bootstrap = vi.fn(async () => ({
      session,
      shutdown,
    })) as unknown as AgenCBootstrapFunction;
    const callClient = new AgenCRealtimeCallClient({
      baseUrl: "https://api.openai.com/v1",
      fetch: async () => ({
        status: 201,
        headers: { get: () => "/v1/realtime/calls/rtc_test" },
        text: async () => "answer-sdp",
      }),
    });
    const realtimeConnectTransport = vi.fn(async () => ({
      writer: {
        sendAudioFrame: vi.fn(),
        sendConversationItemCreate: vi.fn(),
        sendConversationFunctionCallOutput: vi.fn(),
        sendResponseCreate: vi.fn(),
        sendPayload: vi.fn(),
      },
      nextEvent: vi.fn(async () => null),
      close: vi.fn(),
    }));
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      realtimeCallClient: callClient,
      realtimeConnectTransport,
    });

    await runner.startAgent({
      objective: "open realtime",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const binding = await runner.resolveRealtimeThread("agent_realtime");

    expect(binding).toMatchObject({
      threadId: "agent_realtime",
      conversation: session.conversation,
      session,
      callClient,
    });
    expect(binding?.connectTransport).toBe(realtimeConnectTransport);
    await binding?.routeRealtimeTextInput?.("hello");
    expect(control.sendInput).toHaveBeenCalledWith("agent_realtime", "hello");
  });

  it("still shuts down bootstrap resources when control shutdown fails", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = {
      shutdown: vi.fn(async () => {
        throw new Error("control shutdown failed");
      }),
    };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await expect(
      runner.stopAgent("agent_live", "operator stop"),
    ).rejects.toThrow("control shutdown failed");
    expect(control.shutdown).toHaveBeenCalledWith(
      "agent_live",
      "operator stop",
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
    await expect(runner.getAgentSnapshot("agent_live")).resolves.toEqual({
      status: "error",
      lastActiveAt: "2026-05-01T12:00:00.500Z",
    });
  });

  it("replays real delegate progress to the bound daemon session and routes attached input to the live agent", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = {
      shutdown: vi.fn(async () => {}),
      sendInput: vi.fn(async () => {}),
    };
    let statusListener: ((status: AgentStatus) => void) | undefined;
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      onStatusChange: vi.fn((listener: (status: AgentStatus) => void) => {
        statusListener = listener;
        listener({ status: "pending_init" });
        return vi.fn();
      }),
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const delegateFn = vi.fn(
      async (opts: Parameters<AgenCDelegateFunction>[0]) => {
        await opts.onProgress?.(
          {
            kind: "message",
            message: { role: "assistant", content: "he" },
          },
          thread,
        );
        await opts.onProgress?.(
          {
            kind: "message",
            message: { role: "assistant", content: "hello" },
          },
          thread,
        );
        await opts.onProgress?.(
          {
            kind: "tool_call",
            callId: "tool_1",
            toolName: "FileRead",
            arguments: JSON.stringify({ path: "src/index.ts" }),
          },
          thread,
        );
        await opts.onProgress?.(
          {
            kind: "tool_result",
            callId: "tool_1",
            toolName: "FileRead",
            result: "file text",
            isError: false,
          },
          thread,
        );
        return {
          kind: "async_launched",
          thread,
        };
      },
    ) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    statusListener?.({
      status: "completed",
      turnId: "turn_1",
      endedAtMs: 100,
      lastMessage: "hello",
    });
    await runner.submitAgentMessage("agent_live", {
      sessionId: "session_1",
      content: "continue",
      originalContent: "continue",
      messageId: "message_1",
      streamId: "stream_1",
      acceptedAt: "2026-05-01T12:00:01.000Z",
    });

    expect(control.sendInput).toHaveBeenCalledWith("agent_live", "continue");
    expect(emitted).toEqual([
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.message_chunk",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: expect.any(String),
          delta: "he",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.message_chunk",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: expect.any(String),
          delta: "llo",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.tool_request",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: "tool_1",
          requestId: "tool_1",
          toolName: "FileRead",
          input: { path: "src/index.ts" },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: "tool-result-tool_1",
          event: {
            id: "tool-result-tool_1",
            type: "tool_call_completed",
            payload: {
              callId: "tool_1",
              result: "file text",
              isError: false,
              metadata: {
                toolName: "FileRead",
              },
            },
          },
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.agent_status",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: expect.any(String),
          status: "idle",
          runStatus: "completed",
          turnId: "turn_1",
          message: "hello",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
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
      },
    ]);
  });

  it("emits final interrupted progress as a stopped agent-status event", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const delegateFn = vi.fn(
      async (opts: Parameters<AgenCDelegateFunction>[0]) => {
        await opts.onProgress?.(
          {
            kind: "run_interrupted",
            reason: "operator interrupted",
          },
          thread,
        );
        return {
          kind: "async_launched",
          thread,
        };
      },
    ) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });

    expect(emitted).toContainEqual({
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        sessionId: "session_1",
        agentId: "agent_live",
        eventId: expect.any(String),
        status: "stopped",
        runStatus: "stopped",
        message: "operator interrupted",
      },
    });
  });

  it("emits run completion progress as a completed agent-status event", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const delegateFn = vi.fn(
      async (opts: Parameters<AgenCDelegateFunction>[0]) => {
        await opts.onProgress?.(
          {
            kind: "run_complete",
            finalMessage: "done",
            toolCallCount: 0,
          },
          thread,
        );
        return {
          kind: "async_launched",
          thread,
        };
      },
    ) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });

    expect(emitted).toContainEqual({
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        sessionId: "session_1",
        agentId: "agent_live",
        eventId: expect.any(String),
        status: "idle",
        runStatus: "completed",
        message: "done",
      },
    });
  });

  it("replays terminal progress when the thread completes before session attach", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(async () => ({
        threadId: "agent_live",
        durationMs: 1,
        outcome: "completed",
        finalMessage: "done",
      })),
    } as unknown as AgentThread;
    const delegateFn = vi.fn(
      async (opts: Parameters<AgenCDelegateFunction>[0]) => {
        await opts.onProgress?.(
          {
            kind: "run_complete",
            finalMessage: "done",
            toolCallCount: 0,
          },
          thread,
        );
        return {
          kind: "async_launched",
          thread,
        };
      },
    ) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await Promise.resolve();
    await Promise.resolve();
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });

    expect(emitted).toContainEqual({
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        sessionId: "session_1",
        agentId: "agent_live",
        eventId: expect.any(String),
        status: "idle",
        runStatus: "completed",
        message: "done",
      },
    });
  });

  it("feeds runner-emitted tool requests through the TUI adapter with real input", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const delegateFn = vi.fn(
      async (opts: Parameters<AgenCDelegateFunction>[0]) => {
        await opts.onProgress?.(
          {
            kind: "tool_call",
            callId: "tool_1",
            toolName: "FileRead",
            arguments: JSON.stringify({ path: "src/index.ts" }),
          },
          thread,
        );
        return {
          kind: "async_launched",
          thread,
        };
      },
    ) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    let sessionListener: ((event: JsonObject) => void) | undefined;
    const client: AgenCDaemonTuiClient = {
      request: async () => ({}) as never,
      subscribeToSessionEvents: (sessionId, listener) => {
        expect(sessionId).toBe("session_1");
        sessionListener = listener;
        return () => {
          sessionListener = undefined;
        };
      },
    };
    const tuiSession = createDaemonTuiSession({
      baseSession: { conversationId: "session_1", services: {} },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });
    const received: JsonObject[] = [];
    const unsubscribe = tuiSession.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        sessionListener?.(event as JsonObject);
      },
    });
    unsubscribe();

    expect(received).toEqual([
      {
        id: "tool_1",
        type: "tool_call_started",
        payload: {
          callId: "tool_1",
          toolName: "FileRead",
          args: JSON.stringify({ path: "src/index.ts" }),
        },
      },
    ]);
  });

  it("forwards session elicitation waits as typed daemon notifications", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    let sessionEventListener:
      | ((event: {
          readonly id: string;
          readonly msg: {
            readonly type: string;
            readonly payload: JsonObject;
          };
        }) => void)
      | undefined;
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
      services: {},
      eventLog: {
        subscribe: vi.fn((listener) => {
          sessionEventListener = listener;
          return vi.fn();
        }),
      },
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    sessionEventListener?.({
      id: "input_1",
      msg: {
        type: "request_user_input",
        payload: {
          callId: "call_1",
          turnId: "turn_1",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Proceed?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Yes", description: "Continue." },
                { label: "No", description: "Stop." },
              ],
            },
          ],
        },
      },
    });
    sessionEventListener?.({
      id: "mcp_1",
      msg: {
        type: "mcp_elicitation_request",
        payload: {
          serverName: "srv",
          requestId: "mcp_1",
          turnId: "turn_1",
          request: {
            mode: "form",
            message: "Need details",
            requestedSchema: { type: "object", properties: {} },
          },
        },
      },
    });
    await Promise.resolve();

    expect(emitted).toEqual([
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.user_input_request",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: "input_1",
          requestId: "call_1",
          callId: "call_1",
          turnId: "turn_1",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Proceed?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Yes", description: "Continue." },
                { label: "No", description: "Stop." },
              ],
            },
          ],
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.mcp_elicitation_request",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: "mcp_1",
          requestId: "mcp_1",
          serverName: "srv",
          turnId: "turn_1",
          request: {
            mode: "form",
            message: "Need details",
            requestedSchema: { type: "object", properties: {} },
          },
        },
      },
    ]);
  });

  it("bridges background tool approvals through daemon session decisions", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const services: { approvalResolver?: ApprovalResolver } = {};
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
      services,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    let resolver: ApprovalResolver | undefined;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async (opts: Parameters<AgenCDelegateFunction>[0]) => {
        resolver = opts.parent.services.approvalResolver;
        return {
          kind: "async_launched",
          thread,
        };
      }) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });

    const decision = resolver!.request({
      callId: "call_1",
      toolName: "Bash",
      turnId: "turn_1",
      invocation: {
        session: { conversationId: "agent_live" },
        payload: {
          kind: "function",
          arguments: JSON.stringify({ command: "pwd" }),
        },
      },
    } as never);
    await Promise.resolve();

    expect(emitted).toEqual([
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.permission_request",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: "call_1",
          requestId: "call_1",
          toolName: "Bash",
          turnId: "turn_1",
          permissions: ["tool.use"],
          input: { command: "pwd" },
        },
      },
    ]);
    await expect(
      runner.resolveToolDecision("agent_live", {
        requestId: "call_1",
        decision: APPROVED,
      }),
    ).resolves.toBe(true);
    await expect(decision).resolves.toBe(APPROVED);
  });

  it("cancels active background tool work by interrupting the live agent", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const services: { approvalResolver?: ApprovalResolver } = {};
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
      services,
    };
    const control = {
      interrupt: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    let resolver: ApprovalResolver | undefined;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async (opts: Parameters<AgenCDelegateFunction>[0]) => {
        resolver = opts.parent.services.approvalResolver;
        return {
          kind: "async_launched",
          thread,
        };
      }) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const decision = resolver!.request({
      callId: "call_1",
      toolName: "Bash",
      turnId: "turn_1",
      invocation: {
        session: { conversationId: "agent_live" },
        payload: {
          kind: "function",
          arguments: JSON.stringify({ command: "sleep 60" }),
        },
      },
    } as never);
    await Promise.resolve();

    await expect(
      runner.cancelTool("agent_live", {
        requestId: "call_1",
        reason: "user stop",
      }),
    ).resolves.toBe(true);
    expect(control.interrupt).toHaveBeenCalledWith("agent_live", "user stop");
    await expect(decision).resolves.toBe(ABORT);
  });

  it("does not interrupt an active agent for an unknown tool cancel request", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = {
      interrupt: vi.fn(),
      shutdown: vi.fn(async () => {}),
    };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async (opts: Parameters<AgenCDelegateFunction>[0]) => {
        await opts.onProgress?.(
          {
            kind: "tool_call",
            callId: "call_known",
            toolName: "Bash",
          },
          thread,
        );
        return {
          kind: "async_launched",
          thread,
        };
      }) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await expect(
      runner.cancelTool("agent_live", {
        requestId: "missing_call",
        reason: "stale client request",
      }),
    ).resolves.toBe(false);
    expect(control.interrupt).not.toHaveBeenCalled();

    await expect(
      runner.cancelTool("agent_live", {
        requestId: "call_known",
        reason: "user stop",
      }),
    ).resolves.toBe(true);
    expect(control.interrupt).toHaveBeenCalledWith("agent_live", "user stop");
  });

  it("preserves structured attached input and honors hidden display submits", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = {
      shutdown: vi.fn(async () => {}),
      sendInput: vi.fn(async () => {}),
    };
    const downInbox = { send: vi.fn(() => "sent") };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      live: {
        agentPath: "/root/agent_live",
        downInbox,
      },
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    await runner.submitAgentMessage("agent_live", {
      sessionId: "session_1",
      content: [
        { type: "text", text: "inspect" },
        {
          type: "image_url",
          image_url: { url: "file:///tmp/screenshot.png" },
        },
      ],
      originalContent: [
        { type: "text", text: "inspect" },
        {
          type: "image_url",
          image_url: { url: "file:///tmp/screenshot.png" },
        },
      ],
      displayUserMessage: null,
      messageId: "message_1",
      streamId: "stream_1",
      acceptedAt: "2026-05-01T12:00:01.000Z",
    });

    expect(control.sendInput).not.toHaveBeenCalled();
    expect(downInbox.send).toHaveBeenCalledWith({
      author: "/root/agent_live",
      recipient: "/root/agent_live",
      content: "inspect\n[image]",
      triggerTurn: true,
      direction: "down",
      metadata: {
        kind: "user_input",
        inputContent: [
          { type: "text", text: "inspect" },
          {
            type: "image_url",
            image_url: { url: "file:///tmp/screenshot.png" },
          },
        ],
      },
    });
    expect(emitted).toEqual([]);
  });

  it("clears daemon-owned agent history before emitting history_cleared", async () => {
    const shutdown = vi.fn(async () => {});
    const parentHistory = [{ role: "user", content: "old parent turn" }];
    const clearProviderResponseId = vi.fn();
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
      state: {
        with: vi.fn(async (fn: (state: { history: unknown[] }) => void) =>
          fn({ history: parentHistory }),
        ),
      },
      services: {},
      clearProviderResponseId,
    };
    const clearConversationHistory = vi.fn(async () => {});
    const control = {
      shutdown: vi.fn(async () => {}),
      clearConversationHistory,
    };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      live: {
        messages: [{ role: "assistant", content: "old child reply" }],
      },
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emit = vi.fn(async () => {});

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit,
    });

    await runner.clearAgentSession("agent_live", {
      sessionId: "session_1",
      clearedAt: "2026-05-01T12:00:01.000Z",
    });

    expect(parentHistory).toEqual([]);
    expect(clearProviderResponseId).toHaveBeenCalledTimes(1);
    expect(clearConversationHistory).toHaveBeenCalledWith("agent_live");
    expect(clearConversationHistory.mock.invocationCallOrder[0]).toBeLessThan(
      emit.mock.invocationCallOrder[0]!,
    );
    expect(emit).toHaveBeenCalledWith({
      jsonrpc: JSON_RPC_VERSION,
      method: "event.session_event",
      params: {
        sessionId: "session_1",
        agentId: "agent_live",
        eventId: "history-cleared-session_1-2026-05-01T12:00:01.000Z",
        acceptedAt: "2026-05-01T12:00:01.000Z",
        event: {
          id: "history-cleared-session_1-2026-05-01T12:00:01.000Z",
          type: "history_cleared",
          acceptedAt: "2026-05-01T12:00:01.000Z",
          payload: { timestamp: Date.parse("2026-05-01T12:00:01.000Z") },
        },
      },
    });
  });

  it("refuses daemon clear while the owning session has an active turn", async () => {
    const shutdown = vi.fn(async () => {});
    const parentHistory = [{ role: "user", content: "old parent turn" }];
    const clearProviderResponseId = vi.fn();
    const stateWith = vi.fn(async (fn: (state: { history: unknown[] }) => void) =>
      fn({ history: parentHistory }),
    );
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
      activeTurn: {
        unsafePeek: () => ({ turnId: "turn_1" }),
      },
      state: {
        with: stateWith,
      },
      services: {},
      clearProviderResponseId,
    };
    const clearConversationHistory = vi.fn(async () => {});
    const control = {
      shutdown: vi.fn(async () => {}),
      clearConversationHistory,
    };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      live: {
        messages: [{ role: "assistant", content: "old child reply" }],
      },
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emit = vi.fn(async () => {});

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit,
    });

    await expect(
      runner.clearAgentSession("agent_live", {
        sessionId: "session_1",
        clearedAt: "2026-05-01T12:00:01.000Z",
      }),
    ).rejects.toThrow("Cannot clear right now");

    expect(parentHistory).toEqual([{ role: "user", content: "old parent turn" }]);
    expect(stateWith).not.toHaveBeenCalled();
    expect(clearProviderResponseId).not.toHaveBeenCalled();
    expect(clearConversationHistory).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("reports live status freshness from thread status changes", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    let currentStatus: AgentStatus = {
      status: "running",
      turnId: "turn-1",
      startedAtMs: 1,
    };
    let statusListener: ((status: AgentStatus) => void) | undefined;
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      get currentStatus() {
        return currentStatus;
      },
      onStatusChange: vi.fn((listener: (status: AgentStatus) => void) => {
        statusListener = listener;
        listener(currentStatus);
        return vi.fn();
      }),
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const times = ["2026-05-01T12:00:00.500Z", "2026-05-01T12:00:01.000Z"];
    let timeIndex = 0;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      now: () => {
        const value = times[timeIndex];
        if (value === undefined) throw new Error("test time exhausted");
        timeIndex += 1;
        return value;
      },
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await expect(runner.getAgentSnapshot("agent_live")).resolves.toEqual({
      status: "running",
      lastActiveAt: "2026-05-01T12:00:00.500Z",
    });

    currentStatus = {
      status: "interrupted",
      turnId: "turn-1",
      endedAtMs: 2,
      reason: "waiting for approval",
    };
    statusListener?.(currentStatus);

    await expect(runner.getAgentSnapshot("agent_live")).resolves.toEqual({
      status: "running",
      lastActiveAt: "2026-05-01T12:00:01.000Z",
    });
  });

  it("preserves interrupted thread status as a turn_aborted session event", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    let currentStatus: AgentStatus = {
      status: "running",
      turnId: "turn-1",
      startedAtMs: 1,
    };
    let statusListener: ((status: AgentStatus) => void) | undefined;
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      get currentStatus() {
        return currentStatus;
      },
      onStatusChange: vi.fn((listener: (status: AgentStatus) => void) => {
        statusListener = listener;
        listener(currentStatus);
        return vi.fn();
      }),
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    currentStatus = {
      status: "interrupted",
      turnId: "turn-1",
      endedAtMs: 2,
      reason: "waiting for approval",
    };
    statusListener?.(currentStatus);

    expect(emitted).toEqual([
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.agent_status",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: "turn-1",
          status: "running",
          runStatus: "running",
          turnId: "turn-1",
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "agent_live",
          eventId: "turn-1",
          event: {
            id: "turn-1",
            type: "turn_aborted",
            payload: {
              turnId: "turn-1",
              reason: "waiting for approval",
            },
          },
        },
      },
    ]);
  });

  it.each([
    {
      status: "shutdown" as const,
      threadStatus: { status: "shutdown" as const, endedAtMs: 2 },
      eventId: "shutdown-2",
      message: "shutdown",
    },
    {
      status: "not_found" as const,
      threadStatus: { status: "not_found" as const },
      eventId: "not-found",
      message: "not_found",
    },
  ])("emits %s thread status as a stopped agent-status event", async (item) => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = {
      conversationId: "parent-session",
      permissionModeRegistry,
    };
    const control = { shutdown: vi.fn(async () => {}) };
    let currentStatus: AgentStatus = {
      status: "running",
      turnId: "turn-1",
      startedAtMs: 1,
    };
    let statusListener: ((status: AgentStatus) => void) | undefined;
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      get currentStatus() {
        return currentStatus;
      },
      onStatusChange: vi.fn((listener: (status: AgentStatus) => void) => {
        statusListener = listener;
        listener(currentStatus);
        return vi.fn();
      }),
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
      now: () => "2026-05-01T12:00:00.500Z",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("agent_live", {
      sessionId: "session_1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    currentStatus = item.threadStatus;
    statusListener?.(currentStatus);

    expect(emitted).toContainEqual({
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        sessionId: "session_1",
        agentId: "agent_live",
        eventId: item.eventId,
        status: "stopped",
        runStatus: "stopped",
        message: item.message,
      },
    });
  });

  it("shuts down the bootstrap when delegate rejects the background start", async () => {
    const shutdown = vi.fn(async () => {});
    const bootstrap = vi.fn(async () => ({
      session: {
        permissionModeRegistry: {
          current: () => createEmptyToolPermissionContext(),
          update: vi.fn(async () => {}),
        },
      },
      shutdown,
    })) as unknown as AgenCBootstrapFunction;
    const ensureAgentControl = vi.fn(() => ({
      control: {},
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction;
    const delegateFn = vi.fn(async () => ({
      kind: "rejected",
      reason: "not enough slots",
    })) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap,
      delegateFn,
      ensureAgentControl,
    });

    await expect(
      runner.startAgent({
        objective: "compile the daemon",
        unattendedAllow: ["FileRead"],
        unattendedDeny: [],
      }),
    ).rejects.toThrow("not enough slots");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("releases retained bootstrap state when the background thread finishes", async () => {
    const shutdown = vi.fn(async () => {});
    const session = {
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
    };
    const control = { shutdown: vi.fn(async () => {}) };
    let finishThread!: () => void;
    const thread = {
      threadId: "agent_done",
      agentPath: "/root/agent_done",
      join: vi.fn(
        () =>
          new Promise((resolve) => {
            finishThread = () => resolve({} as never);
          }),
      ),
    } as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    expect(shutdown).not.toHaveBeenCalled();

    finishThread();
    await new Promise((resolve) => setImmediate(resolve));

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
