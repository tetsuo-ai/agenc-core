import { describe, expect, test } from "vitest";

import { buildStatusLineSession } from "./status-derivation.js";

describe("buildStatusLineSession", () => {
  test("derives live token, context, output, cost, and budget fields", () => {
    const session = {
      conversationId: "session-1234567890",
      services: {
        costSidecar: { getTotalCostUsd: () => 1.25 },
        configStore: { current: () => ({ max_budget_usd: 5 }) },
      },
      state: {
        unsafePeek: () => ({
          totalTokenUsage: {
            promptTokens: 300,
            completionTokens: 120,
            totalTokens: 500,
            cachedInputTokens: 0,
            reasoningOutputTokens: 30,
          },
          previousTurnSettings: {
            contextWindow: 1_000,
          },
        }),
      },
    };

    expect(buildStatusLineSession(session, "plan", "grok-4")).toMatchObject({
      model: "grok-4",
      mode: "plan",
      sessionId: "session-1234567890",
      tokensUsed: 500,
      outputTokens: 150,
      contextPercent: 50,
      costUsd: 1.25,
      budgetUsd: 5,
      budgetRemainingUsd: 3.75,
    });
  });

  test("falls back to initial token usage before live totals exist", () => {
    const session = {
      state: {
        unsafePeek: () => ({
          initialTokenUsage: {
            completionTokens: 10,
            totalTokens: 42,
            reasoningOutputTokens: 5,
          },
        }),
      },
    };

    expect(buildStatusLineSession(session, "default", undefined)).toMatchObject({
      mode: "default",
      tokensUsed: 42,
      outputTokens: 15,
    });
  });
});
