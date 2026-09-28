import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMChatOptions, LLMMessage } from "../../src/llm/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import { STEP_LIMIT_WRAPUP_TIMEOUT_MS, StepLimitTrail, stepLimitWrapup } from "../../src/session/step-limit-wrapup.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import type { SessionServices } from "../../src/session/session.js";
import { WorkflowHandoffSpool } from "../../src/agents/workflow-handoff-spool.js";
import { CONTEXT_IMAGE_BUDGET_ENV } from "../../src/session/query-image-budget.js";
import { imageRoute, recordRejectedImages, requestImageUrls } from "../../src/session/query-image-safety.js";
import type { ToolRegistry } from "../../src/tool-registry.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function investigatingProvider(toolName = "Read") {
  const requests: { messages: LLMMessage[]; options?: LLMChatOptions }[] = [];
  const provider = mkProvider();
  provider.chatStream = vi.fn(async (messages, _onChunk, options) => {
    requests.push({ messages: structuredClone(messages), options: structuredClone({ ...options, signal: undefined, trace: undefined }) });
    return options?.toolChoice === "none"
      ? { content: "Found a defect. Integration tests were not checked.", toolCalls: [], model: "test-model",
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4, availability: "reported" as const, provenance: "provider" as const }, finishReason: "stop" as const }
      : { content: "Checking the next file.", toolCalls: [{ id: `read-${requests.length}`, name: toolName, arguments: `{"file":"${requests.length}.ts"}` }],
          model: "test-model", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "tool_calls" as const };
  });
  return { provider, requests };
}

describe("one-shot child step limit", () => {
  it("retains expanded file attachments in the synthesis request", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agenc-step-limit-attachment-"));
    try {
      writeFileSync(join(cwd, "evidence.ts"), "export const evidence = 42;\n");
      const { provider, requests } = investigatingProvider();
      const { session, state } = mkSession({ provider, cwd });
      const ctx = mkCtx({ cwd, config: { ...mkCtx().config, maxTurns: 1 } });
      await drain(runTurn(session, ctx, "review @evidence.ts", { stepLimitWrapup: {} }));
      expect(requests).toHaveLength(2);
      const attachments = requests[0]!.messages.filter((message) =>
        message.runtimeOnly?.mergeBoundary === "user_context");
      expect(JSON.stringify(attachments)).toContain("export const evidence = 42;");
      expect(requests[1]!.messages.filter((message) =>
        message.runtimeOnly?.mergeBoundary === "user_context")).toEqual(attachments);
      expect(JSON.stringify(state.history)).not.toContain("export const evidence = 42;");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("bounds the final investigation tool result before synthesis", async () => {
    vi.stubEnv("AGENC_TOOL_RESULT_BUDGET_CHARS", "1000");
    const content = "tool evidence ".repeat(1500);
    const execute = vi.fn(async () => ({ content, isError: false }));
    const registry = {
      tools: [{ name: "read_probe", description: "Read evidence", inputSchema: { type: "object" },
        requiresApproval: false, recoveryCategory: "read-only", execute }],
      toLLMTools: () => [], dispatch: execute,
    } as unknown as ToolRegistry;
    const { provider, requests } = investigatingProvider("read_probe");
    const { session } = mkSession({ provider, registry });
    const ctx = mkCtx({ config: { ...mkCtx().config, maxTurns: 1 } });
    await drain(runTurn(session, ctx, "review", { stepLimitWrapup: {} }));
    expect(requests).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const result = requests[1]!.messages.find((message) => message.toolCallId === "read-1");
    expect(result).toBeDefined();
    expect(JSON.stringify(result!.content).length).toBeLessThan(content.length);
  });

  it.each([
    { content: "Finding.<oai-mem-citation>hidden citation</oai-mem-citation>", visible: "Finding." },
    { content: "Finding.<oai-mem-citation>hidden citation", visible: "Finding." },
    { content: "<oai-mem-citation>hidden citation</oai-mem-citation>", visible: "fallback trail" },
    { content: "Finding.\n<proposed_plan>\nhidden plan\n</proposed_plan>", visible: "Finding.", permissionMode: "plan" as const },
    { content: "<proposed_plan>\nhidden plan", visible: "fallback trail", permissionMode: "plan" as const },
  ])("strips hidden synthesis blocks: $content", async ({ content, visible, permissionMode }) => {
    const { session } = mkSession({ provider: mkProvider({ content }) });
    const result = await stepLimitWrapup({ session, ctx: mkCtx({ permissionMode }),
      signal: new AbortController().signal,
      request: { input: [], tools: [], baseInstructions: "", parallelToolCalls: false },
      fallback: "fallback trail" });
    expect(result.text).toBe(visible === "fallback trail"
      ? visible : `Partial result: stopped at the step limit.\n\n${visible}`);
  });

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
    expect(requests.at(-1)!.options).toMatchObject({ tools: requests[0]!.options?.tools, toolChoice: "none", singleWireAttempt: true });
    expect(requests.at(-1)!.messages.at(-1)?.content).toContain("Stop investigating");
    expect(requests.at(-1)!.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it.each([false, true])("publishes the capped workflow result through its spool (fallback: %s)", async (fallback) => {
    const { provider, requests } = investigatingProvider();
    const chatStream = provider.chatStream;
    provider.chatStream = async (...args) => {
      const response = await chatStream(...args);
      return fallback && args[2]?.toolChoice === "none"
        ? { ...response, content: "" } : response;
    };
    const spool = WorkflowHandoffSpool.create({ maximumBytes: 8192, maximumTokens: 8192 });
    try {
      const { session } = mkSession({ provider });
      const ctx = mkCtx();
      const phases = [];
      for await (const phase of runTurn(session, { ...ctx, config: { ...ctx.config, maxTurns: 1 } }, "review", {
        stepLimitWrapup: {}, assistantOutputSink: spool,
      })) phases.push(phase);
      const chunks: Buffer[] = [];
      for await (const chunk of spool.seal().chunks()) chunks.push(Buffer.from(chunk));
      const artifact = Buffer.concat(chunks).toString("utf8");
      expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: artifact, stopReason: "max_turns" });
      expect(artifact).toContain(fallback ? "Final-answer synthesis was unavailable" : "Found a defect");
      expect(requests).toHaveLength(2);
    } finally {
      await spool.dispose();
    }
  });

  it.each(["reset", "writeCanonicalDelta"] as const)("propagates workflow sink %s failures during wrap-up", async (method) => {
    const { provider, requests } = investigatingProvider();
    const { session } = mkSession({ provider });
    const ctx = mkCtx();
    const error = new Error("workflow sink failed");
    const sink = { reset() {}, writeCanonicalDelta(_delta: string) {} };
    sink[method] = () => {
      if (requests.length === 2) throw error;
    };
    await expect(drain(runTurn(session, { ...ctx, config: { ...ctx.config, maxTurns: 1 } }, "review", {
      stepLimitWrapup: {}, assistantOutputSink: sink,
    }))).rejects.toBe(error);
    expect(requests).toHaveLength(2);
  });

  it.each(["rejected", "undecodable", "over budget"])("keeps previously %s images out of synthesis", async (reason) => {
    const url = reason === "undecodable"
      ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
      : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
    if (reason === "over budget") vi.stubEnv(CONTEXT_IMAGE_BUDGET_ENV, "1");
    const history: LLMMessage[] = [
      { role: "user", content: "inspect image" },
      { role: "assistant", content: "", toolCalls: [{ id: "image", name: "Read", arguments: "{}" }] },
      { role: "tool", toolCallId: "image", toolName: "Read", content: [
        { type: "text", text: "image evidence" },
        { type: "image_url", image_url: { url } },
      ] },
    ];
    const { provider, requests } = investigatingProvider();
    const { session, state } = mkSession({ provider, history });
    const ctx = mkCtx();
    if (reason === "rejected") {
      recordRejectedImages(session, imageRoute(provider.name, session.config.model ?? ctx.modelInfo.slug), [url], {
        provider: provider.name, reason: "unsupported image",
      });
    }
    await drain(runTurn(session, { ...ctx, config: { ...ctx.config, maxTurns: 1 } }, "review", { stepLimitWrapup: {} }));
    expect(requests).toHaveLength(2);
    expect(requestImageUrls(requests[0]!.messages)).toEqual([]);
    expect(requestImageUrls(requests[1]!.messages)).toEqual([]);
    expect(requests[1]!.messages.find((message) => message.toolCallId === "image")).toEqual(
      requests[0]!.messages.find((message) => message.toolCallId === "image"),
    );
    expect(requestImageUrls(state.history)).toEqual([url]);
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
