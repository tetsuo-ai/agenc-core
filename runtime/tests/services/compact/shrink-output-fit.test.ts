import { expect, it, vi } from "vitest";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { createRuntimeEmergencySummarizer } from "../../../src/services/compact/emergency-summarizer.js";
import type { TokenAccountingRequest } from "../../../src/llm/token-accounting.js";

it.each([41_450, 45_000])("validates a replacement with %i input tokens against the output ceiling admission can fit", async inputTokens => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user", content: "HISTORICAL_SOURCE "+index+" "+"x".repeat(10_000),
  }));
  const h = createCompactionTransactionHarness(messages, { contextWindowTokens: 45_600, maxOutputTokens: 8_192 });
  try {
    Object.assign(h.provider, { tokenCountCapability: {
      capabilityVersion: "shrink-output-fit", adapterRevision: "1", configurationRevision: String(inputTokens),
      countTokens: vi.fn(async (request: TokenAccountingRequest) => ({
        inputTokens: request.messages.some(m => m.runtimeOnly?.compactionHistory)
          ? inputTokens : request.messages.some(m => typeof m.content === "string" && m.content.startsWith("HISTORICAL_SOURCE")) ? 80_000 : 128,
        complete: true, confidence: "exact", countedComponents: ["system", "messages", "tools", "provider_framing"],
      })),
    }, getExecutionProfile: async () => ({ provider: "grok", model: "grok-4.5", contextWindowTokens: 45_600,
      contextSafetyBufferTokens: 1_024, usageReporting: "authoritative", supportsMaxOutputTokens: true }) });
    const result = compactConversation(messages, h.context, "", {
      keepCount: 0, summarizer: createRuntimeEmergencySummarizer(2_048),
    });
    if (inputTokens === 41_450) await expect(result).resolves.toMatchObject({ postCompactTokenCount: inputTokens });
    else await expect(result).rejects.toThrow(/context window/);
  } finally { h.close(); }
});
