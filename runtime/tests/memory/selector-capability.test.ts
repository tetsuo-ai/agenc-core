import { describe, expect, it, vi } from "vitest";
import { createAdmittedMemorySelector } from "../../src/memory/admitted-selector.js";
import { assertProviderStructuredOutputCompatibility } from "../../src/llm/provider-capabilities.js";
import { QwenTokenPlanProvider } from "../../src/llm/providers/qwen/index.js";
import type { Session } from "../../src/session/session.js";
import type { MemorySelectorRequest } from "../../src/memory/recall-contract.js";

const request: MemorySelectorRequest = {
  policy: "agenc.memory-selector.v1", query: { text: "browser", mode: "query" },
  recentTools: [], candidates: [],
};

describe("memory selector capability selection", () => {
  it.each(["qwen4-max-preview", "qwen4.0-max-preview"])("refuses %s before admission or fetch", async model => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new QwenTokenPlanProvider({ model, apiKey: "fixture", fetchImpl });
    const validateRequest = vi.spyOn(provider, "validateRequest");
    const chat = vi.spyOn(provider, "chat");
    const emit = vi.fn(), acquire = vi.fn();
    const session = { conversationId: "session", modelInfo: { slug: model },
      services: { provider, executionAdmission: { acquire } },
      emit, nextInternalSubId: () => "selector",
    } as unknown as Session;
    for (let round = 0; round < 2; round++) {
      await expect(createAdmittedMemorySelector(session).select(request, new AbortController().signal))
        .resolves.toEqual({ kind: "unavailable", diagnostic: "local_provider_capability_rejection" });
    }
    expect(validateRequest).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledOnce();
  });

  it("remembers DeepSeek incompatibility for the session before creating admitted work", async () => {
    const emit = vi.fn(), acquire = vi.fn(), chat = vi.fn();
    const validateRequest = vi.fn(() => assertProviderStructuredOutputCompatibility({
      providerName: "deepseek", model: "deepseek-flash", api: "chat_completions",
      structuredOutput: { enabled: true, schema: {
        type: "json_schema", name: "test", schema: { type: "object" },
      } },
    }));
    const session = { conversationId: "session", modelInfo: { slug: "deepseek-flash" },
      services: { provider: { name: "deepseek", chat, validateRequest },
        executionAdmission: { acquire } },
      emit, nextInternalSubId: () => "selector",
    } as unknown as Session;
    for (let round = 0; round < 3; round++) {
      // The attachment producer can recreate the selector each round.
      await expect(createAdmittedMemorySelector(session).select(request, new AbortController().signal))
        .resolves.toMatchObject({ kind: "unavailable", diagnostic: "local_provider_capability_rejection" });
    }
    expect(chat).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(validateRequest).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(JSON.stringify(emit.mock.calls)).not.toContain("browser");

    Object.assign(session.modelInfo, { slug: "another-model" });
    await createAdmittedMemorySelector(session).select(request, new AbortController().signal);
    expect(validateRequest).toHaveBeenCalledTimes(2);
    const otherSession = { ...session } as Session;
    await createAdmittedMemorySelector(otherSession).select(request, new AbortController().signal);
    expect(validateRequest).toHaveBeenCalledTimes(3);
    Object.assign(session.services, { provider: { ...session.services.provider } });
    await createAdmittedMemorySelector(session).select(request, new AbortController().signal);
    expect(validateRequest).toHaveBeenCalledTimes(4);
  });

  it("does not cache a transient validation failure", async () => {
    const validateRequest = vi.fn(() => { throw new Error("temporarily unavailable"); });
    const session = { modelInfo: { slug: "test" }, services: {
      provider: { name: "test", validateRequest },
    } } as unknown as Session;
    for (let round = 0; round < 2; round++) {
      await expect(createAdmittedMemorySelector(session).select(request, new AbortController().signal))
        .resolves.toEqual({ kind: "unavailable" });
    }
    expect(validateRequest).toHaveBeenCalledTimes(2);
  });
});
