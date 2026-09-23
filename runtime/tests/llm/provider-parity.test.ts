import { describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../config/schema.js";
import { resolveProviderCapabilityEntry } from "./capabilities.js";
import { StaticModelsManager } from "./models-manager.js";
import {
  createProvider,
  readProviderIdentity,
  KNOWN_PROVIDER_NAMES,
  type ProviderFactoryOptions,
  type ProviderName,
} from "./provider.js";
import { AnthropicProvider } from "./providers/anthropic/adapter.js";
import { BedrockProvider } from "./providers/bedrock/index.js";
import { DeepSeekProvider } from "./providers/deepseek/index.js";
import { MetaProvider } from "./providers/meta/index.js";
import { CerebrasProvider } from "./providers/cerebras/index.js";
import {
  ZaiCodingPlanProvider,
  ZaiProvider,
} from "./providers/zai/index.js";
import { KimiProvider } from "./providers/kimi/index.js";
import {
  QwenProvider,
  QwenTokenPlanProvider,
} from "./providers/qwen/index.js";
import { GeminiProvider } from "./providers/gemini/index.js";
import { createGeminiEndpointPlan } from "./providers/gemini/endpoint-plan.js";
import { GrokProvider } from "./providers/grok/adapter.js";
import { GroqProvider } from "./providers/groq/index.js";
import { GitHubProvider } from "./providers/github/index.js";
import { LMStudioProvider } from "./providers/lmstudio/index.js";
import { MiniMaxProvider } from "./providers/minimax/index.js";
import { MistralProvider } from "./providers/mistral/index.js";
import { NvidiaNimProvider } from "./providers/nvidia-nim/index.js";
import { OllamaProvider } from "./providers/ollama/adapter.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible/index.js";
import { OpenAIProvider } from "./providers/openai/adapter.js";
import { OpenRouterProvider } from "./providers/openrouter/index.js";
import { OllamaCloudProvider } from "./providers/ollama-cloud/index.js";
import { AgenCProvider } from "./providers/agenc/index.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMTool,
  LLMToolCall,
} from "./types.js";
import { DESKTOP_PLUGIN_TOOLS } from "./fixtures/desktop-plugin-tools.js";
import { encodeMcpToolNameForWire } from "./wire/mcp-tool-naming.js";
import { buildToolRegistry } from "../tool-registry.js";
import type { Tool } from "../tools/types.js";
import { Server as McpFixtureServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Client as McpFixtureClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ECHO_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo the provided text.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

const GEMINI_ENDPOINT_PLAN = createGeminiEndpointPlan();

/**
 * Wire form of `system.echo` under the bijective MCP tool-name encoding
 * (src/llm/wire/mcp-tool-naming.ts). The strict-regex providers reject
 * dotted function names, so the shared wire shims (chat-completions,
 * responses-openai/xai, messages-anthropic) encode the internal dotted
 * name on the request and decode the provider's echoed name back before
 * dispatch. The literal is hardcoded on purpose: this suite pins the wire
 * contract instead of round-tripping through the encoder.
 *
 * Gemini and Ollama use their own converters that pass tool names
 * through unencoded, so their wire form stays `system.echo`. Bedrock's
 * Converse `ToolSpecification.name` pattern (`[a-zA-Z0-9_-]+`) rejects
 * dots, so its converter encodes/decodes like the strict-regex shims.
 */
const ECHO_TOOL_WIRE_NAME = "tool2__system_x2eecho";
const PASSTHROUGH_WIRE_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  "ollama",
  "gemini",
]);

/**
 * Real providers echo `function.name` back in tool-call responses exactly
 * as it appeared on the wire request. The mocked payloads must do the
 * same (encoded form for the strict-regex providers) so the runtime's
 * decode path is genuinely exercised — the response-side assertions in
 * `assertToolCalls` expect the DECODED dotted name.
 */
function encodedWireToolCallName(name: string): string {
  return name === "system.echo" ? ECHO_TOOL_WIRE_NAME : name;
}

const BASE_USAGE = {
  promptTokens: 11,
  completionTokens: 3,
  totalTokens: 14,
  availability: "reported",
  provenance: "provider",
} as const;

// These entries use the shared Chat Completions parser. Its usage payload has
// no cache-write count, so admission must conservatively price possible writes.
// Responses, Anthropic, and Bedrock can report writes; Gemini and Ollama use
// their own usage formats and must not inherit this wire-specific marker.
const CHAT_COMPLETIONS_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  "lmstudio",
  "openai-compatible",
  "openrouter",
  "groq",
  "deepseek",
  "meta",
  "cerebras",
  "zai",
  "zai-coding-plan",
  "kimi",
  "qwen",
  "qwen-token-plan",
  "mistral",
  "nvidia-nim",
  "minimax",
  "github",
]);

interface ExpectedToolCall {
  readonly name: string;
  readonly arguments: string;
}

interface CanonicalPromptCase {
  readonly id: string;
  readonly messages: readonly LLMMessage[];
  readonly requestMarkers: readonly string[];
  readonly tools?: readonly LLMTool[];
  readonly options?: LLMChatOptions;
  readonly expected: {
    readonly content: string;
    readonly finishReason: LLMResponse["finishReason"];
    readonly toolCalls: readonly ExpectedToolCall[];
  };
}

interface CapturedRequest {
  readonly url?: string;
  readonly payload: unknown;
}

interface ProviderHarness {
  readonly provider: LLMProvider;
  readonly requests: CapturedRequest[];
}

interface ProviderParityEntry {
  readonly provider: ProviderName;
  readonly model: string;
  readonly apiKey?: string;
  readonly extra?: ProviderFactoryOptions["extra"];
  readonly env: Record<string, string | undefined>;
  readonly createHarness: (parityCase: CanonicalPromptCase) => ProviderHarness;
}

const CANONICAL_PROMPTS: readonly CanonicalPromptCase[] = [
  {
    id: "plain-user-text",
    messages: [{ role: "user", content: "PARITY::plain-user-text" }],
    requestMarkers: ["PARITY::plain-user-text"],
    expected: {
      content: "provider-parity/plain-user-text",
      finishReason: "stop",
      toolCalls: [],
    },
  },
  {
    id: "system-and-user-text",
    messages: [
      { role: "system", content: "SYSTEM::be-terse-2" },
      { role: "user", content: "PARITY::system-user-text" },
    ],
    requestMarkers: ["SYSTEM::be-terse-2", "PARITY::system-user-text"],
    expected: {
      content: "provider-parity/system-and-user-text",
      finishReason: "stop",
      toolCalls: [],
    },
  },
  {
    id: "multi-turn-text",
    messages: [
      { role: "user", content: "history hello 3" },
      { role: "assistant", content: "history ack 3" },
      { role: "user", content: "PARITY::multi-turn-text" },
    ],
    requestMarkers: ["history hello 3", "history ack 3", "PARITY::multi-turn-text"],
    expected: {
      content: "provider-parity/multi-turn-text",
      finishReason: "stop",
      toolCalls: [],
    },
  },
  {
    id: "content-parts-user",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "PARITY::parts-a" },
          { type: "text", text: "PARITY::parts-b" },
        ],
      },
    ],
    requestMarkers: ["PARITY::parts-a", "PARITY::parts-b"],
    expected: {
      content: "provider-parity/content-parts-user",
      finishReason: "stop",
      toolCalls: [],
    },
  },
  {
    id: "assistant-phase-metadata",
    messages: [
      {
        role: "assistant",
        content: "draft commentary 5",
        phase: "commentary",
      },
      { role: "user", content: "PARITY::assistant-phase" },
    ],
    requestMarkers: ["draft commentary 5", "PARITY::assistant-phase"],
    expected: {
      content: "provider-parity/assistant-phase-metadata",
      finishReason: "stop",
      toolCalls: [],
    },
  },
  {
    id: "tool-call-only",
    messages: [{ role: "user", content: "PARITY::tool-call-only" }],
    // The wire tool name differs per provider family (encoded vs
    // pass-through), so it is asserted per provider below rather than as a
    // shared marker here.
    requestMarkers: ["PARITY::tool-call-only"],
    tools: [ECHO_TOOL],
    expected: {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          name: "system.echo",
          arguments: '{"text":"tool-only"}',
        },
      ],
    },
  },
  {
    id: "tool-call-with-text",
    messages: [{ role: "user", content: "PARITY::tool-call-with-text" }],
    requestMarkers: ["PARITY::tool-call-with-text"],
    tools: [ECHO_TOOL],
    expected: {
      content: "Need system.echo before answering.",
      finishReason: "tool_calls",
      toolCalls: [
        {
          name: "system.echo",
          arguments: '{"text":"tool-text"}',
        },
      ],
    },
  },
  {
    id: "tool-follow-up-text",
    messages: [
      { role: "user", content: "PARITY::tool-follow-up-start" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_echo_8",
            name: "system.echo",
            arguments: '{"text":"previous"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_echo_8",
        toolName: "system.echo",
        content: "tool-output-8",
      },
      { role: "user", content: "PARITY::tool-follow-up-final" },
    ],
    requestMarkers: ["PARITY::tool-follow-up-final", "tool-output-8"],
    expected: {
      content: "provider-parity/tool-follow-up-text",
      finishReason: "stop",
      toolCalls: [],
    },
  },
  {
    id: "tool-follow-up-parts",
    messages: [
      { role: "user", content: "PARITY::tool-follow-up-parts-start" },
      {
        role: "assistant",
        content: "Tool completed.",
        toolCalls: [
          {
            id: "call_echo_9",
            name: "system.echo",
            arguments: '{"text":"structured"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_echo_9",
        toolName: "system.echo",
        content: [
          { type: "text", text: "tool-output-9a" },
          { type: "text", text: "tool-output-9b" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "PARITY::tool-follow-up-parts-final" },
          { type: "text", text: "PARITY::tool-follow-up-parts-extra" },
        ],
      },
    ],
    requestMarkers: [
      "PARITY::tool-follow-up-parts-final",
      "tool-output-9a",
      "tool-output-9b",
    ],
    expected: {
      content: "provider-parity/tool-follow-up-parts",
      finishReason: "stop",
      toolCalls: [],
    },
  },
  {
    id: "blank-user-turn",
    messages: [
      { role: "system", content: "SYSTEM::blank-user-turn" },
      { role: "user", content: "" },
    ],
    requestMarkers: ["SYSTEM::blank-user-turn"],
    expected: {
      content: "provider-parity/blank-user-turn",
      finishReason: "stop",
      toolCalls: [],
    },
  },
];

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function withResponse<T>(data: T) {
  return {
    withResponse: async () => ({
      data,
      response: jsonResponse(data as Record<string, unknown>),
      request_id: null,
    }),
  };
}

function buildResponsesApiPayload(
  model: string,
  parityCase: CanonicalPromptCase,
): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = [];
  if (parityCase.expected.content.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: parityCase.expected.content }],
    });
  }
  output.push(
    ...parityCase.expected.toolCalls.map((toolCall, index) => ({
      type: "function_call",
      id: `fc_${parityCase.id}_${index}`,
      call_id: `call_${parityCase.id}_${index}`,
      name: encodedWireToolCallName(toolCall.name),
      arguments: toolCall.arguments,
    })),
  );
  return {
    id: `resp_${parityCase.id}`,
    status: "completed",
    model,
    output,
    output_text: parityCase.expected.content,
    usage: {
      input_tokens: BASE_USAGE.promptTokens,
      output_tokens: BASE_USAGE.completionTokens,
      total_tokens: BASE_USAGE.totalTokens,
    },
  };
}

function buildChatCompletionsPayload(
  model: string,
  parityCase: CanonicalPromptCase,
): Record<string, unknown> {
  return {
    id: `chatcmpl_${parityCase.id}`,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: parityCase.expected.content,
          ...(parityCase.expected.toolCalls.length > 0
            ? {
              tool_calls: parityCase.expected.toolCalls.map((toolCall, index) => ({
                id: `call_${parityCase.id}_${index}`,
                type: "function",
                function: {
                  name: encodedWireToolCallName(toolCall.name),
                  arguments: toolCall.arguments,
                },
              })),
            }
            : {}),
        },
        finish_reason:
          parityCase.expected.finishReason === "tool_calls"
            ? "tool_calls"
            : "stop",
      },
    ],
    usage: {
      prompt_tokens: BASE_USAGE.promptTokens,
      completion_tokens: BASE_USAGE.completionTokens,
      total_tokens: BASE_USAGE.totalTokens,
    },
  };
}

function buildGeminiPayload(
  model: string,
  parityCase: CanonicalPromptCase,
): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  if (parityCase.expected.content.length > 0) {
    parts.push({ text: parityCase.expected.content });
  }
  parts.push(
    ...parityCase.expected.toolCalls.map((toolCall) => ({
      functionCall: {
        name: toolCall.name,
        args: JSON.parse(toolCall.arguments) as Record<string, unknown>,
      },
    })),
  );

  return {
    model,
    candidates: [
      {
        content: {
          role: "model",
          parts,
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: BASE_USAGE.promptTokens,
      candidatesTokenCount: BASE_USAGE.completionTokens,
      totalTokenCount: BASE_USAGE.totalTokens,
    },
  };
}

function buildAnthropicPayload(
  model: string,
  parityCase: CanonicalPromptCase,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (parityCase.expected.content.length > 0) {
    content.push({
      type: "text",
      text: parityCase.expected.content,
    });
  }
  content.push(
    ...parityCase.expected.toolCalls.map((toolCall, index) => ({
      type: "tool_use",
      id: `toolu_${parityCase.id}_${index}`,
      name: encodedWireToolCallName(toolCall.name),
      input: JSON.parse(toolCall.arguments) as Record<string, unknown>,
    })),
  );
  return {
    id: `msg_${parityCase.id}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason:
      parityCase.expected.finishReason === "tool_calls" ? "tool_use" : "end_turn",
    usage: {
      input_tokens: BASE_USAGE.promptTokens,
      output_tokens: BASE_USAGE.completionTokens,
    },
  };
}

function buildBedrockPayload(
  parityCase: CanonicalPromptCase,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (parityCase.expected.content.length > 0) {
    content.push({ text: parityCase.expected.content });
  }
  content.push(
    ...parityCase.expected.toolCalls.map((toolCall, index) => ({
      toolUse: {
        toolUseId: `toolu_${parityCase.id}_${index}`,
        // Bedrock echoes the encoded wire name back in toolUse blocks.
        name: encodedWireToolCallName(toolCall.name),
        input: JSON.parse(toolCall.arguments) as Record<string, unknown>,
      },
    })),
  );
  return {
    output: {
      message: {
        role: "assistant",
        content,
      },
    },
    stopReason:
      parityCase.expected.finishReason === "tool_calls" ? "tool_use" : "end_turn",
    usage: {
      inputTokens: BASE_USAGE.promptTokens,
      outputTokens: BASE_USAGE.completionTokens,
      totalTokens: BASE_USAGE.totalTokens,
    },
  };
}

function buildOllamaPayload(
  model: string,
  parityCase: CanonicalPromptCase,
): Record<string, unknown> {
  return {
    model,
    message: {
      role: "assistant",
      content: parityCase.expected.content,
      ...(parityCase.expected.toolCalls.length > 0
        ? {
          tool_calls: parityCase.expected.toolCalls.map((toolCall) => ({
            function: {
              name: toolCall.name,
              arguments: JSON.parse(toolCall.arguments) as Record<string, unknown>,
            },
          })),
        }
        : {}),
    },
    prompt_eval_count: BASE_USAGE.promptTokens,
    eval_count: BASE_USAGE.completionTokens,
  };
}

function createFetchHarness<T extends LLMProvider>(args: {
  readonly factory: (fetchImpl: typeof fetch) => T;
  readonly payload: Record<string, unknown>;
}): ProviderHarness {
  const requests: CapturedRequest[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const body = String(init?.body ?? "{}");
    requests.push({
      url: String(input),
      payload: JSON.parse(body) as Record<string, unknown>,
    });
    return jsonResponse(args.payload);
  });
  return {
    provider: args.factory(fetchImpl),
    requests,
  };
}

function createResponsesHarness(args: {
  readonly providerFactory: () => LLMProvider;
  readonly payload: Record<string, unknown>;
}): ProviderHarness {
  const requests: CapturedRequest[] = [];
  const provider = args.providerFactory();
  (provider as any).client = {
    responses: {
      create: vi.fn((params: Record<string, unknown>) => {
        requests.push({ payload: params });
        return withResponse(args.payload);
      }),
    },
  };
  return { provider, requests };
}

function createOllamaHarness(args: {
  readonly providerFactory: () => LLMProvider;
  readonly payload: Record<string, unknown>;
}): ProviderHarness {
  const requests: CapturedRequest[] = [];
  const provider = args.providerFactory();
  (provider as any).client = {
    chat: vi.fn(async (params: Record<string, unknown>) => {
      requests.push({ payload: params });
      return args.payload;
    }),
    list: vi.fn().mockResolvedValue({ models: [] }),
  };
  return { provider, requests };
}

function serializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function assertToolCalls(
  actual: readonly LLMToolCall[],
  expected: readonly ExpectedToolCall[],
): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, toolCall] of actual.entries()) {
    const wanted = expected[index];
    expect(toolCall.id).toEqual(expect.any(String));
    expect(toolCall.id.length).toBeGreaterThan(0);
    expect(toolCall.name).toBe(wanted?.name);
    expect(toolCall.arguments).toBe(wanted?.arguments);
  }
}

const PROVIDERS: readonly ProviderParityEntry[] = [
  {
    provider: "grok",
    model: "grok-4-fast",
    apiKey: "xai-test",
    env: { XAI_API_KEY: undefined },
    createHarness: (parityCase) =>
      createResponsesHarness({
        providerFactory: () =>
          new GrokProvider({
            apiKey: "xai-test",
            model: "grok-4-fast",
            tools: parityCase.tools ? [...parityCase.tools] : [],
          }),
        payload: buildResponsesApiPayload("grok-4-fast", parityCase),
      }),
  },
  {
    provider: "openai",
    model: "gpt-5",
    apiKey: "openai-test",
    env: { OPENAI_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new OpenAIProvider({
            apiKey: "openai-test",
            model: "gpt-5",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildResponsesApiPayload("gpt-5", parityCase),
      }),
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    apiKey: "anthropic-test",
    env: { ANTHROPIC_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new AnthropicProvider({
            apiKey: "anthropic-test",
            model: "claude-opus-4-7",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildAnthropicPayload("claude-opus-4-7", parityCase),
      }),
  },
  {
    provider: "ollama",
    model: "llama3.3",
    env: {},
    createHarness: (parityCase) =>
      createOllamaHarness({
        providerFactory: () =>
          new OllamaProvider({
            model: "llama3.3",
            tools: parityCase.tools ? [...parityCase.tools] : [],
          }),
        payload: buildOllamaPayload("llama3.3", parityCase),
      }),
  },
  {
    provider: "lmstudio",
    model: "gpt-4o-mini",
    env: {},
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new LMStudioProvider({
            model: "gpt-4o-mini",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("gpt-4o-mini", parityCase),
      }),
  },
  {
    provider: "openai-compatible",
    model: "local-model",
    env: {},
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new OpenAICompatibleProvider({
            model: "local-model",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("local-model", parityCase),
      }),
  },
  {
    provider: "openrouter",
    model: "openai/gpt-5",
    apiKey: "openrouter-test",
    env: { OPENROUTER_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new OpenRouterProvider({
            apiKey: "openrouter-test",
            model: "openai/gpt-5",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("openai/gpt-5", parityCase),
      }),
  },
  {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    apiKey: "groq-test",
    env: { GROQ_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new GroqProvider({
            apiKey: "groq-test",
            model: "llama-3.3-70b-versatile",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload(
          "llama-3.3-70b-versatile",
          parityCase,
        ),
      }),
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: "deepseek-test",
    env: { DEEPSEEK_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new DeepSeekProvider({
            apiKey: "deepseek-test",
            model: "deepseek-v4-pro",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("deepseek-v4-pro", parityCase),
      }),
  },
  {
    provider: "meta",
    model: "muse-spark-1.3",
    apiKey: "meta-test",
    env: { MODEL_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new MetaProvider({
            apiKey: "meta-test",
            model: "muse-spark-1.3",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("muse-spark-1.3", parityCase),
      }),
  },
  {
    provider: "cerebras",
    model: "gpt-oss-120b",
    apiKey: "cerebras-test",
    env: { CEREBRAS_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new CerebrasProvider({
            apiKey: "cerebras-test",
            model: "gpt-oss-120b",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("gpt-oss-120b", parityCase),
      }),
  },
  {
    provider: "zai",
    model: "glm-5.3",
    apiKey: "zai-test",
    env: { ZAI_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new ZaiProvider({
            apiKey: "zai-test",
            model: "glm-5.3",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("glm-5.3", parityCase),
      }),
  },
  {
    provider: "zai-coding-plan",
    model: "glm-5.3",
    apiKey: "zai-coding-plan-test",
    env: { ZAI_CODING_PLAN_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new ZaiCodingPlanProvider({
            apiKey: "zai-coding-plan-test",
            model: "glm-5.3",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("glm-5.3", parityCase),
      }),
  },
  {
    provider: "kimi",
    model: "kimi-k3",
    apiKey: "moonshot-test",
    env: { MOONSHOT_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new KimiProvider({
            apiKey: "moonshot-test",
            model: "kimi-k3",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("kimi-k3", parityCase),
      }),
  },
  {
    provider: "qwen",
    model: "qwen3.8-max",
    apiKey: "sk-ws-test",
    env: { DASHSCOPE_API_KEY: undefined, QWEN_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new QwenProvider({
            apiKey: "sk-ws-test",
            model: "qwen3.8-max",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("qwen3.8-max", parityCase),
      }),
  },
  {
    provider: "qwen-token-plan",
    model: "qwen3.8-max",
    apiKey: "sk-sp-test",
    env: {
      QWEN_TOKEN_PLAN_API_KEY: undefined,
      DASHSCOPE_TOKEN_PLAN_API_KEY: undefined,
    },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new QwenTokenPlanProvider({
            apiKey: "sk-sp-test",
            model: "qwen3.8-max",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("qwen3.8-max", parityCase),
      }),
  },
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    extra: {
      gemini: {
        credentialPlan: {
          kind: "api-key",
          credential: "gemini-test",
          source: "factory",
        },
        endpointPlan: GEMINI_ENDPOINT_PLAN,
      },
    },
    env: { GEMINI_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new GeminiProvider({
            credentialPlan: {
              kind: "api-key",
              credential: "gemini-test",
              source: "factory",
            },
            endpointPlan: GEMINI_ENDPOINT_PLAN,
            model: "gemini-2.5-pro",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildGeminiPayload("gemini-2.5-pro", parityCase),
      }),
  },
  {
    provider: "mistral",
    model: "mistral-medium-latest",
    apiKey: "mistral-test",
    env: { MISTRAL_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new MistralProvider({
            apiKey: "mistral-test",
            model: "mistral-medium-latest",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("mistral-medium-latest", parityCase),
      }),
  },
  {
    provider: "nvidia-nim",
    model: "nvidia/llama-3.1-nemotron-70b-instruct",
    apiKey: "nvidia-test",
    env: { NVIDIA_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new NvidiaNimProvider({
            apiKey: "nvidia-test",
            model: "nvidia/llama-3.1-nemotron-70b-instruct",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload(
          "nvidia/llama-3.1-nemotron-70b-instruct",
          parityCase,
        ),
      }),
  },
  {
    provider: "minimax",
    model: "MiniMax-M2.5",
    apiKey: "minimax-test",
    env: { MINIMAX_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new MiniMaxProvider({
            apiKey: "minimax-test",
            model: "MiniMax-M2.5",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("MiniMax-M2.5", parityCase),
      }),
  },
  {
    provider: "github",
    model: "gpt-4o",
    apiKey: "github-test",
    env: { GITHUB_TOKEN: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new GitHubProvider({
            apiKey: "github-test",
            model: "gpt-4o",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("gpt-4o", parityCase),
      }),
  },
  {
    provider: "amazon-bedrock",
    model: "amazon.nova-pro-v1:0",
    extra: {
      accessKeyId: "bedrock-test",
      secretAccessKey: "bedrock-secret",
    },
    env: {
      AWS_BEDROCK_ACCESS_KEY_ID: undefined,
      AWS_BEDROCK_SECRET_ACCESS_KEY: undefined,
      AWS_BEDROCK_REGION: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new BedrockProvider({
            accessKeyId: "bedrock-test",
            secretAccessKey: "bedrock-secret",
            model: "amazon.nova-pro-v1:0",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
            now: () => new Date("2024-01-02T03:04:05Z"),
          }),
        payload: buildBedrockPayload(parityCase),
      }),
  },
];

const MATRIX_PROVIDERS: readonly ProviderParityEntry[] = [
  ...PROVIDERS,
  {
    provider: "ollama-cloud", model: "deepseek-v4.1-flash", env: {},
    createHarness: (parityCase) => createFetchHarness({
      factory: (fetchImpl) => new OllamaCloudProvider({
        apiKey: "ollama-cloud-test", model: "deepseek-v4.1-flash",
        tools: parityCase.tools ? [...parityCase.tools] : [], fetchImpl,
      }),
      payload: buildChatCompletionsPayload("deepseek-v4.1-flash", parityCase),
    }),
  },
  {
    provider: "agenc", model: "grok-4-fast", env: {},
    createHarness: (parityCase) => {
      const delegate = createResponsesHarness({
        providerFactory: () => new GrokProvider({
          apiKey: "managed-test", model: "grok-4-fast",
          tools: parityCase.tools ? [...parityCase.tools] : [],
        }),
        payload: buildResponsesApiPayload("grok-4-fast", parityCase),
      });
      return {
        requests: delegate.requests,
        provider: new AgenCProvider({
          model: "grok-4-fast", tools: parityCase.tools ? [...parityCase.tools] : [],
          sessionId: "session-matrix" as any,
          authBackend: {
            inferAgencModel: () => ({ provider: "grok", model: "grok-4-fast" }),
            vendKey: () => ({ kind: "api-key", provider: "grok", sessionId: "session-matrix", apiKey: "managed-test" }),
          } as any,
          providerFactory: () => delegate.provider,
        }),
      };
    },
  },
  {
    provider: "grok", model: "grok-4.7", env: {},
    createHarness: (parityCase) => createResponsesHarness({
      providerFactory: () => new GrokProvider({ apiKey: "xai-test", model: "grok-4.7", tools: parityCase.tools ? [...parityCase.tools] : [] }),
      payload: buildResponsesApiPayload("grok-4.7", parityCase),
    }),
  },
  {
    provider: "anthropic", model: "claude-opus-5-5", env: {},
    createHarness: (parityCase) => createFetchHarness({
      factory: (fetchImpl) => new AnthropicProvider({ apiKey: "anthropic-test", model: "claude-opus-5-5", tools: parityCase.tools ? [...parityCase.tools] : [], fetchImpl }),
      payload: buildAnthropicPayload("claude-opus-5-5", parityCase),
    }),
  },
];

describe("provider parity", () => {
  it("loads Desktop and plugin MCP definitions through the session tool search", async () => {
    const servers = new Map<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>();
    for (const tool of DESKTOP_PLUGIN_TOOLS) {
      const qualified = tool.function.name.slice("mcp.".length);
      const separator = qualified.indexOf(".");
      const serverName = qualified.slice(0, separator);
      const rawName = qualified.slice(separator + 1);
      const definitions = servers.get(serverName) ?? [];
      definitions.push({ name: rawName, description: tool.function.description, inputSchema: tool.function.parameters });
      servers.set(serverName, definitions);
    }
    const serverTools: Tool[] = [];
    for (const [serverName, definitions] of servers) {
      const server = new McpFixtureServer({ name: serverName, version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
      const client = new McpFixtureClient({ name: "matrix-client", version: "1.0.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        for (const listed of (await client.listTools()).tools) {
          serverTools.push({
            name: `mcp.${serverName}.${listed.name}`,
            description: listed.description ?? listed.name,
            inputSchema: listed.inputSchema,
            execute: async () => ({ content: "fixture" }),
          });
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
    const registry = buildToolRegistry({
      workspaceRoot: "/private/tmp", requireAdmission: false,
      mcpToolsProvider: { getTools: () => serverTools },
    });
    const initial = registry.toLLMTools().map((tool) => tool.function.name);
    expect(initial).toContain("system.searchTools");
    expect(initial).not.toContain(DESKTOP_PLUGIN_TOOLS[0]!.function.name);
    for (const tool of DESKTOP_PLUGIN_TOOLS) {
      const result = await registry.dispatch({
        id: `load-${tool.function.name}`, name: "system.searchTools",
        arguments: JSON.stringify({ select: tool.function.name }),
      });
      expect(result.isError, tool.function.name).not.toBe(true);
    }
    for (const tool of DESKTOP_PLUGIN_TOOLS) {
      expect(registry.toLLMTools().find((loaded) => loaded.function.name === tool.function.name)?.function.parameters)
        .toEqual(tool.function.parameters);
    }
  });

  it("round-trips a long Gemini plugin name through call and history", async () => {
    const tool = DESKTOP_PLUGIN_TOOLS.at(-1)!;
    const wireName = encodeMcpToolNameForWire(tool.function.name);
    const requests: Record<string, any>[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, any>);
      return jsonResponse({
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: wireName, args: { symbol: "AAPL" } } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    });
    const provider = new GeminiProvider({
      credentialPlan: { kind: "api-key", credential: "gemini-test", source: "factory" },
      endpointPlan: GEMINI_ENDPOINT_PLAN, model: "gemini-2.5-pro", tools: [tool], fetchImpl,
    });
    const first = await provider.chat([{ role: "user", content: "Inspect AAPL" }], {
      toolChoice: { type: "function", name: tool.function.name },
    });
    expect(requests[0]?.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual([wireName]);
    expect(first.toolCalls[0]?.name).toBe(tool.function.name);
    await provider.chat([
      { role: "user", content: "Inspect AAPL" },
      { role: "assistant", content: "", toolCalls: first.toolCalls },
      { role: "tool", toolCallId: first.toolCalls[0]!.id, toolName: tool.function.name, content: "ok" },
    ]);
    expect(requests[1]?.contents?.[1]?.parts?.[0]?.functionCall?.name).toBe(wireName);
    expect(requests[1]?.contents?.[2]?.parts?.[0]?.functionResponse?.name).toBe(wireName);
  });

  it("decodes a streamed Gemini plugin call before exposing it to the tool executor", async () => {
    const tool = DESKTOP_PLUGIN_TOOLS.at(-1)!;
    const wireName = encodeMcpToolNameForWire(tool.function.name);
    const frame = JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: wireName, args: { symbol: "AAPL" } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`data: ${frame}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    );
    const provider = new GeminiProvider({
      credentialPlan: { kind: "api-key", credential: "gemini-test", source: "factory" },
      endpointPlan: GEMINI_ENDPOINT_PLAN, model: "gemini-2.5-pro", tools: [tool], fetchImpl,
    });
    const chunks: unknown[] = [];
    const response = await provider.chatStream([{ role: "user", content: "Inspect AAPL" }], (chunk) => chunks.push(chunk));
    expect(response.toolCalls[0]?.name).toBe(tool.function.name);
    expect(chunks).toContainEqual(expect.objectContaining({
      toolInputBlockStart: expect.objectContaining({
        contentBlock: expect.objectContaining({ name: tool.function.name }),
      }),
    }));
  });

  it("keeps Desktop and plugin tools on a Grok 4.7 vision turn", async () => {
    const parityCase: CanonicalPromptCase = {
      id: "grok-4-7-vision-tools",
      messages: [{ role: "user", content: [
        { type: "text", text: "Inspect this image and list my routines" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
      ] }],
      requestMarkers: [], tools: DESKTOP_PLUGIN_TOOLS,
      expected: { content: "ok", finishReason: "stop", toolCalls: [] },
    };
    const entry = MATRIX_PROVIDERS.find((provider) => provider.provider === "grok" && provider.model === "grok-4.7")!;
    const { provider, requests } = entry.createHarness(parityCase);
    await provider.chat([...parityCase.messages]);
    const payload = requests[0]?.payload as Record<string, any>;
    expect(payload.tools).toHaveLength(DESKTOP_PLUGIN_TOOLS.length);
  });

  it("covers every registered provider in the wire capture matrix", () => {
    expect(new Set(MATRIX_PROVIDERS.map((entry) => entry.provider))).toEqual(new Set(KNOWN_PROVIDER_NAMES));
  });

  it.each(MATRIX_PROVIDERS)("advertises tool search to $provider/$model before MCP discovery", async (entry) => {
    const search = buildToolRegistry({ workspaceRoot: "/private/tmp", requireAdmission: false })
      .toLLMTools().find((tool) => tool.function.name === "system.searchTools");
    expect(search).toBeDefined();
    const parityCase: CanonicalPromptCase = {
      id: "desktop-plugin-search-entry",
      messages: [{ role: "user", content: "Find the Desktop routine and plugin tools" }],
      requestMarkers: [], tools: [search!],
      expected: { content: "ok", finishReason: "stop", toolCalls: [] },
    };
    const { provider, requests } = entry.createHarness(parityCase);
    await provider.chat([...parityCase.messages]);
    expect(requests).toHaveLength(1);
    const payload = requests[0]!.payload as Record<string, any>;
    const names: string[] = entry.provider === "gemini"
      ? payload.tools?.[0]?.functionDeclarations?.map((tool: any) => tool.name) ?? []
      : entry.provider === "amazon-bedrock"
        ? payload.toolConfig?.tools?.map((tool: any) => tool.toolSpec.name) ?? []
        : payload.tools?.map((tool: any) => tool.function?.name ?? tool.name) ?? [];
    // Gemini accepts dots in declarations; Ollama keeps local catalog names.
    const expectedName = entry.provider === "gemini" || entry.provider === "ollama"
      ? search!.function.name : encodeMcpToolNameForWire(search!.function.name);
    expect(names).toContain(expectedName);
  });

  it.each(MATRIX_PROVIDERS)("serves Desktop routines and plugin MCP tools to $provider/$model", async (entry) => {
    const parityCase: CanonicalPromptCase = {
      id: "desktop-plugin-matrix",
      messages: [{ role: "user", content: "List my routines and inspect AAPL" }],
      requestMarkers: [],
      tools: DESKTOP_PLUGIN_TOOLS,
      expected: { content: "ok", finishReason: "stop", toolCalls: [] },
    };
    const { provider, requests } = entry.createHarness(parityCase);
    await provider.chat([...parityCase.messages]);
    expect(requests).toHaveLength(1);
    const payload = requests[0]!.payload as Record<string, any>;
    const definitions: Array<{ name: string; schema: Record<string, unknown> }> =
      entry.provider === "gemini"
        ? payload.tools?.[0]?.functionDeclarations?.map((tool: any) => ({ name: tool.name, schema: tool.parametersJsonSchema })) ?? []
        : entry.provider === "amazon-bedrock"
          ? payload.toolConfig?.tools?.map((tool: any) => ({ name: tool.toolSpec.name, schema: tool.toolSpec.inputSchema.json })) ?? []
          : entry.provider === "anthropic"
            ? payload.tools?.map((tool: any) => ({ name: tool.name, schema: tool.input_schema })) ?? []
            : payload.tools?.map((tool: any) => ({ name: tool.function?.name ?? tool.name, schema: tool.function?.parameters ?? tool.parameters })) ?? [];
    expect(definitions).toHaveLength(DESKTOP_PLUGIN_TOOLS.length);
    for (const fixture of DESKTOP_PLUGIN_TOOLS) {
      const wireName = encodeMcpToolNameForWire(fixture.function.name);
      const definition = definitions.find((tool) => tool.name === wireName);
      expect(definition, `${entry.provider}/${entry.model}: ${fixture.function.name}`).toBeDefined();
      expect(definition!.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(definition!.schema?.type).toBe("object");
      expect(Object.keys(definition!.schema.properties as Record<string, unknown>)).toEqual(
        Object.keys(fixture.function.parameters.properties as Record<string, unknown>),
      );
      expect(definition!.schema.required).toEqual(fixture.function.parameters.required);
    }
  });
  it("constructs every provider and preserves canonical identity/capability/model metadata", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "grok",
    });

    for (const entry of PROVIDERS) {
      const provider = withEnv(entry.env, () =>
        createProvider(entry.provider, {
          ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
          model: entry.model,
          ...(entry.extra !== undefined ? { extra: entry.extra } : {}),
        }),
      );
      const caps = resolveProviderCapabilityEntry({
        provider: entry.provider,
        model: entry.model,
      });
      const modelInfo = await manager.getModelInfo(
        entry.provider === "qwen" ||
          entry.provider === "qwen-token-plan" ||
          entry.provider === "zai" ||
          entry.provider === "zai-coding-plan" ||
          entry.provider === "kimi"
          ? `${entry.provider}:${entry.model}`
          : entry.model,
      );

      expect(readProviderIdentity(provider)).toBe(entry.provider);
      expect(provider.name).toBe(entry.provider);
      expect(typeof provider.chat).toBe("function");
      expect(typeof provider.chatStream).toBe("function");
      expect(typeof provider.healthCheck).toBe("function");
      expect(caps.provider).toBe(entry.provider);
      expect(caps.model).toBe(entry.model);
      expect(modelInfo.slug).toBe(entry.model);
    }
  });

  describe.each(PROVIDERS)("$provider", (entry) => {
    it.each(CANONICAL_PROMPTS)(
      "normalizes $id through chat()",
      async (parityCase) => {
        const { provider, requests } = entry.createHarness(parityCase);

        const response = await provider.chat(
          [...parityCase.messages],
          parityCase.options,
        );

        expect(response.content).toBe(parityCase.expected.content);
        expect(response.finishReason).toBe(parityCase.expected.finishReason);
        assertToolCalls(response.toolCalls, parityCase.expected.toolCalls);
        expect(response.model).toBe(entry.model);
        expect(response.usage).toEqual({
          ...BASE_USAGE,
          ...(CHAT_COMPLETIONS_PROVIDERS.has(entry.provider)
            ? { cacheWritesUnreported: true }
            : {}),
        });
        expect(response.requestMetrics?.messageCount).toBeGreaterThan(0);
        expect(response.requestMetrics?.toolCount).toBe(
          parityCase.tools?.length ?? 0,
        );
        expect(requests).toHaveLength(1);

        const serializedRequest = serializePayload(requests[0]?.payload);
        for (const marker of parityCase.requestMarkers) {
          expect(serializedRequest).toContain(marker);
        }
        if ((parityCase.tools?.length ?? 0) > 0) {
          if (PASSTHROUGH_WIRE_PROVIDERS.has(entry.provider)) {
            expect(serializedRequest).toContain("system.echo");
          } else {
            // Strict-regex providers must receive the bijectively encoded
            // name, and the raw dotted form must not leak onto the wire.
            expect(serializedRequest).toContain(ECHO_TOOL_WIRE_NAME);
            expect(serializedRequest).not.toContain("system.echo");
          }
        }
      },
    );
  });
});
