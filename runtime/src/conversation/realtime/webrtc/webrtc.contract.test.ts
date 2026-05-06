import { describe, expect, test, vi } from "vitest";
import {
  RealtimeWebrtcError,
  RealtimeWebrtcSession,
  isRealtimeWebrtcUnsupportedPlatform,
  type RealtimeWebrtcEvent,
  type RealtimeWebrtcEventReceiver,
} from "./lib.js";
import {
  audioLevelToPeak,
  localAudioLevel,
  type RealtimeWebrtcMediaStream,
  type RealtimeWebrtcMediaTrack,
  type RealtimeWebrtcPeerConnection,
  type RealtimeWebrtcRuntimeSupport,
  type RealtimeWebrtcSessionDescription,
  type RealtimeWebrtcTimer,
  type RealtimeWebrtcTransceiver,
} from "./native.js";

const VALID_ANSWER_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

class FakeAudioTrack implements RealtimeWebrtcMediaTrack {
  stop = vi.fn();
}

class FakeMediaStream implements RealtimeWebrtcMediaStream {
  readonly track = new FakeAudioTrack();
  readonly #tracks: readonly RealtimeWebrtcMediaTrack[];

  constructor(tracks?: readonly RealtimeWebrtcMediaTrack[]) {
    this.#tracks = tracks ?? [this.track];
  }

  getAudioTracks(): readonly RealtimeWebrtcMediaTrack[] {
    return this.#tracks;
  }
}

class FakePeerConnection implements RealtimeWebrtcPeerConnection {
  localDescription: RealtimeWebrtcSessionDescription | null = null;
  remoteDescription: RealtimeWebrtcSessionDescription | null = null;
  connectionState = "new";
  readonly listeners = new Map<string, Set<() => void>>();
  readonly setTrack = vi.fn();
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
  });
  readonly transceiver: RealtimeWebrtcTransceiver = {
    sender: {
      setTrack: this.setTrack,
    },
  };
  addTransceiverArgs: {
    readonly trackOrKind: RealtimeWebrtcMediaTrack | "audio";
    readonly init: {
      readonly direction: "sendrecv";
      readonly streams?: readonly RealtimeWebrtcMediaStream[];
    };
  } | null = null;
  offerOptions: unknown = null;
  stats: unknown = new Map([
    [
      "local-audio",
      {
        type: "media-source",
        kind: "audio",
        audioLevel: 0.5,
      },
    ],
  ]);
  remoteDescriptionError: Error | null = null;
  addTransceiverError: Error | null = null;
  addEventListenerError: Error | null = null;
  createOfferError: Error | null = null;
  localDescriptionError: Error | null = null;
  statsError: Error | null = null;
  statsDelay: Promise<void> | null = null;
  getStatsCalls = 0;
  activeStatsCalls = 0;
  maxConcurrentStatsCalls = 0;

  addTransceiver(
    trackOrKind: RealtimeWebrtcMediaTrack | "audio",
    init: {
      readonly direction: "sendrecv";
      readonly streams?: readonly RealtimeWebrtcMediaStream[];
    },
  ): RealtimeWebrtcTransceiver {
    if (this.addTransceiverError !== null) throw this.addTransceiverError;
    this.addTransceiverArgs = { trackOrKind, init };
    return this.transceiver;
  }

  createOffer(options: {
    readonly iceRestart: boolean;
    readonly offerToReceiveAudio: boolean;
    readonly offerToReceiveVideo: boolean;
  }): Promise<RealtimeWebrtcSessionDescription> {
    if (this.createOfferError !== null) {
      return Promise.reject(this.createOfferError);
    }
    this.offerOptions = options;
    return Promise.resolve({ type: "offer", sdp: "offer-sdp" });
  }

  setLocalDescription(
    description: RealtimeWebrtcSessionDescription,
  ): Promise<void> {
    if (this.localDescriptionError !== null) {
      return Promise.reject(this.localDescriptionError);
    }
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(
    description: RealtimeWebrtcSessionDescription,
  ): Promise<void> {
    if (this.remoteDescriptionError !== null) {
      return Promise.reject(this.remoteDescriptionError);
    }
    this.remoteDescription = description;
    return Promise.resolve();
  }

  async getStats(): Promise<unknown> {
    if (this.statsError !== null) return Promise.reject(this.statsError);
    this.getStatsCalls += 1;
    this.activeStatsCalls += 1;
    this.maxConcurrentStatsCalls = Math.max(
      this.maxConcurrentStatsCalls,
      this.activeStatsCalls,
    );
    try {
      if (this.statsDelay !== null) await this.statsDelay;
      return this.stats;
    } finally {
      this.activeStatsCalls -= 1;
    }
  }

  addEventListener(
    event: "connectionstatechange" | "iceconnectionstatechange",
    listener: () => void,
  ): void {
    if (this.addEventListenerError !== null) {
      throw this.addEventListenerError;
    }
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(
    event: "connectionstatechange" | "iceconnectionstatechange",
    listener: () => void,
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "connectionstatechange" | "iceconnectionstatechange"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function fakeRuntime(): {
  readonly peerConnection: FakePeerConnection;
  readonly mediaStream: FakeMediaStream;
  readonly runtime: RealtimeWebrtcRuntimeSupport;
  readonly tickAudioLevel: () => Promise<void>;
} {
  const peerConnection = new FakePeerConnection();
  const mediaStream = new FakeMediaStream();
  let intervalCallback: (() => void) | null = null;
  const runtime: RealtimeWebrtcRuntimeSupport = {
    createPeerConnection: () => peerConnection,
    getUserMedia: () => Promise.resolve(mediaStream),
    setInterval: (callback) => {
      intervalCallback = callback;
      return { unref: vi.fn() } as RealtimeWebrtcTimer;
    },
    clearInterval: vi.fn(),
  };
  return {
    peerConnection,
    mediaStream,
    runtime,
    tickAudioLevel: async () => {
      intervalCallback?.();
      await Promise.resolve();
    },
  };
}

function fakeRuntimeWithStream(mediaStream: FakeMediaStream): {
  readonly peerConnection: FakePeerConnection;
  readonly runtime: RealtimeWebrtcRuntimeSupport;
} {
  const peerConnection = new FakePeerConnection();
  return {
    peerConnection,
    runtime: {
      createPeerConnection: () => peerConnection,
      getUserMedia: () => Promise.resolve(mediaStream),
    },
  };
}

async function nextEvent(
  events: RealtimeWebrtcEventReceiver,
): Promise<RealtimeWebrtcEvent | null> {
  return events.recv();
}

describe("RealtimeWebrtcSession", () => {
  test("reports unsupported platform when host WebRTC APIs are unavailable", async () => {
    await expect(
      RealtimeWebrtcSession.start({ runtime: {} }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isRealtimeWebrtcUnsupportedPlatform(error)).toBe(true);
      expect(error).toBeInstanceOf(RealtimeWebrtcError);
      expect((error as Error).message).toBe(
        "realtime WebRTC is not supported on this platform",
      );
      return true;
    });
  });

  test("creates an offer, applies provider answer, emits events, and closes", async () => {
    const fixture = fakeRuntime();
    const started = await RealtimeWebrtcSession.start({
      runtime: fixture.runtime,
      localAudioLevelIntervalMs: 10,
    });

    expect(started.offerSdp).toBe("offer-sdp");
    expect(fixture.peerConnection.offerOptions).toEqual({
      iceRestart: false,
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    expect(fixture.peerConnection.addTransceiverArgs?.trackOrKind).toBe(
      fixture.mediaStream.track,
    );
    expect(fixture.peerConnection.addTransceiverArgs?.init.direction).toBe(
      "sendrecv",
    );
    expect(fixture.peerConnection.setTrack).toHaveBeenCalledWith(
      fixture.mediaStream.track,
    );

    await started.handle.applyAnswerSdp(VALID_ANSWER_SDP);
    expect(fixture.peerConnection.remoteDescription).toEqual({
      type: "answer",
      sdp: VALID_ANSWER_SDP,
    });
    await expect(nextEvent(started.events)).resolves.toEqual({
      type: "connected",
    });

    await fixture.tickAudioLevel();
    await expect(nextEvent(started.events)).resolves.toEqual({
      type: "local_audio_level",
      peak: audioLevelToPeak(0.5),
    });
    expect(started.handle.localAudioPeak().load()).toBe(audioLevelToPeak(0.5));

    await started.handle.close();
    await expect(nextEvent(started.events)).resolves.toEqual({
      type: "closed",
    });
    await expect(nextEvent(started.events)).resolves.toBeNull();
    expect(fixture.mediaStream.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.peerConnection.close).toHaveBeenCalledTimes(1);
  });

  test("rejects answer application after close with worker-stopped semantics", async () => {
    const fixture = fakeRuntime();
    const started = await RealtimeWebrtcSession.start({
      runtime: fixture.runtime,
    });

    await started.handle.close();

    await expect(
      started.handle.applyAnswerSdp(VALID_ANSWER_SDP),
    ).rejects.toThrow("realtime WebRTC worker stopped");
  });

  test("wraps remote answer failures with WebRTC description context", async () => {
    const fixture = fakeRuntime();
    fixture.peerConnection.remoteDescriptionError = new Error("bad answer");
    const started = await RealtimeWebrtcSession.start({
      runtime: fixture.runtime,
    });

    await expect(
      started.handle.applyAnswerSdp(VALID_ANSWER_SDP),
    ).rejects.toThrow("failed to set remote WebRTC description: bad answer");
    expect(started.events.tryRecv()).toBeUndefined();
  });

  test("rejects malformed answer SDP without emitting connected", async () => {
    const fixture = fakeRuntime();
    const started = await RealtimeWebrtcSession.start({
      runtime: fixture.runtime,
    });

    await expect(started.handle.applyAnswerSdp("answer-sdp")).rejects.toThrow(
      "failed to parse WebRTC answer SDP",
    );

    expect(fixture.peerConnection.remoteDescription).toBeNull();
    expect(started.events.tryRecv()).toBeUndefined();
  });

  test("emits failed and ends the receiver when the peer connection fails", async () => {
    const fixture = fakeRuntime();
    const started = await RealtimeWebrtcSession.start({
      runtime: fixture.runtime,
    });
    await started.handle.applyAnswerSdp(VALID_ANSWER_SDP);
    await nextEvent(started.events);

    fixture.peerConnection.connectionState = "failed";
    fixture.peerConnection.emit("connectionstatechange");

    await expect(nextEvent(started.events)).resolves.toEqual({
      type: "failed",
      message: "realtime WebRTC connection failed",
    });
    await expect(nextEvent(started.events)).resolves.toBeNull();
    expect(fixture.peerConnection.close).toHaveBeenCalledTimes(1);
  });

  test("cleans startup resources when audio capture has no track", async () => {
    const fixture = fakeRuntimeWithStream(new FakeMediaStream([]));

    await expect(
      RealtimeWebrtcSession.start({ runtime: fixture.runtime }),
    ).rejects.toThrow("no audio track");

    expect(fixture.peerConnection.close).toHaveBeenCalledTimes(1);
  });

  test("cleans startup resources when audio attachment fails", async () => {
    const mediaStream = new FakeMediaStream();
    const fixture = fakeRuntimeWithStream(mediaStream);
    fixture.peerConnection.addTransceiverError = new Error("attach failed");

    await expect(
      RealtimeWebrtcSession.start({ runtime: fixture.runtime }),
    ).rejects.toThrow("failed to attach WebRTC audio track: attach failed");

    expect(mediaStream.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.peerConnection.close).toHaveBeenCalledTimes(1);
  });

  test("cleans startup resources when offer creation fails", async () => {
    const mediaStream = new FakeMediaStream();
    const fixture = fakeRuntimeWithStream(mediaStream);
    fixture.peerConnection.createOfferError = new Error("offer failed");

    await expect(
      RealtimeWebrtcSession.start({ runtime: fixture.runtime }),
    ).rejects.toThrow("failed to create WebRTC offer: offer failed");

    expect(mediaStream.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.peerConnection.close).toHaveBeenCalledTimes(1);
  });

  test("cleans startup resources when local description fails", async () => {
    const mediaStream = new FakeMediaStream();
    const fixture = fakeRuntimeWithStream(mediaStream);
    fixture.peerConnection.localDescriptionError = new Error(
      "local description failed",
    );

    await expect(
      RealtimeWebrtcSession.start({ runtime: fixture.runtime }),
    ).rejects.toThrow(
      "failed to set local WebRTC description: local description failed",
    );

    expect(mediaStream.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.peerConnection.close).toHaveBeenCalledTimes(1);
  });

  test("cleans startup resources when event listener setup fails", async () => {
    const mediaStream = new FakeMediaStream();
    const fixture = fakeRuntimeWithStream(mediaStream);
    fixture.peerConnection.addEventListenerError = new Error("listener failed");

    await expect(
      RealtimeWebrtcSession.start({ runtime: fixture.runtime }),
    ).rejects.toThrow(
      "failed to start realtime WebRTC event listeners: listener failed",
    );

    expect(mediaStream.track.stop).toHaveBeenCalledTimes(1);
    expect(fixture.peerConnection.close).toHaveBeenCalledTimes(1);
  });

  test("ignores transient stats failures during local audio polling", async () => {
    const fixture = fakeRuntime();
    fixture.peerConnection.statsError = new Error("stats unavailable");
    const started = await RealtimeWebrtcSession.start({
      runtime: fixture.runtime,
      localAudioLevelIntervalMs: 10,
    });
    await started.handle.applyAnswerSdp(VALID_ANSWER_SDP);
    await nextEvent(started.events);

    await fixture.tickAudioLevel();

    expect(started.events.tryRecv()).toBeUndefined();
    expect(fixture.peerConnection.close).not.toHaveBeenCalled();
    await started.handle.close();
  });

  test("serializes slow local audio stats polling", async () => {
    const fixture = fakeRuntime();
    let releaseStats!: () => void;
    fixture.peerConnection.statsDelay = new Promise((resolve) => {
      releaseStats = resolve;
    });
    const started = await RealtimeWebrtcSession.start({
      runtime: fixture.runtime,
      localAudioLevelIntervalMs: 10,
    });
    await started.handle.applyAnswerSdp(VALID_ANSWER_SDP);
    await nextEvent(started.events);

    await fixture.tickAudioLevel();
    await fixture.tickAudioLevel();

    expect(fixture.peerConnection.getStatsCalls).toBe(1);
    expect(fixture.peerConnection.maxConcurrentStatsCalls).toBe(1);

    releaseStats();
    await expect(nextEvent(started.events)).resolves.toEqual({
      type: "local_audio_level",
      peak: audioLevelToPeak(0.5),
    });
    await started.handle.close();
  });
});

describe("WebRTC audio level helpers", () => {
  test("converts and clamps audio levels to realtime peaks", () => {
    expect(audioLevelToPeak(-1)).toBe(0);
    expect(audioLevelToPeak(0.5)).toBe(16_384);
    expect(audioLevelToPeak(2)).toBe(32_767);
    expect(audioLevelToPeak(Number.NaN)).toBe(0);
  });

  test("extracts local audio level from flat and nested stats shapes", async () => {
    const flat = {
      getStats: () =>
        Promise.resolve(
          new Map([
            ["flat", { type: "media-source", kind: "audio", audioLevel: 0.25 }],
          ]),
        ),
    };
    const nested = {
      getStats: () =>
        Promise.resolve([
          {
            source: { kind: "audio" },
            audio: { audio_level: 0.75 },
          },
        ]),
    };

    await expect(localAudioLevel(flat)).resolves.toBe(audioLevelToPeak(0.25));
    await expect(localAudioLevel(nested)).resolves.toBe(audioLevelToPeak(0.75));
  });
});
