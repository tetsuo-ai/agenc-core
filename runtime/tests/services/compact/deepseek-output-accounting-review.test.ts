import { describe, expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../../src/llm/providers/deepseek/index.js";
import type { LLMProvider } from "../../../src/llm/types.js";
import { createTokenAccountingRequest, tokenAccountingService } from "../../../src/llm/token-accounting.js";
import { parseChatCompletionsResponse } from "../../../src/llm/wire/chat-completions.js";
import { compactConversationTransactionally } from "../../../src/services/compact/transaction.js";
import { conservativeOutputTokenEstimate } from "../../../src/services/compact/transaction-limits.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

const model = "deepseek-flash";
const body = JSON.stringify({
  narrative: "Synthetic bounded summary. ".repeat(900),
  facts: [], open_actions: [], tool_pairs: [],
});
const response = (usage?: Record<string, number>) => ({
  model,
  choices: [{ index: 0, message: { role: "assistant", content: body }, finish_reason: "stop" }],
  ...(usage ? { usage } : {}),
});

describe("independent DeepSeek compaction accounting review", () => {
  test("stock DeepSeek output counting uses conservative fallback without network", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider: LLMProvider = new DeepSeekProvider({ apiKey: "offline-fixture", model, fetchImpl });
    expect(provider.tokenCountCapability).toBeUndefined();
    const result = await tokenAccountingService.count(createTokenAccountingRequest({
      provider: "deepseek", model, messages: [{ role: "assistant", content: body }],
      options: { model, systemPrompt: "", maxOutputTokens: 0, contextWindowTokens: 262_144 },
      contextWindowTokens: 262_144, reservedOutputTokens: 0,
    }), { capability: provider.tokenCountCapability });
    expect(result.source).toBe("conservative_fallback");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("the actual wire parser marks absent usage as synthetic unknown zero", () => {
    const parsed = parseChatCompletionsResponse(model, response(), { model, messages: [], tools: [] });
    expect(parsed.usage).toMatchObject({ completionTokens: 0, availability: "unknown", provenance: "synthetic" });
    expect(conservativeOutputTokenEstimate(parsed.content)).toBeGreaterThan(8_192);
  });

  test.each(["prompt-only", "total-only"] as const)("%s usage also manufactures a completion zero despite reported availability", mode => {
    const usage = mode === "prompt-only" ? { prompt_tokens: 100 } : { total_tokens: 100 };
    const parsed = parseChatCompletionsResponse(model, response(usage), { model, messages: [], tools: [] });
    expect(parsed.usage).toMatchObject({ completionTokens: 0, availability: "reported", provenance: "provider" });
  });

  test.each(["missing", "prompt-only", "total-only", "reported-overrun", "reported-within-limit"] as const)("%s usage observes the correct compaction output bound", async (mode) => {
    const source = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `Synthetic source ${index}: ${"source ".repeat(5_000)}`,
    }));
    const harness = createCompactionTransactionHarness(source, { maxOutputTokens: 8_192, contextWindowTokens: 524_288 });
    const usage = mode === "reported-overrun" ? { prompt_tokens: 100, completion_tokens: 8_193, total_tokens: 8_293 }
      : mode === "reported-within-limit" ? { prompt_tokens: 100, completion_tokens: 8_192, total_tokens: 8_292 }
      : mode === "prompt-only" ? { prompt_tokens: 100 }
      : mode === "total-only" ? { total_tokens: 100 }
      : undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(wire.max_tokens).toBe(8_192);
      return new Response(JSON.stringify(response(usage)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const provider = new DeepSeekProvider({ apiKey: "offline-fixture", model, fetchImpl });
    try {
      const observed = await compactConversationTransactionally({
        ...harness.context, provider,
        options: { ...harness.context.options, mainLoopModel: model },
      }, {
        automatic: false, customInstructions: "retain synthetic facts",
        completeSourceMessages: source, messagesToSummarize: source, messagesToKeep: [],
        summaryPlacement: "before_keep",
        createBoundaryMarker: () => ({ role: "user", originalRole: "developer", content: "authenticated compaction boundary" }),
        createSummaryMessage: content => ({ role: "user", content }),
      }).then(() => ({ kind: "committed" }), error => ({ kind: "rejected", reason: error.reason ?? error.code }));
      // Missing usage currently reaches the later no_shrink guard. This
      // regression asks for the missing earlier output check, not proof of
      // a committed oversized summary or an observed live provider failure.
      expect(observed).toMatchObject({
        kind: "rejected",
        reason: mode === "reported-within-limit" ? "no_shrink" : "output_limit_exceeded",
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(harness.store.readAll().some(record => record.type === "compaction_committed")).toBe(false);
    } finally {
      harness.close();
    }
  });
});
