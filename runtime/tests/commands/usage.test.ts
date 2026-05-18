import { describe, expect, it } from "vitest";
import { formatUsage, usageCommand } from "./usage.js";
import type { Session } from "../session/session.js";

function stubSession(opts: {
  totalTokenUsage?: Record<string, number>;
  budget?: { emitted: number; remaining: number | null };
}): Session {
  return {
    state: {
      unsafePeek: () => ({
        totalTokenUsage: opts.totalTokenUsage,
      }),
    },
    budgetTracker: opts.budget,
  } as unknown as Session;
}

describe("usageCommand", () => {
  it("formats zero-usage state when no token totals are present", () => {
    const text = formatUsage(stubSession({}));
    expect(text).toContain("Usage");
    expect(text).toContain("total tokens: 0");
    expect(text).toContain("budget emitted: n/a");
    expect(text).toContain("budget remaining: n/a");
  });

  it("formats real usage and budget state", () => {
    const text = formatUsage(
      stubSession({
        totalTokenUsage: {
          totalTokens: 12000,
          promptTokens: 8000,
          completionTokens: 4000,
          cachedInputTokens: 5000,
        },
        budget: { emitted: 12000, remaining: 88_000 },
      }),
    );
    expect(text).toContain("total tokens: 12000");
    expect(text).toContain("prompt tokens: 8000");
    expect(text).toContain("completion tokens: 4000");
    expect(text).toContain("cached input tokens: 5000");
    expect(text).toContain("budget emitted: 12000");
    expect(text).toContain("budget remaining: 88000");
  });

  it("renders 'unlimited' when budget remaining is null", () => {
    const text = formatUsage(
      stubSession({
        budget: { emitted: 10, remaining: null },
      }),
    );
    expect(text).toContain("budget remaining: unlimited");
  });

  it("execute() returns a text result", async () => {
    const result = await usageCommand.execute({
      session: stubSession({}),
      argsRaw: "",
      cwd: "/tmp/ws",
      home: "/tmp/home",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("Usage");
    }
  });
});
