import { describe, expect, test, vi } from "vitest";
import { LLMCapabilityError } from "../../src/llm/errors.js";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMTool } from "../../src/llm/types.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import { GrokAcpProvider } from "../../src/llm/providers/grok/acp-adapter.js";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { OllamaProvider } from "../../src/llm/providers/ollama/adapter.js";
import { BedrockProvider } from "../../src/llm/providers/bedrock/index.js";

const messages: LLMMessage[] = [{ role: "user", content: "Choose the relevant entry." }];
const tool: LLMTool = { type: "function", function: {
  name: "select_entry", description: "Select an entry", parameters: { type: "object" },
} };
const schema: LLMChatOptions["structuredOutput"] = { schema: {
  type: "json_schema", name: "selection", schema: {
    type: "object", properties: { id: { type: "string" } }, required: ["id"],
    additionalProperties: false,
  },
} };

async function validate(provider: LLMProvider, options: LLMChatOptions): Promise<void> {
  expect(provider.validateRequest).toBeTypeOf("function");
  await provider.validateRequest!(messages, options);
}

describe("auxiliary capability preflight", () => {
  test.each([
    ["openai", "gpt-5.4", true],
    ["meta", "muse-spark-1.3", true],
    ["cerebras", "gpt-oss-120b", true],
    ["zai", "glm-5.3", true],
    ["zai-coding-plan", "glm-5.3", true],
    ["kimi", "kimi-k3", true],
    ["deepseek", "deepseek-flash", false],
    ["qwen", "qwen3.8-max", false],
    ["qwen-token-plan", "qwen3.8-max", false],
    ["openrouter", "openai/gpt-5.4", false],
    ["venice", "qwen3-235b", false],
    ["abliteration", "abliterated-model", false],
    ["groq", "llama-3.3-70b-versatile", false],
    ["ollama-cloud", "qwen3-coder:480b", false],
    ["mistral", "mistral-large-latest", false],
    ["nvidia-nim", "nvidia/nemotron-3-super-120b-a12b", false],
    ["minimax", "MiniMax-M2.1", false],
    ["github", "github:copilot:gpt-5.4", false],
    ["lmstudio", "local-model", false],
    ["openai-compatible", "custom-model", false],
  ] as const)("preflights %s structured output without fetching", async (providerName, model, supported) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new OpenAIProvider({ providerName, model, apiKey: "test-only",
      baseURL: "https://provider.invalid/v1", useResponsesApi: false, fetchImpl });
    const request = { structuredOutput: schema, tools: [], maxOutputTokens: 128 };
    if (supported) await expect(validate(provider, request)).resolves.toBeUndefined();
    else await expect(validate(provider, request)).rejects.toMatchObject({
      name: "LLMCapabilityError", providerName, capability: "structured_output",
    });
    await expect(validate(provider, { tools: [], maxOutputTokens: 128 })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["cerebras", "kimi"])("rejects %s combined schema and tool requests locally", async (providerName) => {
    const provider = new OpenAIProvider({ providerName,
      model: providerName === "cerebras" ? "gpt-oss-120b" : "kimi-k3",
      apiKey: "test-only", useResponsesApi: false });
    await expect(validate(provider, { structuredOutput: schema, tools: [tool] }))
      .rejects.toBeInstanceOf(LLMCapabilityError);
  });

  test("uses the actual Responses API selection for Meta model overrides", async () => {
    const provider = new OpenAIProvider({ providerName: "meta", model: "muse-spark-1.3",
      apiKey: "test-only", useResponsesApi: false });
    await expect(validate(provider, { model: "muse-wonder-1.0", structuredOutput: schema }))
      .resolves.toBeUndefined();
  });

  test("Grok validates the selected tool envelope and permits tool-free schemas", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new GrokProvider({ apiKey: "test-only", model: "grok-code-fast-1",
      tools: [tool], fetchImpl });
    await expect(validate(provider, { structuredOutput: schema }))
      .rejects.toMatchObject({ capability: "structured_output_with_tools" });
    await expect(validate(provider, { structuredOutput: schema, tools: [] }))
      .resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("Anthropic accepts its native tool schema and rejects a reserved tool collision", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new AnthropicProvider({ apiKey: "test-only", model: "claude-sonnet-4-5", fetchImpl });
    await expect(validate(provider, { structuredOutput: schema, tools: [tool] })).resolves.toBeUndefined();
    const reservedTool = { ...tool, function: { ...tool.function, name: "agenc_structured_output" } };
    await expect(validate(provider, { structuredOutput: schema, tools: [reservedTool] }))
      .rejects.toMatchObject({ capability: "structured_output_with_tools" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("Gemini uses native schema capabilities instead of the Chat Completions matrix", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new GeminiProvider({ model: "gemini-2.5-pro", fetchImpl,
      endpointPlan: createGeminiEndpointPlan(),
      credentialPlan: { kind: "api-key", credential: "test-only", source: "factory" } });
    await expect(validate(provider, { structuredOutput: schema, tools: [tool] })).resolves.toBeUndefined();
    await expect(validate(provider, { structuredOutput: { schema: {
      type: "json_schema", name: "unsupported", schema: { type: "object", not: { type: "string" } },
    } } })).rejects.toMatchObject({ capability: "request_features" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["ollama", "amazon-bedrock", "grok-acp"])("does not silently drop a schema on %s", async (name) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider: LLMProvider = name === "ollama"
      ? new OllamaProvider({ model: "llama3.3", fetchImpl })
      : name === "amazon-bedrock"
        ? new BedrockProvider({ model: "amazon.nova-pro-v1:0", fetchImpl })
        : new GrokAcpProvider({ model: "grok-composer", env: {} });
    await expect(validate(provider, { structuredOutput: schema, tools: [] }))
      .rejects.toMatchObject({ capability: "structured_output" });
    await expect(validate(provider, { structuredOutput: { ...schema, enabled: false }, tools: [] }))
      .resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    await provider.dispose?.();
  });

  test.each(["ollama", "amazon-bedrock"])("validates %s named tool choice without dispatch", async (name) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = name === "ollama"
      ? new OllamaProvider({ model: "llama3.3", fetchImpl })
      : new BedrockProvider({ model: "amazon.nova-pro-v1:0", fetchImpl });
    await expect(validate(provider, { tools: [tool], toolChoice: { type: "function", name: "missing" } }))
      .rejects.toMatchObject({ capability: "request_features" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
