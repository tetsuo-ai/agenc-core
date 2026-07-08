import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyToolResultBudget,
  provisionContentReplacementState,
  resolveToolResultBudgetChars,
  shrinkOversizedToolResults,
  shrinkToolResultContent,
  type ContentReplacementState,
  type ToolResultBudgetMessage,
} from "./_deps/tool-result-storage.js";
import { roughTokenCountEstimationForMessages } from "../llm/token-estimation.js";
import type { LLMMessage } from "../llm/types.js";

function toolMsg(id: string, content: string): ToolResultBudgetMessage {
  return {
    role: "user",
    originalRole: "tool",
    toolCallId: id,
    content,
    message: { role: "user", content },
  };
}

function assistantMsg(content = "ok"): ToolResultBudgetMessage {
  return { role: "assistant", content, message: { role: "assistant", content } };
}

function freshState(): ContentReplacementState {
  return provisionContentReplacementState();
}

const fakePersist = () =>
  vi.fn(async (_content: string, toolUseId: string) => `<persisted:${toolUseId}>`);

afterEach(() => {
  delete process.env.AGENC_TOOL_RESULT_BUDGET_CHARS;
});

describe("applyToolResultBudget (flat shape)", () => {
  test("replaces the largest fresh results when a group exceeds the budget", async () => {
    const state = freshState();
    const persist = fakePersist();
    const messages = [
      assistantMsg(),
      ...Array.from({ length: 50 }, (_, i) =>
        toolMsg(`id-${i}`, "x".repeat(100_000)),
      ),
    ];
    const result = await applyToolResultBudget(messages, state, {
      limitChars: 200_000,
      persist,
    });
    // 50 × 100K = 5M chars; each replacement sheds ~100K so 48
    // replacements bring the group to 200K.
    expect(result.newlyReplaced).toHaveLength(48);
    expect(persist).toHaveBeenCalledTimes(48);
    const totalToolChars = result.messages
      .filter((m) => m.originalRole === "tool")
      .reduce((sum, m) => sum + (m.content as string).length, 0);
    expect(totalToolChars).toBeLessThanOrEqual(220_000);
    // Replaced messages carry the persisted marker in BOTH content mirrors.
    const replaced = result.messages.find(
      (m) => m.toolCallId === result.newlyReplaced[0]?.toolUseId,
    );
    expect(replaced?.content).toMatch(/^<persisted:/);
    expect(replaced?.message?.content).toMatch(/^<persisted:/);
  });

  test("re-applies cached replacements byte-identically without new persists", async () => {
    const state = freshState();
    const persist = fakePersist();
    const messages = [toolMsg("big", "y".repeat(300_000))];
    const first = await applyToolResultBudget(messages, state, {
      limitChars: 200_000,
      persist,
    });
    expect(first.newlyReplaced).toHaveLength(1);
    // Second pass over the ORIGINAL content (as replayed each turn).
    const second = await applyToolResultBudget(messages, state, {
      limitChars: 200_000,
      persist,
    });
    expect(second.newlyReplaced).toHaveLength(0);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(second.messages[0]?.content).toBe(first.messages[0]?.content);
  });

  test("previously-seen unreplaced results are frozen forever", async () => {
    const state = freshState();
    const persist = fakePersist();
    const small = toolMsg("seen-early", "z".repeat(10_000));
    await applyToolResultBudget([small], state, {
      limitChars: 200_000,
      persist,
    });
    expect(state.seenIds.has("seen-early")).toBe(true);
    // Later the same result appears in an over-budget group: only the
    // FRESH sibling may be replaced, never the frozen one.
    const result = await applyToolResultBudget(
      [small, toolMsg("fresh-huge", "w".repeat(400_000))],
      state,
      { limitChars: 200_000, persist },
    );
    expect(result.newlyReplaced.map((r) => r.toolUseId)).toEqual([
      "fresh-huge",
    ]);
    expect(result.messages[0]?.content).toBe(small.content);
  });

  test("persist failure keeps the original content and freezes the id", async () => {
    const state = freshState();
    const persist = vi.fn(async () => null);
    const messages = [toolMsg("fails", "f".repeat(300_000))];
    const result = await applyToolResultBudget(messages, state, {
      limitChars: 200_000,
      persist,
    });
    expect(result.newlyReplaced).toHaveLength(0);
    expect(result.messages[0]?.content).toBe(messages[0]?.content);
    expect(state.seenIds.has("fails")).toBe(true);
    // Never retried on the next pass (frozen).
    await applyToolResultBudget(messages, state, {
      limitChars: 200_000,
      persist,
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  test("results under the min-replace floor are never persisted", async () => {
    const state = freshState();
    const persist = fakePersist();
    // 200 × 1K in one group = 200K > 100K limit, but every result is
    // below the 2K floor.
    const messages = Array.from({ length: 200 }, (_, i) =>
      toolMsg(`tiny-${i}`, "t".repeat(1_000)),
    );
    const result = await applyToolResultBudget(messages, state, {
      limitChars: 100_000,
      persist,
    });
    expect(result.newlyReplaced).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });

  test("groups separated by non-tool messages are budgeted independently", async () => {
    const state = freshState();
    const persist = fakePersist();
    const messages = [
      toolMsg("a", "a".repeat(150_000)),
      assistantMsg(),
      toolMsg("b", "b".repeat(150_000)),
    ];
    const result = await applyToolResultBudget(messages, state, {
      limitChars: 200_000,
      persist,
    });
    expect(result.newlyReplaced).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });

  test("undefined state is a no-op", async () => {
    const persist = fakePersist();
    const messages = [toolMsg("x", "x".repeat(500_000))];
    const result = await applyToolResultBudget(messages, undefined, {
      limitChars: 200_000,
      persist,
    });
    expect(result.messages[0]?.content).toBe(messages[0]?.content);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("resolveToolResultBudgetChars", () => {
  test("window-relative with ceiling and floor", () => {
    expect(resolveToolResultBudgetChars(131_072)).toBe(200_000); // clamped
    expect(resolveToolResultBudgetChars(32_768)).toBe(65_536); // 0.5× window chars
    expect(resolveToolResultBudgetChars(4_096)).toBe(50_000); // floor
    expect(resolveToolResultBudgetChars(undefined)).toBe(200_000);
  });

  test("env override wins", () => {
    process.env.AGENC_TOOL_RESULT_BUDGET_CHARS = "123456";
    expect(resolveToolResultBudgetChars(131_072)).toBe(123_456);
    process.env.AGENC_TOOL_RESULT_BUDGET_CHARS = "0";
    expect(resolveToolResultBudgetChars(131_072)).toBe(0);
  });
});

describe("shrinkToolResultContent / shrinkOversizedToolResults", () => {
  test("head+tail slice with marker, no-op under cap", () => {
    const content = `${"h".repeat(5_000)}${"m".repeat(5_000)}${"t".repeat(5_000)}`;
    const shrunk = shrinkToolResultContent(content, 4_000);
    expect(shrunk.length).toBeLessThan(5_000);
    expect(shrunk.startsWith("hhh")).toBe(true);
    expect(shrunk.endsWith("ttt")).toBe(true);
    expect(shrunk).toContain("[shrunk to fit the context window");
    expect(shrinkToolResultContent("short", 4_000)).toBe("short");
  });

  test("shrinks only oversized tool results, preserving pairing", () => {
    const messages = [
      assistantMsg(),
      toolMsg("big", "b".repeat(50_000)),
      toolMsg("small", "s".repeat(100)),
    ];
    const result = shrinkOversizedToolResults(messages, 10_000);
    expect(result.shrunkCount).toBe(1);
    expect(result.messages).toHaveLength(3);
    expect((result.messages[1]?.content as string).length).toBeLessThan(11_000);
    expect(result.messages[2]?.content).toBe("s".repeat(100));
  });
});

describe("acceptance: 50 × 100KB results fit a 131K window", () => {
  test("budget + shrink keep the assembled request under the context budget", async () => {
    const windowTokens = 131_072;
    const state = freshState();
    const persist = fakePersist();
    const messages = [
      assistantMsg(),
      ...Array.from({ length: 50 }, (_, i) =>
        toolMsg(`acc-${i}`, `result ${i}: ${"data ".repeat(20_000)}`),
      ),
    ];
    const budgeted = await applyToolResultBudget(messages, state, {
      limitChars: resolveToolResultBudgetChars(windowTokens),
      persist,
    });
    const flat: LLMMessage[] = budgeted.messages.map((m) => ({
      role: (m.originalRole ?? m.role) as LLMMessage["role"],
      content: m.content as string,
      ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
    }));
    const estimate = roughTokenCountEstimationForMessages(flat);
    expect(estimate).toBeLessThan(windowTokens - 16_000);
  });
});
