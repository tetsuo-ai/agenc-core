import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { runTurn } from "../../src/session/run-turn.js";
import { RETRY_REASONING_ONLY_CONTENT } from "../../src/recovery/max-output-tokens.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { supportsToolResultRuntimeContext } from "../../src/session/reasoning-recovery-capability.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { bodyAt, sseResponse } from "../llm/providers/openai-compatible-test-helpers.js";

type WireMessage = { readonly role: string; readonly content: unknown };

const nativeHints = chatCompletionsCapabilityHintsForProvider("deepseek", "deepseek-flash");

const history: LLMMessage[] = [
  { role: "user", content: "Read the fixture." },
  {
    role: "assistant", content: "",
    toolCalls: [{ id: "call1", name: "read_fixture", arguments: "{}" }],
    providerReasoningContent: "Plan the read.",
    providerReasoningProvenance: { provider: "deepseek", model: "deepseek-flash" },
  },
  { role: "tool", toolCallId: "call1", toolName: "read_fixture", content: "observed" },
];

const reminder: LLMMessage = {
  role: "user",
  content: "<system-reminder>\nreminder\n</system-reminder>",
  runtimeOnly: { mergeBoundary: "user_context" },
};

test.each([
  ["deepseek", "deepseek-flash", true],
  ["deepseek", "deepseek-v4-pro", true],
  ["deepseek", "unknown", false],
  ["openai", "deepseek-flash", false],
  ["openrouter", "deepseek/deepseek-flash", false],
] as const)("tool-result runtime context route %s/%s", (provider, model, expected) => {
  expect(supportsToolResultRuntimeContext(provider, model)).toBe(expected);
});

test("wire: the session option carries runtime context inside the preceding native DeepSeek tool result", () => {
  const messages = [...history, reminder];
  const off = buildChatCompletionsRequest({
    model: "deepseek-flash", messages, tools: [], providerCapabilityHints: nativeHints,
  }).messages as WireMessage[];
  const on = buildChatCompletionsRequest({
    model: "deepseek-flash", messages, tools: [],
    options: { runtimeContextInToolResults: true }, providerCapabilityHints: nativeHints,
  }).messages as WireMessage[];
  expect(off.map(m => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  expect(off[2]!.content).toBe("observed");
  expect(on.map(m => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(on[2]!.content).toBe(
    "observed\n\n<runtime-context>\n<system-reminder>\nreminder\n</system-reminder>\n</runtime-context>",
  );
  // The replayed reasoning chain is untouched by the projection.
  expect(on[1]).toMatchObject({ role: "assistant", reasoning_content: "Plan the read." });
  expect(on[1]).toEqual(off[1]);
});

test("wire: a human message after a tool result stays a user message; context before the human message is untouched", () => {
  const human: LLMMessage = { role: "user", content: "Also check the second fixture." };
  const on = buildChatCompletionsRequest({
    model: "deepseek-flash", messages: [...history, human], tools: [],
    options: { runtimeContextInToolResults: true }, providerCapabilityHints: nativeHints,
  }).messages as WireMessage[];
  expect(on.map(m => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  expect(on[2]!.content).toBe("observed");
  const leading = buildChatCompletionsRequest({
    model: "deepseek-flash", messages: [reminder, ...history], tools: [],
    options: { runtimeContextInToolResults: true }, providerCapabilityHints: nativeHints,
  }).messages as WireMessage[];
  expect(leading.map(m => m.role)).toEqual(["user", "user", "assistant", "tool"]);
});

test("buildProviderOptions requests the layout only on native DeepSeek with the switch on", () => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const signal = new AbortController().signal;
  for (const [providerName, model, expected] of [
    ["deepseek", "deepseek-flash", true],
    ["openai", "deepseek-flash", undefined],
  ] as const) {
    const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
    const { session } = mkSession({ model, provider: { ...mkProvider(), name: providerName } });
    const request = buildSamplingRequestContract(state, session, ctx);
    expect(buildProviderOptions(request, ctx, signal, session).runtimeContextInToolResults).toBeUndefined();
    Object.assign(session.config!, { runtimeContextInToolResults: true });
    expect(buildProviderOptions(request, ctx, signal, session).runtimeContextInToolResults).toBe(expected);
  }
});

type Sample = "reason-cap" | "tool" | "final";

async function scenario(samples: Sample[], config: Record<string, unknown>) {
  const execute = vi.fn(async () => ({ content: "observed fixture" }));
  const tool = {
    name: "read_fixture", description: "Read fixture", inputSchema: { type: "object", properties: {} },
    isReadOnly: true, recoveryCategory: "idempotent" as const, execute,
  };
  const registry = {
    tools: [tool],
    toLLMTools: () => [{ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }],
    dispatch: execute,
  };
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const i = index++;
    const sample = samples[i] ?? "final";
    const capped = sample === "reason-cap";
    const delta = capped ? { reasoning_content: "Consider the next step." }
      : sample === "tool" ? { tool_calls: [{ index: 0, id: `read${i}`, type: "function", function: { name: tool.name, arguments: "{}" } }] }
      : { content: "Finished." };
    return sseResponse([
      `data: ${JSON.stringify({ model: "deepseek-flash", choices: [{ index: 0, delta }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: capped ? "length" : sample === "tool" ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: capped ? 8192 : 10, total_tokens: capped ? 8202 : 20,
          ...(capped ? { completion_tokens_details: { reasoning_tokens: 8192 } } : {}) } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  const provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", fetchImpl });
  const { session, events } = mkSession({ provider, model: "deepseek-flash", registry });
  Object.assign(session.config!, config);
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, { ...ctx,
    config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 },
    modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["low", "high", "max"] },
  }, "Read the fixture and finish."));
  const bodies = fetchImpl.mock.calls.map((_, i) => bodyAt(fetchImpl, i));
  return { bodies, events, execute };
}

const retryEnvelope = `<runtime-context>\n${RETRY_REASONING_ONLY_CONTENT}\n</runtime-context>`;

test("the reasoning-only retry instruction rides inside the last tool result on native DeepSeek with the switch on", async () => {
  const { bodies, events, execute } = await scenario(["tool", "reason-cap", "tool", "final"], { runtimeContextInToolResults: true });
  expect(bodies).toHaveLength(4);
  expect(bodies.map(b => (b.thinking as { type: string }).type)).toEqual(["enabled", "enabled", "disabled", "enabled"]);
  const recovery = bodies[2]!.messages as WireMessage[];
  const last = recovery.at(-1)!;
  expect(last.role).toBe("tool");
  expect(String(last.content)).toContain(retryEnvelope);
  expect(recovery.filter(m => m.role === "user" && String(m.content).includes(RETRY_REASONING_ONLY_CONTENT))).toHaveLength(0);
  // The thinking-off sample's tool call and result follow the folded instruction unchanged.
  const next = bodies[3]!.messages as WireMessage[];
  expect(next.map(m => m.role).slice(-3)).toEqual(["tool", "assistant", "tool"]);
  expect(String(next.at(-3)!.content)).toContain(retryEnvelope);
  expect(String(next.at(-1)!.content)).not.toContain("<runtime-context>");
  expect(next.filter(m => m.role === "user" && String(m.content).includes(RETRY_REASONING_ONLY_CONTENT))).toHaveLength(0);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(true);
});

test("with the switch off the retry instruction is a separate user message, as before", async () => {
  const { bodies } = await scenario(["tool", "reason-cap", "tool", "final"], {});
  const recovery = bodies[2]!.messages as WireMessage[];
  expect(recovery.at(-1)).toMatchObject({ role: "user", content: RETRY_REASONING_ONLY_CONTENT });
  expect(recovery.at(-2)?.role).toBe("tool");
  expect(String(recovery.at(-2)!.content)).not.toContain("<runtime-context>");
});

test("a cap before any tool result keeps the retry instruction as its own user message, not merged into the request", async () => {
  const { bodies } = await scenario(["reason-cap", "final"], { runtimeContextInToolResults: true });
  const recovery = bodies[1]!.messages as WireMessage[];
  const users = recovery.filter(m => m.role === "user").map(m => String(m.content));
  expect(users.some(content => content === RETRY_REASONING_ONLY_CONTENT)).toBe(true);
  expect(users.some(content => content.includes("Read the fixture and finish.") && content.includes(RETRY_REASONING_ONLY_CONTENT))).toBe(false);
  expect(JSON.stringify(recovery)).not.toContain("<runtime-context>");
});
