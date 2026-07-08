import { describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../config/schema.js";
import { resolveProviderCapabilityEntry } from "./capabilities.js";
import { StaticModelsManager } from "./models-manager.js";
import {
  createProvider,
  readProviderIdentity,
  type ProviderFactoryOptions,
  type ProviderName,
} from "./provider.js";
import { AnthropicProvider } from "./providers/anthropic/adapter.js";
import { BedrockProvider } from "./providers/bedrock/index.js";
import { DeepSeekProvider } from "./providers/deepseek/index.js";
import { GeminiProvider } from "./providers/gemini/index.js";
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
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMTool,
  LLMToolCall,
} from "./types.js";

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

/**
 * Wire form of `system.echo` under the bijective MCP tool-name encoding
 * (src/llm/wire/mcp-tool-naming.ts). The strict-regex providers reject
 * dotted function names, so the shared wire shims (chat-completions,
 * responses-openai/xai, messages-anthropic) encode the internal dotted
 * name on the request and decode the provider's echoed name back before
 * dispatch. The literal is hardcoded on purpose: this suite pins the wire
 * contract instead of round-tripping through the encoder.
 *
 * Gemini, Bedrock, and Ollama use their own converters that pass tool
 * names through unencoded, so their wire form stays `system.echo`.
 */
const ECHO_TOOL_WIRE_NAME = "tool2__system_x2eecho";
const PASSTHROUGH_WIRE_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  "ollama",
  "gemini",
  "amazon-bedrock",
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
} as const;

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
        name: toolCall.name,
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
    model: "deepseek-reasoner",
    apiKey: "deepseek-test",
    env: { DEEPSEEK_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new DeepSeekProvider({
            apiKey: "deepseek-test",
            model: "deepseek-reasoner",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("deepseek-reasoner", parityCase),
      }),
  },
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    apiKey: "gemini-test",
    env: { GEMINI_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new GeminiProvider({
            apiKey: "gemini-test",
            model: "gemini-2.5-pro",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildGeminiPayload("gemini-2.5-pro", parityCase),
      }),
  },
  {
    provider: "mistral",
    model: "devstral-latest",
    apiKey: "mistral-test",
    env: { MISTRAL_API_KEY: undefined },
    createHarness: (parityCase) =>
      createFetchHarness({
        factory: (fetchImpl) =>
          new MistralProvider({
            apiKey: "mistral-test",
            model: "devstral-latest",
            tools: parityCase.tools ? [...parityCase.tools] : [],
            fetchImpl,
          }),
        payload: buildChatCompletionsPayload("devstral-latest", parityCase),
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
    apiKey: "bedrock-test",
    extra: {
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

describe("provider parity", () => {
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
      const modelInfo = await manager.getModelInfo(entry.model);

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
        expect(response.usage).toEqual(BASE_USAGE);
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
