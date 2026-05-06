import { describe, expect, test, vi } from "vitest";

import {
  createRealtimeWebrtcEventChannel,
  RealtimeWebrtcSessionHandle,
  type StartedRealtimeWebrtcSession,
} from "../../conversation/realtime/webrtc/lib.js";
import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
} from "../../app-server/protocol/index.js";
import { createRealtimeTuiControls } from "./controller.js";

function createClient(): {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }>;
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
  ): Promise<AgenCDaemonResultByMethod[Method]>;
} {
  const requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }> = [];
  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      return {} as AgenCDaemonResultByMethod[typeof method];
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

describe("AgenC realtime TUI controller", () => {
  test("routes websocket start, text, audio, and stop through daemon RPC", async () => {
    const client = createClient();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
    });

    await controls.start({ transport: "websocket", outputModality: "text" });
    await controls.appendText("hello");
    await controls.appendAudio({
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
    });
    await controls.stop();

    expect(client.requests).toEqual([
      {
        method: "thread/realtime/start",
        params: {
          threadId: "agent_1",
          transport: { type: "websocket" },
          realtimeSessionId: null,
          prompt: null,
          outputModality: "text",
          voice: null,
        },
      },
      {
        method: "thread/realtime/appendText",
        params: { threadId: "agent_1", text: "hello" },
      },
      {
        method: "thread/realtime/appendAudio",
        params: {
          threadId: "agent_1",
          audio: { data: "AAAA", sampleRate: 24000, numChannels: 1 },
        },
      },
      {
        method: "thread/realtime/stop",
        params: { threadId: "agent_1" },
      },
    ]);
  });

  test("applies provider SDP and local audio-level events for WebRTC sessions", async () => {
    const client = createClient();
    const channel = createRealtimeWebrtcEventChannel();
    const applyAnswerSdp = vi.fn();
    const close = vi.fn();
    const setMicrophoneMuted = vi.fn();
    const started: StartedRealtimeWebrtcSession = {
      offerSdp: "offer-sdp",
      handle: new RealtimeWebrtcSessionHandle({
        applyAnswerSdp,
        close,
        setMicrophoneMuted,
      }),
      events: channel.receiver,
    };
    const emitted: JsonObject[] = [];
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: (event) => emitted.push(event),
      startWebrtcSession: async () => started,
    });

    controls.setPushToTalk(true);
    await controls.start({ transport: "webrtc" });
    expect(setMicrophoneMuted).toHaveBeenLastCalledWith(true);
    expect(client.requests[0]).toEqual({
      method: "thread/realtime/start",
      params: {
        threadId: "agent_1",
        transport: { type: "webrtc", sdp: "offer-sdp" },
        realtimeSessionId: null,
        prompt: null,
        outputModality: "audio",
        voice: null,
      },
    });

    controls.handleTranscriptEvent({
      type: "realtime_sdp",
      payload: { sdp: "answer-sdp" },
    });
    expect(applyAnswerSdp).toHaveBeenCalledWith("answer-sdp");

    channel.sender.send({ type: "local_audio_level", peak: 12000 });
    await waitFor(
      () =>
        controls.getState().localAudioLevel === 12000 &&
        emitted.some((event) => event.type === "realtime_local_audio_level"),
      "local audio level fanout",
    );

    controls.setPushToTalkHeld(true);
    expect(setMicrophoneMuted).toHaveBeenLastCalledWith(false);

    await controls.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "realtime_error",
      { message: "remote failed" },
      { phase: "inactive", errorBanner: "remote failed" },
    ],
    [
      "realtime_closed",
      { reason: "remote closed" },
      {
        phase: "inactive",
        errorBanner: null,
        closedBanner: "Realtime closed: remote closed",
      },
    ],
  ])(
    "closes the active WebRTC session on remote %s notifications",
    async (type, payload, expectedState) => {
      const client = createClient();
      const channel = createRealtimeWebrtcEventChannel();
      const close = vi.fn();
      const started: StartedRealtimeWebrtcSession = {
        offerSdp: "offer-sdp",
        handle: new RealtimeWebrtcSessionHandle({
          applyAnswerSdp: vi.fn(),
          close,
        }),
        events: channel.receiver,
      };
      const controls = createRealtimeTuiControls({
        threadId: "agent_1",
        client,
        emitEvent: () => {},
        startWebrtcSession: async () => started,
      });

      await controls.start({ transport: "webrtc" });
      controls.handleTranscriptEvent({ type, payload });

      await waitFor(
        () => close.mock.calls.length === 1,
        "remote terminal WebRTC cleanup",
      );
      expect(controls.getState()).toMatchObject(expectedState);
    },
  );
});
