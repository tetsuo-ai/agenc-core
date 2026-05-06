/**
 * Ports upstream runtime `realtime-webrtc/src/native.rs` onto host-provided
 * WebRTC primitives.
 *
 * Shape difference from upstream:
 *   - The source crate binds a macOS-native WebRTC runtime. AgenC accepts an
 *     injected or global WebRTC runtime so Node/Electron hosts can provide the
 *     peer connection and microphone primitives directly.
 */

import {
  RealtimeWebrtcError,
  RealtimeWebrtcEventReceiver,
  RealtimeWebrtcLocalAudioPeak,
  createRealtimeWebrtcEventChannel,
  realtimeWebrtcWorkerStoppedError,
  type RealtimeWebrtcEventSender,
  type RealtimeWebrtcSessionHandleDriver,
} from "./lib.js";

const DEFAULT_LOCAL_AUDIO_LEVEL_INTERVAL_MS = 200;

export interface RealtimeWebrtcMediaTrack {
  stop?(): void;
}

export interface RealtimeWebrtcMediaStream {
  getAudioTracks(): readonly RealtimeWebrtcMediaTrack[];
}

export interface RealtimeWebrtcSender {
  setTrack?(track: RealtimeWebrtcMediaTrack | null): Promise<void> | void;
}

export interface RealtimeWebrtcTransceiver {
  readonly sender?: RealtimeWebrtcSender;
}

export interface RealtimeWebrtcSessionDescription {
  readonly type?: string;
  readonly sdp?: string;
}

export interface RealtimeWebrtcPeerConnection {
  readonly localDescription?: RealtimeWebrtcSessionDescription | null;
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  addTransceiver(
    trackOrKind: RealtimeWebrtcMediaTrack | "audio",
    init: {
      readonly direction: "sendrecv";
      readonly streams?: readonly RealtimeWebrtcMediaStream[];
    },
  ): RealtimeWebrtcTransceiver;
  createOffer(options: {
    readonly iceRestart: boolean;
    readonly offerToReceiveAudio: boolean;
    readonly offerToReceiveVideo: boolean;
  }): Promise<RealtimeWebrtcSessionDescription>;
  setLocalDescription(
    description: RealtimeWebrtcSessionDescription,
  ): Promise<void>;
  setRemoteDescription(
    description: RealtimeWebrtcSessionDescription,
  ): Promise<void>;
  getStats?(): Promise<unknown>;
  close(): void;
  addEventListener?(
    event: "connectionstatechange" | "iceconnectionstatechange",
    listener: () => void,
  ): void;
  removeEventListener?(
    event: "connectionstatechange" | "iceconnectionstatechange",
    listener: () => void,
  ): void;
}

export type RealtimeWebrtcTimer = ReturnType<typeof setInterval>;

export interface RealtimeWebrtcRuntimeSupport {
  readonly createPeerConnection?: () => RealtimeWebrtcPeerConnection;
  readonly getUserMedia?: (constraints: {
    readonly audio: true;
    readonly video: false;
  }) => Promise<RealtimeWebrtcMediaStream>;
  readonly setInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => RealtimeWebrtcTimer;
  readonly clearInterval?: (timer: RealtimeWebrtcTimer) => void;
}

export interface RealtimeWebrtcNativeStartOptions {
  readonly runtime?: RealtimeWebrtcRuntimeSupport;
  readonly localAudioLevelIntervalMs?: number;
}

export interface RealtimeWebrtcNativeSessionHandle extends RealtimeWebrtcSessionHandleDriver {}

export interface StartedNativeRealtimeWebrtcSession {
  readonly offerSdp: string;
  readonly handle: RealtimeWebrtcNativeSessionHandle;
  readonly events: RealtimeWebrtcEventReceiver;
  readonly localAudioPeak: RealtimeWebrtcLocalAudioPeak;
}

interface ResolvedRealtimeWebrtcRuntime {
  readonly createPeerConnection: () => RealtimeWebrtcPeerConnection;
  readonly getUserMedia: (constraints: {
    readonly audio: true;
    readonly video: false;
  }) => Promise<RealtimeWebrtcMediaStream>;
  readonly setInterval: (
    callback: () => void,
    intervalMs: number,
  ) => RealtimeWebrtcTimer;
  readonly clearInterval: (timer: RealtimeWebrtcTimer) => void;
}

interface CreatedPeerConnectionAndOffer {
  readonly peerConnection: RealtimeWebrtcPeerConnection;
  readonly mediaStream: RealtimeWebrtcMediaStream;
  readonly offerSdp: string;
}

export async function startNativeRealtimeWebrtcSession(
  options: RealtimeWebrtcNativeStartOptions = {},
): Promise<StartedNativeRealtimeWebrtcSession> {
  const runtime = resolveRealtimeWebrtcRuntime(options.runtime);
  const localAudioPeak = new RealtimeWebrtcLocalAudioPeak();
  const channel = createRealtimeWebrtcEventChannel();
  const started = await createPeerConnectionAndOffer(runtime);
  let handle: NativeRealtimeWebrtcSessionHandle;
  try {
    handle = new NativeRealtimeWebrtcSessionHandle({
      peerConnection: started.peerConnection,
      mediaStream: started.mediaStream,
      events: channel.sender,
      localAudioPeak,
      intervalMs:
        options.localAudioLevelIntervalMs ??
        DEFAULT_LOCAL_AUDIO_LEVEL_INTERVAL_MS,
      setInterval: runtime.setInterval,
      clearInterval: runtime.clearInterval,
    });
  } catch (error) {
    cleanupStartedPeerConnection(started.peerConnection, started.mediaStream);
    throw toRealtimeWebrtcError(
      "failed to start realtime WebRTC event listeners",
      error,
    );
  }

  return {
    offerSdp: started.offerSdp,
    handle,
    events: channel.receiver,
    localAudioPeak,
  };
}

class NativeRealtimeWebrtcSessionHandle implements RealtimeWebrtcNativeSessionHandle {
  readonly #peerConnection: RealtimeWebrtcPeerConnection;
  readonly #mediaStream: RealtimeWebrtcMediaStream;
  readonly #events: RealtimeWebrtcEventSender;
  readonly #localAudioPeak: RealtimeWebrtcLocalAudioPeak;
  readonly #intervalMs: number;
  readonly #setInterval: (
    callback: () => void,
    intervalMs: number,
  ) => RealtimeWebrtcTimer;
  readonly #clearInterval: (timer: RealtimeWebrtcTimer) => void;
  readonly #connectionStateListener: () => void;
  #timer: RealtimeWebrtcTimer | null = null;
  #closed = false;
  #connected = false;
  #audioPollInFlight = false;

  constructor(options: {
    readonly peerConnection: RealtimeWebrtcPeerConnection;
    readonly mediaStream: RealtimeWebrtcMediaStream;
    readonly events: RealtimeWebrtcEventSender;
    readonly localAudioPeak: RealtimeWebrtcLocalAudioPeak;
    readonly intervalMs: number;
    readonly setInterval: (
      callback: () => void,
      intervalMs: number,
    ) => RealtimeWebrtcTimer;
    readonly clearInterval: (timer: RealtimeWebrtcTimer) => void;
  }) {
    this.#peerConnection = options.peerConnection;
    this.#mediaStream = options.mediaStream;
    this.#events = options.events;
    this.#localAudioPeak = options.localAudioPeak;
    this.#intervalMs = options.intervalMs;
    this.#setInterval = options.setInterval;
    this.#clearInterval = options.clearInterval;
    this.#connectionStateListener = () => this.#handleConnectionStateChange();
    this.#peerConnection.addEventListener?.(
      "connectionstatechange",
      this.#connectionStateListener,
    );
    this.#peerConnection.addEventListener?.(
      "iceconnectionstatechange",
      this.#connectionStateListener,
    );
  }

  async applyAnswerSdp(answerSdp: string): Promise<void> {
    if (this.#closed) throw realtimeWebrtcWorkerStoppedError();
    try {
      await applyAnswer(this.#peerConnection, answerSdp);
    } catch (error) {
      throw toRealtimeWebrtcError(
        "failed to set remote WebRTC description",
        error,
      );
    }
    if (this.#closed) throw realtimeWebrtcWorkerStoppedError();
    if (!this.#connected) {
      this.#connected = true;
      this.#events.send({ type: "connected" });
      this.#startLocalAudioLevelTask();
    }
  }

  close(): void {
    this.#closeAndFinish("closed");
  }

  #startLocalAudioLevelTask(): void {
    if (this.#timer !== null || this.#intervalMs <= 0) return;
    this.#timer = this.#setInterval(() => {
      void this.#pollLocalAudioLevel();
    }, this.#intervalMs);
    unrefTimer(this.#timer);
  }

  async #pollLocalAudioLevel(): Promise<void> {
    if (this.#closed || this.#audioPollInFlight) return;
    this.#audioPollInFlight = true;
    try {
      const state = realtimeWebrtcConnectionState(this.#peerConnection);
      if (state === "closed") {
        this.#closeAndFinish("closed");
        return;
      }
      if (state === "failed") {
        this.#failAndFinish("realtime WebRTC connection failed");
        return;
      }

      const peak = await localAudioLevel(this.#peerConnection);
      if (peak === null || this.#closed) return;
      this.#localAudioPeak.store(peak);
      this.#events.send({
        type: "local_audio_level",
        peak: this.#localAudioPeak.load(),
      });
    } finally {
      this.#audioPollInFlight = false;
    }
  }

  #handleConnectionStateChange(): void {
    if (this.#closed) return;
    const state = realtimeWebrtcConnectionState(this.#peerConnection);
    if (state === "closed") {
      this.#closeAndFinish("closed");
    } else if (state === "failed") {
      this.#failAndFinish("realtime WebRTC connection failed");
    }
  }

  #failAndFinish(message: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanup();
    this.#events.send({ type: "failed", message });
    this.#events.close();
  }

  #closeAndFinish(event: "closed" | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanup();
    if (event === "closed") this.#events.send({ type: "closed" });
    this.#events.close();
  }

  #cleanup(): void {
    if (this.#timer !== null) {
      this.#clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#peerConnection.removeEventListener?.(
      "connectionstatechange",
      this.#connectionStateListener,
    );
    this.#peerConnection.removeEventListener?.(
      "iceconnectionstatechange",
      this.#connectionStateListener,
    );
    for (const track of this.#mediaStream.getAudioTracks()) {
      track.stop?.();
    }
    try {
      this.#peerConnection.close();
    } catch {
      return;
    }
  }
}

async function createPeerConnectionAndOffer(
  runtime: ResolvedRealtimeWebrtcRuntime,
): Promise<CreatedPeerConnectionAndOffer> {
  let peerConnection: RealtimeWebrtcPeerConnection | null = null;
  let mediaStream: RealtimeWebrtcMediaStream | null = null;
  try {
    peerConnection = runtime.createPeerConnection();
    mediaStream = await runtime.getUserMedia({ audio: true, video: false });

    const localAudioTrack = mediaStream.getAudioTracks()[0];
    if (localAudioTrack === undefined) {
      throw RealtimeWebrtcError.withMessage(
        "failed to open realtime WebRTC audio input: no audio track",
      );
    }

    try {
      const transceiver = peerConnection.addTransceiver(localAudioTrack, {
        direction: "sendrecv",
        streams: [mediaStream],
      });
      await transceiver.sender?.setTrack?.(localAudioTrack);
    } catch (error) {
      throw toRealtimeWebrtcError("failed to attach WebRTC audio track", error);
    }

    let offer: RealtimeWebrtcSessionDescription;
    try {
      offer = await peerConnection.createOffer({
        iceRestart: false,
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
    } catch (error) {
      throw toRealtimeWebrtcError("failed to create WebRTC offer", error);
    }

    try {
      await peerConnection.setLocalDescription(offer);
    } catch (error) {
      throw toRealtimeWebrtcError(
        "failed to set local WebRTC description",
        error,
      );
    }

    const offerSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
    if (typeof offerSdp !== "string" || offerSdp.length === 0) {
      throw RealtimeWebrtcError.withMessage(
        "failed to create WebRTC offer: missing SDP",
      );
    }
    return { peerConnection, mediaStream, offerSdp };
  } catch (error) {
    cleanupStartedPeerConnection(peerConnection, mediaStream);
    if (error instanceof RealtimeWebrtcError) throw error;
    const prefix =
      peerConnection === null
        ? "failed to create WebRTC peer connection"
        : "failed to open realtime WebRTC audio input";
    throw toRealtimeWebrtcError(prefix, error);
  }
}

function cleanupStartedPeerConnection(
  peerConnection: RealtimeWebrtcPeerConnection | null,
  mediaStream: RealtimeWebrtcMediaStream | null,
): void {
  if (mediaStream !== null) {
    for (const track of mediaStream.getAudioTracks()) {
      track.stop?.();
    }
  }
  try {
    peerConnection?.close();
  } catch {
    return;
  }
}

async function applyAnswer(
  peerConnection: RealtimeWebrtcPeerConnection,
  answerSdp: string,
): Promise<void> {
  validateAnswerSdp(answerSdp);
  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });
}

export async function localAudioLevel(
  peerConnection: Pick<RealtimeWebrtcPeerConnection, "getStats">,
): Promise<number | null> {
  if (peerConnection.getStats === undefined) return null;
  let stats: unknown;
  try {
    stats = await peerConnection.getStats();
  } catch {
    return null;
  }
  for (const stat of realtimeWebrtcStatsValues(stats)) {
    const audioLevel = realtimeWebrtcAudioLevelFromStat(stat);
    if (audioLevel !== null) return audioLevelToPeak(audioLevel);
  }
  return null;
}

export function audioLevelToPeak(audioLevel: number): number {
  if (!Number.isFinite(audioLevel)) return 0;
  return Math.round(Math.max(0, Math.min(1, audioLevel)) * 32_767);
}

function resolveRealtimeWebrtcRuntime(
  runtime: RealtimeWebrtcRuntimeSupport | undefined,
): ResolvedRealtimeWebrtcRuntime {
  const defaults = defaultRealtimeWebrtcRuntime();
  const createPeerConnection =
    runtime?.createPeerConnection ?? defaults.createPeerConnection;
  const getUserMedia = runtime?.getUserMedia ?? defaults.getUserMedia;
  if (createPeerConnection === undefined || getUserMedia === undefined) {
    throw RealtimeWebrtcError.unsupportedPlatform();
  }
  return {
    createPeerConnection,
    getUserMedia,
    setInterval: runtime?.setInterval ?? defaults.setInterval ?? setInterval,
    clearInterval:
      runtime?.clearInterval ?? defaults.clearInterval ?? clearInterval,
  };
}

function defaultRealtimeWebrtcRuntime(): RealtimeWebrtcRuntimeSupport {
  const global = globalThis as {
    readonly RTCPeerConnection?:
      | (new () => RealtimeWebrtcPeerConnection)
      | undefined;
    readonly webkitRTCPeerConnection?:
      | (new () => RealtimeWebrtcPeerConnection)
      | undefined;
    readonly navigator?:
      | {
          readonly mediaDevices?:
            | {
                readonly getUserMedia?:
                  | ((constraints: {
                      readonly audio: true;
                      readonly video: false;
                    }) => Promise<RealtimeWebrtcMediaStream>)
                  | undefined;
              }
            | undefined;
        }
      | undefined;
  };
  const PeerConnection =
    global.RTCPeerConnection ?? global.webkitRTCPeerConnection;
  const mediaDevices = global.navigator?.mediaDevices;
  return {
    ...(PeerConnection !== undefined
      ? { createPeerConnection: () => new PeerConnection() }
      : {}),
    ...(mediaDevices?.getUserMedia !== undefined
      ? { getUserMedia: mediaDevices.getUserMedia.bind(mediaDevices) }
      : {}),
    setInterval,
    clearInterval,
  };
}

function realtimeWebrtcStatsValues(stats: unknown): readonly unknown[] {
  if (stats === null || stats === undefined) return [];
  const iterable = stats as Partial<Iterable<unknown>>;
  if (typeof iterable[Symbol.iterator] === "function") {
    return Array.from(iterable as Iterable<unknown>, (entry) => {
      if (Array.isArray(entry) && entry.length === 2) return entry[1];
      return entry;
    });
  }
  const forEachable = stats as {
    forEach?: (callback: (value: unknown) => void) => void;
  };
  if (typeof forEachable.forEach === "function") {
    const values: unknown[] = [];
    forEachable.forEach((value) => {
      values.push(value);
    });
    return values;
  }
  return [];
}

function realtimeWebrtcAudioLevelFromStat(stat: unknown): number | null {
  if (stat === null || typeof stat !== "object") return null;
  const record = stat as Record<string, unknown>;
  if (
    record.type === "media-source" &&
    record.kind === "audio" &&
    typeof record.audioLevel === "number"
  ) {
    return record.audioLevel;
  }
  const source = record.source as Record<string, unknown> | undefined;
  const audio = record.audio as Record<string, unknown> | undefined;
  if (source?.kind === "audio" && typeof audio?.audio_level === "number") {
    return audio.audio_level;
  }
  return null;
}

function realtimeWebrtcConnectionState(
  peerConnection: RealtimeWebrtcPeerConnection,
): "closed" | "failed" | "other" {
  const state =
    peerConnection.connectionState ?? peerConnection.iceConnectionState;
  if (state === "closed") return "closed";
  if (state === "failed") return "failed";
  return "other";
}

function toRealtimeWebrtcError(
  prefix: string,
  error: unknown,
): RealtimeWebrtcError {
  if (error instanceof RealtimeWebrtcError) return error;
  return RealtimeWebrtcError.withMessage(`${prefix}: ${errorMessage(error)}`);
}

function unrefTimer(timer: RealtimeWebrtcTimer): void {
  if (timer === null || typeof timer !== "object") return;
  const maybeTimer = timer as { unref?: unknown };
  if (typeof maybeTimer.unref === "function") maybeTimer.unref();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateAnswerSdp(answerSdp: string): void {
  if (typeof answerSdp !== "string" || answerSdp.trim().length === 0) {
    throw RealtimeWebrtcError.withMessage(
      "failed to parse WebRTC answer SDP: missing SDP",
    );
  }
  const lines = answerSdp
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines[0] !== "v=0") {
    throw RealtimeWebrtcError.withMessage(
      "failed to parse WebRTC answer SDP: missing v=0 line",
    );
  }
  if (!lines.some((line) => line.startsWith("m="))) {
    throw RealtimeWebrtcError.withMessage(
      "failed to parse WebRTC answer SDP: missing media section",
    );
  }
}
