import { describe, expect, test } from "vitest";

import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "../../session/attachment-state.js";
import { usageNoticesProducer } from "./usage-notices.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

function makeOpts(
  sessionKey: object,
  patch: Partial<GetAttachmentsOptions> = {},
): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput: null,
    loadedTools: [],
    discoveredToolNames: new Set(),
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd: "/tmp/agenc-usage-notices-test",
    subagentDepth: 0,
    signal: new AbortController().signal,
    ...patch,
  };
}

describe("usageNoticesProducer", () => {
  test("emits context usage once per increasing threshold bucket", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);

    const first = await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          context: {
            usedTokens: 70,
            totalTokens: 100,
            remainingTokens: 30,
            percentUsed: 70,
          },
        },
      }),
      state,
    );
    expect(first).toEqual([
      {
        kind: "token_usage",
        used: 70,
        total: 100,
        remaining: 30,
        percentUsed: 70,
      },
    ]);

    const repeat = await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          context: {
            usedTokens: 75,
            totalTokens: 100,
            remainingTokens: 25,
            percentUsed: 75,
          },
        },
      }),
      state,
    );
    expect(repeat).toEqual([]);

    const next = await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          context: {
            usedTokens: 80,
            totalTokens: 100,
            remainingTokens: 20,
            percentUsed: 80,
          },
        },
      }),
      state,
    );
    expect(next).toEqual([
      {
        kind: "token_usage",
        used: 80,
        total: 100,
        remaining: 20,
        percentUsed: 80,
      },
    ]);

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("resets context gating when usage drops below the first bucket", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);

    await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          context: {
            usedTokens: 80,
            totalTokens: 100,
            remainingTokens: 20,
            percentUsed: 80,
          },
        },
      }),
      state,
    );
    await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          context: {
            usedTokens: 30,
            totalTokens: 100,
            remainingTokens: 70,
            percentUsed: 30,
          },
        },
      }),
      state,
    );
    const out = await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          context: {
            usedTokens: 70,
            totalTokens: 100,
            remainingTokens: 30,
            percentUsed: 70,
          },
        },
      }),
      state,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("token_usage");

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("emits USD and output-token budgets from the snapshot", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);

    const out = await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          costBudget: {
            usedUsd: 1.25,
            totalUsd: 5,
            remainingUsd: 3.75,
            percentUsed: 25,
          },
          output: {
            turnTokens: 750,
            sessionTokens: 2_000,
            budgetTokens: 4_000,
          },
        },
      }),
      state,
    );

    expect(out).toEqual([
      {
        kind: "budget_usd",
        used: 1.25,
        total: 5,
        remaining: 3.75,
        percentUsed: 25,
      },
      {
        kind: "output_token_usage",
        turn: 750,
        session: 2_000,
        budget: 4_000,
      },
    ]);

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("emits compaction reminder once per increasing threshold bucket", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);

    const first = await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          compaction: {
            usedTokens: 800,
            thresholdTokens: 1_000,
            remainingTokens: 200,
            percentUsed: 80,
          },
        },
      }),
      state,
    );
    expect(first).toEqual([
      {
        kind: "compaction_reminder",
        used: 800,
        threshold: 1_000,
        remaining: 200,
        percentUsed: 80,
      },
    ]);

    const repeat = await usageNoticesProducer(
      makeOpts(sessionKey, {
        usageSnapshot: {
          compaction: {
            usedTokens: 850,
            thresholdTokens: 1_000,
            remainingTokens: 150,
            percentUsed: 85,
          },
        },
      }),
      state,
    );
    expect(repeat).toEqual([]);

    _resetAttachmentTrackingStateForTest(sessionKey);
  });

  test("skips subagents", async () => {
    const sessionKey = {};
    const state = getAttachmentTrackingState(sessionKey);
    const out = await usageNoticesProducer(
      makeOpts(sessionKey, {
        subagentDepth: 1,
        usageSnapshot: {
          context: {
            usedTokens: 95,
            totalTokens: 100,
            remainingTokens: 5,
            percentUsed: 95,
          },
        },
      }),
      state,
    );
    expect(out).toEqual([]);
    _resetAttachmentTrackingStateForTest(sessionKey);
  });
});

