import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  ThreadRealtimeAppendAudioParams,
  ThreadRealtimeAudioChunk,
  ThreadRealtimeOutputModality,
  ThreadRealtimeStartParams,
  ThreadRealtimeStopParams,
  ThreadRealtimeVoice,
} from "../../app-server/protocol/index.js";
import {
  RealtimeWebrtcSession,
  type RealtimeWebrtcEvent,
  type StartedRealtimeWebrtcSession,
} from "../../conversation/realtime/webrtc/lib.js";
import {
  createProcessRealtimeAudioPlayer,
  startDefaultRealtimeAudioCapture,
  type RealtimeAudioCaptureSession,
  type RealtimeAudioPlayer,
  type StartRealtimeAudioCapture,
} from "./audio.js";
import { logError } from "../../utils/log.js";
import { isRecord } from "../../utils/record.js";
import {
  effectiveRealtimeMicrophoneMuted,
  initialRealtimeTuiState,
  reduceRealtimeTuiState,
  type RealtimeTuiEvent,
  type RealtimeTuiState,
  type RealtimeTuiTransport,
} from "./state.js";

export interface RealtimeDaemonRequestClient {
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
  ): Promise<AgenCDaemonResultByMethod[Method]>;
}

export interface RealtimeStartOptions {
  readonly transport?: RealtimeTuiTransport;
  readonly realtimeSessionId?: string | null;
  readonly prompt?: string | null;
  readonly outputModality?: ThreadRealtimeOutputModality;
  readonly voice?: ThreadRealtimeVoice | null;
}

export interface AgenCRealtimeTuiControls {
  start(options?: RealtimeStartOptions): Promise<void>;
  stop(): Promise<void>;
  appendText(text: string): Promise<void>;
  appendAudio(audio: ThreadRealtimeAudioChunk): Promise<void>;
  setMuted(muted: boolean): void;
  setPushToTalk(enabled: boolean): void;
  setPushToTalkHeld(held: boolean): void;
  getState(): RealtimeTuiState;
  subscribe(cb: (state: RealtimeTuiState) => void): () => void;
  handleTranscriptEvent(event: unknown): void;
}

export interface CreateRealtimeTuiControlsOptions {
  readonly threadId: string;
  readonly client: RealtimeDaemonRequestClient;
  readonly emitEvent: (event: JsonObject) => void;
  readonly startWebrtcSession?: () => Promise<StartedRealtimeWebrtcSession>;
  readonly startAudioCapture?: StartRealtimeAudioCapture;
  readonly audioPlayer?: RealtimeAudioPlayer;
}

export function createRealtimeTuiControls(
  options: CreateRealtimeTuiControlsOptions,
): AgenCRealtimeTuiControls {
  return new RealtimeTuiController(options);
}

class RealtimeTuiController implements AgenCRealtimeTuiControls {
  readonly #threadId: string;
  readonly #client: RealtimeDaemonRequestClient;
  readonly #emitEvent: (event: JsonObject) => void;
  readonly #startWebrtcSession: () => Promise<StartedRealtimeWebrtcSession>;
  readonly #startAudioCapture: StartRealtimeAudioCapture;
  readonly #audioPlayer: RealtimeAudioPlayer;
  readonly #subscribers = new Set<(state: RealtimeTuiState) => void>();
  #state = initialRealtimeTuiState();
  #webRtc: StartedRealtimeWebrtcSession | null = null;
  #audioCapture: RealtimeAudioCaptureSession | null = null;
  #eventSequence = 0;
  #lifecycleOperation: Promise<void> = Promise.resolve();

  constructor(options: CreateRealtimeTuiControlsOptions) {
    this.#threadId = options.threadId;
    this.#client = options.client;
    this.#emitEvent = options.emitEvent;
    this.#startWebrtcSession =
      options.startWebrtcSession ?? (() => RealtimeWebrtcSession.start());
    this.#startAudioCapture =
      options.startAudioCapture ?? startDefaultRealtimeAudioCapture;
    this.#audioPlayer = options.audioPlayer ?? createProcessRealtimeAudioPlayer();
  }

  async start(options: RealtimeStartOptions = {}): Promise<void> {
    await this.#runLifecycleOperation(() => this.#start(options));
  }

  async stop(): Promise<void> {
    await this.#runLifecycleOperation(() => this.#stop());
  }

  async #runLifecycleOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.#lifecycleOperation.then(operation, operation);
    this.#lifecycleOperation = next.catch(() => {});
    await next;
  }

  async #start(options: RealtimeStartOptions = {}): Promise<void> {
    if (this.#state.phase === "starting" || this.#state.phase === "active") {
      return;
    }
    const transport = options.transport ?? "websocket";
    this.#dispatch({ type: "start_requested", transport });
    let startedWebRtc: StartedRealtimeWebrtcSession | null = null;
    let daemonStarted = false;
    try {
      const requestTransport =
        transport === "webrtc"
          ? await this.#startWebrtcTransport()
          : { type: "websocket" as const };
      startedWebRtc = this.#webRtc;
      await this.#client.request("thread/realtime/start", {
        threadId: this.#threadId,
        transport: requestTransport,
        realtimeSessionId: options.realtimeSessionId ?? null,
        prompt: options.prompt ?? null,
        outputModality: options.outputModality ?? "audio",
        voice: options.voice ?? null,
      } satisfies ThreadRealtimeStartParams);
      daemonStarted = true;
      if (transport === "websocket") {
        await this.#startWebsocketAudioCapture();
      }
    } catch (error) {
      await this.#stopAudioCapture().catch(logError);
      if (startedWebRtc !== null) {
        await this.#closeWebrtc(startedWebRtc).catch(logError);
      }
      if (this.#webRtc === startedWebRtc) this.#webRtc = null;
      if (daemonStarted) await this.#requestDaemonStop();
      const message = error instanceof Error ? error.message : String(error);
      this.#dispatch({ type: "start_failed", message });
      this.#emitLocal("realtime_error", { threadId: this.#threadId, message });
      throw error;
    }
  }

  async #stop(): Promise<void> {
    if (this.#state.phase === "inactive") return;
    this.#dispatch({ type: "stop_requested" });
    let localCleanupError: unknown = null;
    await this.#stopAudioCapture().catch((error) => {
      localCleanupError = error;
    });
    const webRtc = this.#webRtc;
    this.#webRtc = null;
    if (webRtc !== null) {
      await this.#closeWebrtc(webRtc).catch((error) => {
        localCleanupError ??= error;
      });
    }
    let daemonStopError: unknown = null;
    try {
      await this.#client.request("thread/realtime/stop", {
        threadId: this.#threadId,
      } satisfies ThreadRealtimeStopParams);
    } catch (error) {
      daemonStopError = error;
    }
    try {
      this.#audioPlayer.close();
    } catch (error) {
      localCleanupError ??= error;
    }
    if (daemonStopError !== null) {
      this.#surfaceRealtimeError(daemonStopError, "Realtime stop failed");
      throw daemonStopError;
    }
    if (localCleanupError !== null) {
      const message = this.#surfaceRealtimeError(
        localCleanupError,
        "Realtime cleanup failed",
      );
      throw errorFromUnknown(localCleanupError, message);
    }
    this.#dispatch({ type: "closed", reason: "requested" });
  }

  async appendText(text: string): Promise<void> {
    if (!this.#canAppendRealtimeInput()) return;
    await this.#client.request("thread/realtime/appendText", {
      threadId: this.#threadId,
      text,
    });
  }

  async appendAudio(audio: ThreadRealtimeAudioChunk): Promise<void> {
    if (!this.#canAppendRealtimeInput()) return;
    if (effectiveRealtimeMicrophoneMuted(this.#state)) return;
    await this.#client.request("thread/realtime/appendAudio", {
      threadId: this.#threadId,
      audio,
    } satisfies ThreadRealtimeAppendAudioParams);
  }

  setMuted(muted: boolean): void {
    const previousMuted = this.#state.muted;
    this.#dispatch({ type: "muted_changed", muted });
    this.#applyMicrophoneMutedWithRollback(() => {
      this.#dispatch({ type: "muted_changed", muted: previousMuted });
    });
  }

  setPushToTalk(enabled: boolean): void {
    const previousEnabled = this.#state.pushToTalk;
    const previousHeld = this.#state.pushToTalkHeld;
    this.#dispatch({ type: "push_to_talk_changed", enabled });
    this.#applyMicrophoneMutedWithRollback(() => {
      this.#dispatch({
        type: "push_to_talk_changed",
        enabled: previousEnabled,
      });
      this.#dispatch({
        type: "push_to_talk_held_changed",
        held: previousHeld,
      });
    });
  }

  setPushToTalkHeld(held: boolean): void {
    const previousHeld = this.#state.pushToTalkHeld;
    this.#dispatch({ type: "push_to_talk_held_changed", held });
    this.#applyMicrophoneMutedWithRollback(() => {
      this.#dispatch({
        type: "push_to_talk_held_changed",
        held: previousHeld,
      });
    });
  }

  getState(): RealtimeTuiState {
    return this.#state;
  }

  subscribe(cb: (state: RealtimeTuiState) => void): () => void {
    this.#subscribers.add(cb);
    cb(this.#state);
    return () => {
      this.#subscribers.delete(cb);
    };
  }

  handleTranscriptEvent(event: unknown): void {
    if (!isJsonObject(event) || typeof event.type !== "string") return;
    const payload = isJsonObject(event.payload) ? event.payload : {};
    switch (event.type) {
      case "realtime_started":
        this.#dispatch({
          type: "started",
          realtimeSessionId:
            typeof payload.realtimeSessionId === "string"
              ? payload.realtimeSessionId
              : null,
        });
        break;
      case "realtime_sdp":
        if (!this.#canApplyRealtimeSessionEvent()) return;
        if (typeof payload.sdp === "string") {
          void this.#applyProviderSdp(payload.sdp);
        }
        break;
      case "realtime_output_audio_delta":
        if (!this.#canApplyRealtimeSessionEvent()) return;
        if (isJsonObject(payload.audio)) {
          const audio = toRealtimeAudioChunk(payload.audio);
          if (audio !== null) this.#audioPlayer.enqueue(audio);
        }
        break;
      case "realtime_transcript_delta":
        if (!this.#canApplyRealtimeSessionEvent()) return;
        if (
          typeof payload.role === "string" &&
          typeof payload.delta === "string"
        ) {
          this.#dispatch({
            type: "transcript_delta",
            role: payload.role,
            delta: payload.delta,
          });
        }
        break;
      case "realtime_transcript_done":
        if (!this.#canApplyRealtimeSessionEvent()) return;
        if (
          typeof payload.role === "string" &&
          typeof payload.text === "string"
        ) {
          this.#dispatch({
            type: "transcript_done",
            role: payload.role,
            text: payload.text,
          });
        }
        break;
      case "realtime_item_added":
        if (!this.#canApplyRealtimeSessionEvent()) return;
        this.#dispatch({ type: "item_added", item: payload.item ?? null });
        break;
      case "realtime_error":
        void this.#stopAudioCapture().catch(logError);
        this.#closeActiveWebrtc();
        this.#closeAudioPlayerBestEffort();
        this.#dispatch({
          type: "error",
          message:
            typeof payload.message === "string"
              ? payload.message
              : "Realtime error",
        });
        break;
      case "realtime_closed":
        void this.#stopAudioCapture().catch(logError);
        this.#closeActiveWebrtc();
        this.#closeAudioPlayerBestEffort();
        this.#dispatch({
          type: "closed",
          reason: typeof payload.reason === "string" ? payload.reason : null,
        });
        break;
      case "realtime_local_audio_level":
        if (!this.#canApplyRealtimeSessionEvent()) return;
        if (typeof payload.peak === "number") {
          this.#dispatch({ type: "local_audio_level", peak: payload.peak });
        }
        break;
    }
  }

  async #startWebrtcTransport(): Promise<{ readonly type: "webrtc"; readonly sdp: string }> {
    const started = await this.#startWebrtcSession();
    this.#webRtc = started;
    void this.#consumeWebrtcEvents(started);
    await this.#applyMicrophoneMuted();
    return { type: "webrtc", sdp: started.offerSdp };
  }

  async #consumeWebrtcEvents(started: StartedRealtimeWebrtcSession): Promise<void> {
    for await (const event of started.events) {
      if (this.#webRtc !== started) return;
      this.#handleWebrtcEvent(event);
    }
  }

  #handleWebrtcEvent(event: RealtimeWebrtcEvent): void {
    switch (event.type) {
      case "connected":
        this.#dispatch({ type: "connected" });
        break;
      case "local_audio_level":
        this.#dispatch({ type: "local_audio_level", peak: event.peak });
        this.#emitLocal("realtime_local_audio_level", {
          threadId: this.#threadId,
          peak: event.peak,
        });
        break;
      case "closed": {
        const requestedClose = this.#state.requestedClose;
        this.#webRtc = null;
        this.#dispatch({ type: "closed", reason: "webrtc_closed" });
        this.#emitLocal("realtime_closed", {
          threadId: this.#threadId,
          reason: "webrtc_closed",
        });
        if (!requestedClose) void this.#requestDaemonStop();
        break;
      }
      case "failed": {
        const requestedClose = this.#state.requestedClose;
        this.#webRtc = null;
        this.#dispatch({ type: "error", message: event.message });
        this.#emitLocal("realtime_error", {
          threadId: this.#threadId,
          message: event.message,
        });
        if (!requestedClose) void this.#requestDaemonStop();
        break;
      }
    }
  }

  async #applyMicrophoneMuted(): Promise<void> {
    const muted = effectiveRealtimeMicrophoneMuted(this.#state);
    await this.#webRtc?.handle.setMicrophoneMuted?.(muted);
  }

  #applyMicrophoneMutedWithRollback(rollback: () => void): void {
    const started = this.#webRtc;
    void this.#applyMicrophoneMuted().catch((error) => {
      rollback();
      if (started !== null && this.#webRtc === started) {
        this.#webRtc = null;
        void this.#closeWebrtc(started).catch(logError);
      }
      this.#closeAudioPlayerBestEffort();
      void this.#requestDaemonStop();
      this.#surfaceRealtimeError(error, "Realtime microphone state failed");
    });
  }

  #canAppendRealtimeInput(): boolean {
    return this.#state.phase === "starting" || this.#state.phase === "active";
  }

  #canApplyRealtimeSessionEvent(): boolean {
    return (
      !this.#state.requestedClose &&
      (this.#state.phase === "starting" || this.#state.phase === "active")
    );
  }

  async #handleRealtimeInputFailure(
    error: unknown,
    fallback: string,
  ): Promise<void> {
    if (this.#state.requestedClose || this.#state.phase === "inactive") return;
    await this.#stopAudioCapture().catch(logError);
    this.#closeActiveWebrtc();
    this.#closeAudioPlayerBestEffort();
    this.#surfaceRealtimeError(error, fallback);
    await this.#requestDaemonStop();
  }

  #closeAudioPlayerBestEffort(): void {
    try {
      this.#audioPlayer.close();
    } catch (error) {
      // Audio output cleanup must not tear down daemon notification handling.
      logError(error);
    }
  }

  async #startWebsocketAudioCapture(): Promise<void> {
    await this.#stopAudioCapture();
    this.#audioCapture = await this.#startAudioCapture({
      onAudio: (audio) => {
        void this.appendAudio(audio).catch((error) => {
          void this.#handleRealtimeInputFailure(
            error,
            "Realtime audio append failed",
          );
        });
      },
      onLevel: (peak) => {
        this.#dispatch({ type: "local_audio_level", peak });
        this.#emitLocal("realtime_local_audio_level", {
          threadId: this.#threadId,
          peak,
        });
      },
      onError: (message) => {
        void this.#handleCaptureTerminal("error", message);
      },
      onClosed: () => {
        void this.#handleCaptureTerminal("closed", "audio_capture_closed");
      },
    });
  }

  async #handleCaptureTerminal(
    kind: "error" | "closed",
    message: string,
  ): Promise<void> {
    if (this.#state.requestedClose || this.#state.phase === "inactive") return;
    await this.#stopAudioCapture().catch(logError);
    this.#closeAudioPlayerBestEffort();
    if (kind === "error") {
      this.#surfaceRealtimeError(message, "Realtime audio capture failed");
    } else {
      this.#dispatch({ type: "closed", reason: message });
      this.#emitLocal("realtime_closed", {
        threadId: this.#threadId,
        reason: message,
      });
    }
    await this.#requestDaemonStop();
  }

  async #stopAudioCapture(): Promise<void> {
    const capture = this.#audioCapture;
    if (capture === null) return;
    this.#audioCapture = null;
    await capture.stop();
  }

  async #requestDaemonStop(): Promise<void> {
    await this.#client
      .request("thread/realtime/stop", {
        threadId: this.#threadId,
      } satisfies ThreadRealtimeStopParams)
      .catch(logError);
  }

  async #applyProviderSdp(sdp: string): Promise<void> {
    const started = this.#webRtc;
    if (started === null) return;
    try {
      await started.handle.applyAnswerSdp(sdp);
    } catch (error) {
      if (this.#webRtc === started) this.#webRtc = null;
      await this.#closeWebrtc(started).catch(logError);
      this.#closeAudioPlayerBestEffort();
      this.#surfaceRealtimeError(error, "Realtime SDP failed");
      await this.#requestDaemonStop();
    }
  }

  async #closeWebrtc(started: StartedRealtimeWebrtcSession): Promise<void> {
    started.events.close?.();
    await started.handle.close();
  }

  #closeActiveWebrtc(): void {
    const started = this.#webRtc;
    if (started === null) return;
    this.#webRtc = null;
    void this.#closeWebrtc(started).catch(logError);
  }

  #surfaceRealtimeError(error: unknown, fallback: string): string {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string" && error.trim().length > 0
          ? error
          : fallback;
    this.#dispatch({ type: "error", message });
    this.#emitLocal("realtime_error", { threadId: this.#threadId, message });
    return message;
  }

  #dispatch(event: RealtimeTuiEvent): void {
    this.#state = reduceRealtimeTuiState(this.#state, event);
    for (const subscriber of [...this.#subscribers]) {
      subscriber(this.#state);
    }
  }

  #emitLocal(type: string, payload: JsonObject): void {
    this.#eventSequence += 1;
    this.#emitEvent({
      id: `realtime-local-${this.#eventSequence}`,
      type,
      payload,
    });
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function toRealtimeAudioChunk(value: JsonObject): ThreadRealtimeAudioChunk | null {
  if (
    typeof value.data !== "string" ||
    typeof value.sampleRate !== "number" ||
    typeof value.numChannels !== "number"
  ) {
    return null;
  }
  return {
    data: value.data,
    sampleRate: value.sampleRate,
    numChannels: value.numChannels,
    samplesPerChannel:
      typeof value.samplesPerChannel === "number"
        ? value.samplesPerChannel
        : null,
    itemId: typeof value.itemId === "string" ? value.itemId : null,
  };
}

function errorFromUnknown(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}
