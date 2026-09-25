import { describe, expect, test, vi } from "vitest";

import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../registry/provider-info.js";
import { ECHO_TOOL } from "./openai-compatible-test-helpers.js";
import { BedrockProvider } from "./bedrock/index.js";
import { createGeminiEndpointPlan } from "./gemini/endpoint-plan.js";
import { GeminiProvider } from "./gemini/index.js";
import { OpenAICompatibleProvider } from "./openai-compatible/index.js";
import {
  abortableEventStreamResponse,
  bedrockTextDelta,
  describeSseStreamTerminalEvents,
  describeStreamTerminalEvents,
  eventStreamFetch,
  eventStreamFetchAfterFrame,
  eventStreamFrame,
  eventStreamFrameFromBytes,
  HELLO_SUCCESS_CHUNKS,
  PARTIAL_TEXT_CHUNK,
  sseFetch,
  type StreamTerminalAdapter,
} from "./shared/stream-terminal.js";

const GEMINI_PARTIAL =
  'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n';
const OPENAI_PARTIAL =
  'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n';
const OPENAI_HELLO =
  'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n';
const OPENAI_DONE = "data: [DONE]\n\n";

function geminiProvider(fetchImpl: typeof fetch): StreamTerminalAdapter {
  return new GeminiProvider({
    credentialPlan: {
      kind: "api-key",
      credential: "gemini-test",
      source: "factory",
    },
    endpointPlan: createGeminiEndpointPlan(),
    model: "gemini-2.5-pro",
    fetchImpl,
  });
}

function openaiCompatible(fetchImpl: typeof fetch): StreamTerminalAdapter {
  return new OpenAICompatibleProvider({
    model: BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
    fetchImpl,
  });
}

function bedrockProvider(fetchImpl: typeof fetch): StreamTerminalAdapter {
  return new BedrockProvider({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
    model: "amazon.nova-pro-v1:0",
    fetchImpl,
  });
}

const GEMINI_MID = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}]}\n\n',
  'data: {"usageMetadata":{"promptTokenCount":1',
] as const;
const GEMINI_SUCCESS = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n',
  'data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n',
] as const;
const GEMINI_MALFORMED = [
  GEMINI_PARTIAL,
  "data: {not-json}\n\n",
  'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
] as const;
const OPENAI_MID = [
  'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
  'data: {"choices":[{"index":0,"finish_reason":"st',
] as const;
const OPENAI_SUCCESS = [
  OPENAI_HELLO,
  'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
] as const;
const OPENAI_MALFORMED = [OPENAI_PARTIAL, "data: {not-json}\n\n", OPENAI_DONE] as const;

const GEMINI_FINISHED =
  'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n' +
  'data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n';
const GEMINI_EXTRAS = [
  {
    name: "a recognized prompt-level blockReason is a successful terminal",
    fetchImpl: sseFetch(['data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n']),
    finishReason: "content_filter" as const,
    expectedChunks: [{ content: "", done: true }],
  },
  {
    name: "a finished reply followed by unterminated [DONE] still completes",
    fetchImpl: sseFetch([`${GEMINI_FINISHED}data: [DONE]`]),
    content: "Hello",
    finishReason: "stop" as const,
    usage: {
      promptTokens: 3,
      completionTokens: 1,
      totalTokens: 4,
    },
    expectedChunks: HELLO_SUCCESS_CHUNKS,
  },
  {
    name: "a finished reply followed by an unterminated keep-alive still completes",
    fetchImpl: sseFetch([`${GEMINI_FINISHED}: keep-alive`]),
    content: "Hello",
    finishReason: "stop" as const,
    usage: {
      promptTokens: 3,
      completionTokens: 1,
      totalTokens: 4,
    },
    expectedChunks: HELLO_SUCCESS_CHUNKS,
  },
  {
    name: "a final finishReason frame without a trailing blank line still completes",
    fetchImpl: sseFetch([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}',
    ]),
    content: "Hello",
    finishReason: "stop" as const,
    usage: {
      promptTokens: 3,
      completionTokens: 1,
      totalTokens: 4,
    },
    expectedChunks: HELLO_SUCCESS_CHUNKS,
  },
];
const GEMINI_EOF_ERRORS = [
  {
    name: "an unterminated [DONE] after a partial reply is still truncated",
    fetchImpl: sseFetch([`${GEMINI_PARTIAL}data: [DONE]`]),
    kind: "truncated" as const,
    errorPattern: /closed before a candidate finishReason/i,
    expectedChunks: [PARTIAL_TEXT_CHUNK],
    expectNoDone: true,
  },
];
const OPENAI_FINISHED =
  'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n';
const OPENAI_EXTRAS = [
  {
    name: "[DONE] without finish_reason is a valid text terminal",
    fetchImpl: sseFetch([OPENAI_HELLO, OPENAI_DONE]),
    content: "Hello",
    finishReason: "stop" as const,
    expectedChunks: HELLO_SUCCESS_CHUNKS,
  },
  {
    name: "[DONE] without a trailing blank line still completes the turn",
    fetchImpl: sseFetch([`${OPENAI_FINISHED}data: [DONE]`]),
    content: "Hello",
    finishReason: "stop" as const,
    usage: {
      promptTokens: 3,
      completionTokens: 1,
      totalTokens: 4,
    },
    expectedChunks: HELLO_SUCCESS_CHUNKS,
  },
  {
    name: "a keep-alive line without a trailing blank line still completes the turn",
    fetchImpl: sseFetch([`${OPENAI_FINISHED}: keep-alive`]),
    content: "Hello",
    finishReason: "stop" as const,
    usage: {
      promptTokens: 3,
      completionTokens: 1,
      totalTokens: 4,
    },
    expectedChunks: HELLO_SUCCESS_CHUNKS,
  },
];
const OPENAI_TOOL_ERRORS = [
  {
    name: "a truncated tool_calls fragment is an unterminated event",
    fetchImpl: sseFetch([
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0',
    ]),
    kind: "invalid" as const,
    errorPattern: /unterminated event/i,
    expectNoDone: true,
  },
  {
    name: "open streamed tool calls at [DONE] fail with a typed provider error",
    createProvider: (fetchImpl: typeof fetch) =>
      new OpenAICompatibleProvider({
        model: BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
        fetchImpl,
        tools: [ECHO_TOOL],
      }),
    fetchImpl: sseFetch([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"system.echo","arguments":"{\\"text\\":\\"hi\\"}"}}]}}]}\n\n',
      OPENAI_DONE,
    ]),
    kind: "invalid" as const,
    errorPattern: /tool calls.*finish_reason=tool_calls/i,
    expectNoDone: true,
  },
];

describeSseStreamTerminalEvents({
  title: "Gemini",
  createProvider: geminiProvider,
  missingTerminalLabel: "finishReason",
  missingTerminalPattern: /finishReason/i,
  missingTerminalFrames: [GEMINI_PARTIAL],
  midFramePattern: /unterminated event/i,
  midFrameFrames: GEMINI_MID,
  successfulTerminalLabel: "a candidate finishReason",
  successfulTerminalFrames: GEMINI_SUCCESS,
  malformedPattern: /Malformed JSON in Gemini SSE/i,
  malformedFrames: GEMINI_MALFORMED,
  cancelFrame: GEMINI_PARTIAL,
  extraSuccesses: GEMINI_EXTRAS,
  extraErrors: GEMINI_EOF_ERRORS,
});
describeSseStreamTerminalEvents({
  title: "OpenAI-compatible",
  createProvider: openaiCompatible,
  missingTerminalLabel: "finish_reason or [DONE]",
  missingTerminalPattern: /finish_reason or \[DONE\]/i,
  missingTerminalFrames: [OPENAI_PARTIAL],
  midFramePattern: /closed before a finish_reason or \[DONE\]/i,
  midFrameFrames: OPENAI_MID,
  successfulTerminalLabel: "a choice finish_reason",
  successfulTerminalFrames: OPENAI_SUCCESS,
  malformedPattern: /Malformed JSON/i,
  malformedFrames: OPENAI_MALFORMED,
  cancelFrame: OPENAI_PARTIAL,
  extraSuccesses: OPENAI_EXTRAS,
  extraErrors: OPENAI_TOOL_ERRORS,
});

describe("Gemini [DONE] while the proxy holds the socket", () => {
  test("returns after [DONE] instead of waiting for EOF", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n' +
            'data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n' +
            "data: [DONE]\n\n",
          ));
        },
      }), { headers: { "content-type": "text/event-stream" } })),
    );
    const provider = geminiProvider(fetchImpl);
    const chunks: { content: string; done: boolean }[] = [];
    const pending = provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => {
        chunks.push({ content: chunk.content, done: chunk.done });
      },
    );
    const response = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("stream stalled after [DONE]")), 500);
      }),
    ]);
    expect(response.content).toBe("Hello");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toMatchObject({
      promptTokens: 3,
      completionTokens: 1,
      totalTokens: 4,
    });
    expect(chunks).toEqual(HELLO_SUCCESS_CHUNKS);
  });
});

describeStreamTerminalEvents({
  title: "Bedrock",
  createProvider: bedrockProvider,
  missingTerminalLabel: "messageStop",
  missingTerminal: {
    fetchImpl: eventStreamFetch([bedrockTextDelta("partial")]),
    errorPattern: /messageStop/i,
  },
  midFrame: {
    fetchImpl: eventStreamFetchAfterFrame(
      eventStreamFrame(bedrockTextDelta("Hi")),
      new Uint8Array([0, 0, 0, 80, 0, 0]),
    ),
    errorPattern: /partial event frame/i,
  },
  successfulTerminalLabel: "messageStop",
  successfulTerminal: {
    fetchImpl: eventStreamFetch([
      bedrockTextDelta("Hello"),
      { messageStop: { stopReason: "end_turn" } },
      {
        metadata: {
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        },
      },
    ]),
  },
  malformedJson: {
    fetchImpl: eventStreamFetchAfterFrame(
      eventStreamFrame(bedrockTextDelta("Hi")),
      eventStreamFrameFromBytes(new TextEncoder().encode("{not-json")),
    ),
    errorPattern: /Malformed JSON/i,
  },
  cancelAfterPartial: {
    fetchImpl: abortableEventStreamResponse([bedrockTextDelta("partial")]),
  },
  extraErrors: [
    {
      name: "an open tool block at messageStop is a typed provider error",
      fetchImpl: eventStreamFetch([
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "toolu-1", name: "lookup" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"query":"status"}' } },
          },
        },
        { messageStop: { stopReason: "tool_use" } },
      ]),
      kind: "invalid",
      errorPattern: /open content or tool block/i,
      expectNoDone: true,
    },
  ],
});
