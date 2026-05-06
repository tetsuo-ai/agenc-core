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
  readonly #subscribers = new Set<(state: RealtimeTuiState) => void>();
  #state = initialRealtimeTuiState();
  #webRtc: StartedRealtimeWebrtcSession | null = null;
  #eventSequence = 0;

  constructor(options: CreateRealtimeTuiControlsOptions) {
    this.#threadId = options.threadId;
    this.#client = options.client;
    this.#emitEvent = options.emitEvent;
    this.#startWebrtcSession =
      options.startWebrtcSession ?? (() => RealtimeWebrtcSession.start());
  }

  async start(options: RealtimeStartOptions = {}): Promise<void> {
    if (this.#state.phase === "starting" || this.#state.phase === "active") {
      return;
    }
    const transport = options.transport ?? "websocket";
    this.#dispatch({ type: "start_requested", transport });
    let startedWebRtc: StartedRealtimeWebrtcSession | null = null;
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
    } catch (error) {
      if (startedWebRtc !== null) {
        await this.#closeWebrtc(startedWebRtc).catch(() => {});
      }
      if (this.#webRtc === startedWebRtc) this.#webRtc = null;
      const message = error instanceof Error ? error.message : String(error);
      this.#dispatch({ type: "start_failed", message });
      this.#emitLocal("realtime_error", { threadId: this.#threadId, message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state.phase === "inactive") return;
    this.#dispatch({ type: "stop_requested" });
    const webRtc = this.#webRtc;
    this.#webRtc = null;
    if (webRtc !== null) {
      await this.#closeWebrtc(webRtc).catch(() => {});
    }
    try {
      await this.#client.request("thread/realtime/stop", {
        threadId: this.#threadId,
      } satisfies ThreadRealtimeStopParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#dispatch({ type: "error", message });
      this.#emitLocal("realtime_error", { threadId: this.#threadId, message });
      throw error;
    }
  }

  async appendText(text: string): Promise<void> {
    await this.#client.request("thread/realtime/appendText", {
      threadId: this.#threadId,
      text,
    });
  }

  async appendAudio(audio: ThreadRealtimeAudioChunk): Promise<void> {
    if (effectiveRealtimeMicrophoneMuted(this.#state)) return;
    await this.#client.request("thread/realtime/appendAudio", {
      threadId: this.#threadId,
      audio,
    } satisfies ThreadRealtimeAppendAudioParams);
  }

  setMuted(muted: boolean): void {
    this.#dispatch({ type: "muted_changed", muted });
    void this.#applyMicrophoneMuted().catch(() => {});
  }

  setPushToTalk(enabled: boolean): void {
    this.#dispatch({ type: "push_to_talk_changed", enabled });
    void this.#applyMicrophoneMuted().catch(() => {});
  }

  setPushToTalkHeld(held: boolean): void {
    this.#dispatch({ type: "push_to_talk_held_changed", held });
    void this.#applyMicrophoneMuted().catch(() => {});
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
        if (typeof payload.sdp === "string") {
          void this.#applyProviderSdp(payload.sdp);
        }
        break;
      case "realtime_transcript_delta":
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
        this.#dispatch({ type: "item_added", item: payload.item ?? null });
        break;
      case "realtime_error":
        this.#closeActiveWebrtc();
        this.#dispatch({
          type: "error",
          message:
            typeof payload.message === "string"
              ? payload.message
              : "Realtime error",
        });
        break;
      case "realtime_closed":
        this.#closeActiveWebrtc();
        this.#dispatch({
          type: "closed",
          reason: typeof payload.reason === "string" ? payload.reason : null,
        });
        break;
      case "realtime_local_audio_level":
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
        break;
      case "local_audio_level":
        this.#dispatch({ type: "local_audio_level", peak: event.peak });
        this.#emitLocal("realtime_local_audio_level", {
          threadId: this.#threadId,
          peak: event.peak,
        });
        break;
      case "closed":
        this.#webRtc = null;
        this.#dispatch({ type: "closed", reason: "webrtc_closed" });
        this.#emitLocal("realtime_closed", {
          threadId: this.#threadId,
          reason: "webrtc_closed",
        });
        break;
      case "failed":
        this.#webRtc = null;
        this.#dispatch({ type: "error", message: event.message });
        this.#emitLocal("realtime_error", {
          threadId: this.#threadId,
          message: event.message,
        });
        break;
    }
  }

  async #applyMicrophoneMuted(): Promise<void> {
    const muted = effectiveRealtimeMicrophoneMuted(this.#state);
    await this.#webRtc?.handle.setMicrophoneMuted?.(muted);
  }

  async #applyProviderSdp(sdp: string): Promise<void> {
    const started = this.#webRtc;
    if (started === null) return;
    try {
      await started.handle.applyAnswerSdp(sdp);
    } catch (error) {
      if (this.#webRtc === started) this.#webRtc = null;
      await this.#closeWebrtc(started).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.#dispatch({ type: "error", message });
      this.#emitLocal("realtime_error", { threadId: this.#threadId, message });
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
    void this.#closeWebrtc(started).catch(() => {});
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
