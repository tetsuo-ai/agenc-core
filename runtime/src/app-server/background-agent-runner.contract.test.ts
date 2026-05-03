import { describe, expect, it, vi } from "vitest";
import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCDelegateFunction,
  type AgenCEnsureAgentControlFunction,
} from "./background-agent-runner.js";
import type { AgentThread } from "../agents/thread.js";
import type { AuthBackend } from "../auth/backend.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { ABORT, APPROVED } from "../permissions/review-decision.js";
import type { AgentStatus } from "../agents/status.js";
import type { ApprovalResolver } from "../tools/orchestrator.js";
import {
  JSON_RPC_VERSION,
  type JsonObject,
} from "./protocol/index.js";
import {
  createDaemonTuiSession,
  type AgenCDaemonTuiClient,
} from "../tui/daemon-session.js";

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
    const session = { conversationId: "parent-session", permissionModeRegistry };
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
        unattendedAllow: ["FileRead", "system.grep"],
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
    expect(permissionUpdates[0]?.alwaysAllowRules.session).toEqual([
      "FileRead",
      "system.grep",
    ]);
    expect(permissionUpdates[0]?.alwaysDenyRules.session).toEqual([
      "exec_command",
    ]);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("passes the daemon AuthBackend into delegate bootstrap", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = { conversationId: "parent-session", permissionModeRegistry };
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

  it("still shuts down bootstrap resources when control shutdown fails", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = { conversationId: "parent-session", permissionModeRegistry };
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
    const session = { conversationId: "parent-session", permissionModeRegistry };
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
    const delegateFn = vi.fn(async (opts: Parameters<AgenCDelegateFunction>[0]) => {
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
      await opts.onProgress?.(
        {
          kind: "run_complete",
          finalMessage: "hello",
          toolCallCount: 1,
        },
        thread,
      );
      return {
        kind: "async_launched",
        thread,
      };
    }) as unknown as AgenCDelegateFunction;
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

  it("feeds runner-emitted tool requests through the TUI adapter with real input", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = { conversationId: "parent-session", permissionModeRegistry };
    const control = { shutdown: vi.fn(async () => {}) };
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as unknown as AgentThread;
    const delegateFn = vi.fn(async (opts: Parameters<AgenCDelegateFunction>[0]) => {
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
    }) as unknown as AgenCDelegateFunction;
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

  it("reports live status freshness from thread status changes", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async () => {}),
    };
    const session = { conversationId: "parent-session", permissionModeRegistry };
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
    const times = [
      "2026-05-01T12:00:00.500Z",
      "2026-05-01T12:00:01.000Z",
    ];
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
    const session = { conversationId: "parent-session", permissionModeRegistry };
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
