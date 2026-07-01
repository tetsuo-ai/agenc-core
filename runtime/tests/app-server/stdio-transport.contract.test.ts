import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import {
  AGENC_STDIO_DEFAULT_MAX_LINE_BYTES,
  AgenCStdioTransport,
  encodeJsonLine,
  parseJsonObjectLine,
  writeJsonLine,
} from "./transport/stdio.js";

function nextChunk(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    stream.once("data", (chunk: Buffer) => {
      resolve(chunk.toString("utf8"));
    });
  });
}

describe("AgenC stdio transport", () => {
  it("encodes one compact JSON message per newline", () => {
    const line = encodeJsonLine({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: { text: "hello\nworld" },
    });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: { text: "hello\nworld" },
    });
  });

  it("parses JSON object lines and rejects malformed frames", () => {
    expect(
      parseJsonObjectLine(
        '{"jsonrpc":"2.0","id":1,"method":"agent.list","params":{}}',
      ),
    ).toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: "agent.list",
      params: {},
    });

    expect(() => parseJsonObjectLine("")).toThrow(/empty JSON line/);
    expect(() => parseJsonObjectLine("[]")).toThrow(/expected a JSON object/);
    expect(() => parseJsonObjectLine("{")).toThrow(SyntaxError);
  });

  it("reads newline-delimited requests from input and writes responses to output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received = new Promise((resolve) => {
      const transport = new AgenCStdioTransport({
        input,
        output,
        onMessage: resolve,
      });
      transport.start();
    });

    input.write(
      '{"jsonrpc":"2.0","id":7,"method":"message.send","params":{"sessionId":"session_1","content":"hello"}}\n',
    );

    await expect(received).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 7,
      method: "message.send",
      params: { sessionId: "session_1", content: "hello" },
    });

    await writeJsonLine(output, {
      jsonrpc: JSON_RPC_VERSION,
      id: 7,
      result: { messageId: "message_1", acceptedAt: "now" },
    });

    await expect(nextChunk(output)).resolves.toBe(
      '{"jsonrpc":"2.0","id":7,"result":{"messageId":"message_1","acceptedAt":"now"}}\n',
    );
  });

  it("reports bad input lines without stopping subsequent valid messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: readonly Error[] = [];
    const received = new Promise((resolve) => {
      const transport = new AgenCStdioTransport({
        input,
        output,
        onMessage: resolve,
        onError: (error) => {
          (errors as Error[]).push(error);
        },
      });
      transport.start();
    });

    input.write("not-json\n");
    input.write('{"jsonrpc":"2.0","id":2,"method":"auth.whoami"}\n');

    await expect(received).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      method: "auth.whoami",
    });
    expect(errors).toHaveLength(1);
  });

  it("dispatches two pipelined same-connection requests in arrival order", async () => {
    // Regression for audit #13: dispatch used to be fire-and-forget
    // (`Promise.resolve(onMessage(...))` not awaited), so a slow first
    // handler let the second request's handler complete first, corrupting
    // order-dependent flows (e.g. session.clear then message.send).
    const input = new PassThrough();
    const output = new PassThrough();
    const completionOrder: number[] = [];
    let resolveFirst: (() => void) | undefined;
    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: async (message) => {
        const id = message.id as number;
        if (id === 1) {
          // First handler is slow; it must still complete before the
          // second handler is even invoked, because dispatch is serialized.
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        completionOrder.push(id);
      },
    });
    transport.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"session.clear"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"message.send"}\n');

    // Give the event loop time: without serialization the second handler
    // would have already run and pushed `2` before `1`.
    await delay(20);
    expect(completionOrder).toEqual([]);

    resolveFirst?.();
    await delay(20);
    expect(completionOrder).toEqual([1, 2]);

    await transport.close();
  });

  it("dispatches request.cancel ahead of an in-flight long request", async () => {
    // Regression for the transport-FIFO cancellation starvation: a
    // request.cancel chained behind a long-running request could never run
    // until that request completed, defeating cancellation. Control messages
    // must dispatch off-chain so cancel runs while the target is still in
    // flight, while normal requests stay FIFO (guarded by the test above).
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    let releaseLong: (() => void) | undefined;
    let resolveStarted: () => void = () => {};
    const longStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: async (message) => {
        if (message.method === "session.partialCompactFromMessage") {
          events.push("long:start");
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseLong = resolve;
          });
          events.push("long:end");
        } else if (message.method === "request.cancel") {
          events.push("cancel");
        }
      },
    });
    transport.start();

    input.write(
      '{"jsonrpc":"2.0","id":1,"method":"session.partialCompactFromMessage"}\n',
    );
    await longStarted;
    input.write('{"jsonrpc":"2.0","id":2,"method":"request.cancel"}\n');

    await delay(20);
    // Cancel must have run while the long request is still blocked.
    expect(events).toEqual(["long:start", "cancel"]);

    releaseLong?.();
    await delay(20);
    expect(events).toEqual(["long:start", "cancel", "long:end"]);

    await transport.close();
  });

  it("dispatches session.cancelTurn ahead of an in-flight stream request", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    let releaseLong: (() => void) | undefined;
    let resolveStarted: () => void = () => {};
    const longStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: async (message) => {
        if (message.method === "message.stream") {
          events.push("stream:start");
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseLong = resolve;
          });
          events.push("stream:end");
        } else if (message.method === "session.cancelTurn") {
          events.push("turn:cancel");
        }
      },
    });
    transport.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"message.stream"}\n');
    await longStarted;
    input.write(
      '{"jsonrpc":"2.0","id":2,"method":"session.cancelTurn","params":{"sessionId":"session_1","reason":"interrupted"}}\n',
    );

    await delay(20);
    expect(events).toEqual(["stream:start", "turn:cancel"]);

    releaseLong?.();
    await delay(20);
    expect(events).toEqual(["stream:start", "turn:cancel", "stream:end"]);

    await transport.close();
  });

  it("rejects normal requests beyond the per-connection queue cap", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let releaseFirst: (() => void) | undefined;
    let resolveStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const transport = new AgenCStdioTransport({
      input,
      output,
      maxQueuedRequests: 1,
      onMessage: async (message) => {
        if (message.id === 1) {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    });
    transport.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"session.clear"}\n');
    await firstStarted;
    input.write('{"jsonrpc":"2.0","id":2,"method":"message.send"}\n');

    const rejected = JSON.parse(await nextChunk(output));
    expect(rejected).toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      error: {
        code: -32000,
        data: {
          code: "TOO_MANY_QUEUED_REQUESTS",
          maxQueuedRequests: 1,
        },
      },
    });

    releaseFirst?.();
    await transport.close();
  });

  it("tears down the connection when an unterminated line exceeds the cap", async () => {
    // Regression for audit #14: readline imposes no max line length, so a
    // peer streaming bytes without a newline grew daemon memory unbounded.
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const destroyed = new Promise<void>((resolve) => {
      input.once("close", () => resolve());
    });
    const transport = new AgenCStdioTransport({
      input,
      output,
      maxLineBytes: 64,
      onMessage: () => {},
      onError: (error) => {
        errors.push(error);
      },
    });
    transport.start();

    // 200 bytes with no newline must trip the 64-byte bound.
    input.write("x".repeat(200));

    await destroyed;
    expect(input.destroyed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
    expect(errors[0]?.message).toMatch(/64 bytes without a newline/);
  });

  it("does not trip the cap when newlines keep lines bounded", async () => {
    // Prior valid behavior: a long stream of newline-terminated frames whose
    // individual lines stay under the cap must keep flowing.
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const received: number[] = [];
    const transport = new AgenCStdioTransport({
      input,
      output,
      maxLineBytes: 64,
      onMessage: (message) => {
        received.push(message.id as number);
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    transport.start();

    for (let id = 1; id <= 10; id += 1) {
      input.write(`{"jsonrpc":"2.0","id":${id},"method":"ping"}\n`);
    }

    await delay(20);
    expect(errors).toHaveLength(0);
    expect(input.destroyed).toBe(false);
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    await transport.close();
  });

  it("exposes a default max line bound matching the websocket payload cap", () => {
    expect(AGENC_STDIO_DEFAULT_MAX_LINE_BYTES).toBe(16 * 1024 * 1024);
  });

  it("can send through the transport instance", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new AgenCStdioTransport({
      input,
      output,
      onMessage: () => {},
    });

    await transport.send({
      jsonrpc: JSON_RPC_VERSION,
      id: 3,
      result: { authenticated: false },
    });

    await expect(nextChunk(output)).resolves.toBe(
      '{"jsonrpc":"2.0","id":3,"result":{"authenticated":false}}\n',
    );
  });
});
