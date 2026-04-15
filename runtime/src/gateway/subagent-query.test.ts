/**
 * Phase K acceptance test: the `querySubagent` recursive wrapper
 * drives the Phase C `executeChat` generator with a subagent
 * spec, forwards events to the caller, and returns the child's
 * Terminal. `runSubagentToLegacyResult` drains the generator and
 * returns the legacy result shape for callers that don't need
 * nested event bubbling.
 */

import { describe, it, expect, vi } from "vitest";
import {
  querySubagent,
  runSubagentToLegacyResult,
} from "./subagent-query.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import { createPromptEnvelope } from "../llm/prompt-envelope.js";
import type { GatewayMessage } from "./message.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
import type {
  AssistantMessage,
  ExecuteChatYield,
  RequestStartEvent,
} from "../llm/streaming-events.js";

function makeMessage(content = "sub-agent task"): GatewayMessage {
  return {
    id: "msg-subagent",
    channel: "test",
    senderId: "parent",
    senderName: "Parent",
    sessionId: "child-session",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

function createMockProvider(
  response: Partial<LLMResponse> = {},
): LLMProvider {
  const baseResponse: LLMResponse = {
    content: response.content ?? "sub-agent done",
    toolCalls: response.toolCalls ?? [],
    usage: response.usage ?? {
      promptTokens: 20,
      completionTokens: 5,
      totalTokens: 25,
    },
    model: response.model ?? "mock-model",
    finishReason: response.finishReason ?? "stop",
  };
  return {
    name: "mock-subagent-provider",
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(baseResponse),
    chatStream: vi
      .fn<
        [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
        Promise<LLMResponse>
      >()
      .mockResolvedValue(baseResponse),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
  };
}

describe("querySubagent (Phase K)", () => {
  it("drives executeChat with the subagent spec and forwards events", async () => {
    const provider = createMockProvider();
    const executor = new ChatExecutor({ providers: [provider] });
    const generator = querySubagent(executor, {
      sessionId: "child-session",
      parentSessionId: "parent-session",
      params: {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a scoped subagent."),
        sessionId: "child-session",
      },
    });
    const events: ExecuteChatYield[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const step = await generator.next();
      if (step.done) {
        expect(step.value.reason).toBe("stop_reason_end_turn");
        expect(step.value.finalContent).toBe("sub-agent done");
        break;
      }
      events.push(step.value);
    }
    const start = events.find(
      (e) => e.type === "request_start",
    ) as RequestStartEvent | undefined;
    expect(start).toBeDefined();
    expect(start?.turnIndex).toBe(0);

    const assistant = events.find(
      (e) => e.type === "assistant",
    ) as AssistantMessage | undefined;
    expect(assistant?.content).toBe("sub-agent done");
  });

  it("returns the child Terminal with legacyResult carried through", async () => {
    const provider = createMockProvider({ content: "child result" });
    const executor = new ChatExecutor({ providers: [provider] });
    const generator = querySubagent(executor, {
      sessionId: "child-1",
      params: {
        message: makeMessage("child task"),
        history: [],
        promptEnvelope: createPromptEnvelope("System"),
        sessionId: "child-1",
      },
    });
    let terminal;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const step = await generator.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
    }
    expect(terminal).toBeDefined();
    expect(terminal?.finalContent).toBe("child result");
    expect(terminal?.legacyResult).toBeDefined();
    expect(terminal?.legacyResult?.content).toBe("child result");
  });
});

describe("runSubagentToLegacyResult (Phase K)", () => {
  it("drains the generator and returns the legacy result", async () => {
    const provider = createMockProvider({ content: "legacy shape" });
    const executor = new ChatExecutor({ providers: [provider] });
    const result = await runSubagentToLegacyResult(executor, {
      sessionId: "legacy-child",
      params: {
        message: makeMessage("legacy test"),
        history: [],
        promptEnvelope: createPromptEnvelope("System"),
        sessionId: "legacy-child",
      },
    });
    expect(result.terminal.finalContent).toBe("legacy shape");
    expect(result.legacyResult).toBeDefined();
    expect(result.legacyResult?.content).toBe("legacy shape");
    expect(result.legacyResult?.provider).toBe("mock-subagent-provider");
  });

  it("rethrows underlying execute() errors when all providers fail", async () => {
    const provider: LLMProvider = {
      name: "reject-provider",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockRejectedValue(new Error("subagent provider boom")),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockRejectedValue(new Error("subagent provider boom")),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({ providers: [provider] });
    // When the provider chain exhausts and ChatExecutor throws,
    // executeChat captures the error on the Terminal and the
    // drain helper rethrows it so callers preserve their catch
    // paths (same contract as executeChatToLegacyResult).
    await expect(
      runSubagentToLegacyResult(executor, {
        sessionId: "error-child",
        params: {
          message: makeMessage(),
          history: [],
          promptEnvelope: createPromptEnvelope("System"),
          sessionId: "error-child",
        },
      }),
    ).rejects.toThrow();
  });

  it("keeps token-budget continuation disabled for subagent turns", async () => {
    const provider: LLMProvider = {
      name: "mock-subagent-provider",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            { id: "tc-1", name: "system.listDir", arguments: '{"path":"."}' },
          ],
          usage: { promptTokens: 20, completionTokens: 50, totalTokens: 70 },
          model: "mock-model",
          finishReason: "tool_calls",
        })
        .mockResolvedValueOnce({
          content: "Next I will continue with the remaining work.",
          toolCalls: [],
          usage: { promptTokens: 20, completionTokens: 100, totalTokens: 120 },
          model: "mock-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content: "Bootstrap complete. Continuing.",
          toolCalls: [],
          usage: { promptTokens: 20, completionTokens: 100, totalTokens: 120 },
          model: "mock-model",
          finishReason: "stop",
        }),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockRejectedValue(new Error("unused")),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: vi.fn(async () => '{"ok":true}'),
    });

    const result = await runSubagentToLegacyResult(executor, {
      sessionId: "subagent:continued-child",
      params: {
        message: makeMessage("continue the task"),
        history: [],
        promptEnvelope: createPromptEnvelope("System"),
        sessionId: "subagent:continued-child",
        turnOutputTokenBudget: 2_000,
      },
    });

    expect(result.legacyResult?.content).toBe("Bootstrap complete. Continuing.");
    expect(result.legacyResult?.callUsage.map((entry) => entry.phase)).toEqual([
      "initial",
      "tool_followup",
      "tool_followup",
    ]);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });
});
