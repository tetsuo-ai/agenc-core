import { describe, expect, test, vi } from "vitest";
import { EventLog, type Event } from "../session/event-log.js";
import { CostSidecar } from "../session/cost.js";
import type { Session } from "../session/session.js";
import { AsyncLock } from "../utils/async-lock.js";
import type { TurnContext } from "../session/turn-context.js";
import { TurnTimingState } from "../session/turn-context.js";
import { buildInitialTurnState } from "../session/turn-state.js";
import { BudgetTracker } from "../conversation/token-budget.js";
import type {
  LLMMessage,
  LLMChatOptions,
  LLMProvider,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  StreamProgressCallback,
} from "../llm/types.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { Tool } from "../tools/types.js";
import { parseAnthropicMessagesResponse } from "../llm/wire/messages-anthropic.js";

const streamedDispatchCalls: string[] = [];

vi.mock("./execute-tools.js", () => ({
  ensureStreamingToolExecutor: () => ({ mocked: true }),
  queueStreamingToolCall: (
    _executor: unknown,
    _block: unknown,
    call: { id: string },
  ) => {
    streamedDispatchCalls.push(call.id);
    return true;
  },
  validateToolCallsForDispatch: (
    raw: unknown[],
    session?: { nextInternalSubId?: () => string; emit?: (event: Event) => void },
  ) => {
    const valid: LLMToolCall[] = [];
    const failures: Array<{ raw: unknown; cause: string }> = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") {
        failures.push({ raw: item, cause: "invalid_shape" });
        continue;
      }
      const candidate = item as { id?: unknown; name?: unknown; arguments?: unknown };
      if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
        failures.push({ raw: item, cause: "invalid_shape" });
        continue;
      }
      if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
        failures.push({ raw: item, cause: "invalid_shape" });
        continue;
      }
      if (typeof candidate.arguments !== "string") {
        failures.push({ raw: item, cause: "invalid_shape" });
        continue;
      }
      try {
        const parsed = JSON.parse(candidate.arguments);
        if (!!parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          valid.push(item as LLMToolCall);
        } else {
          failures.push({ raw: item, cause: "invalid_shape" });
        }
      } catch {
        failures.push({ raw: item, cause: "invalid_json" });
      }
    }
    for (let i = 0; i < failures.length; i += 1) {
      session?.emit?.({
        id: session.nextInternalSubId?.() ?? `sub-${i}`,
        msg: {
          type: "stream_error",
          payload: {
            cause: "malformed_tool_call",
            message: "provider returned malformed tool_use (invalid_json)",
          },
        },
      } as Event);
    }
    return {
      valid,
      failures,
    };
  },
}));

import {
  streamModel,
  type StreamModelRequestContract,
} from "./stream-model.js";

function mkCtx(mode = "chat"): TurnContext {
  return {
    subId: "turn-stream",
    cwd: "/tmp",
    config: {} as unknown,
    configSnapshot: {} as unknown,
    modelInfo: {
      slug: "test-model",
      effectiveContextWindowPercent: 100,
      contextWindow: 1024,
      supportedReasoningLevels: [],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
    collaborationMode: { model: mode },
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    reasoningSummary: "auto",
    sessionSource: "cli_main",
    currentDate: "2026-04-20",
    timezone: "Etc/UTC",
    turnTimingState: new TurnTimingState(),
    dynamicTools: [],
    depth: 0,
    toolCallGate: {
      isReady: () => true,
      signal: () => {},
      wait: async () => {},
    },
    // The plan-mode gate is now `sessionConfiguration.permissionContext.mode`
    // exclusively (legacy `collaborationMode.model === "plan"` was retired).
    // Preserve the test ergonomic of `mkCtx("plan")` ⇒ plan-mode-active by
    // routing the literal "plan" through the authoritative path.
    ...(mode === "plan"
      ? { sessionConfiguration: { permissionContext: { mode: "plan" } } }
      : {}),
  } as unknown as TurnContext;
}

function mkRequest(
  input: ReadonlyArray<LLMMessage>,
): StreamModelRequestContract {
  return {
    input,
    tools: [],
    parallelToolCalls: false,
    baseInstructions: "",
  };
}

function mkSession(
  provider: LLMProvider,
  budgetTracker: BudgetTracker | null = null,
  registry?: ToolRegistry,
): {
  session: Session;
  events: Event[];
} {
  const events: Event[] = [];
  const eventLog = new EventLog();
  eventLog.subscribe((event) => events.push(event));
  let subId = 0;
  const session = {
    conversationId: "conv-stream",
    eventLog,
    services: {
      provider,
      ...(registry !== undefined ? { registry } : {}),
    },
    budgetTracker,
    nextInternalSubId: () => `sub-${++subId}`,
    emit: (event: Event) => {
      eventLog.emit(event);
    },
    // Minimal SessionState for the cross-turn accumulator writer in
    // streamModel. Only the fields the writer touches need to exist;
    // the rest of the SessionState shape is irrelevant for these
    // stream-level unit tests.
    state: new AsyncLock<{ totalTokenUsage?: unknown }>({}),
  } as unknown as Session;
  return { session, events };
}

function mkState(ctx: TurnContext) {
  return buildInitialTurnState(ctx, {
    role: "user",
    content: "hello",
  });
}

function mkProvider(
  impl: (
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ) => Promise<LLMResponse>,
): LLMProvider {
  return {
    name: "stub-provider",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
    chatStream: impl,
    healthCheck: async () => true,
  };
}

function mkRegistry(tools: Tool[]): ToolRegistry {
  return {
    tools,
    toLLMTools(): LLMTool[] {
      return tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    },
    dispatch: async (call: LLMToolCall): Promise<ToolDispatchResult> => {
      const tool = tools.find((candidate) => candidate.name === call.name);
      if (!tool) {
        return {
          content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
          isError: true,
        };
      }
      const args = call.arguments ? JSON.parse(call.arguments) : {};
      const result = await tool.execute(args);
      return { content: result.content, isError: result.isError };
    },
  };
}

describe("streamModel — live assistant text sanitization", () => {
  test("forwards reasoning summary and session-scoped transport hints to the provider", async () => {
    const ctx = mkCtx("chat");
    (ctx as TurnContext & { reasoningEffort?: "high" }).reasoningEffort = "high";
    (ctx as TurnContext & { reasoningSummary: "detailed" }).reasoningSummary =
      "detailed";
    (ctx as TurnContext & { modelVerbosity?: "high" }).modelVerbosity = "high";
    (ctx as TurnContext & { serviceTier?: "priority" }).serviceTier =
      "priority";

    const seenOptions: Array<Record<string, unknown> | undefined> = [];
    const provider = mkProvider(async (_messages, _onChunk, options) => {
      seenOptions.push(options as Record<string, unknown> | undefined);
      return {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session, events } = mkSession(provider);
    const state = mkState(ctx);

    await streamModel(
      state,
      ctx,
      session,
      mkRequest([{ role: "user", content: "hello" }]),
    );

    expect(seenOptions[0]).toMatchObject({
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      modelVerbosity: "high",
      serviceTier: "priority",
      parallelToolCalls: false,
    });
  });

  test("keeps base instructions out of provider transcript messages", async () => {
    const ctx = mkCtx("chat");
    const seenMessages: LLMMessage[][] = [];
    const seenOptions: LLMChatOptions[] = [];
    const provider = mkProvider(async (messages, _onChunk, options) => {
      seenMessages.push(messages);
      seenOptions.push(options ?? {});
      return {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session } = mkSession(provider);
    const state = mkState(ctx);

    await streamModel(
      state,
      ctx,
      session,
      {
        ...mkRequest([{ role: "user", content: "hello" }]),
        baseInstructions: "base system",
        contextWindowTokens: 1024,
        maxOutputTokens: 256,
      },
    );

    expect(seenMessages[0]).toEqual([{ role: "user", content: "hello" }]);
    expect(seenOptions[0]).toMatchObject({
      systemPrompt: "base system",
      contextWindowTokens: 1024,
      maxOutputTokens: 256,
    });
  });

  test("requires a tool choice in plan mode when tools are available", async () => {
    const ctx = mkCtx("plan");
    const state = mkState(ctx);
    const registry = mkRegistry([
      {
        name: "AskUserQuestion",
        description: "asks the user a question",
        inputSchema: { type: "object" },
        execute: async () => ({ content: "answered" }),
      },
    ]);
    const seenOptions: LLMChatOptions[] = [];
    const provider = mkProvider(async (_messages, _onChunk, options) => {
      seenOptions.push(options ?? {});
      return {
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            name: "AskUserQuestion",
            arguments: JSON.stringify({ questions: [] }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      };
    });
    const { session } = mkSession(provider, null, registry);

    await streamModel(
      state,
      ctx,
      session,
      {
        ...mkRequest([{ role: "user", content: "plan this" }]),
        tools: registry.toLLMTools(),
      },
    );

    expect(seenOptions[0]?.toolChoice).toBe("required");
  });

  test("does not require tool choice outside plan mode", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    const registry = mkRegistry([
      {
        name: "AskUserQuestion",
        description: "asks the user a question",
        inputSchema: { type: "object" },
        execute: async () => ({ content: "answered" }),
      },
    ]);
    const seenOptions: LLMChatOptions[] = [];
    const provider = mkProvider(async (_messages, _onChunk, options) => {
      seenOptions.push(options ?? {});
      return {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session } = mkSession(provider, null, registry);

    await streamModel(
      state,
      ctx,
      session,
      {
        ...mkRequest([{ role: "user", content: "hello" }]),
        tools: registry.toLLMTools(),
      },
    );

    expect(seenOptions[0]?.toolChoice).toBeUndefined();
  });

  test("dispatches streamed tool calls before chatStream resolves", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    streamedDispatchCalls.length = 0;
    const registry = mkRegistry([
      {
        name: "FileRead",
        description: "reads a file",
        inputSchema: { type: "object" },
        concurrencyClass: { kind: "shared_read" as const },
        execute: async () => {
          return { content: "file contents" };
        },
      },
    ]);
    const provider = mkProvider(async (_messages, onChunk) => {
      onChunk({
        content: "Working...",
        done: false,
        toolCalls: [
          {
            id: "tool-1",
            name: "FileRead",
            arguments: JSON.stringify({ path: "/tmp/demo.txt" }),
          },
        ],
      });
      expect(streamedDispatchCalls).toEqual(["tool-1"]);
      return {
        content: "Working...",
        toolCalls: [
          {
            id: "tool-1",
            name: "FileRead",
            arguments: JSON.stringify({ path: "/tmp/demo.txt" }),
          },
        ],
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        model: "test-model",
        finishReason: "tool_calls",
      };
    });
    const { session, events } = mkSession(provider, null, registry);

    await streamModel(
      state,
      ctx,
      session,
      {
        ...mkRequest([{ role: "user", content: "hello" }]),
        tools: registry.toLLMTools(),
      },
      undefined,
    );

    expect(state.toolUseBlocks.map((block) => block.id)).toEqual(["tool-1"]);
    expect(streamedDispatchCalls).toEqual(["tool-1"]);
    expect(events.some((event) => event.msg.type === "agent_message")).toBe(true);
  });

  test("validates streamed tool calls before queueing them", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    streamedDispatchCalls.length = 0;
    const registry = mkRegistry([
      {
        name: "FileRead",
        description: "reads a file",
        inputSchema: { type: "object" },
        execute: async () => ({ content: "file contents" }),
      },
    ]);
    const provider = mkProvider(async (_messages, onChunk) => {
      onChunk({
        content: "Working...",
        done: false,
        toolCalls: [
          {
            id: "tool-bad",
            name: "FileRead",
            arguments: "[",
          } as unknown as LLMToolCall,
        ],
      });
      return {
        content: "Working...",
        toolCalls: [
          {
            id: "tool-bad",
            name: "FileRead",
            arguments: "[",
          } as unknown as LLMToolCall,
        ],
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        model: "test-model",
        finishReason: "tool_calls",
      };
    });
    const { session, events } = mkSession(provider, null, registry);

    await streamModel(
      state,
      ctx,
      session,
      {
        ...mkRequest([{ role: "user", content: "hello" }]),
        tools: registry.toLLMTools(),
      },
      undefined,
    );

    expect(streamedDispatchCalls).toEqual([]);
    expect(state.toolUseBlocks).toEqual([]);
    expect(
      events.filter(
        (event) =>
          event.msg.type === "tool_call_completed" &&
          event.msg.payload.callId === "tool-bad",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.msg.type === "stream_error" &&
          event.msg.payload.cause === "malformed_tool_call",
      ),
    ).toBe(true);
  });

  test("marks length responses for max-output recovery and drops tool calls", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    streamedDispatchCalls.length = 0;
    const registry = mkRegistry([
      {
        name: "Write",
        description: "writes a file",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            content: { type: "string" },
          },
          required: ["file_path", "content"],
        },
        execute: async () => ({ content: "wrote" }),
      },
    ]);
    const provider = mkProvider(async () => ({
      content: "Let me start with the parser rewrite.",
      toolCalls: [
        {
          id: "tool-1",
          name: "Write",
          arguments: JSON.stringify({ file_path: "/tmp/parser.c" }),
        },
      ],
      usage: { promptTokens: 85_000, completionTokens: 4_096, totalTokens: 89_096 },
      model: "test-model",
      finishReason: "length",
    }));
    const { session, events } = mkSession(provider, null, registry);

    await streamModel(
      state,
      ctx,
      session,
      {
        ...mkRequest([{ role: "user", content: "rewrite parser" }]),
        tools: registry.toLLMTools(),
      },
      undefined,
    );

    expect(state.assistantMessages.at(-1)?.apiError).toBe("max_output_tokens");
    expect(state.assistantMessages.at(-1)?.toolCalls).toEqual([]);
    expect(state.toolUseBlocks).toEqual([]);
    expect(state.needsFollowUp).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Let me start with the parser rewrite.",
    });
    expect((state.messages.at(-1) as { toolCalls?: unknown }).toolCalls).toBeUndefined();
    expect(streamedDispatchCalls).toEqual([]);
    expect(events.some((event) => event.msg.type === "tool_call_started")).toBe(false);
  });

  test("strips hidden tags and spoof patterns before delta/final event emission", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    const provider = mkProvider(async (_messages, onChunk) => {
      onChunk({ content: "Hello <oai-mem-citati", done: false });
      onChunk({
        content:
          "on>doc</oai-mem-citation> [Approval Required]world",
        done: false,
      });
      return {
        content:
          "Hello <oai-mem-citation>doc</oai-mem-citation> [Approval Required]world",
        toolCalls: [],
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session, events } = mkSession(provider);

    await streamModel(
      state,
      ctx,
      session,
      mkRequest([{ role: "user", content: "hello" }]),
      undefined,
    );

    const deltas = events.filter((event) => event.msg.type === "agent_message_delta");
    expect(deltas.length).toBe(2);
    const combinedDelta = deltas
      .map((event) =>
        event.msg.type === "agent_message_delta" ? event.msg.payload.delta : "",
      )
      .join("");
    expect(combinedDelta).toBe("Hello  world");
    expect(combinedDelta).not.toContain("oai-mem-citation");
    expect(combinedDelta).not.toContain("[Approval Required]");

    const finalMessage = events.findLast(
      (event) => event.msg.type === "agent_message",
    );
    expect(finalMessage).toBeDefined();
    if (finalMessage?.msg.type === "agent_message") {
      expect(finalMessage.msg.payload.message).toBe("Hello  world");
    }

    const warnings = events.filter((event) => event.msg.type === "warning");
    expect(warnings.some((event) => (
      event.msg.type === "warning" &&
      event.msg.payload.cause === "model_ui_spoof_pattern"
    ))).toBe(true);
    expect(state.assistantMessages.at(-1)?.text).toBe("Hello  world");
  });

  test("suppresses proposed_plan blocks in emitted assistant text while preserving raw response history", async () => {
    const ctx = mkCtx("plan");
    const state = mkState(ctx);
    const provider = mkProvider(async (_messages, onChunk) => {
      onChunk({ content: "Before\n<proposed", done: false });
      onChunk({
        content: "_plan>\nhidden\n</proposed_plan>\nAfter",
        done: false,
      });
      return {
        content: "Before\n<proposed_plan>\nhidden\n</proposed_plan>\nAfter",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session, events } = mkSession(provider);

    await streamModel(
      state,
      ctx,
      session,
      mkRequest([{ role: "user", content: "hello" }]),
      undefined,
    );

    const combinedDelta = events
      .filter((event) => event.msg.type === "agent_message_delta")
      .map((event) =>
        event.msg.type === "agent_message_delta" ? event.msg.payload.delta : "",
      )
      .join("");
    expect(combinedDelta).toBe("Before\nAfter");
    expect(combinedDelta).not.toContain("<proposed_plan>");
    expect(combinedDelta).not.toContain("hidden");
    expect(state.assistantMessages.at(-1)?.text).toBe("Before\nAfter");

    const rawAssistantMessage = state.messages.at(-1);
    expect(rawAssistantMessage?.role).toBe("assistant");
    expect(rawAssistantMessage?.content).toBe(
      "Before\n<proposed_plan>\nhidden\n</proposed_plan>\nAfter",
    );
  });
});

describe("streamModel — token budget boundary semantics", () => {
  test("stores the continuation prompt when boundary truth stays below the completion threshold", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    const budgetTracker = new BudgetTracker(1_000, 100);
    const provider = mkProvider(async (_messages, onChunk) => {
      onChunk({
        content: "x".repeat(4_000),
        done: false,
      });
      return {
        content: "concise final answer",
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 400, totalTokens: 420 },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session } = mkSession(provider, budgetTracker);

    await streamModel(
      state,
      ctx,
      session,
      mkRequest([{ role: "user", content: "hello" }]),
      undefined,
    );

    expect(state.pendingBudgetDecision?.kind).toBe("stop");
    expect(state.pendingBudgetDecision?.reason).toContain(
      "Stopped at 40% of token target",
    );
  });

  test("clears pending budget continuation when provider truth reaches the stop path", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    const budgetTracker = new BudgetTracker(1_000, 100);
    const provider = mkProvider(async (_messages, onChunk) => {
      onChunk({
        content: "x".repeat(4_000),
        done: false,
      });
      return {
        content: "long enough",
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 950, totalTokens: 970 },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session } = mkSession(provider, budgetTracker);

    await streamModel(
      state,
      ctx,
      session,
      mkRequest([{ role: "user", content: "hello" }]),
      undefined,
    );

    expect(state.pendingBudgetDecision).toBeUndefined();
  });
});

describe("streamModel — SessionState.totalTokenUsage accumulator", () => {
  // Regression guard. `run-turn.ts` reads `SessionState.totalTokenUsage`
  // via `getTotalTokenUsage(session)` to drive the mid-turn compact gate
  // (`total_usage_tokens >= auto_compact_limit`). Upstream agenc runtime
  // maintains a real cross-turn accumulator
  // (`Session::update_token_info_from_usage`,
  // `TokenUsageInfo::append_last_usage` at protocol.rs:2294-2297); AgenC
  // used to read an unwritten field and papered over the miss with
  // `Math.max(sessionTotal, usage.totalTokens)` in the mid-turn arm. The
  // writer now lives in `streamModel` right after the per-turn usage
  // stash on TurnState — every provider-reported stream completion
  // element-wise accumulates into `state.totalTokenUsage` under the
  // session state lock.

  type StatePeek = Readonly<{
    totalTokenUsage?: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
      readonly cachedInputTokens: number;
      readonly reasoningOutputTokens: number;
    };
  }>;

  function peek(session: Session): StatePeek {
    return (
      session as unknown as {
        state: { unsafePeek: () => StatePeek };
      }
    ).state.unsafePeek();
  }

  test("compounds successive provider usage element-wise into session.state.totalTokenUsage", async () => {
    const ctx = mkCtx("chat");
    let call = 0;
    const provider = mkProvider(async () => {
      call += 1;
      // Two distinct samples so every slot has to accumulate, not just
      // totalTokens. Provider may surface cache/reasoning fields as
      // structural extras alongside the LLMUsage base contract; the
      // writer reads those optimistically so the accumulator stays
      // aligned with agenc runtime's 5-field TokenUsage shape.
      if (call === 1) {
        return {
          content: "first",
          toolCalls: [],
          usage: {
            promptTokens: 100,
            completionTokens: 200,
            totalTokens: 300,
            cachedInputTokens: 10,
            cacheCreationInputTokens: 4,
            reasoningOutputTokens: 5,
            webSearchRequests: 2,
          } as unknown as {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
          },
          model: "test-model",
          finishReason: "stop",
        };
      }
      return {
        content: "second",
        toolCalls: [],
        usage: {
          promptTokens: 50,
          completionTokens: 75,
          totalTokens: 125,
          cachedInputTokens: 3,
          reasoningOutputTokens: 2,
        } as unknown as {
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
        },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session, events } = mkSession(provider);

    const state1 = mkState(ctx);
    await streamModel(
      state1,
      ctx,
      session,
      mkRequest([{ role: "user", content: "one" }]),
    );
    expect(peek(session).totalTokenUsage).toEqual({
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      cachedInputTokens: 10,
      reasoningOutputTokens: 5,
    });
    expect(
      events.find((event) => event.msg.type === "token_count")?.msg,
    ).toEqual({
      type: "token_count",
      payload: {
        promptTokens: 100,
        completionTokens: 200,
        totalTokens: 300,
        model: "test-model",
        provider: "stub-provider",
        cachedInputTokens: 10,
        cacheCreationInputTokens: 4,
        reasoningOutputTokens: 5,
        webSearchRequests: 2,
      },
    });

    // Second call — a distinct TurnState to model a continuation
    // iteration that would otherwise reset per-turn counters. The
    // session-level accumulator MUST keep adding, not reset.
    const state2 = mkState(ctx);
    await streamModel(
      state2,
      ctx,
      session,
      mkRequest([{ role: "user", content: "two" }]),
    );
    expect(peek(session).totalTokenUsage).toEqual({
      promptTokens: 150,
      completionTokens: 275,
      totalTokens: 425,
      cachedInputTokens: 13,
      reasoningOutputTokens: 7,
    });
  });

  test("token_count uses the response model and provider for cost attribution", async () => {
    const ctx = mkCtx("chat");
    const provider = mkProvider(async () => ({
      content: "ok",
      toolCalls: [],
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      model: "actual-response-model",
      finishReason: "stop",
    }));
    const { session, events } = mkSession(provider);

    await streamModel(
      mkState(ctx),
      ctx,
      session,
      mkRequest([{ role: "user", content: "attribute this" }]),
    );

    const tokenCount = events.find((event) => event.msg.type === "token_count");
    expect(tokenCount?.msg).toMatchObject({
      type: "token_count",
      payload: {
        model: "actual-response-model",
        provider: "stub-provider",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    });
  });

  test("real-shaped provider usage reaches CostSidecar through token_count", async () => {
    const ctx = mkCtx("chat");
    const provider = mkProvider(async () =>
      parseAnthropicMessagesResponse(
        // branding-scan: allow documented Anthropic API model identifier
        "claude-sonnet-4-5",
        {
          // branding-scan: allow documented Anthropic API model identifier
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 300,
            server_tool_use: { web_search_requests: 2 },
          },
        },
        {
          // branding-scan: allow documented Anthropic API model identifier
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "search" }],
          tools: [],
        },
      )
    );
    const { session } = mkSession(provider);
    const sidecar = new CostSidecar();
    session.eventLog.subscribe((event) => sidecar.onEvent(event));

    await streamModel(
      mkState(ctx),
      ctx,
      session,
      mkRequest([{ role: "user", content: "search" }]),
    );

    expect(sidecar.getPerModelUsage()).toMatchObject([
      {
        provider: "stub-provider",
        // branding-scan: allow documented Anthropic API model identifier
        model: "claude-sonnet-4-5",
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 200,
        cacheCreationInputTokens: 300,
        webSearchRequests: 2,
      },
    ]);
    expect(sidecar.getTotalCacheCreationInputTokens()).toBe(300);
    expect(sidecar.getTotalWebSearchRequests()).toBe(2);
    expect(sidecar.getTotalCostUsd()).toBeGreaterThan(0.02);
  });

  test("survives a non-compacting turn — a third call keeps adding onto the prior two", async () => {
    // Regression guard against a naive reset-per-turn implementation.
    // agenc runtime's accumulator is additive across the whole session; the
    // only agenc runtime reset paths are `recompute_token_usage` (after
    // compaction) and `fill_to_context_window`, neither of which runs
    // on a plain non-compacting turn.
    const ctx = mkCtx("chat");
    const provider = mkProvider(async () => {
      return {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        model: "test-model",
        finishReason: "stop",
      };
    });
    const { session } = mkSession(provider);

    for (let i = 0; i < 3; i += 1) {
      const state = mkState(ctx);
      // eslint-disable-next-line no-await-in-loop
      await streamModel(
        state,
        ctx,
        session,
        mkRequest([{ role: "user", content: "turn" }]),
      );
    }

    expect(peek(session).totalTokenUsage).toEqual({
      promptTokens: 30,
      completionTokens: 60,
      totalTokens: 90,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });

  test("provider omitting usage is a no-op, not a zero-write — accumulator stays intact", async () => {
    // Task rule: "Providers either emit usage or they don't; handle the
    // undefined case as a no-op write, not a zero write (zero would
    // pollute the accumulator)." Guard that contract here — the first
    // sample seeds, the second (no usage) leaves the accumulator alone.
    const ctx = mkCtx("chat");
    let call = 0;
    const provider = mkProvider(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: "first",
          toolCalls: [],
          usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
          model: "test-model",
          finishReason: "stop",
        };
      }
      return {
        content: "second",
        toolCalls: [],
        // No usage field — provider truly reported nothing.
        model: "test-model",
        finishReason: "stop",
      } as unknown as {
        content: string;
        toolCalls: unknown[];
        model: string;
        finishReason: string;
      };
    });
    const { session } = mkSession(provider);

    await streamModel(
      mkState(ctx),
      ctx,
      session,
      mkRequest([{ role: "user", content: "one" }]),
    );
    await streamModel(
      mkState(ctx),
      ctx,
      session,
      mkRequest([{ role: "user", content: "two" }]),
    );

    expect(peek(session).totalTokenUsage).toEqual({
      promptTokens: 7,
      completionTokens: 11,
      totalTokens: 18,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });
});

describe("streamModel — refusal stop reason (task 28)", () => {
  // Claude Fable 5 safety classifiers can decline a request on HTTP 200
  // with `stop_reason: "refusal"` and an EMPTY content array. The wire
  // normalizes that to finishReason "content_filter"; without an apiError
  // mapping the turn ended as a silent empty assistant message.
  test("surfaces a pre-output refusal as a visible apiError message, not silent empty content", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    const provider = mkProvider(async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      model: "claude-fable-5",
      finishReason: "content_filter",
    }));
    const { session } = mkSession(provider);

    await streamModel(
      state,
      ctx,
      session,
      mkRequest([{ role: "user", content: "hello" }]),
    );

    const assistant = state.assistantMessages.at(-1);
    expect(assistant?.apiError).toBe("refusal");
    // Clear user-visible body — not an empty message.
    expect(assistant?.text).toContain("refusal");
    expect((assistant?.text ?? "").length).toBeGreaterThan(0);
  });

  test("a mid-stream refusal keeps the partial text and still flags the apiError", async () => {
    const ctx = mkCtx("chat");
    const state = mkState(ctx);
    const provider = mkProvider(async (_messages, onChunk) => {
      onChunk({ content: "partial answer ", done: false });
      return {
        content: "partial answer ",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
        model: "claude-fable-5",
        finishReason: "content_filter",
      };
    });
    const { session } = mkSession(provider);

    await streamModel(
      state,
      ctx,
      session,
      mkRequest([{ role: "user", content: "hello" }]),
    );

    const assistant = state.assistantMessages.at(-1);
    expect(assistant?.apiError).toBe("refusal");
    expect(assistant?.text).toContain("partial answer");
  });
});
