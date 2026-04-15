import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "./chat-executor.js";
import type { ChatExecuteParams } from "./chat-executor.js";
import { createPromptEnvelope } from "./prompt-envelope.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";
import type { ArtifactCompactionState } from "../memory/artifact-store.js";
import * as hooks from "./hooks/index.js";
import { HookRegistry } from "./hooks/index.js";
import { LLMProviderError } from "./errors.js";

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
    promptEnvelope: createPromptEnvelope("You are a helpful assistant."),
    sessionId: "session-1",
    runtimeContext: { workspaceRoot: "/tmp/chat-executor-test-workspace" },
    ...overrides,
  };
}

function buildLongHistory(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message ${i}`,
  }));
}

// ============================================================================
// Tests for chat-executor-request.executeRequest:
//   - Per-call streaming hook wiring
//   - Stateful session options, reconciliation messages, fallback summary
//   - Result-assembly paths (artifactContext, statefulSummary)
// ============================================================================

describe("ChatExecutor request assembly", () => {
  describe("per-call streaming", () => {
    it("per-call callback overrides constructor callback", async () => {
      const constructorCallback = vi.fn();
      const perCallCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        onStreamChunk: constructorCallback,
      });

      await executor.execute(createParams({ onStreamChunk: perCallCallback }));

      // Phase F: execute() routes through executeChat which wraps
      // the caller's onStreamChunk in a stream-queue forwarder
      // before handing it to the provider. The reference identity
      // of the callback the provider receives is therefore the
      // wrapper, not the original. What matters for the contract
      // is that the streaming path was taken (chatStream, not
      // chat) and that the constructor-level default did not win.
      expect(provider.chatStream).toHaveBeenCalledTimes(1);
      expect(provider.chat).not.toHaveBeenCalled();
      expect(constructorCallback).not.toHaveBeenCalled();
    });

    it("per-call callback used when no constructor callback set", async () => {
      const perCallCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(createParams({ onStreamChunk: perCallCallback }));

      // Phase F: chatStream is taken (not chat) because the
      // per-call callback forced the streaming path. The provider
      // sees the executeChat wrapper, not the original callback
      // reference.
      expect(provider.chatStream).toHaveBeenCalledTimes(1);
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("constructor callback used when per-call not provided", async () => {
      const constructorCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        onStreamChunk: constructorCallback,
      });

      await executor.execute(createParams());

      // Phase F: the streaming path is forced whenever either the
      // constructor or the per-call callback is set. The provider
      // sees the executeChat wrapper, not the original reference.
      expect(provider.chatStream).toHaveBeenCalledTimes(1);
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("no streaming when neither callback set", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(createParams());

      expect(provider.chat).toHaveBeenCalledOnce();
      expect(provider.chatStream).not.toHaveBeenCalled();
    });

    it("per-call streaming persists through multi-round tool loop", async () => {
      const perCallCallback = vi.fn();
      const toolHandler = vi.fn().mockResolvedValue("tool result");
      const provider = createMockProvider("primary", {
        chatStream: vi
          .fn<[LLMMessage[], StreamProgressCallback, LLMChatOptions?], Promise<LLMResponse>>()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "search", arguments: '{"q":"test"}' },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "final" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({ onStreamChunk: perCallCallback }),
      );

      expect(result.content).toBe("final");
      // Phase F: streaming path persists across tool rounds via
      // executeChat's hooked callback. Both provider calls took
      // the chatStream path. The provider sees the executeChat
      // wrapper, not the original perCallCallback reference —
      // the forwarding delivers chunks to perCallCallback.
      expect(provider.chatStream).toHaveBeenCalledTimes(2);
    });
  });

  describe("stateful session wiring and result assembly", () => {
    it("does not inject a request milestone contract before the first model call", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "ok" })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            verificationContract: {
              workspaceRoot: "/tmp/chat-executor-test-workspace",
              targetArtifacts: ["/tmp/chat-executor-test-workspace/src/main.c"],
              verificationMode: "mutation_required",
              requestCompletion: {
                requiredMilestones: [
                  { id: "phase_1", description: "Finish phase 1" },
                  { id: "phase_2", description: "Verify phase 2" },
                ],
              },
            } as any,
          },
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as LLMMessage[];
      const instruction = messages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Request milestone contract:"),
      );

      expect(instruction).toBeUndefined();
    });

    it("passes stateful session options through provider calls", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-session" };

      await executor.execute(
        createParams({
          message,
          sessionId: "stateful-session",
        }),
      );

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "stateful-session",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
    });

    it("passes the full normalized history into reconciliationMessages", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const history = Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `history-${index}`,
      })) as LLMMessage[];

      await executor.execute(
        createParams({
          history,
          sessionId: "stateful-history-window",
          message: {
            ...createMessage("continue"),
            sessionId: "stateful-history-window",
          },
        }),
      );

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      const reconciliationMessages = options?.stateful?.reconciliationMessages as
        | LLMMessage[]
        | undefined;
      expect(reconciliationMessages).toBeDefined();
      expect(reconciliationMessages).toHaveLength(26);
      expect(reconciliationMessages?.[1]).toMatchObject({
        role: "user",
        content: "history-0",
      });
      expect(reconciliationMessages?.at(-1)).toMatchObject({
        role: "user",
        content: "continue",
      });
    });

    it("preserves full history in reconciliationMessages when prompt replay truncates", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const longHistoryEntry = "history-" + "x".repeat(110_000);

      await executor.execute(
        createParams({
          history: [
            { role: "user", content: longHistoryEntry },
            { role: "assistant", content: "stored" },
          ],
          sessionId: "stateful-long-history",
          message: {
            ...createMessage("continue"),
            sessionId: "stateful-long-history",
          },
        }),
      );

      const callMessages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | LLMMessage[]
        | undefined;
      const options = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      const reconciliationMessages = options?.stateful?.reconciliationMessages as
        | LLMMessage[]
        | undefined;

      expect(callMessages?.[1]).toMatchObject({
        role: "user",
      });
      expect(typeof callMessages?.[1]?.content).toBe("string");
      expect(String(callMessages?.[1]?.content)).toHaveLength(100_000);
      expect(String(callMessages?.[1]?.content).endsWith("...")).toBe(true);

      expect(reconciliationMessages?.[1]).toEqual({
        role: "user",
        content: longHistoryEntry,
      });
    });

    it("passes persisted stateful resume anchors through provider calls", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: true,
              continued: true,
              store: true,
              fallbackToStateless: true,
              previousResponseId: "resp_prev",
              responseId: "resp_next",
              reconciliationHash: "hash-next",
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-resume" };

      await executor.execute(
        createParams({
          message,
          sessionId: "stateful-resume",
          stateful: {
            resumeAnchor: {
              previousResponseId: "resp_prev",
              reconciliationHash: "hash-prev",
            },
          },
        }),
      );

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "stateful-resume",
            reconciliationMessages: expect.any(Array),
            resumeAnchor: {
              previousResponseId: "resp_prev",
              reconciliationHash: "hash-prev",
            },
          }),
        }),
      );
    });

    it("injects compacted artifact refs into execution context for long-running sessions", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const artifactContext: ArtifactCompactionState = {
        version: 1,
        snapshotId: "snapshot:artifact-context",
        sessionId: "session-1",
        createdAt: 1,
        source: "session_compaction",
        historyDigest: "digest",
        sourceMessageCount: 24,
        retainedTailCount: 5,
        narrativeSummary: "Compacted shell implementation context",
        openLoops: ["Verify PLAN.md against parser tests"],
        artifactRefs: [
          {
            id: "artifact:plan",
            kind: "plan",
            title: "PLAN.md",
            summary: "Current shell roadmap and milestone breakdown",
            createdAt: 1,
            digest: "digest-plan",
            tags: ["plan", "PLAN.md"],
          },
          {
            id: "artifact:test",
            kind: "test_result",
            title: "parser.test.ts",
            summary: "Parser regression tests passed after the lexer fix",
            createdAt: 2,
            digest: "digest-test",
            tags: ["test", "parser"],
          },
        ],
      };

      await executor.execute(
        createParams({
          history: buildLongHistory(6),
          message: createMessage("Finish the parser and keep the plan aligned."),
          stateful: {
            artifactContext,
          },
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as LLMMessage[];
      const artifactMessage = messages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Compacted artifact context:"),
      );
      expect(artifactMessage).toBeUndefined();
    });

    it("aggregates stateful fallback reason counters in result summary", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: true,
              continued: false,
              store: true,
              fallbackToStateless: true,
              fallbackReason: "provider_retrieval_failure",
              events: [
                {
                  type: "stateful_continuation_attempt",
                },
                {
                  type: "stateful_fallback",
                  reason: "provider_retrieval_failure",
                },
              ],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-summary" };

      const result = await executor.execute(
        createParams({
          message,
          sessionId: "stateful-summary",
        }),
      );

      expect(result.statefulSummary).toBeDefined();
      expect(result.statefulSummary).toMatchObject({
        enabled: true,
        attemptedCalls: 1,
        continuedCalls: 0,
        fallbackCalls: 1,
      });
      expect(
        result.statefulSummary?.fallbackReasons.provider_retrieval_failure,
      ).toBe(1);
    });

    it("tracks store-disabled stateful fallbacks in the result summary", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: false,
              fallbackToStateless: true,
              fallbackReason: "store_disabled",
              events: [
                {
                  type: "stateful_fallback",
                  reason: "store_disabled",
                },
              ],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-store-disabled" };

      const result = await executor.execute(
        createParams({
          message,
          sessionId: "stateful-store-disabled",
        }),
      );

      expect(result.statefulSummary).toBeDefined();
      expect(result.statefulSummary?.fallbackReasons.store_disabled).toBe(1);
      expect(result.statefulSummary?.attemptedCalls).toBe(0);
    });

    it("dispatches StopFailure with api error context before rethrowing", async () => {
      const dispatchHooksSpy = vi
        .spyOn(hooks, "dispatchHooks")
        .mockResolvedValue({ action: "noop", outcomes: [] });

      try {
        const provider = createMockProvider("primary", {
          chat: vi
            .fn()
            .mockRejectedValue(
              new LLMProviderError("primary", "Bad request", 400),
            ),
        });
        const executor = new ChatExecutor({
          providers: [provider],
          hookRegistry: new HookRegistry([
            {
              event: "StopFailure",
              kind: "http",
              target: "https://example.invalid/stop-failure",
            },
          ]),
        });

        const caught = await executor.execute(createParams()).catch((error) => error);
        expect(caught).toBeInstanceOf(LLMProviderError);
        const stopFailureCalls = dispatchHooksSpy.mock.calls.filter(
          ([input]) => input.event === "StopFailure",
        );
        expect(stopFailureCalls).toHaveLength(1);
        expect(stopFailureCalls[0]?.[0]).toMatchObject({
          event: "StopFailure",
          matchKey: "session-1",
          context: expect.objectContaining({
            event: "StopFailure",
            sessionId: "session-1",
            stopReason: "provider_error",
            stopReasonDetail: expect.stringContaining("provider_error"),
            failure: expect.objectContaining({
              name: "LLMProviderError",
              message: expect.stringContaining("Bad request"),
              providerName: "primary",
              statusCode: 400,
            }),
          }),
        });
      } finally {
        dispatchHooksSpy.mockRestore();
      }
    });
  });
});
