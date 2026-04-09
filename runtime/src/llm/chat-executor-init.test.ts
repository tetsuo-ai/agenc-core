import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "./chat-executor.js";
import type { ChatExecuteParams } from "./chat-executor.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";

// ============================================================================
// Shared helpers
// ============================================================================

function mockResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "mock response",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock-model",
    finishReason: "stop",
    ...overrides,
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

function createMockProvider(
  name = "primary",
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  return {
    name,
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn<
        [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
        Promise<LLMResponse>
      >()
      .mockResolvedValue(mockResponse()),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMessage(content = "hello"): GatewayMessage {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

function createParams(
  overrides: Partial<ChatExecuteParams> = {},
): ChatExecuteParams {
  return {
    message: createMessage(),
    history: [],
    systemPrompt: "You are a helpful assistant.",
    sessionId: "session-1",
    runtimeContext: { workspaceRoot: "/tmp/chat-executor-test-workspace" },
    ...overrides,
  };
}

// ============================================================================
// Tests for chat-executor-init.initializeExecutionContext behavior:
//   - history normalization (image stripping)
//   - user message truncation / assistant output guards
//   - prompt budget diagnostics and runtime hint caps
// ============================================================================

describe("ChatExecutor initialization and prompt budgeting", () => {
  describe("history normalization and message truncation", () => {
    it("omits historical image payloads from normalized history", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });
      const hugeImage = `data:image/png;base64,${"A".repeat(120_000)}`;

      await executor.execute(
        createParams({
          history: [
            {
              role: "assistant",
              content: [
                { type: "image_url", image_url: { url: hugeImage } },
                { type: "text", text: "previous screenshot context" },
              ],
            },
          ],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      const historicalAssistant = messages.find((m) => m.role === "assistant");
      expect(historicalAssistant).toBeDefined();
      expect(Array.isArray(historicalAssistant?.content)).toBe(true);
      const parts = historicalAssistant!.content as Array<
        { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
      >;
      expect(parts.some((p) => p.type === "image_url")).toBe(false);
      expect(
        parts.some(
          (p) => p.type === "text" && p.text.includes("prior image omitted"),
        ),
      ).toBe(true);
    });

    it("truncates oversized user messages before provider call", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });
      const hugeUserMessage = "U".repeat(30_000);

      await executor.execute(
        createParams({
          message: createMessage(hugeUserMessage),
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      const last = messages[messages.length - 1];
      expect(last.role).toBe("user");
      expect(typeof last.content).toBe("string");
      expect((last.content as string).length).toBeLessThanOrEqual(8_000);
    });

    it("suppresses runaway repetitive assistant output", async () => {
      const repetitive = Array.from({ length: 120 }, () => "Yes.").join("\n");
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: repetitive })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.content).toContain("repetitive model output suppressed");
      expect(result.content.length).toBeLessThan(3_000);
    });

    it("preserves long final assistant output without truncation", async () => {
      // AgenC no longer applies an output-size cap to final model output.
      // The previous MAX_FINAL_RESPONSE_CHARS=24_000 hard cap has been
      // removed so legitimate long responses flow through untouched.
      // The runaway-repetition safety net still catches degenerate loops
      // (40+ identical lines, <35% unique); a single repeated character
      // is one "line" and does not trigger that detector.
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValue(mockResponse({ content: "x".repeat(80_000) })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.content).not.toContain("oversized model output suppressed");
      expect(result.content.length).toBe(80_000);
    });

    it("keeps prompt growth bounded across repeated long turns", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn(async () => mockResponse({ content: "ok" })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const promptSizes: number[] = [];
      let history: LLMMessage[] = [];

      for (let i = 0; i < 12; i++) {
        const userText = `turn-${i} ` + "x".repeat(6_000);
        const result = await executor.execute(
          createParams({
            history,
            message: createMessage(userText),
          }),
        );
        promptSizes.push(result.callUsage[0].afterBudget.estimatedChars);
        history = [
          ...history,
          { role: "user", content: userText },
          { role: "assistant", content: result.content },
        ];
      }

      // Hard budget is 500k chars in ChatExecutor; include small metadata overhead.
      expect(Math.max(...promptSizes)).toBeLessThanOrEqual(550_000);

      // Tail variance should be bounded once truncation/normalization kicks in.
      const tail = promptSizes.slice(-4);
      const tailRange = Math.max(...tail) - Math.min(...tail);
      expect(tailRange).toBeLessThan(50_000);
    });
  });

  describe("prompt budget diagnostics and runtime hint caps", () => {
    it("truncates oversized assistant tool-call arguments before follow-up model calls", async () => {
      let callCount = 0;
      const oversizedArgs = safeJson({
        command:
          "cat <<'EOF'\n" +
          "x".repeat(120_000) +
          "\nEOF",
      });
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve(
              mockResponse({
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "tc-1",
                    name: "desktop.bash",
                    arguments: oversizedArgs,
                  },
                ],
              }),
            );
          }
          return Promise.resolve(mockResponse({ content: "done" }));
        }),
      });
      const toolHandler = vi.fn().mockResolvedValue('{"exitCode":0,"stdout":"ok"}');
      const executor = new ChatExecutor({ providers: [provider], toolHandler });

      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const assistantWithToolCalls = secondCallMessages.find(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.toolCalls) &&
          message.toolCalls.length > 0,
      );
      expect(assistantWithToolCalls).toBeDefined();
      const replayedArgs = assistantWithToolCalls!.toolCalls![0]!.arguments;
      expect(replayedArgs.length).toBeLessThanOrEqual(100_000);
      expect(replayedArgs).toContain("__truncatedToolCallArgs");
    });

    it("reports section-level budget diagnostics when constrained", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "ok" })),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        promptBudget: {
          contextWindowTokens: 4_096,
          maxOutputTokens: 2_048,
          hardMaxPromptChars: 8_000,
        },
      });

      const history = Array.from({ length: 24 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `history-${i} ` + "h".repeat(3_000),
      })) as LLMMessage[];

      const result = await executor.execute(
        createParams({
          history,
          message: createMessage("u".repeat(6_000)),
        }),
      );

      const diagnostics = result.callUsage[0].budgetDiagnostics;
      expect(diagnostics).toBeDefined();
      expect(diagnostics?.constrained).toBe(true);
      expect(
        (diagnostics?.sections.history.droppedMessages ?? 0) +
          (diagnostics?.sections.history.truncatedMessages ?? 0),
      ).toBeGreaterThan(0);
    });

    it("caps additive runtime system hints via prompt budget config", async () => {
      const toolHandler = vi.fn(async (name: string) => {
        if (name === "system.bash") {
          return '{"exitCode":1,"stderr":"spawn set ENOENT"}';
        }
        return '{"error":"Private/loopback address blocked: 127.0.0.1"}';
      });

      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"set"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-2",
                  name: "system.browse",
                  arguments: '{"url":"http://127.0.0.1:8123"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
        promptBudget: { maxRuntimeHints: 1 },
      });
      await executor.execute(createParams());

      const thirdCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[2][0] as LLMMessage[];
      const runtimeHints = thirdCallMessages.filter(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.startsWith("Tool recovery hint:"),
      );
      expect(runtimeHints).toHaveLength(1);
      expect(String(runtimeHints[0].content)).toContain("localhost");
      expect(String(runtimeHints[0].content)).not.toContain("Shell builtins");
    });

    it("retains one system anchor and sheds extra runtime system blocks under pressure", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "ok" })),
      });
      const skillInjector = {
        inject: vi.fn().mockResolvedValue("skill ".repeat(3_000)),
      };
      const memoryRetriever = {
        retrieve: vi.fn().mockResolvedValue("memory ".repeat(3_000)),
      };
      const learningProvider = {
        retrieve: vi.fn().mockResolvedValue("learning ".repeat(3_000)),
      };
      const progressProvider = {
        retrieve: vi.fn().mockResolvedValue("progress ".repeat(3_000)),
      };

      const executor = new ChatExecutor({
        providers: [provider],
        skillInjector,
        memoryRetriever,
        learningProvider,
        progressProvider,
        promptBudget: {
          contextWindowTokens: 4_096,
          maxOutputTokens: 2_048,
          hardMaxPromptChars: 8_000,
        },
      });

      const result = await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "previous turn" }],
          message: createMessage("hello"),
        }),
      );

      const diagnostics = result.callUsage[0].budgetDiagnostics;
      expect(diagnostics).toBeDefined();
      expect(diagnostics?.sections.system_anchor.afterMessages).toBe(1);
      expect(
        (diagnostics?.sections.system_runtime.droppedMessages ?? 0) +
          (diagnostics?.sections.system_runtime.truncatedMessages ?? 0),
      ).toBeGreaterThan(0);
    });
  });
});
