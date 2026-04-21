import { describe, expect, test } from "vitest";
import { EventLog, type Event } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import { buildInitialTurnState } from "../session/turn-state.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
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
    dynamicTools: [],
    depth: 0,
    toolCallGate: {
      isReady: () => true,
      signal: () => {},
      wait: async () => {},
    },
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

function mkSession(provider: LLMProvider): {
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
    services: { provider },
    budgetTracker: null,
    nextInternalSubId: () => `sub-${++subId}`,
    emit: (event: Event) => {
      eventLog.emit(event);
    },
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

describe("streamModel — live assistant text sanitization", () => {
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
