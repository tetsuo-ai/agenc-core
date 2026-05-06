/**
 * Ports upstream runtime `realtime-webrtc/src/lib.rs` onto AgenC's
 * TypeScript realtime WebRTC session surface.
 *
 * Shape difference from upstream:
 *   - AgenC uses WebRTC APIs provided by the host Node/Electron runtime. When
 *     those APIs are absent, `RealtimeWebrtcSession.start()` preserves the
 *     upstream unsupported-platform error.
 */

import { AsyncQueue } from "../../../utils/async-queue.js";
import {
  startNativeRealtimeWebrtcSession,
  type RealtimeWebrtcNativeSessionHandle,
  type RealtimeWebrtcNativeStartOptions,
} from "./native.js";

export const REALTIME_WEBRTC_UNSUPPORTED_PLATFORM_MESSAGE =
  "realtime WebRTC is not supported on this platform";

export type RealtimeWebrtcErrorKind = "message" | "unsupported_platform";

export class RealtimeWebrtcError extends Error {
  readonly kind: RealtimeWebrtcErrorKind;

  private constructor(kind: RealtimeWebrtcErrorKind, message: string) {
    super(message);
    this.name = "RealtimeWebrtcError";
    this.kind = kind;
  }

  static withMessage(message: string): RealtimeWebrtcError {
    return new RealtimeWebrtcError("message", message);
  }

  static unsupportedPlatform(): RealtimeWebrtcError {
    return new RealtimeWebrtcError(
      "unsupported_platform",
      REALTIME_WEBRTC_UNSUPPORTED_PLATFORM_MESSAGE,
    );
  }
}

export function isRealtimeWebrtcUnsupportedPlatform(
  error: unknown,
): error is RealtimeWebrtcError {
  return (
    error instanceof RealtimeWebrtcError &&
    error.kind === "unsupported_platform"
  );
}

export type RealtimeWebrtcEvent =
  | { readonly type: "connected" }
  | { readonly type: "local_audio_level"; readonly peak: number }
  | { readonly type: "closed" }
  | { readonly type: "failed"; readonly message: string };

export class RealtimeWebrtcEventReceiver implements AsyncIterable<RealtimeWebrtcEvent> {
  readonly #queue: AsyncQueue<RealtimeWebrtcEvent>;

  constructor(queue: AsyncQueue<RealtimeWebrtcEvent>) {
    this.#queue = queue;
  }

  recv(): Promise<RealtimeWebrtcEvent | null> {
    return this.#queue.recv();
  }

  tryRecv(): RealtimeWebrtcEvent | null | undefined {
    return this.#queue.tryRecv();
  }

  close(): void {
    this.#queue.close();
  }

  stream(): AsyncIterable<RealtimeWebrtcEvent> {
    return this.#queue.stream();
  }

  [Symbol.asyncIterator](): AsyncIterator<RealtimeWebrtcEvent> {
    return this.stream()[Symbol.asyncIterator]();
  }
}

export interface RealtimeWebrtcEventSender {
  send(event: RealtimeWebrtcEvent): boolean;
  close(): void;
}

export function createRealtimeWebrtcEventChannel(): {
  readonly receiver: RealtimeWebrtcEventReceiver;
  readonly sender: RealtimeWebrtcEventSender;
} {
  const queue = new AsyncQueue<RealtimeWebrtcEvent>();
  return {
    receiver: new RealtimeWebrtcEventReceiver(queue),
    sender: {
      send: (event) => queue.send(event),
      close: () => queue.close(),
    },
  };
}

export class RealtimeWebrtcLocalAudioPeak {
  #value = 0;

  load(): number {
    return this.#value;
  }

  store(value: number): void {
    this.#value = clampRealtimeWebrtcPeak(value);
  }
}

export interface RealtimeWebrtcSessionHandleDriver {
  applyAnswerSdp(answerSdp: string): Promise<void> | void;
  setMicrophoneMuted?(muted: boolean): Promise<void> | void;
  close(): Promise<void> | void;
}

export class RealtimeWebrtcSessionHandle {
  readonly #driver: RealtimeWebrtcSessionHandleDriver;
  readonly #localAudioPeak: RealtimeWebrtcLocalAudioPeak;

  constructor(
    driver: RealtimeWebrtcSessionHandleDriver,
    localAudioPeak = new RealtimeWebrtcLocalAudioPeak(),
  ) {
    this.#driver = driver;
    this.#localAudioPeak = localAudioPeak;
  }

  applyAnswerSdp(answerSdp: string): Promise<void> | void {
    return this.#driver.applyAnswerSdp(answerSdp);
  }

  setMicrophoneMuted(muted: boolean): Promise<void> | void {
    return this.#driver.setMicrophoneMuted?.(muted);
  }

  close(): Promise<void> | void {
    return this.#driver.close();
  }

  localAudioPeak(): RealtimeWebrtcLocalAudioPeak {
    return this.#localAudioPeak;
  }
}

export interface StartedRealtimeWebrtcSession {
  readonly offerSdp: string;
  readonly handle: RealtimeWebrtcSessionHandle;
  readonly events: RealtimeWebrtcEventReceiver;
}

export interface RealtimeWebrtcSessionStartOptions extends RealtimeWebrtcNativeStartOptions {}

export class RealtimeWebrtcSession {
  static async start(
    options: RealtimeWebrtcSessionStartOptions = {},
  ): Promise<StartedRealtimeWebrtcSession> {
    const started = await startNativeRealtimeWebrtcSession(options);
    return {
      offerSdp: started.offerSdp,
      handle: new RealtimeWebrtcSessionHandle(
        started.handle,
        started.localAudioPeak,
      ),
      events: started.events,
    };
  }
}

export function realtimeWebrtcWorkerStoppedError(): RealtimeWebrtcError {
  return RealtimeWebrtcError.withMessage("realtime WebRTC worker stopped");
}

function clampRealtimeWebrtcPeak(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(65_535, Math.round(value)));
}

export type { RealtimeWebrtcNativeSessionHandle };
