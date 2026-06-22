import { beforeEach, describe, expect, test, vi } from "vitest";

const logMock = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("../../utils/log.js", () => ({
  logError: logMock.logError,
}));

import {
  createRealtimeWebrtcEventChannel,
  RealtimeWebrtcSessionHandle,
  type StartedRealtimeWebrtcSession,
} from "../../conversation/realtime/webrtc/lib.js";
import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  ThreadRealtimeAudioChunk,
} from "../../app-server/protocol/index.js";
import type {
  RealtimeAudioCaptureCallbacks,
  RealtimeAudioPlayer,
  StartRealtimeAudioCapture,
} from "./audio.js";
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

function createNoopAudioCapture(): StartRealtimeAudioCapture {
  return async () => ({
    stop: vi.fn(),
  });
}

function createAudioPlayer(): RealtimeAudioPlayer & {
  readonly enqueued: ThreadRealtimeAudioChunk[];
} {
  const enqueued: ThreadRealtimeAudioChunk[] = [];
  return {
    enqueued,
    enqueue: vi.fn((audio) => {
      enqueued.push(audio);
    }),
    close: vi.fn(),
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
  beforeEach(() => {
    logMock.logError.mockReset();
  });

  test("routes websocket start, text, audio, and stop through daemon RPC", async () => {
    const client = createClient();
    const audioPlayer = createAudioPlayer();
    const emitted: JsonObject[] = [];
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: (event) => emitted.push(event),
      startAudioCapture: createNoopAudioCapture(),
      audioPlayer,
    });

    await controls.start({ transport: "websocket", outputModality: "text" });
    await controls.appendText("hello");
    await controls.appendAudio({
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
    });
    await controls.stop();
    expect(audioPlayer.close).toHaveBeenCalledTimes(1);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      closedBanner: "Realtime closed: requested",
    });
    expect(emitted.some((event) => event.type === "realtime_closed")).toBe(
      false,
    );

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

    controls.handleTranscriptEvent({
      type: "realtime_started",
      payload: { realtimeSessionId: "rt_1" },
    });
    expect(controls.getState()).toMatchObject({
      phase: "starting",
      realtimeSessionId: "rt_1",
    });

    channel.sender.send({ type: "connected" });
    await waitFor(
      () => controls.getState().phase === "active",
      "WebRTC connected state",
    );

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
      "setMuted",
      (controls: ReturnType<typeof createRealtimeTuiControls>) => {
        controls.setMuted(true);
      },
      { muted: false, pushToTalk: false, pushToTalkHeld: false },
    ],
    [
      "setPushToTalk",
      (controls: ReturnType<typeof createRealtimeTuiControls>) => {
        controls.setPushToTalk(true);
      },
      { muted: false, pushToTalk: false, pushToTalkHeld: false },
    ],
    [
      "setPushToTalkHeld",
      (controls: ReturnType<typeof createRealtimeTuiControls>) => {
        controls.setPushToTalkHeld(true);
      },
      { muted: false, pushToTalk: true, pushToTalkHeld: false },
    ],
  ] as const)(
    "surfaces WebRTC microphone state failures from %s",
    async (_label, act, expectedState) => {
      const client = createClient();
      const channel = createRealtimeWebrtcEventChannel();
      const close = vi.fn();
      const audioPlayer = createAudioPlayer();
      const emitted: JsonObject[] = [];
      let failNextMicrophoneUpdate = false;
      const setMicrophoneMuted = vi.fn(async () => {
        if (failNextMicrophoneUpdate) {
          throw new Error("microphone state failed");
        }
      });
      const controls = createRealtimeTuiControls({
        threadId: "agent_1",
        client,
        emitEvent: (event) => emitted.push(event),
        startWebrtcSession: async () => ({
          offerSdp: "offer-sdp",
          handle: new RealtimeWebrtcSessionHandle({
            applyAnswerSdp: vi.fn(),
            close,
            setMicrophoneMuted,
          }),
          events: channel.receiver,
        }),
        audioPlayer,
      });

      await controls.start({ transport: "webrtc" });
      channel.sender.send({ type: "connected" });
      await waitFor(
        () => controls.getState().phase === "active",
        "active WebRTC session before microphone failure",
      );
      if (_label === "setPushToTalkHeld") {
        controls.setPushToTalk(true);
        await waitFor(
          () =>
            setMicrophoneMuted.mock.calls.some(([muted]) => muted === true),
          "push-to-talk setup mute call",
        );
      }
      client.requests.length = 0;
      failNextMicrophoneUpdate = true;

      act(controls);

      await waitFor(
        () =>
          controls.getState().errorBanner === "microphone state failed" &&
          close.mock.calls.length === 1 &&
          client.requests.some(
            (request) => request.method === "thread/realtime/stop",
          ),
        "microphone failure cleanup",
      );
      expect(audioPlayer.close).toHaveBeenCalledTimes(1);
      expect(controls.getState()).toMatchObject({
        phase: "inactive",
        ...expectedState,
      });
      expect(emitted.at(-1)).toMatchObject({
        type: "realtime_error",
        payload: {
          threadId: "agent_1",
          message: "microphone state failed",
        },
      });
    },
  );

  test("serializes overlapping start and stop lifecycle operations", async () => {
    const client = createClient();
    let releaseCapture: (() => void) | null = null;
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
      startAudioCapture: async () => {
        await new Promise<void>((resolve) => {
          releaseCapture = resolve;
        });
        return { stop: vi.fn() };
      },
    });

    const start = controls.start({ transport: "websocket" });
    const stop = controls.stop();
    await waitFor(
      () =>
        client.requests.some(
          (request) => request.method === "thread/realtime/start",
        ),
      "daemon start before queued stop",
    );
    releaseCapture?.();
    await Promise.all([start, stop]);

    expect(client.requests.map((request) => request.method)).toEqual([
      "thread/realtime/start",
      "thread/realtime/stop",
    ]);
    expect(controls.getState().phase).toBe("inactive");
  });

  test("closes WebRTC and surfaces an error when provider SDP is rejected", async () => {
    const client = createClient();
    const channel = createRealtimeWebrtcEventChannel();
    const emitted: JsonObject[] = [];
    const close = vi.fn();
    const started: StartedRealtimeWebrtcSession = {
      offerSdp: "offer-sdp",
      handle: new RealtimeWebrtcSessionHandle({
        applyAnswerSdp: vi.fn(async () => {
          throw new Error("bad sdp");
        }),
        close,
      }),
      events: channel.receiver,
    };
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: (event) => emitted.push(event),
      startWebrtcSession: async () => started,
    });

    await controls.start({ transport: "webrtc" });
    controls.handleTranscriptEvent({
      type: "realtime_sdp",
      payload: { sdp: "bad-answer" },
    });

    await waitFor(
      () =>
        close.mock.calls.length === 1 &&
        controls.getState().errorBanner === "bad sdp" &&
        client.requests.some(
          (request) => request.method === "thread/realtime/stop",
        ),
      "SDP rejection cleanup",
    );
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: { threadId: "agent_1", message: "bad sdp" },
    });
  });

  test("gates audio chunk appends with mute and push-to-talk state", async () => {
    const client = createClient();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
      startAudioCapture: createNoopAudioCapture(),
    });
    const audio = {
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
    };

    await controls.start({ transport: "websocket" });
    client.requests.length = 0;

    controls.setMuted(true);
    await controls.appendAudio(audio);
    expect(client.requests).toHaveLength(0);

    controls.setMuted(false);
    await controls.appendAudio(audio);
    expect(client.requests).toHaveLength(1);

    controls.setPushToTalk(true);
    await controls.appendAudio(audio);
    expect(client.requests).toHaveLength(1);

    controls.setPushToTalkHeld(true);
    await controls.appendAudio(audio);
    expect(client.requests).toHaveLength(2);
    expect(client.requests.at(-1)).toEqual({
      method: "thread/realtime/appendAudio",
      params: { threadId: "agent_1", audio },
    });
  });

  test("does not send text or audio appends while realtime is inactive", async () => {
    const client = createClient();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
      startAudioCapture: createNoopAudioCapture(),
    });
    const audio = {
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
    };

    await controls.appendText("before start");
    await controls.appendAudio(audio);
    expect(client.requests).toHaveLength(0);

    await controls.start({ transport: "websocket" });
    await controls.stop();
    client.requests.length = 0;

    await controls.appendText("after stop");
    await controls.appendAudio(audio);
    expect(client.requests).toHaveLength(0);
  });

  test("starts websocket audio capture and routes captured frames to appendAudio", async () => {
    const client = createClient();
    let callbacks: RealtimeAudioCaptureCallbacks | null = null;
    const stop = vi.fn();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
      startAudioCapture: async (nextCallbacks) => {
        callbacks = nextCallbacks;
        return { stop };
      },
    });
    const audio = {
      data: "BBBB",
      sampleRate: 16000,
      numChannels: 1,
      samplesPerChannel: 2,
    };

    await controls.start({ transport: "websocket" });
    callbacks?.onLevel(32000);
    callbacks?.onAudio(audio);
    await waitFor(
      () =>
        client.requests.some(
          (request) => request.method === "thread/realtime/appendAudio",
        ),
      "captured audio append",
    );

    expect(controls.getState().localAudioLevel).toBe(32000);
    expect(client.requests.at(-1)).toEqual({
      method: "thread/realtime/appendAudio",
      params: { threadId: "agent_1", audio },
    });

    controls.setMuted(true);
    callbacks?.onAudio({ ...audio, data: "CCCC" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.requests.at(-1)).toEqual({
      method: "thread/realtime/appendAudio",
      params: { threadId: "agent_1", audio },
    });

    await controls.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("stops capture and daemon realtime when captured audio append fails", async () => {
    const requests: Array<{
      readonly method: AgenCDaemonMethod;
      readonly params?: JsonObject;
    }> = [];
    const client = {
      requests,
      async request<Method extends AgenCDaemonMethod>(
        method: Method,
        params?: JsonObject,
      ): Promise<AgenCDaemonResultByMethod[Method]> {
        requests.push({ method, params });
        if (method === "thread/realtime/appendAudio") {
          throw new Error("append failed");
        }
        return {} as AgenCDaemonResultByMethod[Method];
      },
    };
    const audioPlayer = createAudioPlayer();
    const emitted: JsonObject[] = [];
    let callbacks: RealtimeAudioCaptureCallbacks | null = null;
    const stop = vi.fn();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: (event) => emitted.push(event),
      startAudioCapture: async (nextCallbacks) => {
        callbacks = nextCallbacks;
        return { stop };
      },
      audioPlayer,
    });

    await controls.start({ transport: "websocket" });
    callbacks?.onAudio({
      data: "BBBB",
      sampleRate: 16000,
      numChannels: 1,
    });

    await waitFor(
      () =>
        controls.getState().errorBanner === "append failed" &&
        requests.some((request) => request.method === "thread/realtime/stop"),
      "append failure cleanup",
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(audioPlayer.close).toHaveBeenCalledTimes(1);
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: { threadId: "agent_1", message: "append failed" },
    });
    await controls.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("stops daemon realtime if websocket capture fails after daemon start", async () => {
    const client = createClient();
    const emitted: JsonObject[] = [];
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: (event) => emitted.push(event),
      startAudioCapture: async () => {
        throw new Error("microphone unavailable");
      },
    });

    await expect(controls.start({ transport: "websocket" })).rejects.toThrow(
      "microphone unavailable",
    );

    expect(client.requests.map((request) => request.method)).toEqual([
      "thread/realtime/start",
      "thread/realtime/stop",
    ]);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      errorBanner: "microphone unavailable",
    });
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: { threadId: "agent_1", message: "microphone unavailable" },
    });
  });

  test.each([
    ["error", "capture failed", "realtime_error"],
    ["closed", "audio_capture_closed", "realtime_closed"],
  ] as const)(
    "stops daemon realtime when websocket capture reports %s",
    async (kind, message, eventType) => {
      const client = createClient();
      let callbacks: RealtimeAudioCaptureCallbacks | null = null;
      const emitted: JsonObject[] = [];
      const cleanupError = new Error(`${kind} capture cleanup failed`);
      const stop = vi.fn(async () => {
        throw cleanupError;
      });
      const controls = createRealtimeTuiControls({
        threadId: "agent_1",
        client,
        emitEvent: (event) => emitted.push(event),
        startAudioCapture: async (nextCallbacks) => {
          callbacks = nextCallbacks;
          return { stop };
        },
      });

      await controls.start({ transport: "websocket" });
      if (kind === "error") callbacks?.onError(message);
      else callbacks?.onClosed();

      await waitFor(
        () =>
          client.requests.filter(
            (request) => request.method === "thread/realtime/stop",
          ).length === 1 &&
          logMock.logError.mock.calls.some(([error]) => error === cleanupError),
        "daemon stop after capture terminal event",
      );
      expect(stop).toHaveBeenCalledTimes(1);
      expect(emitted.at(-1)).toMatchObject({
        type: eventType,
      });
    },
  );

  test("enqueues realtime output audio deltas into the audio player", async () => {
    const client = createClient();
    const audioPlayer = createAudioPlayer();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
      startAudioCapture: createNoopAudioCapture(),
      audioPlayer,
    });
    const audio = {
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
    };

    await controls.start({ transport: "websocket" });
    controls.handleTranscriptEvent([] as never);
    controls.handleTranscriptEvent({
      type: "realtime_output_audio_delta",
      payload: [] as never,
    });
    expect(audioPlayer.enqueue).not.toHaveBeenCalled();

    controls.handleTranscriptEvent({
      type: "realtime_started",
      payload: { realtimeSessionId: "rt_1" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_output_audio_delta",
      payload: { audio },
    });

    expect(audioPlayer.enqueue).toHaveBeenCalledWith({
      ...audio,
      samplesPerChannel: null,
      itemId: null,
    });
    expect(audioPlayer.enqueued).toEqual([
      { ...audio, samplesPerChannel: null, itemId: null },
    ]);
  });

  test("ignores stale media and transcript notifications after stop", async () => {
    const client = createClient();
    const audioPlayer = createAudioPlayer();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
      startAudioCapture: createNoopAudioCapture(),
      audioPlayer,
    });
    const audio = {
      data: "AAAA",
      sampleRate: 24000,
      numChannels: 1,
    };

    await controls.start({ transport: "websocket" });
    controls.handleTranscriptEvent({
      type: "realtime_started",
      payload: { realtimeSessionId: "rt_1" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_output_audio_delta",
      payload: { audio },
    });
    await controls.stop();

    controls.handleTranscriptEvent({
      type: "realtime_output_audio_delta",
      payload: { audio: { ...audio, data: "BBBB" } },
    });
    controls.handleTranscriptEvent({
      type: "realtime_transcript_delta",
      payload: { role: "assistant", delta: "stale" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_item_added",
      payload: { item: { type: "message", id: "stale_item" } },
    });
    controls.handleTranscriptEvent({
      type: "realtime_local_audio_level",
      payload: { peak: 32000 },
    });

    expect(audioPlayer.enqueued).toEqual([
      { ...audio, samplesPerChannel: null, itemId: null },
    ]);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      localAudioLevel: 0,
      lastTranscript: null,
      lastItemSummary: null,
      closedBanner: "Realtime closed: requested",
    });
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
    "guards audio player close failures during remote %s notifications",
    (type, payload, expectedState) => {
      const client = createClient();
      const closeError = new Error("close failed");
      const audioPlayer = {
        enqueue: vi.fn(),
        close: vi.fn(() => {
          throw closeError;
        }),
      };
      const controls = createRealtimeTuiControls({
        threadId: "agent_1",
        client,
        emitEvent: () => {},
        audioPlayer,
      });

      expect(() => {
        controls.handleTranscriptEvent({ type, payload });
      }).not.toThrow();
      expect(controls.getState()).toMatchObject(expectedState);
      expect(logMock.logError).toHaveBeenCalledWith(closeError);
    },
  );

  test.each(["realtime_error", "realtime_closed"] as const)(
    "logs audio capture cleanup failures during remote %s notifications",
    async (type) => {
      const client = createClient();
      const cleanupError = new Error("capture cleanup failed");
      const stop = vi.fn(async () => {
        throw cleanupError;
      });
      const controls = createRealtimeTuiControls({
        threadId: "agent_1",
        client,
        emitEvent: () => {},
        startAudioCapture: async () => ({ stop }),
      });

      await controls.start({ transport: "websocket" });
      controls.handleTranscriptEvent({
        type,
        payload:
          type === "realtime_error"
            ? { message: "remote failed" }
            : { reason: "remote closed" },
      });

      await waitFor(
        () => logMock.logError.mock.calls.some(([error]) => error === cleanupError),
        "logged remote cleanup failure",
      );
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  test("ignores stale started notifications after a stopped session", async () => {
    const client = createClient();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: () => {},
    });

    controls.handleTranscriptEvent({
      type: "realtime_started",
      payload: { realtimeSessionId: "stale" },
    });

    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      realtimeSessionId: null,
      transport: null,
    });
  });

  test("surfaces stop RPC failures after local WebRTC cleanup", async () => {
    const requests: Array<{
      readonly method: AgenCDaemonMethod;
      readonly params?: JsonObject;
    }> = [];
    const client = {
      requests,
      async request<Method extends AgenCDaemonMethod>(
        method: Method,
        params?: JsonObject,
      ): Promise<AgenCDaemonResultByMethod[Method]> {
        requests.push({ method, params });
        if (method === "thread/realtime/stop") throw new Error("stop failed");
        return {} as AgenCDaemonResultByMethod[Method];
      },
    };
    const channel = createRealtimeWebrtcEventChannel();
    const emitted: JsonObject[] = [];
    const close = vi.fn();
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: (event) => emitted.push(event),
      startWebrtcSession: async () => ({
        offerSdp: "offer-sdp",
        handle: new RealtimeWebrtcSessionHandle({
          applyAnswerSdp: vi.fn(),
          close,
        }),
        events: channel.receiver,
      }),
    });

    await controls.start({ transport: "webrtc" });
    await expect(controls.stop()).rejects.toThrow("stop failed");

    expect(close).toHaveBeenCalledTimes(1);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      errorBanner: "stop failed",
    });
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: { threadId: "agent_1", message: "stop failed" },
    });
  });

  test("still stops daemon realtime when local audio capture stop fails", async () => {
    const client = createClient();
    const audioPlayer = createAudioPlayer();
    const emitted: JsonObject[] = [];
    const stop = vi.fn(async () => {
      throw new Error("capture stop failed");
    });
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: (event) => emitted.push(event),
      startAudioCapture: async () => ({ stop }),
      audioPlayer,
    });

    await controls.start({ transport: "websocket" });
    await expect(controls.stop()).rejects.toThrow("capture stop failed");

    expect(client.requests.map((request) => request.method)).toEqual([
      "thread/realtime/start",
      "thread/realtime/stop",
    ]);
    expect(audioPlayer.close).toHaveBeenCalledTimes(1);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      errorBanner: "capture stop failed",
    });
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: { threadId: "agent_1", message: "capture stop failed" },
    });
  });

  test.each([
    [{ type: "failed" as const, message: "peer failed" }, "realtime_error"],
    [{ type: "closed" as const }, "realtime_closed"],
  ])(
    "stops daemon realtime on unexpected local WebRTC %s events",
    async (event, eventType) => {
      const stopError = new Error("daemon stop failed");
      const requests: Array<{
        readonly method: AgenCDaemonMethod;
        readonly params?: JsonObject;
      }> = [];
      const client = {
        requests,
        async request<Method extends AgenCDaemonMethod>(
          method: Method,
          params?: JsonObject,
        ): Promise<AgenCDaemonResultByMethod[Method]> {
          requests.push({ method, params });
          if (method === "thread/realtime/stop") throw stopError;
          return {} as AgenCDaemonResultByMethod[Method];
        },
      };
      const channel = createRealtimeWebrtcEventChannel();
      const emitted: JsonObject[] = [];
      const controls = createRealtimeTuiControls({
        threadId: "agent_1",
        client,
        emitEvent: (nextEvent) => emitted.push(nextEvent),
        startWebrtcSession: async () => ({
          offerSdp: "offer-sdp",
          handle: new RealtimeWebrtcSessionHandle({
            applyAnswerSdp: vi.fn(),
            close: vi.fn(),
          }),
          events: channel.receiver,
        }),
      });

      await controls.start({ transport: "webrtc" });
      channel.sender.send(event);

      await waitFor(
        () =>
          client.requests.filter(
            (request) => request.method === "thread/realtime/stop",
          ).length === 1 &&
          logMock.logError.mock.calls.some(([error]) => error === stopError),
        "daemon stop after local WebRTC terminal event",
      );
      expect(emitted.at(-1)).toMatchObject({ type: eventType });
    },
  );

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
      const closeError = new Error("remote WebRTC cleanup failed");
      const close = vi.fn(async () => {
        throw closeError;
      });
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
        () =>
          close.mock.calls.length === 1 &&
          logMock.logError.mock.calls.some(([error]) => error === closeError),
        "remote terminal WebRTC cleanup",
      );
      expect(controls.getState()).toMatchObject(expectedState);
    },
  );
});
