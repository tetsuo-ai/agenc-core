import { afterEach, describe, expect, it, vi } from "vitest";
import { HybridTransport } from "./ws-post.js";

const AUTH_ENV_KEYS = [
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_ORGANIZATION_UUID",
] as const;

const originalAuthEnv = Object.fromEntries(
  AUTH_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof AUTH_ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    const value = originalAuthEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

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

  it("retries retryable ingress POSTs with the same payload until one succeeds", async () => {
    const calls: unknown[] = [];
    let attempts = 0;
    const transport = new HybridTransport(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        createSocket: async () => fakeSocket(),
        fetchImpl: async (_input, init) => {
          calls.push(JSON.parse(String(init?.body)));
          attempts += 1;
          return new Response(null, { status: attempts === 1 ? 503 : 200 });
        },
      },
    );

    const payload = [{ type: "control_response", ok: true }] as never[];
    const writePromise = transport.writeBatch(payload);

    await writePromise;

    expect(calls).toEqual([
      { events: [{ type: "control_response", ok: true }] },
      { events: [{ type: "control_response", ok: true }] },
    ]);
    transport.close();
  });

  it("resolves writes after dropping a batch that exhausts the retry budget", async () => {
    const calls: unknown[] = [];
    const transport = new HybridTransport(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        createSocket: async () => fakeSocket(),
        maxConsecutiveFailures: 2,
        fetchImpl: async (_input, init) => {
          calls.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 503 });
        },
      },
    );

    const writePromise = transport.writeBatch([
      { type: "control_response", ok: false },
    ] as never[]);

    await writePromise;

    expect(calls).toEqual([
      { events: [{ type: "control_response", ok: false }] },
      { events: [{ type: "control_response", ok: false }] },
    ]);
    expect(transport.droppedBatchCount).toBe(1);
    transport.close();
  });

  it("posts only auth headers from the retained ingress seam", async () => {
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    const transport = new HybridTransport(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      { Authorization: "Bearer token", "X-Trace": "ignore-me" },
      undefined,
      undefined,
      {
        createSocket: async () => fakeSocket(),
        fetchImpl: async (_input, init) => {
          seenHeaders.push(init?.headers as Record<string, string> | undefined);
          return new Response(null, { status: 200 });
        },
      },
    );

    await transport.write({ type: "control_response", ok: true } as never);

    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
      }),
    );
    expect(seenHeaders[0]).not.toHaveProperty("X-Trace");
    expect(
      typeof seenHeaders[0]?.Authorization === "string" ||
        typeof seenHeaders[0]?.Cookie === "string",
    ).toBe(true);
    transport.close();
  });

  it("uses refreshed session-ingress auth state for POST writes when static headers are empty", async () => {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = "jwt-session-token";
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    const transport = new HybridTransport(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      {},
      undefined,
      undefined,
      {
        createSocket: async () => fakeSocket(),
        fetchImpl: async (_input, init) => {
          seenHeaders.push(init?.headers as Record<string, string> | undefined);
          return new Response(null, { status: 200 });
        },
      },
    );

    await transport.write({ type: "control_response", ok: true } as never);

    expect(seenHeaders).toEqual([
      {
        Authorization: "Bearer jwt-session-token",
        "Content-Type": "application/json",
      },
    ]);
    transport.close();
  });

  it("replays buffered UUID messages through HTTP POST after the read socket reconnects", async () => {
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket({ "x-last-request-id": "u-1" });
    const calls: unknown[] = [];
    let created = 0;
    const transport = new HybridTransport(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        baseReconnectDelayMs: 10_000,
        createSocket: async () => {
          created += 1;
          return created === 1 ? firstSocket : secondSocket;
        },
        fetchImpl: async (_input, init) => {
          calls.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 200 });
        },
      },
    );

    await transport.write({ type: "control_response", uuid: "u-1", ok: true } as never);
    await transport.write({ type: "control_response", uuid: "u-2", ok: true } as never);

    await transport.connect();
    firstSocket.emit("open");

    expect(firstSocket.sent).toEqual([]);
    expect(calls).toEqual([
      { events: [{ type: "control_response", uuid: "u-1", ok: true }] },
      { events: [{ type: "control_response", uuid: "u-2", ok: true }] },
      {
        events: [
          { type: "control_response", uuid: "u-1", ok: true },
          { type: "control_response", uuid: "u-2", ok: true },
        ],
      },
    ]);

    firstSocket.emit("close", 1006);
    await transport.connect();
    secondSocket.emit("open");
    await Promise.resolve();

    expect(secondSocket.sent).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual({
      events: [{ type: "control_response", uuid: "u-2", ok: true }],
    });
    transport.close();
  });

  it("builds POST auth headers from the latest refreshed transport headers", async () => {
    let accessToken = "Bearer first";
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    const transport = new HybridTransport(
      new URL("wss://example.test/v2/session_ingress/ws/session-1"),
      { Authorization: "Bearer stale" },
      undefined,
      () => ({ Authorization: accessToken }),
      {
        createSocket: async () => fakeSocket(),
        fetchImpl: async (_input, init) => {
          seenHeaders.push(init?.headers as Record<string, string> | undefined);
          return new Response(null, { status: 200 });
        },
      },
    );

    await transport.write({ type: "control_response", uuid: "u-1", ok: true } as never);
    accessToken = "Bearer second";
    await transport.write({ type: "control_response", uuid: "u-2", ok: true } as never);

    expect(seenHeaders).toEqual([
      {
        Authorization: "Bearer first",
        "Content-Type": "application/json",
      },
      {
        Authorization: "Bearer second",
        "Content-Type": "application/json",
      },
    ]);
    transport.close();
  });
});

function fakeSocket(upgradeHeaders?: Record<string, string>) {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    sent: [] as string[],
    upgradeHeaders,
    send(data: string) {
      this.sent.push(data);
    },
    close() {},
    on(event: string, handler: (...args: any[]) => void) {
      const current = listeners.get(event) ?? [];
      current.push(handler);
      listeners.set(event, current);
    },
    off(event: string, handler: (...args: any[]) => void) {
      const current = listeners.get(event);
      if (!current) {
        return;
      }
      listeners.set(
        event,
        current.filter((candidate) => candidate !== handler),
      );
    },
    emit(event: string, ...args: any[]) {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args);
      }
    },
  };
}
