import { describe, expect, it } from "vitest";
import {
  cacheStatsCommand,
  formatCacheStats,
  readTokenUsageSummary,
} from "./cache-stats.js";
import type { Session } from "../session/session.js";

function stubSession(usage: Record<string, number> | undefined): Session {
  return {
    state: {
      unsafePeek: () => ({
        totalTokenUsage: usage,
      }),
    },
  } as unknown as Session;
}

describe("readTokenUsageSummary", () => {
  it("returns zeros when no usage data is present", () => {
    const summary = readTokenUsageSummary(stubSession(undefined));
    expect(summary).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });

  it("normalizes invalid numeric fields to 0", () => {
    const session = {
      state: {
        unsafePeek: () => ({
          totalTokenUsage: {
            promptTokens: "not-a-number",
            totalTokens: NaN,
            completionTokens: Infinity,
            cachedInputTokens: 100,
          },
        }),
      },
    } as unknown as Session;
    const summary = readTokenUsageSummary(session);
    expect(summary.promptTokens).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.completionTokens).toBe(0);
    expect(summary.cachedInputTokens).toBe(100);
  });

  it("falls back to initialTokenUsage when totalTokenUsage is absent", () => {
    const session = {
      state: {
        unsafePeek: () => ({
          initialTokenUsage: { promptTokens: 42, totalTokens: 42 },
        }),
      },
    } as unknown as Session;
    expect(readTokenUsageSummary(session)).toMatchObject({
      promptTokens: 42,
      totalTokens: 42,
    });
  });
});

describe("formatCacheStats", () => {
  it("returns the 'no requests' fallback when the tracker module is unavailable", async () => {
    const text = await formatCacheStats();
    expect(text).toContain("Cache stats");
    expect(text).toContain("No API requests yet");
  });
});

describe("cacheStatsCommand.execute", () => {
  it("returns a text result", async () => {
    const result = await cacheStatsCommand.execute({
      session: stubSession(undefined),
      argsRaw: "",
      cwd: "/tmp/ws",
      home: "/tmp/home",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("Cache stats");
    }
  });
});
