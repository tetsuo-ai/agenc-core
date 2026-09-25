import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { ThreadRealtimeAudioChunk } from "../../app-server/protocol/index.js";
import type { RealtimePlaybackBackend } from "../../services/voice.js";
import { isSignalablePid } from "../../utils/child-signal.js";

export interface RealtimeAudioCaptureCallbacks {
  readonly onAudio: (audio: ThreadRealtimeAudioChunk) => void;
  readonly onLevel: (peak: number) => void;
  readonly onError: (message: string) => void;
  readonly onClosed: () => void;
}

export interface RealtimeAudioCaptureSession {
  stop(): void | Promise<void>;
}

export type StartRealtimeAudioCapture = (
  callbacks: RealtimeAudioCaptureCallbacks,
) => Promise<RealtimeAudioCaptureSession>;

export interface RealtimeAudioPlayer {
  enqueue(audio: ThreadRealtimeAudioChunk): void;
  close(): void;
  /** Clears a permanent-unavailable latch and installs the backend resolved at readiness. */
  beginSession?(backend: RealtimePlaybackBackend | null): void;
}

export type RealtimeAudioPlayerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type { RealtimePlaybackBackend };

export interface CreateProcessRealtimeAudioPlayerOptions {
  readonly onError?: (message: string) => void;
  /** Backend already resolved at readiness. enqueue never probes PATH. */
  readonly backend?: RealtimePlaybackBackend | null;
}

const INPUT_SAMPLE_RATE = 16_000;
const INPUT_CHANNELS = 1;
const MAX_OUTPUT_QUEUE_BYTES = 512 * 1024;
const MAX_OUTPUT_ENCODED_BYTES = Math.ceil(MAX_OUTPUT_QUEUE_BYTES / 3) * 4;
const MAX_OUTPUT_SAMPLE_RATE = 384_000;
const MAX_OUTPUT_CHANNELS = 8;
const BASE64_AUDIO_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export async function startDefaultRealtimeAudioCapture(
  callbacks: RealtimeAudioCaptureCallbacks,
): Promise<RealtimeAudioCaptureSession> {
  const voice = await import("../../services/voice.js");
  const availability = await voice.checkRecordingAvailability();
  if (!availability.available) {
    throw new Error(availability.reason ?? "Audio recording is not available");
  }
  const playback = await voice.checkPlaybackAvailability();
  if (!playback.available) {
    throw new Error(playback.reason ?? "Audio playback is not available");
  }
  const started = await voice.startRecording(
    (chunk: Buffer) => {
      callbacks.onAudio(pcmBufferToRealtimeAudioChunk(chunk));
      callbacks.onLevel(pcmPeakLevel(chunk));
    },
    callbacks.onClosed,
    { silenceDetection: false },
  );
  if (!started) {
    throw new Error("Failed to start audio capture");
  }
  return {
    stop() {
      voice.stopRecording();
    },
  };
}

export function createProcessRealtimeAudioPlayer(
  spawnProcess: RealtimeAudioPlayerSpawn = spawn,
  options: CreateProcessRealtimeAudioPlayerOptions = {},
): RealtimeAudioPlayer {
  let child: ChildProcess | null = null;
  let format: { sampleRate: number; numChannels: number } | null = null;
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let waitingForDrain = false;
  // Set once `play` turns out to be missing or not executable (stock macOS
  // has no SoX). Without it every audio chunk spawned `play` again.
  // Cleared on session start so a later session can retry.
  let playerUnavailable = false;
  let backend: RealtimePlaybackBackend | null =
    options.backend === undefined ? "play" : options.backend;

  const reset = (active: ChildProcess | null): void => {
    if (active !== child) return;
    child = null;
    format = null;
    queue.length = 0;
    queuedBytes = 0;
    waitingForDrain = false;
  };

  const close = (): void => {
    const active = child;
    reset(active);
    active?.stdin?.removeAllListeners("drain");
    active?.stdin?.removeAllListeners("error");
    active?.stdin?.removeAllListeners("close");
    active?.stdin?.destroy();
    // A failed spawn has no pid, but until Node reports the failure its open
    // handle sends kill() to pid 0: the TUI's whole process group, including
    // the shell job it runs in. Its error event does the cleanup instead.
    if (active !== null && isSignalablePid(active.pid)) active.kill("SIGTERM");
  };

  const flush = (): void => {
    const active = child;
    // EMFILE and ENFILE leave a failed child's stdin undefined, not null.
    if (
      active === null ||
      active.stdin === null ||
      active.stdin === undefined ||
      active.stdin.destroyed
    ) {
      queue.length = 0;
      queuedBytes = 0;
      waitingForDrain = false;
      return;
    }
    while (queue.length > 0) {
      const chunk = queue[0]!;
      let accepted = false;
      try {
        accepted = active.stdin.write(chunk);
      } catch {
        reset(active);
        return;
      }
      queue.shift();
      queuedBytes -= chunk.length;
      if (!accepted) {
        if (!waitingForDrain) {
          waitingForDrain = true;
          active.stdin.once("drain", () => {
            waitingForDrain = false;
            flush();
          });
        }
        return;
      }
    }
  };

  const enqueueBuffer = (chunk: Buffer): void => {
    while (
      queue.length > 0 &&
      queuedBytes + chunk.length > MAX_OUTPUT_QUEUE_BYTES
    ) {
      queuedBytes -= queue.shift()!.length;
    }
    if (chunk.length > MAX_OUTPUT_QUEUE_BYTES) return;
    queue.push(chunk);
    queuedBytes += chunk.length;
    flush();
  };

  return {
    beginSession(next) {
      playerUnavailable = false;
      backend = next;
    },
    enqueue(audio) {
      if (playerUnavailable) return;
      const decoded = decodeRealtimeOutputAudioChunk(audio);
      if (decoded === null) return;
      const nextFormat = {
        sampleRate: decoded.sampleRate,
        numChannels: decoded.numChannels,
      };
      if (
        child === null ||
        format === null ||
        format.sampleRate !== nextFormat.sampleRate ||
        format.numChannels !== nextFormat.numChannels
      ) {
        close();
        const selected = backend;
        if (selected === null) {
          playerUnavailable = true;
          options.onError?.(
            "Realtime voice playback requires a local `play` (SoX) or `aplay` (ALSA) command.",
          );
          return;
        }
        child = spawnProcess(
          selected,
          playbackBackendArgs(selected, nextFormat),
          { stdio: ["pipe", "ignore", "ignore"] },
        );
        format = nextFormat;
        const active = child;
        active?.on("error", (error: NodeJS.ErrnoException) => {
          if (active !== child) return;
          const permanent = isPermanentSpawnFailure(active, error);
          if (permanent) playerUnavailable = true;
          reset(active);
          if (permanent) {
            options.onError?.(playbackFailureMessage(error, selected));
          }
        });
        active?.on("close", () => reset(active));
        active?.stdin?.on("error", () => reset(active));
        active?.stdin?.on("close", () => reset(active));
      }
      enqueueBuffer(decoded.buffer);
    },
    close,
  };
}

function isPermanentSpawnFailure(
  active: ChildProcess,
  error: NodeJS.ErrnoException,
): boolean {
  return (
    active.pid === undefined &&
    (error.code === "ENOENT" || error.code === "EACCES")
  );
}

function playbackBackendArgs(
  backend: RealtimePlaybackBackend,
  format: { sampleRate: number; numChannels: number },
): string[] {
  switch (backend) {
    case "play":
      return [
        "-q",
        "-t",
        "raw",
        "-r",
        String(format.sampleRate),
        "-e",
        "signed",
        "-b",
        "16",
        "-c",
        String(format.numChannels),
        "-",
      ];
    case "aplay":
      return [
        "-q",
        "-t",
        "raw",
        "-f",
        "S16_LE",
        "-r",
        String(format.sampleRate),
        "-c",
        String(format.numChannels),
        "-",
      ];
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unsupported playback backend: ${String(exhaustive)}`);
    }
  }
}

function playbackFailureMessage(
  error: unknown,
  backend: RealtimePlaybackBackend,
): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return `Realtime audio playback failed (${backend})`;
}

function decodeRealtimeOutputAudioChunk(
  audio: ThreadRealtimeAudioChunk,
): {
  readonly buffer: Buffer;
  readonly sampleRate: number;
  readonly numChannels: number;
} | null {
  if (!isValidOutputAudioFormat(audio.sampleRate, audio.numChannels)) {
    return null;
  }
  if (
    audio.data.length > MAX_OUTPUT_ENCODED_BYTES ||
    !BASE64_AUDIO_RE.test(audio.data)
  ) {
    return null;
  }
  const buffer = Buffer.from(audio.data, "base64");
  if (buffer.length > MAX_OUTPUT_QUEUE_BYTES) return null;
  return {
    buffer,
    sampleRate: audio.sampleRate,
    numChannels: audio.numChannels,
  };
}

function isValidOutputAudioFormat(
  sampleRate: number,
  numChannels: number,
): boolean {
  return (
    Number.isSafeInteger(sampleRate) &&
    sampleRate > 0 &&
    sampleRate <= MAX_OUTPUT_SAMPLE_RATE &&
    Number.isSafeInteger(numChannels) &&
    numChannels > 0 &&
    numChannels <= MAX_OUTPUT_CHANNELS
  );
}

export function pcmBufferToRealtimeAudioChunk(
  chunk: Buffer,
): ThreadRealtimeAudioChunk {
  return {
    data: Buffer.from(chunk).toString("base64"),
    sampleRate: INPUT_SAMPLE_RATE,
    numChannels: INPUT_CHANNELS,
    samplesPerChannel: Math.floor(chunk.length / 2 / INPUT_CHANNELS),
  };
}

export function pcmPeakLevel(chunk: Buffer): number {
  let peak = 0;
  for (let index = 0; index < chunk.length - 1; index += 2) {
    const sample = Math.abs(chunk.readInt16LE(index));
    if (sample > peak) peak = sample;
  }
  return Math.min(65_535, Math.round((peak / 32_767) * 65_535));
}
