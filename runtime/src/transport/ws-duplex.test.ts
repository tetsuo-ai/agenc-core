import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketTransport } from "./ws-duplex.js";

const REMOTE_ENV_KEY = "CLAUDE_CODE_REMOTE";
const originalRemoteEnv = process.env[REMOTE_ENV_KEY];

afterEach(() => {
  if (originalRemoteEnv === undefined) {
    delete process.env[REMOTE_ENV_KEY];
  } else {
    process.env[REMOTE_ENV_KEY] = originalRemoteEnv;
  }
});

describe("WebSocketTransport", () => {
  it("buffers UUID messages until the socket opens and replays them", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketTransport(
      new URL("wss://example.test/ws/session-1"),
      {},
      undefined,
      undefined,
      {
        createSocket: async () => socket,
      },
    );

    await transport.write({ type: "control_response", uuid: "u-1", ok: true } as never);
    await transport.connect();

    socket.emit("open");

    expect(socket.sent).toEqual(['{"type":"control_response","uuid":"u-1","ok":true}\n']);
  });

  it("refreshes auth headers on 4003 before reconnecting", async () => {
    vi.useFakeTimers();
    let auth = "Bearer old";
    const socket = new FakeSocket();
    const createSocket = vi.fn(async ({ headers }: { headers: Record<string, string> }) => {
      socket.headers.push(headers.Authorization ?? "");
      return socket;
    });
    const transport = new WebSocketTransport(
      new URL("wss://example.test/ws/session-1"),
      { Authorization: auth },
      undefined,
      () => ({ Authorization: (auth = "Bearer new") }),
      {
        createSocket,
        random: () => 0.5,
      },
    );

    await transport.connect();
    socket.emit("close", 4003);
    await vi.advanceTimersByTimeAsync(1000);

    expect(socket.headers).toEqual(["Bearer old", "Bearer new"]);
    transport.close();
    vi.useRealTimers();
  });

  it("stops reconnecting after the configured give-up budget", async () => {
    vi.useFakeTimers();
    let now = 0;
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    let created = 0;
    const createSocket = vi.fn(async () => {
      created += 1;
      if (created === 1) {
        return firstSocket;
      }
      return secondSocket;
    });
    const onClose = vi.fn();
    const transport = new WebSocketTransport(
      new URL("wss://example.test/ws/session-1"),
      { Authorization: "Bearer token" },
      undefined,
      undefined,
      {
        createSocket,
        random: () => 0.5,
        now: () => now,
        reconnectGiveUpMs: 1_000,
      },
    );

    transport.setOnClose(onClose);

    await transport.connect();
    firstSocket.emit("close", 1006);
    await vi.advanceTimersByTimeAsync(1_000);

    now = 1_001;
    secondSocket.emit("close", 1006);

    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledWith(1006);
    transport.close();
    vi.useRealTimers();
  });

  it("replays only messages after the server-acknowledged request id", async () => {
    const socket = new FakeSocket();
    socket.upgradeHeaders = { "x-last-request-id": "u-1" };
    const transport = new WebSocketTransport(
      new URL("wss://example.test/ws/session-1"),
      {},
      undefined,
      undefined,
      {
        createSocket: async () => socket,
      },
    );

    await transport.write({ type: "control_response", uuid: "u-1", ok: true } as never);
    await transport.write({ type: "control_response", uuid: "u-2", ok: true } as never);
    await transport.connect();

    socket.emit("open");

    expect(socket.sent).toEqual(['{"type":"control_response","uuid":"u-2","ok":true}\n']);
  });

  it("evicts acknowledged buffered messages across reconnects", async () => {
    const firstSocket = new FakeSocket();
    firstSocket.upgradeHeaders = { "x-last-request-id": "u-1" };
    const secondSocket = new FakeSocket();
    secondSocket.upgradeHeaders = { "x-last-request-id": "u-2" };
    let created = 0;
    const transport = new WebSocketTransport(
      new URL("wss://example.test/ws/session-1"),
      {},
      undefined,
      undefined,
      {
        baseReconnectDelayMs: 10_000,
        createSocket: async () => {
          created += 1;
          return created === 1 ? firstSocket : secondSocket;
        },
      },
    );

    await transport.write({ type: "control_response", uuid: "u-1", ok: true } as never);
    await transport.write({ type: "control_response", uuid: "u-2", ok: true } as never);
    await transport.connect();
    firstSocket.emit("open");
    firstSocket.emit("close", 1006);
    await transport.connect();
    secondSocket.emit("open");

    expect(firstSocket.sent).toEqual(['{"type":"control_response","uuid":"u-2","ok":true}\n']);
    expect(secondSocket.sent).toEqual([]);
    transport.close();
  });

  it("disables periodic keepalive frames for remote sessions", async () => {
    vi.useFakeTimers();
    process.env.CLAUDE_CODE_REMOTE = "1";
    const socket = new FakeSocket();
    const transport = new WebSocketTransport(
      new URL("wss://example.test/ws/session-1"),
      {},
      undefined,
      undefined,
      {
        createSocket: async () => socket,
        keepAliveIntervalMs: 25,
      },
    );

    await transport.connect();
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(100);

    expect(socket.sent).toEqual([]);
    transport.close();
    vi.useRealTimers();
  });
});

class FakeSocket {
  readonly sent: string[] = [];
  readonly headers: string[] = [];
  upgradeHeaders?: Record<string, string>;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  ping(): void {}

  on(event: string, handler: (...args: any[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(handler);
    this.listeners.set(event, existing);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      existing.filter((candidate) => candidate !== handler),
    );
  }

  emit(event: string, ...args: any[]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(...args);
    }
  }
}
