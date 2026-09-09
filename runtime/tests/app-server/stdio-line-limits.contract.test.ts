import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AgenCStdioTransport } from "../../src/app-server/transport/stdio.js";
import { McpStdioServerTransport } from "../../src/mcp-server/stdio.js";
import { McpServerFramework } from "../../src/mcp-server/framework.js";

const MAX_LINE_BYTES = 64;
const REQUEST = { jsonrpc: "2.0", id: 1, method: "initialize" };

function paddedFrame(bytes: number, request = REQUEST): Buffer {
  const json = JSON.stringify(request);
  return Buffer.from(json + " ".repeat(bytes - Buffer.byteLength(json)), "utf8");
}

function createTransport(kind: "app-server" | "mcp", onError?: () => void) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const received: unknown[] = [];
  const errors: Error[] = [];
  const closed = vi.fn();
  const server = new McpServerFramework();
  const processed = vi.spyOn(server, "handleRawMessageAsync");
  const options = {
    input,
    output,
    maxLineBytes: MAX_LINE_BYTES,
    onError(error: Error) {
      errors.push(error);
      onError?.();
    },
    onClose: closed,
  };
  const transport = kind === "app-server"
    ? new AgenCStdioTransport({
        ...options,
        onMessage(message) { received.push(message); },
      })
    : new McpStdioServerTransport({ ...options, server });
  transport.start();
  return {
    input,
    transport,
    errors,
    closed,
    messages: () => kind === "app-server"
      ? received
      : processed.mock.calls.map(([line]) => JSON.parse(line)),
  };
}

describe.each(["app-server", "mcp"] as const)("%s bounded input lines", (kind) => {
  it.each(["same chunk", "crossing chunk", "later newline", "following frames"])(
    "rejects maxLineBytes + 1 before dispatch with %s",
    async (boundary) => {
      const fixture = createTransport(kind);
      const frame = paddedFrame(MAX_LINE_BYTES + 1);
      try {
        if (boundary === "crossing chunk") {
          fixture.input.write(frame.subarray(0, MAX_LINE_BYTES - 1));
          fixture.input.write(Buffer.concat([frame.subarray(MAX_LINE_BYTES - 1), Buffer.from("\n")]));
        } else if (boundary === "later newline") {
          fixture.input.write(frame);
          if (!fixture.input.destroyed) fixture.input.write("\n");
        } else {
          const suffix = boundary === "following frames" ? `\n${JSON.stringify(REQUEST)}\n` : "\n";
          fixture.input.write(Buffer.concat([frame, Buffer.from(suffix)]));
        }
        await nextTick();
        expect(fixture.messages()).toEqual([]);
        expect(fixture.input.destroyed).toBe(true);
        expect(fixture.errors).toHaveLength(1);
        expect(fixture.errors[0]).toBeInstanceOf(RangeError);
        expect(fixture.closed).toHaveBeenCalledTimes(1);
        expect(fixture.input.listenerCount("data")).toBe(0);
      } finally {
        await fixture.transport.close();
        fixture.input.destroy();
      }
    },
  );

  it.each(["\n", "\r\n", "\r"])("accepts exactly the byte cap before %j", async (delimiter) => {
    const fixture = createTransport(kind);
    try {
      fixture.input.write(Buffer.concat([paddedFrame(MAX_LINE_BYTES), Buffer.from(delimiter)]));
      await nextTick();
      expect(fixture.messages()).toEqual([REQUEST]);
      expect(fixture.errors).toEqual([]);
      expect(fixture.input.destroyed).toBe(false);
    } finally {
      await fixture.transport.close();
      fixture.input.destroy();
    }
  });

  it("accepts many bounded frames in one chunk", async () => {
    const fixture = createTransport(kind);
    try {
      fixture.input.write(`${paddedFrame(MAX_LINE_BYTES).toString()}\n`.repeat(20));
      await fixture.transport.close();
      expect(fixture.messages()).toEqual(Array.from({ length: 20 }, () => REQUEST));
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.transport.close();
      fixture.input.destroy();
    }
  });

  it("preserves split UTF-8 and split CRLF at the exact cap", async () => {
    const fixture = createTransport(kind);
    const request = { ...REQUEST, id: "é🛰" };
    const json = JSON.stringify(request);
    const frame = Buffer.from(json + " ".repeat(MAX_LINE_BYTES - Buffer.byteLength(json)) + "\r\n");
    try {
      for (const byte of frame) fixture.input.write(Buffer.from([byte]));
      await nextTick();
      expect(fixture.messages()).toEqual([request]);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.transport.close();
      fixture.input.destroy();
    }
  });

  it("flushes a bounded final line on EOF and closes once", async () => {
    const fixture = createTransport(kind);
    fixture.input.end(paddedFrame(MAX_LINE_BYTES));
    await nextTick();
    await fixture.transport.close();
    expect(fixture.messages()).toEqual([REQUEST]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
  });

  it("discards a partial line on manual close", async () => {
    const fixture = createTransport(kind);
    fixture.input.write(paddedFrame(MAX_LINE_BYTES));
    await fixture.transport.close();
    fixture.input.end("\n");
    await nextTick();
    expect(fixture.messages()).toEqual([]);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
    fixture.input.destroy();
  });

  it("still destroys input and closes once when overflow reporting throws", async () => {
    const failure = new Error("error callback failed");
    const fixture = createTransport(kind, () => { throw failure; });
    try {
      expect(() => fixture.input.write(paddedFrame(MAX_LINE_BYTES + 1))).toThrow(failure);
      await nextTick();
      expect(fixture.messages()).toEqual([]);
      expect(fixture.input.destroyed).toBe(true);
      expect(fixture.closed).toHaveBeenCalledTimes(1);
      expect(fixture.input.listenerCount("data")).toBe(0);
    } finally {
      await fixture.transport.close();
      fixture.input.destroy();
    }
  });
});
