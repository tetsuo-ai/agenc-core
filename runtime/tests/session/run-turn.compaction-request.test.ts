import { afterEach, describe, expect, test, vi } from "vitest";

import type { LLMMessage, LLMTool } from "../../src/llm/types.js";
import * as autoCompact from "../../src/services/compact/autoCompact.js";
import { runAutoCompact } from "../../src/session/run-turn-compaction.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { toAgenCRuntimeMessages } from "../../src/session/runtime-message-conversion.js";
import { mkCtx, mkSession } from "../fixtures.js";
import {
  attachCompactionSession,
  createCompactionTransactionHarness,
} from "../helpers/compaction-transaction-harness.js";

afterEach(() => vi.restoreAllMocks());

describe("automatic compaction sampling request accounting", () => {
  test("commits local-model compaction without charging hidden tool schemas", async () => {
    const source: LLMMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: Array.from({ length: 200 }, (_, line) =>
        `Message ${index}, line ${line}. Preserve this implementation detail.\n`,
      ).join(""),
    }));
    const harness = createCompactionTransactionHarness(source, {
      sessionId: "conv-test",
      maxOutputTokens: 4_096,
      contextWindowTokens: 65_536,
    });
    const { session, events } = mkSession({
      provider: harness.provider,
      history: source,
      services: {
        executionAdmission: harness.session.services.executionAdmission,
      },
    });
    attachCompactionSession(session, harness);
    Object.assign(harness.provider, { tokenCountCapability: undefined });
    vi.spyOn(session.services.registry, "toLLMTools").mockReturnValue([
      {
        type: "function",
        function: {
          name: "FileRead",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "remote_tool",
          description: "Hidden tool documentation ".repeat(5_000),
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    const context = mkCtx({
      modelProviderId: "ollama",
      dynamicTools: [{ name: "remote_tool", deferLoading: true }] as never,
      modelInfo: {
        ...mkCtx().modelInfo,
        slug: "grok-4.5",
        contextWindow: 65_536,
        maxOutputTokens: 4_096,
      },
    });
    const state = buildInitialTurnState(context, source.at(-1)!, {
      priorMessages: source.slice(0, -1),
      modelInstructions: "Keep implementing the user's request.",
    });
    try {
      const compacted = await runAutoCompact(
        session, context, "do_not_inject", "context_limit", "in_turn", state,
      );
      expect(compacted, JSON.stringify(events.filter(
        (event) => event.msg.type === "warning",
      ))).toBe(true);
      expect(harness.store.readAll().some(
        (item) => item.type === "compaction_committed",
      )).toBe(true);
      expect(state.messages).not.toEqual(source);
    } finally {
      session.mountRolloutStore(null);
      harness.close();
    }
  });

  test.each(["ollama", "grok"])(
    "uses the %s sampling catalog without runtime tool wrappers",
    async (providerName) => {
      const tools: LLMTool[] = ["FileRead", "Write", "remote_tool"].map(
        (name) => ({
          type: "function",
          function: {
            name,
            description: `${name} description`,
            parameters: { type: "object", properties: {} },
          },
        }),
      );
      const { session } = mkSession();
      vi.spyOn(session.services.registry, "toLLMTools").mockReturnValue(tools);
      const context = mkCtx({
        modelProviderId: providerName,
        dynamicTools: [{ name: "Write", deferLoading: true }] as never,
        baseInstructions: "base instructions",
      });
      const state = buildInitialTurnState(context, {
        role: "user",
        content: "continue",
      }, {
        modelInstructions: "current assembled instructions",
        initialMaxOutputTokensOverride: 2_048,
      });
      state.messagesForQuery = [
        { role: "system", content: "old summary, not current policy" },
        ...state.messages,
      ];
      const compact = vi.spyOn(autoCompact, "autoCompactIfNeeded")
        .mockResolvedValue({ wasCompacted: false });

      await runAutoCompact(
        session, context, "do_not_inject", "context_limit", "in_turn", state,
      );

      const expected = buildSamplingRequestContract(
        { ...state, messagesForQuery: [] }, session, context,
      );
      const compactContext = compact.mock.calls[0]?.[1];
      expect(compactContext?.options).toMatchObject({
        tools: expected.tools,
        systemPrompt: expected.baseInstructions,
        contextWindowTokens: expected.contextWindowTokens,
        maxOutputTokens: expected.maxOutputTokens,
      });
      expect(compactContext?.options?.tools).toEqual(expected.tools);
      expect(compactContext?.options?.systemPrompt).not.toContain("old summary");
      expect(compact.mock.calls[0]?.[0]).toEqual(
        toAgenCRuntimeMessages(state.messages),
      );
    },
  );
});
