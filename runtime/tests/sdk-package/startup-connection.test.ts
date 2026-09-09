import { EventEmitter, getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgencSocketTransport, connect } from "../../../packages/agenc-sdk/src/socket.js";

const mocks = vi.hoisted(() => ({ socket: vi.fn(), cookie: vi.fn() }));
vi.mock("node:net", async (original) => ({ ...await original<object>(), createConnection: mocks.socket }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<object>(), readFile: mocks.cookie }));

class FakeSocket extends EventEmitter {
  destroyed = false;
  onWrite: (text: string) => void = () => {};

  setEncoding(): this { return this; }
  write(text: string): boolean { this.onWrite(text); return true; }
  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

describe("SDK connection phases share the startup deadline", () => {
  let home: string;
  let sockets: FakeSocket[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-sdk-connect-deadline-"));
    sockets = [];
    mocks.cookie.mockReset().mockResolvedValue("cookie");
    mocks.socket.mockReset().mockImplementation(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
  });

  afterEach(() => {
    for (const socket of sockets) socket.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  test("bounds a cookie read that never settles", async () => {
    mocks.cookie.mockImplementation(() => new Promise(() => {}));
    await expect(connect({ env: { AGENC_HOME: home }, readyTimeoutMs: 10 })).rejects.toThrow(/within 10ms/);
    expect(mocks.socket).not.toHaveBeenCalled();
  });

  test("destroys an initial socket probe that never connects", async () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    mocks.socket.mockReturnValue(socket);
    const spawn = vi.fn();
    await expect(connect({ env: { AGENC_HOME: home }, readyTimeoutMs: 10, spawn })).rejects.toThrow(/within 10ms/);
    expect(socket.destroyed).toBe(true);
    expect(socket.eventNames()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    socket.emit("connect");
    expect(socket.eventNames()).toEqual([]);
  });

  test("destroys a final connection that never connects", async () => {
    const initial = new FakeSocket();
    const final = new FakeSocket();
    sockets.push(initial, final);
    mocks.socket.mockImplementationOnce(() => {
      queueMicrotask(() => initial.emit("connect"));
      return initial;
    }).mockReturnValue(final);
    await expect(connect({ env: { AGENC_HOME: home }, readyTimeoutMs: 10 })).rejects.toThrow(/within 10ms/);
    expect(initial.destroyed).toBe(true);
    expect(final.destroyed).toBe(true);
    expect(final.eventNames()).toEqual([]);
    final.emit("connect");
    expect(final.eventNames()).toEqual([]);
  });

  test("bounds initialize and closes its transport instead of waiting for the control timeout", async () => {
    await expect(connect({ env: { AGENC_HOME: home }, readyTimeoutMs: 10, requestTimeoutMs: 5000 }))
      .rejects.toThrow(/within 10ms/);
    expect(sockets).toHaveLength(2);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  test("cancellation during initialize preserves the reason and closes both sockets", async () => {
    const controller = new AbortController();
    const reason = { cancel: "initialize" };
    mocks.socket.mockImplementation(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      socket.onWrite = () => controller.abort(reason);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    await expect(connect({ env: { AGENC_HOME: home }, signal: controller.signal })).rejects.toBe(reason);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("rejects a successful handshake that arrives after monotonic expiry", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mocks.cookie.mockImplementation(async () => { now = 40; return "cookie"; });
    mocks.socket.mockImplementation(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => { now += 20; socket.emit("connect"); });
      socket.onWrite = (text) => {
        now = 101;
        socket.emit("data", JSON.stringify({
          jsonrpc: "2.0", id: JSON.parse(text).id,
          result: { type: "initialized", protocolVersion: "1.10.0", protocol: { version: "1.10.0" }, capabilities: {} },
        }) + "\n");
      };
      return socket;
    });
    await expect(connect({ env: { AGENC_HOME: home }, readyTimeoutMs: 100 })).rejects.toThrow(/within 100ms/);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  test("successful connection keeps its separate RPC budget and ignores later startup cancellation", async () => {
    const controller = new AbortController();
    mocks.socket.mockImplementation(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      socket.onWrite = (text) => {
        const request = JSON.parse(text);
        if (request.method !== "initialize") return;
        socket.emit("data", JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: { type: "initialized", protocolVersion: "1.10.0", protocol: { version: "1.10.0" }, capabilities: {} },
        }) + "\n");
      };
      return socket;
    });
    const client = await connect({ env: { AGENC_HOME: home }, readyTimeoutMs: 50, requestTimeoutMs: 500, signal: controller.signal });
    try {
      controller.abort(new Error("after connection"));
      expect(sockets[1]?.destroyed).toBe(false);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      vi.useFakeTimers();
      const request = client.request("health.ping", {});
      const rejected = expect(request).rejects.toThrow(/Timed out waiting.*health.ping/);
      await vi.advanceTimersByTimeAsync(50);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(450);
      await rejected;
    } finally {
      await client.close();
    }
  });

  test("transport cancellation preserves the reason and ignores a late connect", async () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    mocks.socket.mockReturnValue(socket);
    const controller = new AbortController();
    const reason = new Error("cancel socket");
    const operation = AgencSocketTransport.connect({ socketPath: "unused", signal: controller.signal });
    controller.abort(reason);
    socket.emit("connect");
    await expect(operation).rejects.toBe(reason);
    expect(socket.destroyed).toBe(true);
    expect(socket.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("an already aborted transport never opens a socket", async () => {
    const reason = new Error("cancelled first");
    await expect(AgencSocketTransport.connect({ socketPath: "unused", signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(mocks.socket).not.toHaveBeenCalled();
  });
});
