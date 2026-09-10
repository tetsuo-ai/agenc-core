import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage, LLMTool } from "../../src/llm/types.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { getActiveContextTokenUsage, getPreSamplingAutoCompactTokenLimit, runPreSamplingCompact } from "../../src/session/run-turn-compaction.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { autoCompactIfNeeded } from "../../src/services/compact/autoCompact.js";
import * as compactService from "../../src/services/compact/compact.js";
import { toAgenCRuntimeMessages } from "../../src/session/runtime-message-conversion.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => { setAutoCompactImplForTests(null); vi.restoreAllMocks(); });

function setup(providerName = "ollama") {
  const provider = mkProvider({ content: "Done", model: "qwen2.5-coder:7b" });
  Object.assign(provider, { name: providerName });
  const tools: LLMTool[] = [{ type: "function", function: {
    name: "FileRead", description: "Detailed file tool documentation. ".repeat(700), parameters: { type: "object" },
  } }];
  const { session, events } = mkSession({ provider });
  vi.spyOn(session.services.registry, "toLLMTools").mockReturnValue(tools);
  const base = mkCtx();
  const ctx = mkCtx({ modelProviderId: providerName, modelInfo: {
    ...base.modelInfo, slug: "qwen2.5-coder:7b", contextWindow: 32_768, maxOutputTokens: 16_384,
  } });
  const user: LLMMessage = { role: "user", content: "Read the verification marker." };
  const state = buildInitialTurnState(ctx, user, { modelInstructions: "Follow the user request." });
  return { provider, tools, session, events, ctx, state, user };
}

describe("local proactive context pressure", () => {
  test.each(["ollama", "lmstudio", "openai-compatible"])("%s does not summarize the first short user message due to nominal output reservation", async providerName => {
    const h = setup(providerName);
    const summary = vi.spyOn(h.provider, "chat");
    const sample = vi.spyOn(h.provider, "chatStream");
    const compact = vi.fn(async () => ({ wasCompacted: false }));
    setAutoCompactImplForTests(compact);
    const threshold = getPreSamplingAutoCompactTokenLimit(h.ctx)!;
    const input = getActiveContextTokenUsage(h.session, h.ctx, h.state);
    const total = getActiveContextTokenUsage(h.session, h.ctx, h.state, { includeOutput: true });
    expect(threshold).toBe(19_768);
    expect(input).toBeLessThan(threshold);
    expect(total).toBe(input + 16_384);
    expect(total).toBeGreaterThan(threshold);
    expect(await runPreSamplingCompact(h.session, h.ctx, "repl_main_thread", h.state)).toBe(false);
    await drain(runTurn(h.session, h.ctx, String(h.user.content)));
    expect(compact).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
    expect(sample).toHaveBeenCalledOnce();
    expect(h.events.map(event => classifyTurnTerminal(event.msg))).toContainEqual(expect.objectContaining({ outcome: "completed" }));
  });

  test("cloud proactive accounting still includes its original output reservation", async () => {
    const h = setup("grok");
    const compact = vi.fn(async () => ({ wasCompacted: false }));
    setAutoCompactImplForTests(compact);
    expect(getActiveContextTokenUsage(h.session, h.ctx, h.state)).toBe(
      getActiveContextTokenUsage(h.session, h.ctx, h.state, { includeOutput: true }),
    );
    await runPreSamplingCompact(h.session, h.ctx, "repl_main_thread", h.state);
    expect(compact).toHaveBeenCalledOnce();
  });

  test("real local input pressure still reaches the compaction dispatcher", async () => {
    const h = setup();
    const historical = "Keep this detailed historical implementation context. ".repeat(1_500);
    h.state.messages.unshift({ role: "assistant", content: historical });
    const compact = vi.fn(async () => ({ wasCompacted: false }));
    setAutoCompactImplForTests(compact);
    expect(getActiveContextTokenUsage(h.session, h.ctx, h.state)).toBeGreaterThan(getPreSamplingAutoCompactTokenLimit(h.ctx)!);
    await runPreSamplingCompact(h.session, h.ctx, "repl_main_thread", h.state);
    expect(compact).toHaveBeenCalledOnce();
    expect(JSON.stringify(compact.mock.calls[0]?.[0])).toContain(historical);
  });

  test("hard admission rejects an oversized actual request even if proactive estimation is small", async () => {
    const h = setup();
    const sample = vi.spyOn(h.provider, "chatStream");
    Object.assign(h.provider, { tokenCountCapability: {
      capabilityVersion: "local-proactive-boundary", adapterRevision: "1", configurationRevision: "overflow",
      countTokens: async () => ({ inputTokens: 32_769, complete: true, confidence: "exact", countedComponents: ["system", "messages", "tools", "provider_framing"] }),
    } });
    const compact = vi.fn(async () => ({ wasCompacted: false }));
    setAutoCompactImplForTests(compact);
    await drain(runTurn(h.session, h.ctx, String(h.user.content)));
    expect(sample).not.toHaveBeenCalled();
    expect(h.events.map(event => classifyTurnTerminal(event.msg))).toContainEqual(expect.objectContaining({ outcome: "errored" }));
  });

  test.each(["ollama", "grok"])("service trigger uses input only for proactive local calls, retaining forced and downshift behavior (%s)", async providerName => {
    const h = setup(providerName);
    const compact = vi.spyOn(compactService, "compactConversation").mockResolvedValue({} as never);
    const messages = toAgenCRuntimeMessages([h.user]);
    const context = { provider: h.provider, options: { mainLoopModel: h.ctx.modelInfo.slug, contextWindowTokens: 32_768, maxOutputTokens: 16_384, tools: h.tools } };
    await autoCompactIfNeeded(messages, context);
    expect(compact).toHaveBeenCalledTimes(providerName === "ollama" ? 0 : 1);
    compact.mockClear();
    await autoCompactIfNeeded(messages, context, undefined, "repl_main_thread", undefined, 0, { force: true });
    expect(compact).toHaveBeenCalledOnce();
    compact.mockClear();
    await autoCompactIfNeeded(messages, context, undefined, "model_downshift");
    expect(compact).toHaveBeenCalledOnce();
    compact.mockClear();
    await autoCompactIfNeeded(toAgenCRuntimeMessages([{ role: "user", content: "Historical data. ".repeat(5_000) }]), context);
    expect(compact).toHaveBeenCalledOnce();
  });
});
