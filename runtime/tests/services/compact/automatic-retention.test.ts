import { describe, expect, test } from "vitest";
import { automaticCompactionLiveUserIndex, automaticCompactionSplit, compactConversation } from "../../../src/services/compact/compact.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";

describe("automatic continuation retention", () => {
  const history: RuntimeMessage[] = [
    { role: "user", content: "old facts".repeat(8_000) },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "fix parser" },
    { role: "assistant", content: "", toolCalls: [
      { id: "read-a", name: "exec_command", arguments: '{}' },
      { id: "read-b", name: "exec_command", arguments: '{}' },
    ] },
    { role: "tool", toolCallId: "read-a", content: "README facts" },
    { role: "tool", toolCallId: "read-b", content: "parser contents" },
  ];
  test("widens the tail to include the parent of all newest results", () => {
    expect(automaticCompactionSplit(history, 32_768)).toBe(1);
    expect(automaticCompactionSplit(history, 32_768, true)).toBe(3);
    expect(history.slice(automaticCompactionSplit(history, 32_768, true)))
      .toEqual(history.slice(3));
  });
  test("does not drop an oversized newest result", () => {
    const huge = [...history.slice(0, -1), { ...history.at(-1)!, content: "x".repeat(200_000) }];
    expect(automaticCompactionSplit(huge, 32_768)).toBe(3);
  });
  test("keeps the completed tool exchange when output-recovery prompts follow it", () => {
    const recovering = [...history.map((message, index) => index === 2
      ? { ...message, runtimeOnly: { responseItemId: "live-request" } }
      : message),
      { role: "user" as const, content: "retry the truncated arguments" }];
    expect(automaticCompactionSplit(recovering, 32_768, true, "live-request")).toBe(3);
  });
  test("can summarize a completed earlier turn when a new request follows its tools", () => {
    const nextTurn = [...history,
      { role: "user" as const, content: "new incident review", runtimeOnly: { responseItemId: "next-request" } }];
    expect(automaticCompactionSplit(nextTurn, 32_768, true, "next-request")).toBe(6);
  });
  test("a degraded state check retains the preceding result needed for the next edit", () => {
    const checked: RuntimeMessage[] = [...history,
      { role: "assistant", content: "check ledger before append", toolCalls: [{ id: "ledger", name: "FileRead", arguments: '{}' }] },
      { role: "tool", toolCallId: "ledger", content: "batches 01-02 appended" }];
    expect(automaticCompactionSplit(checked, 32_768, true)).toBe(3);
    expect(checked.slice(automaticCompactionSplit(checked, 32_768, true)))
      .toContainEqual(history.at(-1));
  });
  test("emergency retention budgets older reasoning but preserves the newest complete exchange", () => {
    const large: RuntimeMessage[] = [...history.map((message, index) => index === 3
      ? { ...message, providerReasoningContent: "used reasoning".repeat(5_000) }
      : message),
      { role: "assistant", content: "check current state", toolCalls: [{ id: "latest", name: "FileRead", arguments: '{}' }] },
      { role: "tool", toolCallId: "latest", content: "current result" }];
    expect(automaticCompactionSplit(large, 32_768, true)).toBe(3);
    expect(automaticCompactionSplit(large, 32_768, true, undefined, 1)).toBe(6);
    expect(large.slice(automaticCompactionSplit(large, 32_768, true, undefined, 1)))
      .toEqual(large.slice(6));
    const small = large.map((message) => ({ ...message, providerReasoningContent: "" }));
    expect(automaticCompactionSplit(small, 32_768, true, undefined, 1)).toBe(3);
  });
  test("emergency retention makes room when the remaining history is mostly recent exchanges", () => {
    const thin: RuntimeMessage[] = [
      { role: "user", content: "continue the current build" },
      { role: "assistant", content: "older step", providerReasoningContent: "r".repeat(6_000),
        toolCalls: [{ id: "older", name: "FileRead", arguments: '{}' }] },
      { role: "tool", toolCallId: "older", content: "used output".repeat(500) },
      { role: "assistant", content: "latest step", providerReasoningContent: "r".repeat(3_000),
        toolCalls: [{ id: "newest", name: "exec_command", arguments: '{}' }] },
      { role: "tool", toolCallId: "newest", content: "current result".repeat(80) },
    ];
    expect(automaticCompactionSplit(thin, 65_536, true, undefined, 1)).toBe(3);
    expect(thin.slice(automaticCompactionSplit(thin, 65_536, true, undefined, 1)))
      .toEqual(thin.slice(3));
  });
  test("protects the actual caller request rather than an internal recovery prompt", () => {
    const recovering = history.map((message, index) => index === 2
      ? { ...message, runtimeOnly: { responseItemId: "live-request" } }
      : message);
    recovering.push({ role: "user", content: "retry the truncated arguments" });
    expect(automaticCompactionLiveUserIndex(recovering, "live-request")).toBe(2);
    expect(() => automaticCompactionLiveUserIndex(recovering, "missing-request"))
      .toThrow(/live user request is missing.*history was not changed/);
  });
  test("counts prior provider reasoning against the optional tail budget", () => {
    const reasoning = history.map((message, index) => index === 1
      ? { ...message, providerReasoningContent: "x".repeat(100_000) }
      : message);
    expect(automaticCompactionSplit(reasoning, 32_768)).toBe(2);
  });
  test("declines when only the current exchange remains", async () => {
    const current = history.slice(2);
    await expect(compactConversation(current, { compactionTransaction: {} as never }))
      .rejects.toThrow(/cannot free room.*latest tool results/);
    expect(current).toEqual(history.slice(2));
  });
  test("keeps recent parser edits beside a large current-step read", () => {
    const recent: RuntimeMessage[] = [
      { role: "user", content: "old".repeat(20_000) },
      { role: "assistant", content: "parser fixed", toolCalls: [{ id: "edit", name: "Write", arguments: JSON.stringify({ content: "correct parser".repeat(80) }) }] },
      { role: "tool", toolCallId: "edit", content: "write succeeded" },
      { role: "assistant", content: "batch01 parsed", toolCalls: [{ id: "batch", name: "exec_command", arguments: '{}' }] },
      { role: "tool", toolCallId: "batch", content: "batch01 total150 latency72625".repeat(140) },
      { role: "assistant", content: "inspect remaining data", toolCalls: [{ id: "chunk", name: "FileRead", arguments: '{}' }] },
      { role: "tool", toolCallId: "chunk", content: "x".repeat(13_000) },
    ];
    expect(automaticCompactionSplit(recent, 31_129)).toBe(1);
  });
});
