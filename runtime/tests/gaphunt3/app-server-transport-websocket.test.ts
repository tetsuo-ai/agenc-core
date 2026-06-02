import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";

import {
  armWebSocketAcceptAuthTimeout,
  AGENC_WEBSOCKET_DEFAULT_ACCEPT_AUTH_TIMEOUT_MS,
  type WebSocketAcceptAuthState,
} from "src/app-server/transport/websocket";

// gaphunt3 #47: the WebSocket daemon transport had no accept-time auth/idle
// teardown (unlike the Unix socket, which destroys a peer that never sends a
// valid `initialize` within AGENC_DAEMON_SOCKET_ACCEPT_AUTH_TIMEOUT_MS). An
// accepted ws peer that never authenticates could pin a #connections slot (and
// its dispatcher connection object) indefinitely. The fix arms a teardown
// timer on accept that terminates the socket and removes the #connections entry
// once the auth window lapses. These tests pin the teardown reaper's behavior;
// each fails if the fix is reverted.

function makeSocket(readyState: number): {
  readyState: number;
  terminate: ReturnType<typeof vi.fn>;
} {
  return { readyState, terminate: vi.fn() };
}

function makeState(readyState: number): WebSocketAcceptAuthState & {
  socket: ReturnType<typeof makeSocket>;
} {
  const socket = makeSocket(readyState);
  return {
    socket,
    closingUnauthenticated: false,
    authTimeout: undefined,
  };
}

describe("gaphunt3 #47 websocket accept-auth teardown timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes a non-zero default accept-auth timeout", () => {
    // A default of 0 / undefined would mean no teardown window at all.
    expect(AGENC_WEBSOCKET_DEFAULT_ACCEPT_AUTH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("does NOT reap or terminate before the timeout elapses", () => {
    const state = makeState(WebSocket.OPEN);
    const onReap = vi.fn();
    state.authTimeout = armWebSocketAcceptAuthTimeout(state, 5000, onReap);

    vi.advanceTimersByTime(4999);

    expect(onReap).not.toHaveBeenCalled();
    expect(state.socket.terminate).not.toHaveBeenCalled();
    expect(state.closingUnauthenticated).toBe(false);
  });

  it("terminates the socket and reaps the connection when the window lapses", () => {
    const state = makeState(WebSocket.OPEN);
    const onReap = vi.fn();
    state.authTimeout = armWebSocketAcceptAuthTimeout(state, 5000, onReap);

    vi.advanceTimersByTime(5000);

    // The unauthenticated peer must be torn down, not left holding a slot.
    expect(onReap).toHaveBeenCalledTimes(1);
    expect(state.socket.terminate).toHaveBeenCalledTimes(1);
    expect(state.closingUnauthenticated).toBe(true);
    // The handle is self-cleared so it cannot be double-cleared / leak.
    expect(state.authTimeout).toBeUndefined();
  });

  it("still reaps but does not terminate an already-closed socket", () => {
    const state = makeState(WebSocket.CLOSED);
    const onReap = vi.fn();
    state.authTimeout = armWebSocketAcceptAuthTimeout(state, 5000, onReap);

    vi.advanceTimersByTime(5000);

    expect(onReap).toHaveBeenCalledTimes(1);
    // terminate() must not be invoked on a dead socket.
    expect(state.socket.terminate).not.toHaveBeenCalled();
    expect(state.closingUnauthenticated).toBe(true);
  });

  it("clearing the armed handle (authenticated in time) prevents teardown", () => {
    const state = makeState(WebSocket.OPEN);
    const onReap = vi.fn();
    state.authTimeout = armWebSocketAcceptAuthTimeout(state, 5000, onReap);

    // Simulate a successful authenticator clearing the timer before it fires.
    clearTimeout(state.authTimeout);
    state.authTimeout = undefined;

    vi.advanceTimersByTime(10_000);

    expect(onReap).not.toHaveBeenCalled();
    expect(state.socket.terminate).not.toHaveBeenCalled();
    expect(state.closingUnauthenticated).toBe(false);
  });
});
