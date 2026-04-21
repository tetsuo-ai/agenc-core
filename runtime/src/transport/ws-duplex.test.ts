import { describe, expect, it, vi } from "vitest";
import { WebSocketTransport } from "./ws-duplex.js";

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
});

class FakeSocket {
  readonly sent: string[] = [];
  readonly headers: string[] = [];
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

