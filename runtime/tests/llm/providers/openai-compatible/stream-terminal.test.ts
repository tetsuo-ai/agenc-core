import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../../registry/provider-info.js";
import { ECHO_TOOL } from "../openai-compatible-test-helpers.js";
import {
  describeSseStreamTerminalEvents,
  HELLO_SUCCESS_CHUNKS,
  sseFetch,
} from "../shared/stream-terminal.js";
import { OpenAICompatibleProvider } from "./index.js";

function openaiCompatible(fetchImpl: typeof fetch) {
  return new OpenAICompatibleProvider({
    model: BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
    fetchImpl,
  });
}

const PARTIAL =
  'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n';
const HELLO =
  'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n';
const DONE = "data: [DONE]\n\n";

describeSseStreamTerminalEvents(
  "OpenAI-compatible",
  openaiCompatible,
  "finish_reason or [DONE]",
  /finish_reason or \[DONE\]/i,
  [PARTIAL],
  /unterminated event/i,
  [
    'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[{"index":0,"finish_reason":"st',
  ],
  "a choice finish_reason",
  [
    HELLO,
    'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
  ],
  /Malformed JSON/i,
  [PARTIAL, "data: {not-json}\n\n", DONE],
  PARTIAL,
  [
    {
      name: "[DONE] without finish_reason is a valid text terminal",
      fetchImpl: sseFetch([HELLO, DONE]),
      content: "Hello",
      finishReason: "stop",
      expectedChunks: HELLO_SUCCESS_CHUNKS,
    },
  ],
  [
    {
      name: "open streamed tool calls at [DONE] fail with a typed provider error",
      createProvider: (fetchImpl) =>
        new OpenAICompatibleProvider({
          model: BUILT_IN_PROVIDER_DEFAULT_MODELS["openai-compatible"],
          fetchImpl,
          tools: [ECHO_TOOL],
        }),
      fetchImpl: sseFetch([
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"system.echo","arguments":"{\\"text\\":\\"hi\\"}"}}]}}]}\n\n',
        DONE,
      ]),
      kind: "invalid",
      errorPattern: /tool calls.*finish_reason=tool_calls/i,
      expectNoDone: true,
    },
  ],
);
