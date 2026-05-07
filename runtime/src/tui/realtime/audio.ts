import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { ThreadRealtimeAudioChunk } from "../../app-server/protocol/index.js";

// RT-15 parity: tui/src/chatwidget/realtime.rs realtime capture/player lifecycle.

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
}

export type RealtimeAudioPlayerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const INPUT_SAMPLE_RATE = 16_000;
const INPUT_CHANNELS = 1;
const MAX_OUTPUT_QUEUE_BYTES = 512 * 1024;

export async function startDefaultRealtimeAudioCapture(
  callbacks: RealtimeAudioCaptureCallbacks,
): Promise<RealtimeAudioCaptureSession> {
  const voice = await import("../../services/voice.js");
  const availability = await voice.checkRecordingAvailability();
  if (!availability.available) {
    throw new Error(availability.reason ?? "Audio recording is not available");
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
): RealtimeAudioPlayer {
  let child: ChildProcess | null = null;
  let format: { sampleRate: number; numChannels: number } | null = null;
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let waitingForDrain = false;

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
    active?.kill("SIGTERM");
  };

  const flush = (): void => {
    const active = child;
    if (active === null || active.stdin === null || active.stdin.destroyed) {
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
      queue.shift();
      queuedBytes -= chunk.length;
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
    enqueue(audio) {
      const nextFormat = {
        sampleRate: audio.sampleRate,
        numChannels: audio.numChannels,
      };
      if (
        child === null ||
        format === null ||
        format.sampleRate !== nextFormat.sampleRate ||
        format.numChannels !== nextFormat.numChannels
      ) {
        close();
        child = spawnProcess(
          "play",
          [
            "-q",
            "-t",
            "raw",
            "-r",
            String(nextFormat.sampleRate),
            "-e",
            "signed",
            "-b",
            "16",
            "-c",
            String(nextFormat.numChannels),
            "-",
          ],
          { stdio: ["pipe", "ignore", "ignore"] },
        );
        format = nextFormat;
        const active = child;
        active?.on("error", () => reset(active));
        active?.on("close", () => reset(active));
        active?.stdin?.on("error", () => reset(active));
        active?.stdin?.on("close", () => reset(active));
      }
      enqueueBuffer(Buffer.from(audio.data, "base64"));
    },
    close,
  };
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
