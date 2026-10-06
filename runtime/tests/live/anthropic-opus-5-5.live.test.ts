/**
 * Minimal paid check of Claude Opus 5.5 through AgenC's real Anthropic
 * adapter and wire builder. It is skipped unless AGENC_LIVE_OPUS55=1 and
 * ANTHROPIC_API_KEY are both set. It sends five requests, plus a sixth
 * fast-mode request when AGENC_LIVE_OPUS55_FAST=1, and refuses to send more
 * than six. Every request is a one-line prompt capped at 1024 output tokens.
 *
 *   cd runtime && AGENC_LIVE_OPUS55=1 ANTHROPIC_API_KEY=... \
 *     /opt/homebrew/bin/node ../node_modules/vitest/vitest.mjs run \
 *     --config vitest.live.config.ts tests/live/anthropic-opus-5-5.live.test.ts
 */
import { describe, expect, it } from "vitest";

import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import { createTokenAccountingRequest } from "../../src/llm/token-accounting.js";
import type { LLMChatOptions, LLMMessage, LLMTool } from "../../src/llm/types.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const enabled = process.env.AGENC_LIVE_OPUS55 === "1" && apiKey.length > 0;
const fastEnabled = process.env.AGENC_LIVE_OPUS55_FAST === "1";
const MODEL = "claude-opus-5-5";
const MAX_OUTPUT = 1024;
const REQUEST_BUDGET = 6;
const ONE_WORD: LLMMessage[] = [{ role: "user", content: "Reply with the single word OK." }];

const clockTool: LLMTool = {
  type: "function",
  function: {
    name: "get_time",
    description: "Return the current UTC time.",
    parameters: { type: "object", properties: {} },
  },
};

let requestsSent = 0;

interface SentRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function recordingProvider(): {
  readonly provider: AnthropicProvider;
  readonly sent: SentRequest[];
  readonly warnings: string[];
} {
  const sent: SentRequest[] = [];
  const warnings: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (requestsSent >= REQUEST_BUDGET) {
      throw new Error(`live check budget of ${REQUEST_BUDGET} requests is spent`);
    }
    requestsSent += 1;
    sent.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return fetch(input, init);
  };
  return {
    provider: new AnthropicProvider({
      apiKey,
      model: MODEL,
      fetchImpl,
      timeoutMs: 110_000,
      maxRetries: 0,
      emitWarning: (warning) => warnings.push(warning.cause),
    }),
    sent,
    warnings,
  };
}

async function turn(step: string, messages: LLMMessage[], options: LLMChatOptions) {
  const { provider, sent, warnings } = recordingProvider();
  const response = await provider.chatStream(messages, () => {}, {
    maxOutputTokens: MAX_OUTPUT,
    singleWireAttempt: true,
    ...options,
  });
  expect(sent).toHaveLength(1);
  const body = sent[0]!.body;
  console.log(`LIVE ${step}`, JSON.stringify({
    model: response.model,
    finishReason: response.finishReason,
    text: response.content.slice(0, 80),
    usage: response.usage,
    sent: {
      model: body.model,
      thinking: body.thinking ?? null,
      output_config: body.output_config ?? null,
      temperature: body.temperature ?? null,
      tool_choice: body.tool_choice ?? null,
      speed: body.speed ?? null,
    },
    warnings,
  }));
  return { response, body, warnings };
}

describe.skipIf(!enabled)("LIVE Claude Opus 5.5 on the Anthropic API", () => {
  it("1. takes a default turn after dropping forced tool choice and temperature", { timeout: 120_000 }, async () => {
    const { response, body } = await turn("1 default", ONE_WORD, {
      tools: [clockTool],
      toolChoice: "required",
      temperature: 0.2,
    });
    expect(body.model).toBe(MODEL);
    expect(body).toHaveProperty("tools");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("output_config");
    expect(response.model.startsWith(MODEL)).toBe(true);
    expect(response.usage.promptTokens).toBeGreaterThan(0);
    expect(response.usage.completionTokens).toBeGreaterThan(0);
  });

  it("2. accepts effort max", { timeout: 120_000 }, async () => {
    const { response, body } = await turn("2 max", ONE_WORD, { reasoningEffort: "max" });
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body).not.toHaveProperty("thinking");
    expect(response.usage.completionTokens).toBeGreaterThan(0);
  });

  it("3. accepts effort xhigh", { timeout: 120_000 }, async () => {
    const { response, body } = await turn("3 xhigh", ONE_WORD, { reasoningEffort: "xhigh" });
    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body).not.toHaveProperty("thinking");
    expect(response.usage.completionTokens).toBeGreaterThan(0);
  });

  it("4. continues a tool loop whose assistant turn carries no thinking block", { timeout: 120_000 }, async () => {
    // The history AgenC sends after a tool call: it never replays thinking.
    const { response, body } = await turn("4 tool loop", [
      { role: "user", content: "What time is it? Use get_time, then reply with only the time." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toolu_agenc_live_check_1", name: "get_time", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "toolu_agenc_live_check_1", toolName: "get_time", content: "12:00 UTC" },
    ], { tools: [clockTool], reasoningEffort: "medium" });
    const wireMessages = body.messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(wireMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(wireMessages[1]!.content.map((block) => block.type)).toEqual(["tool_use"]);
    expect(wireMessages[2]!.content.map((block) => block.type)).toEqual(["tool_result"]);
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(response.usage.completionTokens).toBeGreaterThan(0);
  });

  it("5. counts tokens for a turn that asked for a forced tool at effort max", { timeout: 60_000 }, async () => {
    const { provider, sent } = recordingProvider();
    const result = await provider.tokenCountCapability.countTokens(
      createTokenAccountingRequest({
        provider: provider.name,
        model: MODEL,
        messages: ONE_WORD,
        options: {
          tools: [clockTool],
          toolChoice: "required",
          reasoningEffort: "max",
          maxOutputTokens: MAX_OUTPUT,
        },
        reservedOutputTokens: MAX_OUTPUT,
      }),
      new AbortController().signal,
    );
    expect(sent).toHaveLength(1);
    const { url, body } = sent[0]!;
    console.log("LIVE 5 count_tokens", JSON.stringify({
      url,
      inputTokens: result.inputTokens,
      sent: { tool_choice: body.tool_choice ?? null, output_config: body.output_config ?? null },
    }));
    expect(url.endsWith("/messages/count_tokens")).toBe(true);
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("thinking");
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it.skipIf(!fastEnabled)("6. serves fast mode on the priority tier", { timeout: 120_000 }, async () => {
    const { response, body, warnings } = await turn("6 fast", ONE_WORD, { serviceTier: "priority" });
    expect(body.speed).toBe("fast");
    expect(warnings).not.toContain("fast_mode_not_applied");
    expect(response.usage.speed).toBe("fast");
  });
});
