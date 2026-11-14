import { afterEach, expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../../src/llm/providers/deepseek/index.js";
import { OpenAICompatibleProvider } from "../../../src/llm/providers/openai-compatible/index.js";
import { ECHO_TOOL, bodyAt, sseResponse } from "../../llm/providers/openai-compatible-test-helpers.js";
import type { LLMMessage } from "../../../src/llm/types.js";
import { syntheticPng } from "../../helpers/redacted-inline-image-fixture.js";
import { readCompactionQueryPrefix, rememberCompactionQueryPrefix, snapshotCompactionQueryPrefix } from "../../../src/services/compact/query-prefix.js";
import { compactConversationTransactionally } from "../../../src/services/compact/transaction.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";
import { llmMessageToDurableResponseItem } from "../../../src/session/message-history-conversion.js";
import { tokenAccountingService } from "../../../src/llm/token-accounting.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";

const model = "deepseek-flash";
const sessionId = "prefix-compaction-fixture";
const source: LLMMessage[] = Array.from({ length: 10 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: `Message ${i}. ${`Implementation detail ${i}. `.repeat(700)}`,
  ...(i % 2 ? { providerReasoningContent: `Reasoning ${i}.`, providerReasoningProvenance: { provider: "deepseek", model } } : {}),
}));
const mainOptions = { model, systemPrompt: "Keep implementing the user's task.", tools: [ECHO_TOOL],
  reasoningEffort: "max" as const, maxOutputTokens: 8_192, contextWindowTokens: 1_048_576 };

afterEach(() => tokenAccountingService.clear());

test.each(["plain", "tool_pair", "compatible", "shown_image", "unseen_image", "stale_history", "foreign_provider", "over_window", "app_tools"])(
  "compaction reuses only its successful main prefix: %s", async mode => {
  const sent = structuredClone(source);
  if (mode === "tool_pair") {
    sent.at(-1)!.toolCalls = [{ id: "earlier-echo", name: "system.echo", arguments: '{"text":"hello"}' }];
    sent.push({ role: "tool", toolCallId: "earlier-echo", toolName: "system.echo", content: "hello",
      runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({ runId: sessionId, toolCallId: "earlier-echo", content: "hello" }) } });
  }
  const shownImage = syntheticPng(false);
  if (mode === "shown_image") sent[0]!.content = [{ type: "text", text: String(sent[0]!.content) },
    { type: "image_url", image_url: { url: shownImage } }];
  const complete = structuredClone(sent);
  const unseenImage = syntheticPng(true);
  if (mode === "unseen_image") complete.push({ role: "user", content: [
    { type: "text", text: "New screen, not yet sent" }, { type: "image_url", image_url: { url: unseenImage } },
  ] });
  if (mode === "stale_history") complete[0]!.content = "Replaced source. " + complete[0]!.content;
  const durableBefore = structuredClone(complete);
  const reuse = !["stale_history", "foreign_provider", "over_window", "app_tools"].includes(mode);
  const sentOptions = mode === "over_window"
    // The earlier request fit a larger window than the current summary call.
    ? { ...mainOptions, contextWindowTokens: 4_194_304, systemPrompt: "Earlier lengthy policy. ".repeat(100_000) }
    : { ...mainOptions, ...(mode === "app_tools" ? { deepSeekAppTools: true } : {}) };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => sseResponse([
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { role: "assistant",
      content: JSON.stringify({ narrative: "Task state.", facts: [], open_actions: [] }) }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 60_000, completion_tokens: 30, total_tokens: 60_030 } })}\n\n`,
    "data: [DONE]\n\n",
  ]));
  const provider = mode === "compatible" ? new OpenAICompatibleProvider({ model, fetchImpl })
    : new DeepSeekProvider({ apiKey: "offline-fixture", model, fetchImpl });
  await provider.chatStream(sent, () => {}, sentOptions);
  const main = bodyAt(fetchImpl);
  if (mode === "app_tools") expect(main.tools).toContainEqual({ type: "deepseek_web_search" });
  const harness = createCompactionTransactionHarness([], { sessionId, contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 });
  try {
    for (const message of complete) harness.store.appendRollout({ type: "response_item", payload: llmMessageToDurableResponseItem(message) }, { durable: true });
    rememberCompactionQueryPrefix(harness.session, snapshotCompactionQueryPrefix({
      provider: mode === "foreign_provider" ? "grok" : provider.name, model,
      messages: sent, source: sent, options: sentOptions,
    }));
    const context = { ...harness.context, provider, options: { ...mainOptions, mainLoopModel: model } };
    await compactConversationTransactionally(context, {
      automatic: false, customInstructions: "", completeSourceMessages: complete,
      messagesToSummarize: complete, messagesToKeep: [], summaryPlacement: "before_keep",
      createBoundaryMarker: () => ({ role: "user", originalRole: "developer", content: "Compaction boundary" }),
      createSummaryMessage: content => ({ role: "user", content }),
    });
    expect(complete).toEqual(durableBefore);
    const compact = bodyAt(fetchImpl, 1);
    if (!reuse) {
      expect(compact.tools).toBeUndefined();
      expect(compact.messages).toHaveLength(2);
      return;
    }
    expect(compact.tools).toEqual(main.tools);
    const previous = main.messages as unknown[];
    expect((compact.messages as unknown[]).slice(0, previous.length)).toEqual(previous);
    expect(JSON.stringify((compact.messages as unknown[]).slice(previous.length))).toContain("allowed_source_ref_ids");
    expect(JSON.stringify((compact.messages as unknown[]).slice(previous.length))).not.toContain("Implementation detail 0. ".repeat(20));
    if (mode === "compatible") expect(compact.tool_choice).toBe("none");
    else expect(compact.thinking).toEqual({ type: "disabled" });
    if (mode === "shown_image") expect(JSON.stringify(compact.messages)).toContain(shownImage);
    if (mode === "unseen_image") expect(JSON.stringify(compact.messages)).not.toContain(unseenImage);
    expect(readCompactionQueryPrefix(harness.session)).toBeUndefined();
    expect(harness.store.readAll().filter(row => row.type === "compaction_committed")).toHaveLength(1);
  } finally { harness.close(); }
});

test("a compactor tool call is rejected without replacing history", async () => {
  const clean = source.map(({ providerReasoningContent, providerReasoningProvenance, ...message }) => message);
  const harness = createCompactionTransactionHarness(clean, { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 });
  try {
    const provider = { ...harness.provider, name: "deepseek", chatStream: vi.fn(async () => ({
      content: JSON.stringify({ narrative: "Task state.", facts: [], open_actions: [] }),
      toolCalls: [{ id: "not-executed", name: "system.echo", arguments: '{"text":"hello"}' }],
      usage: { promptTokens: 60_000, completionTokens: 30, totalTokens: 60_030 }, model, finishReason: "stop" as const,
    })) };
    await expect(compactConversationTransactionally({ ...harness.context, provider,
      options: { ...mainOptions, mainLoopModel: model },
      queryPrefix: { provider: "deepseek", model, messages: clean, source: clean, options: mainOptions },
    }, {
      automatic: false, customInstructions: "", completeSourceMessages: clean, messagesToSummarize: clean,
      messagesToKeep: [], summaryPlacement: "before_keep",
      createBoundaryMarker: () => ({ role: "user", originalRole: "developer", content: "Compaction boundary" }),
      createSummaryMessage: content => ({ role: "user", content }),
    })).rejects.toThrow(/tool calls; none were executed/);
    expect(harness.store.readAll().some(row => row.type === "compaction_committed")).toBe(false);
    expect(provider.chatStream).toHaveBeenCalledOnce();
  } finally { harness.close(); }
});
