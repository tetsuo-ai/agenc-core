import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMChatOptions, LLMMessage } from "../../src/llm/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import { STEP_LIMIT_WRAPUP_TIMEOUT_MS, StepLimitTrail, stepLimitWrapup } from "../../src/session/step-limit-wrapup.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import type { SessionServices } from "../../src/session/session.js";

afterEach(() => vi.useRealTimers());

function investigatingProvider() {
  const requests: { messages: LLMMessage[]; options?: LLMChatOptions }[] = [];
  const provider = mkProvider();
  provider.chatStream = vi.fn(async (messages, _onChunk, options) => {
    requests.push({ messages: structuredClone(messages), options: structuredClone({ ...options, signal: undefined, trace: undefined }) });
    return options?.tools?.length === 0 && options.toolChoice === "none"
      ? { content: "Found a defect. Integration tests were not checked.", toolCalls: [], model: "test-model",
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4, availability: "reported" as const, provenance: "provider" as const }, finishReason: "stop" as const }
      : { content: "Checking the next file.", toolCalls: [{ id: `read-${requests.length}`, name: "Read", arguments: `{"file":"${requests.length}.ts"}` }],
          model: "test-model", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "tool_calls" as const };
  });
  return { provider, requests };
}

describe("one-shot child step limit", () => {
  it("appends reminders with eight and two steps left, preserving earlier requests", async () => {
    const { provider, requests } = investigatingProvider();
    const { session } = mkSession({ provider });
    const ctx = mkCtx();
    await drain(runTurn(session, { ...ctx, config: { ...ctx.config, maxTurns: 32 } }, "review", { stepLimitWrapup: {} }));
    expect(requests).toHaveLength(33);
    const reminders = (i: number) => requests[i]!.messages.filter((message) => typeof message.content === "string" && message.content.startsWith("Step budget:"));
    expect(reminders(23)).toHaveLength(0);
    expect(reminders(24).map((m) => m.content)).toEqual([expect.stringContaining("8 of 32")]);
    expect(reminders(29)).toHaveLength(1);
    expect(reminders(30).map((m) => m.content)).toEqual([expect.stringContaining("8 of 32"), expect.stringContaining("2 of 32")]);
    for (const i of [24, 30]) {
      const previous = requests[i - 1]!;
      expect(requests[i]!.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
      expect(requests[i]!.options?.systemPrompt).toBe(previous.options?.systemPrompt);
    }
    expect(requests.at(-1)!.options).toMatchObject({ tools: [], toolChoice: "none", singleWireAttempt: true });
    expect(requests.at(-1)!.messages.at(-1)?.content).toContain("Stop investigating");
    expect(requests.at(-1)!.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("reserves synthesis within an explicit cross-provider call allocation", async () => {
    const { provider, requests } = investigatingProvider();
    const { session } = mkSession({ provider });
    const ctx = mkCtx();
    await drain(runTurn(session, { ...ctx, config: { ...ctx.config, maxTurns: 2 } }, "review", { stepLimitWrapup: { maxModelCalls: 2 } }));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.options?.toolChoice).toBe("none");
  });

  it("cost exhaustion takes precedence when the step cap is reached too", async () => {
    const { provider, requests } = investigatingProvider();
    const { session } = mkSession({ provider, services: {
      costSidecar: { getTotalCostUsd: () => requests.length } as SessionServices["costSidecar"],
    } });
    const ctx = mkCtx();
    const phases = [];
    for await (const phase of runTurn(session, { ...ctx, config: { ...ctx.config, maxTurns: 1, maxBudgetUsd: 1 } }, "review", { stepLimitWrapup: {} })) phases.push(phase);
    expect(requests).toHaveLength(1);
    expect(phases.at(-1)).toMatchObject({ stopReason: "max_budget_usd" });
  });

  it("bounds synthesis even if the provider ignores abort", async () => {
    vi.useFakeTimers();
    const chatStream = vi.fn<ReturnType<typeof mkProvider>["chatStream"]>(() => new Promise<never>(() => {}));
    const { session } = mkSession({ provider: { ...mkProvider(), chatStream } });
    const promise = stepLimitWrapup({ session, ctx: mkCtx(), signal: new AbortController().signal,
      request: { input: [], tools: [], baseInstructions: "", parallelToolCalls: false }, fallback: "fallback trail" });
    await vi.advanceTimersByTimeAsync(STEP_LIMIT_WRAPUP_TIMEOUT_MS);
    expect(await promise).toEqual({ text: "fallback trail" });
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(chatStream.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });

  it("caps the fallback and retains the most recent tool arguments", () => {
    const trail = new StepLimitTrail();
    for (let i = 0; i < 100; i++) trail.record({ id: String(i), name: "exec_command", arguments: `${i} ${"x".repeat(10000)}` });
    const text = trail.fallback("finding ".repeat(10000));
    expect(Buffer.byteLength(text)).toBeLessThan(8192);
    expect(Buffer.byteLength(trail.fallback("😀".repeat(10000)))).toBeLessThan(8192);
    expect(text).toContain("exec_command 99");
    expect(text).not.toContain("exec_command 0 ");
  });
});
