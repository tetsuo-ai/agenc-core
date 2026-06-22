import { describe, expect, test, vi } from "vitest";

import {
  createDaemonTuiSession,
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
    services: {},
  };
}

function createClient(): AgenCDaemonTuiClient & {
  emitNotification(event: JsonObject): void;
} {
  const notificationListeners = new Set<(event: JsonObject) => void>();

  return {
    async request<Method extends AgenCDaemonMethod>(): Promise<
      AgenCDaemonResultByMethod[Method]
    > {
      return {} as AgenCDaemonResultByMethod[Method];
    },
    subscribeToSessionEvents: () => () => {},
    subscribeToNotifications: (cb) => {
      notificationListeners.add(cb);
      return () => {
        notificationListeners.delete(cb);
      };
    },
    emitNotification(event) {
      for (const listener of notificationListeners) {
        listener(event);
      }
    },
  } as AgenCDaemonTuiClient & {
    emitNotification(event: JsonObject): void;
  };
}

describe("daemon TUI realtime notification coverage", () => {
  test("ignores unrelated notifications and supplies fallback realtime transcript fields", () => {
    const client = createClient();
    const audioPlayer = {
      enqueue: vi.fn(),
      close: vi.fn(),
    };
    const session = createDaemonTuiSession({
      baseSession: createBaseSession(),
      client,
      sessionId: "session_1",
      clientId: "tui_1",
      realtimeThreadId: "agent_1",
      realtimeAudioPlayer: audioPlayer,
    });
    const received: JsonObject[] = [];

    const unsubscribe = session.subscribeToEvents((event) => {
      received.push(event as JsonObject);
    });

    client.emitNotification({ params: { threadId: "agent_1" } });
    client.emitNotification({
      method: "event.message_chunk",
      params: { threadId: "agent_1", delta: "ignored" },
    });
    client.emitNotification({
      method: "thread/realtime/started",
      params: "not-an-object",
    });
    client.emitNotification([] as never);
    client.emitNotification({
      method: "thread/realtime/started",
      params: [] as never,
    });
    client.emitNotification({
      method: "thread/realtime/unhandled",
      params: { threadId: "agent_1" },
    });
    client.emitNotification({
      method: "thread/realtime/started",
      params: { threadId: "agent_1" },
    });
    client.emitNotification({
      method: "thread/realtime/transcript/delta",
      params: { eventId: "delta_default", threadId: "agent_1" },
    });
    client.emitNotification({
      method: "thread/realtime/transcript/done",
      params: { eventId: "done_default", threadId: "agent_1" },
    });
    client.emitNotification({
      method: "thread/realtime/itemAdded",
      params: { eventId: "item_default", threadId: "agent_1" },
    });
    client.emitNotification({
      method: "thread/realtime/sdp",
      params: { eventId: "sdp_default", threadId: "agent_1" },
    });
    client.emitNotification({
      method: "thread/realtime/error",
      params: { eventId: "error_default", threadId: "agent_1" },
    });
    client.emitNotification({
      method: "thread/realtime/closed",
      params: { eventId: "closed_default", threadId: "agent_1" },
    });
    unsubscribe();

    expect(received).toEqual([
      {
        id: expect.stringMatching(/^realtime:thread\/realtime\/started:agent_1:\d+$/u),
        type: "realtime_started",
        payload: {
          threadId: "agent_1",
          realtimeSessionId: null,
        },
      },
      {
        id: "delta_default",
        type: "realtime_transcript_delta",
        payload: {
          threadId: "agent_1",
          role: "assistant",
          delta: "",
        },
      },
      {
        id: "done_default",
        type: "realtime_transcript_done",
        payload: {
          threadId: "agent_1",
          role: "assistant",
          text: "",
        },
      },
      {
        id: "item_default",
        type: "realtime_item_added",
        payload: {
          threadId: "agent_1",
          item: null,
        },
      },
      {
        id: "sdp_default",
        type: "realtime_sdp",
        payload: {
          threadId: "agent_1",
          sdp: "",
        },
      },
      {
        id: "error_default",
        type: "realtime_error",
        payload: {
          threadId: "agent_1",
          message: "Realtime error",
        },
      },
      {
        id: "closed_default",
        type: "realtime_closed",
        payload: {
          threadId: "agent_1",
          reason: null,
        },
      },
    ]);
    expect(audioPlayer.enqueue).not.toHaveBeenCalled();
    expect(audioPlayer.close).toHaveBeenCalledTimes(2);
  });
});
