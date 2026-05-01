import { describe, expect, it } from "vitest";
import {
  AGENC_DAEMON_RECONNECTING_MESSAGE,
  attachDaemonTuiSession,
  createDaemonTuiSession,
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "./daemon-session.js";
import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "../app-server/protocol/index.js";

function createBaseSession(): AgenCTuiBridgeSession {
  return {
    conversationId: "local_session",
    services: {
      permissionModeRegistry: {
        current: () =>
          ({
            mode: "default",
            plan: null,
            network: null,
          }) as never,
      },
    },
  };
}

function createClient(): AgenCDaemonTuiClient & {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }>;
  connectionState: AgenCDaemonConnectionState | null;
  emitConnection(state: AgenCDaemonConnectionState): void;
  emit(sessionId: string, event: JsonObject): void;
} {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  const connectionListeners = new Set<
    (state: AgenCDaemonConnectionState) => void
  >();
  const requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }> = [];
  return {
    requests,
    connectionState: null,
    async request<Method extends AgenCDaemonMethod>(
      method: Method,
      params?: JsonObject,
    ): Promise<AgenCDaemonResultByMethod[Method]> {
      requests.push({ method, params });
      return {} as AgenCDaemonResultByMethod[Method];
    },
    subscribeToSessionEvents: (sessionId, cb) => {
      let sessionListeners = listeners.get(sessionId);
      if (sessionListeners === undefined) {
        sessionListeners = new Set();
        listeners.set(sessionId, sessionListeners);
      }
      sessionListeners.add(cb);
      return () => {
        sessionListeners?.delete(cb);
      };
    },
    getConnectionState() {
      return this.connectionState;
    },
    subscribeToConnectionState: (cb) => {
      connectionListeners.add(cb);
      return () => {
        connectionListeners.delete(cb);
      };
    },
    emitConnection(state) {
      this.connectionState = state;
      for (const listener of connectionListeners) {
        listener(state);
      }
    },
    emit: (sessionId, event) => {
      for (const listener of listeners.get(sessionId) ?? []) {
        listener(event);
      }
    },
  };
}

describe("AgenC TUI daemon session adapter", () => {
  it("attaches the TUI client before returning a daemon-backed session", async () => {
    const client = createClient();

    await expect(
      attachDaemonTuiSession({
        baseSession: createBaseSession(),
        client,
        sessionId: "session_1",
        clientId: "tui_1",
      }),
    ).resolves.toMatchObject({
      conversationId: "session_1",
    });
    expect(client.requests).toEqual([
      {
        method: "session.attach",
        params: { sessionId: "session_1", clientId: "tui_1" },
      },
    ]);
  });

  it("sends TUI user input through message.stream", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    await session.submit?.("run tests");
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      method: "message.stream",
      params: {
        sessionId: "session_1",
        content: "run tests",
      },
    });
  });

  it("subscribes the TUI to daemon session events", () => {
    const client = createClient();
    const received: JsonObject[] = [];
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents?.((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_start", id: "turn_1" },
    });
    unsubscribe?.();
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_complete", id: "turn_1" },
    });

    expect(received).toEqual([{ type: "turn_start", id: "turn_1" }]);
  });

  it("shows a reconnecting notice without dropping the daemon event stream", () => {
    const client = createClient();
    const received: JsonObject[] = [];
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_start", id: "turn_1" },
    });
    client.emitConnection({ status: "reconnecting" });
    client.emit("session_1", {
      type: "daemon.event",
      msg: { type: "turn_complete", id: "turn_1" },
    });
    unsubscribe();

    expect(received).toEqual([
      { type: "turn_start", id: "turn_1" },
      {
        id: "agenc-daemon-reconnecting",
        type: "warning",
        payload: {
          message: AGENC_DAEMON_RECONNECTING_MESSAGE,
          status: "reconnecting",
        },
      },
      { type: "turn_complete", id: "turn_1" },
    ]);
  });

  it("preserves initial transcript state while surfacing an existing disconnect", () => {
    const client = createClient();
    client.connectionState = { status: "disconnected" };
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        initialTranscriptEvents: [
          { type: "user_message", payload: { message: "status" } },
        ],
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    expect(session.getInitialTranscriptEvents()).toEqual([
      { type: "user_message", payload: { message: "status" } },
      {
        id: "agenc-daemon-disconnected",
        type: "warning",
        payload: {
          message: AGENC_DAEMON_RECONNECTING_MESSAGE,
          status: "disconnected",
        },
      },
    ]);
  });
});
