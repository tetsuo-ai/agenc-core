import { describe, expect, test, vi } from "vitest";

import {
  LLMInvalidResponseError,
  LLMStreamTruncatedError,
} from "../../errors.js";
import type {
  LLMChatOptions,
  LLMProvider,
  LLMResponse,
  LLMUsage,
} from "../../types.js";
import { sseResponse } from "../openai-compatible-test-helpers.js";

export const BEDROCK_EVENTSTREAM_CONTENT_TYPE =
  "application/vnd.amazon.eventstream";

export const PARTIAL_TEXT_CHUNK = {
  content: "partial",
  done: false,
} as const;

export const HELLO_SUCCESS_CHUNKS = [
  { content: "Hello", done: false },
  { content: "", done: true },
] as const;

export const STANDARD_STREAM_USAGE = {
  promptTokens: 3,
  completionTokens: 1,
  totalTokens: 4,
} as const;

const USER_TURN = [{ role: "user", content: "hello" }] as const;

export type StreamTerminalAdapter = Pick<LLMProvider, "chatStream">;

export type StreamChunkSnapshot = {
  readonly content: string;
  readonly done: boolean;
};

export type StreamTerminalErrorKind = "truncated" | "invalid";

export type StreamTerminalErrorExpectation = {
  readonly fetchImpl: typeof fetch;
  readonly errorPattern: RegExp;
  readonly expectedChunks?: readonly StreamChunkSnapshot[];
  readonly expectNoDone?: boolean;
  readonly createProvider?: (
    fetchImpl: typeof fetch,
  ) => StreamTerminalAdapter;
};

export type StreamTerminalSuccessExpectation = {
  readonly fetchImpl: typeof fetch;
  readonly content?: string;
  readonly finishReason?: LLMResponse["finishReason"];
  readonly usage?: Pick<
    LLMUsage,
    "promptTokens" | "completionTokens" | "totalTokens"
  >;
  readonly expectedChunks?: readonly StreamChunkSnapshot[];
  readonly createProvider?: (
    fetchImpl: typeof fetch,
  ) => StreamTerminalAdapter;
};

export type StreamTerminalSuite = {
  readonly title: string;
  readonly createProvider: (fetchImpl: typeof fetch) => StreamTerminalAdapter;
  readonly missingTerminalLabel: string;
  readonly missingTerminal: StreamTerminalErrorExpectation;
  readonly midFrame: StreamTerminalErrorExpectation;
  readonly successfulTerminalLabel: string;
  readonly successfulTerminal: StreamTerminalSuccessExpectation;
  readonly malformedJson: StreamTerminalErrorExpectation;
  readonly cancelAfterPartial: {
    readonly fetchImpl: typeof fetch;
    readonly expectedChunks?: readonly StreamChunkSnapshot[];
  };
  readonly extraSuccesses?: readonly (StreamTerminalSuccessExpectation & {
    readonly name: string;
  })[];
  readonly extraErrors?: readonly (StreamTerminalErrorExpectation & {
    readonly name: string;
    readonly kind: StreamTerminalErrorKind;
  })[];
};

export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function resolvedFetch(response: Response): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

export function sseFetch(frames: readonly string[]): typeof fetch {
  return resolvedFetch(sseResponse(frames));
}

export function abortableByteResponse(
  firstChunk: Uint8Array,
  contentType: string,
): typeof fetch {
  return vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk);
        const signal = init?.signal;
        if (signal === undefined) return;
        const abort = () => {
          controller.error(
            signal.reason ??
              new DOMException("The operation was aborted.", "AbortError"),
          );
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": contentType },
      }),
    );
  });
}

export function abortableSseResponse(firstChunk: string): typeof fetch {
  return abortableByteResponse(
    new TextEncoder().encode(firstChunk),
    "text/event-stream",
  );
}

export function eventStreamFrameFromBytes(payload: Uint8Array): Uint8Array {
  const totalLength = 16 + payload.length;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, 0, false);
  view.setUint32(8, 0, false);
  frame.set(payload, 12);
  view.setUint32(totalLength - 4, 0, false);
  return frame;
}

export function eventStreamFrame(payload: Record<string, unknown>): Uint8Array {
  return eventStreamFrameFromBytes(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
}

export function eventStreamBytesResponse(
  bytes: Uint8Array,
  status = 200,
): Response {
  return new Response(bytes, {
    status,
    headers: { "content-type": BEDROCK_EVENTSTREAM_CONTENT_TYPE },
  });
}

export function eventStreamResponse(
  events: readonly Record<string, unknown>[],
  status = 200,
): Response {
  return eventStreamBytesResponse(
    concatBytes(...events.map(eventStreamFrame)),
    status,
  );
}

export function eventStreamFetch(
  events: readonly Record<string, unknown>[],
): typeof fetch {
  return resolvedFetch(eventStreamResponse(events));
}

export function abortableEventStreamResponse(
  events: readonly Record<string, unknown>[],
): typeof fetch {
  return abortableByteResponse(
    concatBytes(...events.map(eventStreamFrame)),
    BEDROCK_EVENTSTREAM_CONTENT_TYPE,
  );
}

export function bedrockTextDelta(text: string): Record<string, unknown> {
  return {
    contentBlockDelta: {
      contentBlockIndex: 0,
      delta: { text },
    },
  };
}

export function eventStreamFetchAfterFrame(
  frame: Uint8Array,
  trailer: Uint8Array,
): typeof fetch {
  return resolvedFetch(
    eventStreamBytesResponse(concatBytes(frame, trailer)),
  );
}

function errorClassFor(kind: StreamTerminalErrorKind) {
  switch (kind) {
    case "truncated":
      return LLMStreamTruncatedError;
    case "invalid":
      return LLMInvalidResponseError;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled stream terminal error kind: ${exhaustive}`);
    }
  }
}

function adapterFor(
  suite: StreamTerminalSuite,
  fetchImpl: typeof fetch,
  override?: (fetchImpl: typeof fetch) => StreamTerminalAdapter,
): StreamTerminalAdapter {
  return (override ?? suite.createProvider)(fetchImpl);
}

async function collectChatStreamOutcome(
  provider: StreamTerminalAdapter,
  options?: LLMChatOptions,
): Promise<{
  readonly response?: LLMResponse;
  readonly error?: unknown;
  readonly chunks: StreamChunkSnapshot[];
}> {
  const chunks: StreamChunkSnapshot[] = [];
  try {
    const response = await provider.chatStream(
      [...USER_TURN],
      (chunk) => {
        chunks.push({ content: chunk.content, done: chunk.done });
      },
      options,
    );
    return { response, chunks };
  } catch (error) {
    return { error, chunks };
  }
}

async function expectRejectedTerminalStream(
  provider: StreamTerminalAdapter,
  expectation: StreamTerminalErrorExpectation,
  kind: StreamTerminalErrorKind,
): Promise<void> {
  const { error, chunks } = await collectChatStreamOutcome(provider);
  expect(error).toBeInstanceOf(errorClassFor(kind));
  expect((error as Error).message).toMatch(expectation.errorPattern);
  if (expectation.expectedChunks !== undefined) {
    expect(chunks).toEqual(expectation.expectedChunks);
  }
  if (expectation.expectNoDone === true) {
    expect(chunks.some((chunk) => chunk.done)).toBe(false);
  }
}

async function expectSuccessfulTerminalStream(
  provider: StreamTerminalAdapter,
  expectation: StreamTerminalSuccessExpectation,
): Promise<void> {
  const { response, error, chunks } = await collectChatStreamOutcome(provider);
  expect(error).toBeUndefined();
  expect(response).toBeDefined();
  if (expectation.content !== undefined) {
    expect(response?.content).toBe(expectation.content);
  }
  if (expectation.finishReason !== undefined) {
    expect(response?.finishReason).toBe(expectation.finishReason);
  }
  if (expectation.usage !== undefined) {
    expect(response?.usage).toMatchObject(expectation.usage);
  }
  if (expectation.expectedChunks !== undefined) {
    expect(chunks).toEqual(expectation.expectedChunks);
  }
}

async function expectCancelledAfterPartial(
  provider: StreamTerminalAdapter,
  expectedChunks: readonly StreamChunkSnapshot[],
): Promise<void> {
  const caller = new AbortController();
  const chunks: StreamChunkSnapshot[] = [];
  const pending = provider.chatStream(
    [...USER_TURN],
    (chunk) => {
      chunks.push({ content: chunk.content, done: chunk.done });
    },
    { signal: caller.signal },
  );
  await vi.waitFor(() => {
    expect(chunks).toEqual(expectedChunks);
  });
  caller.abort();
  await expect(pending).rejects.toThrow();
  expect(chunks.some((chunk) => chunk.done)).toBe(false);
}

export type SseStreamTerminalSuite = {
  readonly title: string;
  readonly createProvider: (fetchImpl: typeof fetch) => StreamTerminalAdapter;
  readonly missingTerminalLabel: string;
  readonly missingTerminalPattern: RegExp;
  readonly missingTerminalFrames: readonly string[];
  readonly midFramePattern: RegExp;
  readonly midFrameFrames: readonly string[];
  readonly successfulTerminalLabel: string;
  readonly successfulTerminalFrames: readonly string[];
  readonly malformedPattern: RegExp;
  readonly malformedFrames: readonly string[];
  readonly cancelFrame: string;
  readonly extraSuccesses?: readonly (StreamTerminalSuccessExpectation & {
    readonly name: string;
  })[];
  readonly extraErrors?: readonly (StreamTerminalErrorExpectation & {
    readonly name: string;
    readonly kind: StreamTerminalErrorKind;
  })[];
};

export function describeSseStreamTerminalEvents(
  suite: SseStreamTerminalSuite,
): void {
  describeStreamTerminalEvents({
    title: suite.title,
    createProvider: suite.createProvider,
    missingTerminalLabel: suite.missingTerminalLabel,
    missingTerminal: {
      fetchImpl: sseFetch(suite.missingTerminalFrames),
      errorPattern: suite.missingTerminalPattern,
    },
    midFrame: {
      fetchImpl: sseFetch(suite.midFrameFrames),
      errorPattern: suite.midFramePattern,
    },
    successfulTerminalLabel: suite.successfulTerminalLabel,
    successfulTerminal: {
      fetchImpl: sseFetch(suite.successfulTerminalFrames),
    },
    malformedJson: {
      fetchImpl: sseFetch(suite.malformedFrames),
      errorPattern: suite.malformedPattern,
    },
    cancelAfterPartial: {
      fetchImpl: abortableSseResponse(suite.cancelFrame),
    },
    extraSuccesses: suite.extraSuccesses,
    extraErrors: suite.extraErrors,
  });
}

export function describeStreamTerminalEvents(suite: StreamTerminalSuite): void {
  describe(`${suite.title} stream terminal events`, () => {
    registerStreamTerminalCases(suite);
  });
}

function registerStreamTerminalCases(suite: StreamTerminalSuite): void {
  test(`a complete delta followed by EOF without ${suite.missingTerminalLabel} is truncated`, async () => {
    await expectRejectedTerminalStream(
      adapterFor(
        suite,
        suite.missingTerminal.fetchImpl,
        suite.missingTerminal.createProvider,
      ),
      {
        ...suite.missingTerminal,
        expectedChunks:
          suite.missingTerminal.expectedChunks ?? [PARTIAL_TEXT_CHUNK],
      },
      "truncated",
    );
  });

  test("EOF mid-frame is truncated and emits no done chunk", async () => {
    await expectRejectedTerminalStream(
      adapterFor(suite, suite.midFrame.fetchImpl, suite.midFrame.createProvider),
      { ...suite.midFrame, expectNoDone: true },
      "truncated",
    );
  });

  test(`${suite.successfulTerminalLabel} plus trailing usage metadata succeeds`, async () => {
    await expectSuccessfulTerminalStream(
      adapterFor(
        suite,
        suite.successfulTerminal.fetchImpl,
        suite.successfulTerminal.createProvider,
      ),
      {
        content: suite.successfulTerminal.content ?? "Hello",
        finishReason: suite.successfulTerminal.finishReason ?? "stop",
        usage: suite.successfulTerminal.usage ?? STANDARD_STREAM_USAGE,
        expectedChunks:
          suite.successfulTerminal.expectedChunks ?? HELLO_SUCCESS_CHUNKS,
        fetchImpl: suite.successfulTerminal.fetchImpl,
      },
    );
  });

  test("malformed JSON frames are invalid rather than discarded", async () => {
    await expectRejectedTerminalStream(
      adapterFor(
        suite,
        suite.malformedJson.fetchImpl,
        suite.malformedJson.createProvider,
      ),
      { ...suite.malformedJson, expectNoDone: true },
      "invalid",
    );
  });

  test("cancellation after a content delta rejects without a done chunk", async () => {
    await expectCancelledAfterPartial(
      suite.createProvider(suite.cancelAfterPartial.fetchImpl),
      suite.cancelAfterPartial.expectedChunks ?? [PARTIAL_TEXT_CHUNK],
    );
  });

  for (const extra of suite.extraSuccesses ?? []) {
    test(extra.name, async () => {
      await expectSuccessfulTerminalStream(
        adapterFor(suite, extra.fetchImpl, extra.createProvider),
        extra,
      );
    });
  }

  for (const extra of suite.extraErrors ?? []) {
    test(extra.name, async () => {
      await expectRejectedTerminalStream(
        adapterFor(suite, extra.fetchImpl, extra.createProvider),
        extra,
        extra.kind,
      );
    });
  }
}
