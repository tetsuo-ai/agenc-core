import {
  abortableSseResponse,
  describeStreamTerminalEvents,
  sseFetch,
} from "../shared/stream-terminal.js";
import { createGeminiEndpointPlan } from "./endpoint-plan.js";
import { GeminiProvider } from "./index.js";

const PARTIAL =
  'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n';

describeStreamTerminalEvents({
  title: "Gemini",
  createProvider: (fetchImpl) =>
    new GeminiProvider({
      credentialPlan: {
        kind: "api-key",
        credential: "gemini-test",
        source: "factory",
      },
      endpointPlan: createGeminiEndpointPlan(),
      model: "gemini-2.5-pro",
      fetchImpl,
    }),
  missingTerminalLabel: "finishReason",
  missingTerminal: {
    fetchImpl: sseFetch([PARTIAL]),
    errorPattern: /finishReason/i,
  },
  midFrame: {
    fetchImpl: sseFetch([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}]}\n\n',
      'data: {"usageMetadata":{"promptTokenCount":1',
    ]),
    errorPattern: /unterminated event/i,
  },
  successfulTerminalLabel: "a candidate finishReason",
  successfulTerminal: {
    fetchImpl: sseFetch([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}\n\n',
      'data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}\n\n',
    ]),
  },
  malformedJson: {
    fetchImpl: sseFetch([
      PARTIAL,
      "data: {not-json}\n\n",
      'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
    ]),
    errorPattern: /Malformed JSON in Gemini SSE/i,
  },
  cancelAfterPartial: {
    fetchImpl: abortableSseResponse(PARTIAL),
  },
  extraSuccesses: [
    {
      name: "a recognized prompt-level blockReason is a successful terminal",
      fetchImpl: sseFetch([
        'data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n',
      ]),
      finishReason: "content_filter",
      expectedChunks: [{ content: "", done: true }],
    },
  ],
});
