import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WSMessage } from "../types";
import { useChat } from "./useChat";

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("useChat tool result matching", () => {
  it("matches tools.result to the exact toolCallId", () => {
    const send = vi.fn();

    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "first" },
          toolCallId: "tool-1",
        },
      } as WSMessage);

      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "second" },
          toolCallId: "tool-2",
        },
      } as WSMessage);
    });

    act(() => {
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          toolCallId: "tool-1",
          result: "first-done",
          durationMs: 12,
          isError: false,
        },
      } as WSMessage);
    });

    const message = result.current.messages[0];
    const toolCalls = message?.toolCalls ?? [];

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      toolName: "system.task",
      status: "completed",
      result: "first-done",
      toolCallId: "tool-1",
    });
    expect(toolCalls[1]).toMatchObject({
      toolName: "system.task",
      status: "executing",
      toolCallId: "tool-2",
    });
  });

  it("ignores top-level tool events tagged for subagents", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "desktop.bash",
          toolCallId: "tc-sub-1",
          subagentSessionId: "subagent:child-1",
          args: { command: "echo hi" },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "desktop.bash",
          toolCallId: "tc-sub-1",
          subagentSessionId: "subagent:child-1",
          result: "ok",
          durationMs: 18,
        },
      } as WSMessage);
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it("does not match tool results by name when toolCallId is present", () => {
    const send = vi.fn();

    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "first-no-id" },
        },
      } as WSMessage);
    });

    act(() => {
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          toolCallId: "tool-missing",
          result: "late-result",
          durationMs: 8,
        },
      } as WSMessage);
    });

    const message = result.current.messages[0];
    const toolCalls = message?.toolCalls ?? [];

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolName: "system.task",
      status: "executing",
      toolCallId: undefined,
    });
    expect(toolCalls[0].result).toBeUndefined();
  });

  it("falls back to tool name matching when tool result has no toolCallId", () => {
    const send = vi.fn();

    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { phase: "legacy" },
        },
      } as WSMessage);
    });

    act(() => {
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          result: "legacy-done",
          durationMs: 5,
          isError: false,
        },
      } as WSMessage);
    });

    const toolCalls = (result.current.messages[0]?.toolCalls ?? []);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolName: "system.task",
      status: "completed",
      result: "legacy-done",
      toolCallId: undefined,
    });
  });

  it("correctly matches out-of-order tool results by toolCallId", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "A" },
          toolCallId: "tool-a",
        },
      } as WSMessage);

      result.current.handleMessage({
        type: "tools.executing",
        payload: {
          toolName: "system.task",
          args: { round: "B" },
          toolCallId: "tool-b",
        },
      } as WSMessage);
    });

    act(() => {
      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          toolCallId: "tool-b",
          result: "result-b",
          durationMs: 20,
          isError: false,
        },
      } as WSMessage);

      result.current.handleMessage({
        type: "tools.result",
        payload: {
          toolName: "system.task",
          toolCallId: "tool-a",
          result: "result-a",
          durationMs: 15,
          isError: false,
        },
      } as WSMessage);
    });

    const toolCalls = result.current.messages[0]?.toolCalls ?? [];
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      toolName: "system.task",
      args: { round: "A" },
      toolCallId: "tool-a",
      status: "completed",
      result: "result-a",
    });
    expect(toolCalls[1]).toMatchObject({
      toolName: "system.task",
      args: { round: "B" },
      toolCallId: "tool-b",
      status: "completed",
      result: "result-b",
    });
  });
});

describe("useChat session lifecycle", () => {
  it("hydrates continuity records from canonical session command results", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "session.command.result",
        payload: {
          commandName: "session",
          content: "1 session",
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "list",
            sessions: [
              {
                sessionId: "session-1",
                label: "Coding Session",
                preview: "Investigate git diff handling",
                messageCount: 7,
                createdAt: 1,
                updatedAt: 2,
                lastActiveAt: 3,
                connected: false,
                resumabilityState: "disconnected-resumable",
                shellProfile: "coding",
                workflowStage: "implement",
                childSessionCount: 1,
                worktreeCount: 0,
                pendingApprovalCount: 0,
              },
            ],
          },
        },
      } as WSMessage);
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0]).toMatchObject({
      sessionId: "session-1",
      shellProfile: "coding",
      workflowStage: "implement",
    });
  });

  it("stores structured session command results and resumes via the command bus", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    send.mockClear();
    act(() => {
      result.current.resumeSession("session-target");
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.command.execute",
        payload: expect.objectContaining({
          content: "/session resume session-target",
          client: "web",
        }),
      }),
    );

    send.mockClear();
    act(() => {
      result.current.handleMessage({
        type: "session.command.result",
        payload: {
          commandName: "session",
          content: "Resumed session session-target.",
          sessionId: "web-session",
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "resume",
            resumed: {
              sessionId: "session-target",
              messageCount: 12,
              workspaceRoot: "/tmp/work",
            },
          },
        },
      } as WSMessage);
    });

    expect(result.current.sessionId).toBe("session-target");
    expect(result.current.lastCommandResult?.commandName).toBe("session");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.history",
        payload: expect.objectContaining({
          sessionId: "session-target",
        }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "watch.cockpit.get",
        payload: expect.objectContaining({
          sessionId: "session-target",
        }),
      }),
    );
  });

  it("stores inspect payloads from canonical session command results", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "session.command.result",
        payload: {
          commandName: "session",
          content: "Review session detail",
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "inspect",
            detail: {
              sessionId: "session-2",
              label: "Review Session",
              preview: "Review the current changes",
              messageCount: 9,
              createdAt: 1,
              updatedAt: 2,
              lastActiveAt: 3,
              connected: true,
              resumabilityState: "active",
              shellProfile: "coding",
              workflowStage: "review",
              childSessionCount: 2,
              worktreeCount: 1,
              pendingApprovalCount: 0,
              workflowState: {
                stage: "review",
                worktreeMode: "child_optional",
                enteredAt: 1,
                updatedAt: 2,
              },
            },
          },
        },
      } as WSMessage);
    });

    expect(result.current.selectedSessionDetail).toMatchObject({
      sessionId: "session-2",
      workflowStage: "review",
    });
  });

  it("refreshes history and cockpit against the resumed session id from the session channel", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    send.mockClear();
    act(() => {
      result.current.handleMessage({
        type: "chat.session.resumed",
        payload: {
          sessionId: "session-42",
          messageCount: 4,
        },
      } as WSMessage);
    });

    expect(result.current.sessionId).toBe("session-42");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.history",
        payload: expect.objectContaining({
          sessionId: "session-42",
        }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "watch.cockpit.get",
        payload: expect.objectContaining({
          sessionId: "session-42",
        }),
      }),
    );
  });

  it("persists a server-issued owner token and reuses it in later requests", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "chat.owner",
        payload: { ownerToken: "owner-token-123" },
      } as WSMessage);
    });

    expect(globalThis.localStorage.getItem("agenc-webchat-owner-token")).toBe(
      "owner-token-123",
    );

    send.mockClear();

    act(() => {
      result.current.startNewChat();
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.new",
        id: expect.any(String),
        payload: {
          clientKey: expect.any(String),
          ownerToken: "owner-token-123",
        },
      }),
    );
  });

  it("startNewChat clears local state and requests a new server session", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    send.mockClear();

    act(() => {
      result.current.handleMessage({
        type: "chat.session",
        payload: { sessionId: "session-old" },
      } as WSMessage);
      result.current.injectMessage("hello", "user");
      result.current.injectMessage("world", "agent");
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.sessionId).toBe("session-old");

    act(() => {
      result.current.startNewChat();
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.new",
        id: expect.any(String),
        payload: { clientKey: expect.any(String) },
      }),
    );
    expect(result.current.messages).toEqual([]);
    expect(result.current.sessionId).toBeNull();
  });

  it("sendMessage includes a stable request id for replay dedupe", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.sendMessage("hello");
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "chat.message",
        id: expect.any(String),
        payload: {
          content: "hello",
          clientKey: expect.any(String),
        },
      }),
    );
  });

  it("parses extended chat.usage payload for context breakdown", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "chat.usage",
        payload: {
          totalTokens: 1234,
          budget: 64_000,
          compacted: false,
          contextWindowTokens: 128_000,
          promptTokens: 2048,
          promptTokenBudget: 117_760,
          maxOutputTokens: 8192,
          safetyMarginTokens: 2048,
          sections: [
            { id: "memory", label: "Memory", tokens: 800, percent: 31.2 },
          ],
        },
      } as WSMessage);
    });

    expect(result.current.tokenUsage).toMatchObject({
      totalTokens: 1234,
      budget: 64_000,
      contextWindowTokens: 128_000,
      promptTokens: 2048,
      sections: [{ id: "memory", label: "Memory", tokens: 800, percent: 31.2 }],
    });
  });

  it("keeps typing cleared when late subagent events arrive after the final chat message", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "chat.typing",
        payload: { active: true },
      } as WSMessage);
    });

    expect(result.current.isTyping).toBe(true);

    act(() => {
      result.current.handleMessage({
        type: "chat.message",
        payload: {
          content: "Finished the task.",
          timestamp: 1000,
        },
      } as WSMessage);
    });

    expect(result.current.isTyping).toBe(false);

    act(() => {
      result.current.handleMessage({
        type: "subagents.progress",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          timestamp: 1100,
          data: { objective: "late event flush" },
        },
      } as WSMessage);
    });

    expect(result.current.isTyping).toBe(false);
  });

  it("treats chat.response as a terminal typing signal", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "chat.typing",
        payload: { active: true },
      } as WSMessage);
      result.current.handleMessage({
        type: "chat.response",
        payload: {
          completionState: "completed",
          stopReason: "completed",
        },
      } as WSMessage);
    });

    expect(result.current.isTyping).toBe(false);
  });
});

describe("useChat subagent lifecycle timeline", () => {
  it("tracks delegated child lifecycle and nested tool activity", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "subagents.planned",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          timestamp: 1000,
          data: { stepName: "research", objective: "research target" },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "subagents.spawned",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          timestamp: 1100,
          data: { stepName: "research", objective: "research target" },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "subagents.tool.executing",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          toolName: "desktop.bash",
          timestamp: 1200,
          data: { toolCallId: "tc-1", args: { command: "echo hi" } },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "subagents.tool.result",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          toolName: "desktop.bash",
          timestamp: 1300,
          data: {
            toolCallId: "tc-1",
            result: "ok",
            durationMs: 25,
            isError: false,
          },
        },
      } as WSMessage);
      result.current.handleMessage({
        type: "subagents.completed",
        payload: {
          sessionId: "session-parent",
          parentSessionId: "session-parent",
          subagentSessionId: "subagent:child-1",
          timestamp: 1400,
          data: { durationMs: 200, output: "done" },
        },
      } as WSMessage);
    });

    const agentMessage = result.current.messages.find((message) => message.sender === "agent");
    expect(agentMessage).toBeDefined();
    const subagents = agentMessage?.subagents ?? [];
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      subagentSessionId: "subagent:child-1",
      status: "completed",
      outputSummary: "done",
      elapsedMs: 200,
    });
    expect(subagents[0]?.tools).toHaveLength(1);
    expect(subagents[0]?.tools[0]).toMatchObject({
      toolName: "desktop.bash",
      toolCallId: "tc-1",
      status: "completed",
      result: "ok",
      durationMs: 25,
    });
  });

  it("hydrates subagent failures from events.event envelopes", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useChat({ send, connected: true }));

    act(() => {
      result.current.handleMessage({
        type: "events.event",
        payload: {
          eventType: "subagents.failed",
          timestamp: 2000,
          traceId: "trace-a",
          data: {
            sessionId: "session-parent",
            parentSessionId: "session-parent",
            subagentSessionId: "subagent:child-2",
            reason: "tool misuse",
          },
        },
      } as WSMessage);
    });

    const agentMessage = result.current.messages.find((message) => message.sender === "agent");
    const subagents = agentMessage?.subagents ?? [];
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      subagentSessionId: "subagent:child-2",
      status: "failed",
      errorReason: "tool misuse",
      traceId: "trace-a",
    });
  });
});
