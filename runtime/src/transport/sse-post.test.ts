import { describe, expect, it, vi } from "vitest";
import { parseSSEFrames, SSETransport } from "./sse-post.js";

describe("parseSSEFrames", () => {
  it("parses multi-line data and leaves incomplete frames buffered", () => {
    const parsed = parseSSEFrames(
      "id: 7\nevent: client_event\ndata: {\"a\":1}\ndata: {\"b\":2}\n\nid: 8\nevent: client_event\n",
    );

    expect(parsed.frames).toEqual([
      {
        id: "7",
        event: "client_event",
        data: '{"a":1}\n{"b":2}',
      },
    ]);
    expect(parsed.remaining).toBe("id: 8\nevent: client_event\n");
  });
});

describe("SSETransport", () => {
  it("sends Last-Event-ID and unwraps client_event payloads", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const frame = [
      "id: 9",
      "event: client_event",
      'data: {"event_id":"e-1","sequence_num":9,"event_type":"stream","source":"server","payload":{"type":"stream_event","chunk":"hi"},"created_at":"2026-04-21T00:00:00Z"}',
      "",
      "",
    ].join("\n");
    const transport = new SSETransport(
      new URL("https://example.test/session/1/events/stream"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        initialSequenceNum: 5,
        fetchImpl: async (input, init) => {
          requests.push({
            url: String(input),
            headers: init?.headers as Record<string, string> | undefined,
          });
          return new Response(streamFrom(frame), { status: 200 });
        },
      },
    );

    const data: string[] = [];
    transport.setOnData((chunk) => {
      data.push(chunk);
    });

    await transport.connect();

    expect(String(requests[0]?.headers?.["Last-Event-ID"])).toBe("5");
    expect(transport.getLastSequenceNum()).toBe(9);
    expect(data).toEqual(['{"type":"stream_event","chunk":"hi"}\n']);
  });

  it("treats HTTP 403 as a terminal close for the retained SSE seam", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
    const onClose = vi.fn();
    const transport = new SSETransport(
      new URL("https://example.test/session/1/events/stream"),
      { Authorization: "Bearer old" },
      undefined,
      () => ({ Authorization: "Bearer new" }),
      {
        fetchImpl,
      },
    );
    transport.setOnClose(onClose);

    await transport.connect();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(403);
    expect(transport.isClosedStatus()).toBe(true);
    vi.useRealTimers();
  });

  it("drops duplicate sequence frames during SSE replay", async () => {
    const frame = [
      "id: 9",
      "event: client_event",
      'data: {"event_id":"e-1","sequence_num":9,"event_type":"stream","source":"server","payload":{"type":"stream_event","chunk":"first"},"created_at":"2026-04-21T00:00:00Z"}',
      "",
      "id: 9",
      "event: client_event",
      'data: {"event_id":"e-1-dup","sequence_num":9,"event_type":"stream","source":"server","payload":{"type":"stream_event","chunk":"duplicate"},"created_at":"2026-04-21T00:00:01Z"}',
      "",
      "",
    ].join("\n");
    const data: string[] = [];
    const transport = new SSETransport(
      new URL("https://example.test/session/1/events/stream"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        fetchImpl: async () => new Response(streamFrom(frame), { status: 200 }),
      },
    );

    transport.setOnData((chunk) => {
      data.push(chunk);
    });

    await transport.connect();

    expect(transport.getLastSequenceNum()).toBe(9);
    expect(data).toEqual(['{"type":"stream_event","chunk":"first"}\n']);
  });

  it("resets the reconnect budget after a long sleep gap before retrying", async () => {
    vi.useFakeTimers();
    let now = 0;
    const fetchImpl = vi.fn(async () => {
      throw new Error("network");
    });
    const transport = new SSETransport(
      new URL("https://example.test/session/1/events/stream"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        fetchImpl,
        now: () => now,
        random: () => 0.5,
        sleepDetectionThresholdMs: 60_000,
      },
    );

    await transport.connect();
    expect(transport.getStateLabel()).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    now = 120_000;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    transport.close();
    vi.useRealTimers();
  });
});

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
