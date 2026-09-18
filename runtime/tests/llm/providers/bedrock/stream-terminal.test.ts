import {
  abortableEventStreamResponse,
  bedrockTextDelta,
  describeStreamTerminalEvents,
  eventStreamFetch,
  eventStreamFetchAfterFrame,
  eventStreamFrame,
  eventStreamFrameFromBytes,
} from "../shared/stream-terminal.js";
import { BedrockProvider } from "./index.js";

describeStreamTerminalEvents({
  title: "Bedrock",
  createProvider: (fetchImpl) =>
    new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    }),
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
