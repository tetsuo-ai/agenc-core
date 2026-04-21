import { describe, expect, it, vi } from "vitest";
import { HybridTransport } from "./ws-post.js";

describe("HybridTransport", () => {
  it("batches stream events before posting", async () => {
    vi.useFakeTimers();
    const calls: unknown[] = [];
    const transport = new HybridTransport(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        createSocket: async () => fakeSocket(),
        fetchImpl: async (_input, init) => {
          calls.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 200 });
        },
      },
    );

    await transport.write({ type: "stream_event", chunk: "a" } as never);
    await transport.write({ type: "stream_event", chunk: "b" } as never);
    await vi.advanceTimersByTimeAsync(100);
    await transport.flush();

    expect(calls).toEqual([
      { events: [{ type: "stream_event", chunk: "a" }, { type: "stream_event", chunk: "b" }] },
    ]);
    transport.close();
    vi.useRealTimers();
  });

  it("flushes buffered stream events before non-stream writes", async () => {
    vi.useFakeTimers();
    const calls: unknown[] = [];
    const transport = new HybridTransport(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        createSocket: async () => fakeSocket(),
        fetchImpl: async (_input, init) => {
          calls.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 200 });
        },
      },
    );

    await transport.write({ type: "stream_event", chunk: "a" } as never);
    await transport.write({ type: "control_response", ok: true } as never);

    expect(calls).toEqual([
      {
        events: [
          { type: "stream_event", chunk: "a" },
          { type: "control_response", ok: true },
        ],
      },
    ]);
    transport.close();
    vi.useRealTimers();
  });
});

function fakeSocket() {
  return {
    send() {},
    close() {},
    on() {},
    off() {},
  };
}

