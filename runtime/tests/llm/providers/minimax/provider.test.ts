import { describe, expect, test, vi } from "vitest";

import { resolveProviderCapabilityEntry } from "../../capabilities.js";
import {
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "../../registry/model-catalog.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../registry/provider-info.js";
import type { LLMMessage } from "../../types.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../wire/capability-gating.js";
import {
  bodyAt,
  createSuccessfulChatResponse,
  ECHO_TOOL,
} from "../openai-compatible-test-helpers.js";
import { MiniMaxProvider } from "./index.js";

const successfulChat = createSuccessfulChatResponse("chatcmpl_minimax");

function createSuccessfulMinimaxProvider(model = "MiniMax-M3") {
  // A fresh Response per call: one test drives two turns through one provider.
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
    successfulChat(model),
  );
  const provider = new MiniMaxProvider({
    apiKey: "minimax-test",
    model,
    tools: [ECHO_TOOL],
    fetchImpl,
  });
  return { fetchImpl, provider };
}

function echoReasoningRound(options: {
  readonly id: string;
  readonly text: string;
  readonly reasoning: string;
  readonly model?: string;
}): readonly [LLMMessage, LLMMessage] {
  return [{
    role: "assistant",
    content: "",
    toolCalls: [{
      id: options.id,
      name: "system.echo",
      arguments: JSON.stringify({ text: options.text }),
    }],
    providerReasoningContent: options.reasoning,
    providerReasoningProvenance: {
      provider: "minimax",
      model: options.model ?? "MiniMax-M3",
    },
  }, {
    role: "tool",
    toolCallId: options.id,
    toolName: "system.echo",
    content: options.text,
  }];
}

describe("MiniMax catalog", () => {
  test("lists the documented lineup with M3 as the default", () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.minimax).toBe("MiniMax-M3");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.minimax[0]).toBe("MiniMax-M3");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.minimax).not.toContain(
      "MiniMax-Vision-01",
    );
    expect(
      resolveModelCatalogMetadata({ provider: "minimax", model: "MiniMax-M3" }),
    ).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 131_072 });
    expect(
      resolveModelCatalogMetadata({ provider: "minimax", model: "MiniMax-M2.7-highspeed" }),
    ).toMatchObject({ contextWindow: 204_800, maxOutputTokens: 131_072 });
  });

  test("M3 alone carries the two-position thinking switch and image input", () => {
    const m3 = resolveRegisteredModelCatalogEntry({
      provider: "minimax",
      model: "MiniMax-M3",
    });
    expect(m3?.supportedReasoningLevels).toEqual(["low", "high"]);
    expect(m3?.defaultReasoningLevel).toBe("high");
    expect(
      resolveProviderCapabilityEntry({ provider: "minimax", model: "MiniMax-M3" })
        .supportsImageInput,
    ).toBe(true);

    for (const model of ["MiniMax-M2.7", "MiniMax-M2.5-highspeed", "MiniMax-M2"]) {
      const entry = resolveRegisteredModelCatalogEntry({ provider: "minimax", model });
      expect(entry?.supportedReasoningLevels, model).toEqual([]);
      expect(entry?.defaultReasoningLevel, model).toBeUndefined();
      expect(
        resolveProviderCapabilityEntry({ provider: "minimax", model })
          .supportsImageInput,
        model,
      ).toBe(false);
    }
  });

  test("the wire never forwards reasoning_effort; M3 maps it onto the switch", () => {
    const m3 = chatCompletionsCapabilityHintsForProvider("minimax", "MiniMax-M3");
    expect(m3.acceptsReasoningEffort).toBe(false);
    expect(m3.thinkingConfig).toEqual({ type: "adaptive" });
    expect(m3.reasoningSplit).toBe(true);
    expect(m3.replaysReasoningContent).toBe(true);
    expect(m3.replaysReasoningContentOnlyForAdjacentToolContinuation).toBeUndefined();
    expect(m3.reasoningContentField).toBe("reasoning_content");

    const m27 = chatCompletionsCapabilityHintsForProvider("minimax", "MiniMax-M2.7");
    expect(m27.thinkingConfig).toBeUndefined();
    expect(m27.reasoningSplit).toBe(true);
    expect(m27.replaysReasoningContent).toBe(true);
  });
});

describe("MiniMaxProvider wire", () => {
  test("asks for split reasoning and adaptive thinking on M3 by default", async () => {
    const { fetchImpl, provider } = createSuccessfulMinimaxProvider();
    await provider.chat([{ role: "user", content: "hello" }], {
      reasoningEffort: "high",
      tools: [ECHO_TOOL],
    });
    const body = bodyAt(fetchImpl);
    expect(body).toMatchObject({
      model: "MiniMax-M3",
      reasoning_split: true,
      thinking: { type: "adaptive" },
    });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("a low effort turns M3 thinking off", async () => {
    const { fetchImpl, provider } = createSuccessfulMinimaxProvider();
    await provider.chat([{ role: "user", content: "hello" }], {
      reasoningEffort: "low",
    });
    expect(bodyAt(fetchImpl).thinking).toEqual({ type: "disabled" });
    expect(bodyAt(fetchImpl)).not.toHaveProperty("reasoning_effort");
  });

  test("M2.7 gets split reasoning but no thinking switch", async () => {
    const { fetchImpl, provider } = createSuccessfulMinimaxProvider("MiniMax-M2.7");
    await provider.chat([{ role: "user", content: "hello" }], {
      reasoningEffort: "high",
    });
    const body = bodyAt(fetchImpl);
    expect(body.reasoning_split).toBe(true);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("moves reasoning_content to the thinking channel and keeps it for replay", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("MiniMax-M3", "The answer.", {
        reasoning_content: "opaque MiniMax reasoning",
      }),
    );
    const provider = new MiniMaxProvider({
      apiKey: "minimax-test",
      model: "MiniMax-M3",
      fetchImpl,
    });
    const response = await provider.chat([{ role: "user", content: "hello" }]);
    expect(response.content).toBe("The answer.");
    expect(response.thinking?.[0]?.text).toBe("opaque MiniMax reasoning");
    expect(response.providerReasoningContent).toBe("opaque MiniMax reasoning");
    expect(response.providerReasoningProvenance).toEqual({
      provider: "minimax",
      model: "minimax-m3",
    });
  });

  test("echoes reasoning_content back on every earlier MiniMax turn", async () => {
    const { fetchImpl, provider } = createSuccessfulMinimaxProvider();
    await provider.chat([
      { role: "user", content: "call echo" },
      ...echoReasoningRound({
        id: "call_echo",
        text: "hi",
        reasoning: "reasoning for the echo call",
      }),
    ]);
    const replay = bodyAt(fetchImpl) as { messages: Array<Record<string, unknown>> };
    expect(replay.messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "reasoning for the echo call",
    });

    // A runtime reminder after the tool result, or a later user turn, keeps
    // the chain: MiniMax asks for thinking preserved in later turns.
    await provider.chat([
      { role: "user", content: "call echo" },
      ...echoReasoningRound({
        id: "call_old",
        text: "old",
        reasoning: "earlier turn reasoning",
      }),
      { role: "user", content: "now a new question" },
    ]);
    const later = bodyAt(fetchImpl, 1) as { messages: Array<Record<string, unknown>> };
    expect(later.messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "earlier turn reasoning",
    });
  });

  test("never replays reasoning that came from another provider or model", async () => {
    const { fetchImpl, provider } = createSuccessfulMinimaxProvider();
    await provider.chat([
      { role: "user", content: "call echo" },
      ...echoReasoningRound({
        id: "call_other",
        text: "x",
        reasoning: "foreign reasoning",
        model: "MiniMax-M2.7",
      }),
    ]);
    expect(JSON.stringify(bodyAt(fetchImpl).messages)).not.toContain(
      "foreign reasoning",
    );
  });
});
