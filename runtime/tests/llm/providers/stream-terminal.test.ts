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

const GEMINI_EXTRAS = [
  {
    name: "a recognized prompt-level blockReason is a successful terminal",
    fetchImpl: sseFetch(['data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n']),
    finishReason: "content_filter" as const,
    expectedChunks: [{ content: "", done: true }],
  },
];
const OPENAI_EXTRAS = [
  {
    name: "[DONE] without finish_reason is a valid text terminal",
    fetchImpl: sseFetch([OPENAI_HELLO, OPENAI_DONE]),
    content: "Hello",
    finishReason: "stop" as const,
    expectedChunks: HELLO_SUCCESS_CHUNKS,
  },
];
const OPENAI_TOOL_ERRORS = [
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

describeSseStreamTerminalEvents(
  "Gemini",
  geminiProvider,
  "finishReason",
  /finishReason/i,
  [GEMINI_PARTIAL],
  /unterminated event/i,
  GEMINI_MID,
  "a candidate finishReason",
  GEMINI_SUCCESS,
  /Malformed JSON in Gemini SSE/i,
  GEMINI_MALFORMED,
  GEMINI_PARTIAL,
  GEMINI_EXTRAS,
);
describeSseStreamTerminalEvents(
  "OpenAI-compatible",
  openaiCompatible,
  "finish_reason or [DONE]",
  /finish_reason or \[DONE\]/i,
  [OPENAI_PARTIAL],
  /unterminated event/i,
  OPENAI_MID,
  "a choice finish_reason",
  OPENAI_SUCCESS,
  /Malformed JSON/i,
  OPENAI_MALFORMED,
  OPENAI_PARTIAL,
  OPENAI_EXTRAS,
  OPENAI_TOOL_ERRORS,
);

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
