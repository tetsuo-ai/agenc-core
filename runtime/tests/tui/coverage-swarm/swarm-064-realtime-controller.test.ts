import { describe, expect, test, vi } from "vitest";

import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  ThreadRealtimeAudioChunk,
} from "../../../src/app-server/protocol/index.js";
import {
  createRealtimeWebrtcEventChannel,
  RealtimeWebrtcSessionHandle,
  type StartedRealtimeWebrtcSession,
} from "../../../src/conversation/realtime/webrtc/lib.js";
import type {
  RealtimeAudioCaptureCallbacks,
  RealtimeAudioPlayer,
} from "../../../src/tui/realtime/audio.js";
import { createRealtimeTuiControls } from "../../../src/tui/realtime/controller.js";

type RequestRecord = {
  readonly method: AgenCDaemonMethod;
  readonly params?: JsonObject;
};

function createClient(
  onRequest?: (
    method: AgenCDaemonMethod,
    params?: JsonObject,
  ) => Promise<unknown> | unknown,
): {
  readonly requests: RequestRecord[];
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
  ): Promise<AgenCDaemonResultByMethod[Method]>;
} {
  const requests: RequestRecord[] = [];
  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      const result =
        onRequest === undefined ? {} : await onRequest(method, params);
      return (result ?? {}) as AgenCDaemonResultByMethod[typeof method];
    },
  };
}

function createNoopAudioCapture() {
  return async () => ({ stop: vi.fn() });
}

function createAudioPlayer(closeImpl: () => void = () => {}) {
  const enqueued: ThreadRealtimeAudioChunk[] = [];
  return {
    enqueued,
    enqueue: vi.fn((audio: ThreadRealtimeAudioChunk) => {
      enqueued.push(audio);
    }),
    close: vi.fn(closeImpl),
  } satisfies RealtimeAudioPlayer & {
    readonly enqueued: ThreadRealtimeAudioChunk[];
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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

describe("AgenC realtime TUI controller coverage swarm row 064", () => {
  test("passes explicit websocket start options and ignores lifecycle no-ops", async () => {
    const startGate = deferred();
    const client = createClient(async (method) => {
      if (method === "thread/realtime/start") await startGate.promise;
    });
    const controls = createRealtimeTuiControls({
      threadId: "thread-064",
      client,
      emitEvent: () => {},
      startAudioCapture: createNoopAudioCapture(),
      audioPlayer: createAudioPlayer(),
    });

    await controls.stop();
    expect(client.requests).toHaveLength(0);

    const firstStart = controls.start({
      transport: "websocket",
      realtimeSessionId: "rt-resume",
      prompt: "Keep replies terse",
      outputModality: "text",
      voice: "cedar",
    });
    const duplicateWhileStarting = controls.start({ transport: "websocket" });

    await waitFor(
      () => client.requests.length === 1,
      "pending websocket start request",
    );
    expect(controls.getState()).toMatchObject({
      phase: "starting",
      transport: "websocket",
    });

    startGate.resolve();
    await Promise.all([firstStart, duplicateWhileStarting]);

    expect(client.requests).toEqual([
      {
        method: "thread/realtime/start",
        params: {
          threadId: "thread-064",
          transport: { type: "websocket" },
          realtimeSessionId: "rt-resume",
          prompt: "Keep replies terse",
          outputModality: "text",
          voice: "cedar",
        },
      },
    ]);

    controls.handleTranscriptEvent({
      type: "realtime_started",
      payload: {},
    });
    expect(controls.getState()).toMatchObject({
      phase: "active",
      realtimeSessionId: null,
    });

    await controls.start({ transport: "websocket" });
    expect(client.requests).toHaveLength(1);
  });

  test("surfaces fallback cleanup errors when audio player close throws non-errors", async () => {
    const client = createClient();
    const emitted: JsonObject[] = [];
    const audioPlayer = createAudioPlayer(() => {
      throw "";
    });
    const controls = createRealtimeTuiControls({
      threadId: "thread-064",
      client,
      emitEvent: (event) => emitted.push(event),
      startAudioCapture: createNoopAudioCapture(),
      audioPlayer,
    });

    await controls.start({ transport: "websocket" });
    await expect(controls.stop()).rejects.toThrow("Realtime cleanup failed");

    expect(client.requests.map((request) => request.method)).toEqual([
      "thread/realtime/start",
      "thread/realtime/stop",
    ]);
    expect(audioPlayer.close).toHaveBeenCalledOnce();
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      errorBanner: "Realtime cleanup failed",
    });
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: {
        threadId: "thread-064",
        message: "Realtime cleanup failed",
      },
    });
  });

  test("closes a started WebRTC transport when daemon start rejects with a non-error", async () => {
    const client = createClient((method) => {
      if (method === "thread/realtime/start") throw "daemon rejected";
    });
    const channel = createRealtimeWebrtcEventChannel();
    const close = vi.fn();
    const started: StartedRealtimeWebrtcSession = {
      offerSdp: "offer-sdp-064",
      handle: new RealtimeWebrtcSessionHandle({
        applyAnswerSdp: vi.fn(),
        close,
      }),
      events: channel.receiver,
    };
    const emitted: JsonObject[] = [];
    const controls = createRealtimeTuiControls({
      threadId: "thread-064",
      client,
      emitEvent: (event) => emitted.push(event),
      startWebrtcSession: async () => started,
      audioPlayer: createAudioPlayer(),
    });

    await expect(controls.start({ transport: "webrtc" })).rejects.toBe(
      "daemon rejected",
    );

    expect(close).toHaveBeenCalledOnce();
    expect(client.requests).toEqual([
      {
        method: "thread/realtime/start",
        params: {
          threadId: "thread-064",
          transport: { type: "webrtc", sdp: "offer-sdp-064" },
          realtimeSessionId: null,
          prompt: null,
          outputModality: "audio",
          voice: null,
        },
      },
    ]);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      errorBanner: "daemon rejected",
    });
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: { threadId: "thread-064", message: "daemon rejected" },
    });
  });

  test("filters transcript payloads and preserves complete output audio metadata", () => {
    const client = createClient();
    const audioPlayer = createAudioPlayer();
    const controls = createRealtimeTuiControls({
      threadId: "thread-064",
      client,
      emitEvent: () => {},
      audioPlayer,
    });

    controls.handleTranscriptEvent({
      type: "realtime_sdp",
      payload: { sdp: "ignored-without-webrtc" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_output_audio_delta",
      payload: { audio: "not an object" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_output_audio_delta",
      payload: {
        audio: {
          data: "AAAA",
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 12,
          itemId: "item-064",
        },
      },
    });

    expect(audioPlayer.enqueued).toEqual([
      {
        data: "AAAA",
        sampleRate: 24_000,
        numChannels: 1,
        samplesPerChannel: 12,
        itemId: "item-064",
      },
    ]);

    controls.handleTranscriptEvent({
      type: "realtime_transcript_delta",
      payload: { role: "assistant", delta: "hel" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_transcript_delta",
      payload: { role: "assistant", delta: "lo" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_transcript_delta",
      payload: { role: "assistant", delta: 64 },
    });
    controls.handleTranscriptEvent({
      type: "realtime_transcript_done",
      payload: { role: "user", text: "done" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_transcript_done",
      payload: { role: "user", text: null },
    });
    controls.handleTranscriptEvent({
      type: "realtime_item_added",
      payload: { item: { type: "message", id: "msg-064" } },
    });
    controls.handleTranscriptEvent({
      type: "realtime_local_audio_level",
      payload: { peak: "loud" },
    });
    controls.handleTranscriptEvent({ type: "unhandled_realtime_event" });

    expect(controls.getState()).toMatchObject({
      lastTranscript: { role: "user", text: "done" },
      lastItemSummary: "message msg-064",
      localAudioLevel: 0,
    });
  });

  test("ignores late websocket capture terminal callbacks after requested stop", async () => {
    const client = createClient();
    let callbacks: RealtimeAudioCaptureCallbacks | null = null;
    const controls = createRealtimeTuiControls({
      threadId: "thread-064",
      client,
      emitEvent: () => {},
      startAudioCapture: async (nextCallbacks) => {
        callbacks = nextCallbacks;
        return { stop: vi.fn() };
      },
      audioPlayer: createAudioPlayer(),
    });

    await controls.start({ transport: "websocket" });
    await controls.stop();
    const stopCount = client.requests.filter(
      (request) => request.method === "thread/realtime/stop",
    ).length;

    callbacks?.onError("late capture failure");
    callbacks?.onClosed();
    await Promise.resolve();

    expect(
      client.requests.filter(
        (request) => request.method === "thread/realtime/stop",
      ),
    ).toHaveLength(stopCount);
    expect(controls.getState()).toMatchObject({
      phase: "inactive",
      errorBanner: null,
      closedBanner: "Realtime closed: requested",
    });
  });

  test("keeps capture terminal daemon-stop cleanup best effort", async () => {
    const client = createClient((method) => {
      if (method === "thread/realtime/stop") {
        throw new Error("ignored stop failure");
      }
    });
    const emitted: JsonObject[] = [];
    let callbacks: RealtimeAudioCaptureCallbacks | null = null;
    const stopCapture = vi.fn();
    const audioPlayer = createAudioPlayer();
    const controls = createRealtimeTuiControls({
      threadId: "thread-064",
      client,
      emitEvent: (event) => emitted.push(event),
      startAudioCapture: async (nextCallbacks) => {
        callbacks = nextCallbacks;
        return { stop: stopCapture };
      },
      audioPlayer,
    });

    await controls.start({ transport: "websocket" });
    callbacks?.onError("capture failed");

    await waitFor(
      () =>
        controls.getState().errorBanner === "capture failed" &&
        client.requests.some(
          (request) => request.method === "thread/realtime/stop",
        ),
      "capture terminal cleanup with failing daemon stop",
    );

    expect(stopCapture).toHaveBeenCalledOnce();
    expect(audioPlayer.close).toHaveBeenCalledOnce();
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: { threadId: "thread-064", message: "capture failed" },
    });
  });
});
