import { describe, expect, it } from "vitest";

import {
  createDaemonTuiSession,
  type AgenCDaemonConnectionState,
  type AgenCDaemonTuiClient,
  type AgenCTuiBridgeSession,
} from "../../src/tui/daemon-session.js";
import type {
  AgenCDaemonInternalMethod,
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  SessionPartialCompactFromMessageResult,
  SessionRewindConversationToMessageResult,
} from "../../src/app-server/protocol/index.js";
import { JSON_RPC_VERSION } from "../../src/app-server/protocol/index.js";
import { APPROVED, DENIED } from "../../src/permissions/review-decision.js";

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

interface FakeClient extends AgenCDaemonTuiClient {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod | AgenCDaemonInternalMethod;
    readonly params?: JsonObject;
  }>;
  failMethods: Set<string>;
  connectionState: AgenCDaemonConnectionState | null;
  emit(sessionId: string, event: JsonObject): void;
}

function createClient(): FakeClient {
  const listeners = new Map<string, Set<(event: JsonObject) => void>>();
  const requests: FakeClient["requests"] = [];
  const failMethods = new Set<string>();
  return {
    requests,
    failMethods,
    connectionState: null,
    async request(
      method: AgenCDaemonMethod | AgenCDaemonInternalMethod,
      params?: JsonObject,
    ): Promise<
      | AgenCDaemonResultByMethod[AgenCDaemonMethod]
      | SessionPartialCompactFromMessageResult
      | SessionRewindConversationToMessageResult
    > {
      requests.push({ method, ...(params !== undefined ? { params } : {}) });
      if (failMethods.has(method)) {
        throw new Error("daemon disconnected");
      }
      return {} as AgenCDaemonResultByMethod[AgenCDaemonMethod];
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
    emit: (sessionId, event) => {
      for (const listener of listeners.get(sessionId) ?? []) {
        listener(event);
      }
    },
  };
}

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe("daemon approval/elicitation delivery never silently drops decisions", () => {
  it("surfaces a warning notice when tool.approve delivery fails", async () => {
    const client = createClient();
    client.failMethods.add("tool.approve");
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: { request: async () => APPROVED },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const received: JsonObject[] = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: { callId: "call_1", toolName: "Bash" },
      },
    });
    await flush();
    unsubscribe();

    expect(client.requests).toEqual([
      {
        method: "tool.approve",
        params: { sessionId: "session_1", requestId: "call_1", scope: "once" },
      },
    ]);
    const notice = received.find(
      (event) => event.type === "warning",
    );
    expect(notice).toMatchObject({
      id: "agenc-daemon-delivery-failed-call_1",
      type: "warning",
      payload: {
        cause: "daemon_delivery_failed",
        action: "tool.approve",
        requestId: "call_1",
      },
    });
  });

  it("surfaces a warning notice when tool.deny delivery fails", async () => {
    const client = createClient();
    client.failMethods.add("tool.deny");
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: { request: async () => DENIED },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const received: JsonObject[] = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: { callId: "call_2", toolName: "Bash" },
      },
    });
    await flush();
    unsubscribe();

    expect(received.find((event) => event.type === "warning")).toMatchObject({
      id: "agenc-daemon-delivery-failed-call_2",
      payload: { action: "tool.deny", requestId: "call_2" },
    });
  });

  it("surfaces a warning notice when elicitation.respond delivery fails", async () => {
    const client = createClient();
    client.failMethods.add("elicitation.respond");
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          requestUserInputResolver: {
            request: async () => ({ answers: { choice: { answers: ["Yes"] } } }),
          },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const received: JsonObject[] = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.user_input_request",
      params: {
        sessionId: "session_1",
        eventId: "input_1",
        requestId: "call_3",
        callId: "call_3",
        turnId: "turn_1",
        questions: [],
      },
    });
    await flush();
    unsubscribe();

    expect(received.find((event) => event.type === "warning")).toMatchObject({
      id: "agenc-daemon-delivery-failed-call_3",
      payload: { action: "elicitation.respond", requestId: "call_3" },
    });
  });

  it("does not emit a warning when delivery succeeds", async () => {
    const client = createClient();
    const session = createDaemonTuiSession({
      baseSession: {
        ...createBaseSession(),
        services: {
          ...createBaseSession().services,
          approvalResolver: { request: async () => APPROVED },
        },
      },
      client,
      sessionId: "session_1",
      clientId: "tui_1",
    });

    const received: JsonObject[] = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });
    client.emit("session_1", {
      type: "daemon.event",
      msg: {
        type: "request_permissions",
        payload: { callId: "call_4", toolName: "Bash" },
      },
    });
    await flush();
    unsubscribe();

    expect(received.some((event) => event.type === "warning")).toBe(false);
    expect(client.requests).toEqual([
      {
        method: "tool.approve",
        params: { sessionId: "session_1", requestId: "call_4", scope: "once" },
      },
    ]);
  });
});
