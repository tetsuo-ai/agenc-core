import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

type RecordingAvailability = {
  readonly available: boolean;
  readonly reason?: string | null;
};

type StartRecording = (
  onChunk: (chunk: Buffer) => void,
  onClosed: () => void,
  options: { readonly silenceDetection: boolean },
) => Promise<boolean>;

const voice = vi.hoisted(() => ({
  checkRecordingAvailability: vi.fn<() => Promise<RecordingAvailability>>(),
  checkPlaybackAvailability: vi.fn<() => Promise<RecordingAvailability>>(),
  resolveRealtimePlaybackBackend: vi.fn<() => "play" | "aplay" | null>(),
  startRecording: vi.fn<StartRecording>(),
  stopRecording: vi.fn<() => void>(),
}));

vi.mock("../../services/voice.js", () => voice);

import {
  createProcessRealtimeAudioPlayer,
  startDefaultRealtimeAudioCapture,
  type RealtimeAudioCaptureCallbacks,
  type RealtimeAudioPlayerSpawn,
} from "./audio.js";

function captureCallbacks(): RealtimeAudioCaptureCallbacks {
  return {
    onAudio: vi.fn(),
    onLevel: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
  };
}

function outputAudio(chunk: Buffer) {
  return { data: chunk.toString("base64"), sampleRate: 24_000, numChannels: 1 };
}

function createChild(): ChildProcess & { stdin: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true) as never;
  return child;
}

describe("realtime playback readiness and failure reporting", () => {
  beforeEach(() => {
    voice.checkRecordingAvailability.mockReset();
    voice.checkPlaybackAvailability.mockReset();
    voice.resolveRealtimePlaybackBackend.mockReset();
    voice.startRecording.mockReset();
    voice.stopRecording.mockReset();
    voice.resolveRealtimePlaybackBackend.mockReturnValue("play");
  });

  test("refuses to start capture when the microphone works but playback is missing", async () => {
    voice.checkRecordingAvailability.mockResolvedValue({ available: true });
    voice.checkPlaybackAvailability.mockResolvedValue({
      available: false,
      reason:
        "Realtime voice playback requires SoX `play` or ALSA `aplay`. Native audio capture cannot play assistant audio.",
    });

    await expect(
      startDefaultRealtimeAudioCapture(captureCallbacks()),
    ).rejects.toThrow(/playback requires SoX `play` or ALSA `aplay`/i);

    expect(voice.startRecording).not.toHaveBeenCalled();
  });

  test("starts capture only after both recording and playback are available", async () => {
    voice.checkRecordingAvailability.mockResolvedValue({ available: true });
    voice.checkPlaybackAvailability.mockResolvedValue({
      available: true,
      reason: null,
    });
    voice.startRecording.mockResolvedValue(true);

    await startDefaultRealtimeAudioCapture(captureCallbacks());

    expect(voice.checkPlaybackAvailability).toHaveBeenCalledTimes(1);
    expect(voice.startRecording).toHaveBeenCalledTimes(1);
  });

  test("reports spawn failures instead of silently resetting the process player", () => {
    const onError = vi.fn();
    const child = createChild();
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => child);
    const player = createProcessRealtimeAudioPlayer(spawnProcess, { onError });

    player.enqueue(outputAudio(Buffer.from([1, 2, 3, 4])));
    child.emit("error", Object.assign(new Error("spawn play ENOENT"), { code: "ENOENT" }));

    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/play|playback|ENOENT/i),
    );
  });

  test("spawns the resolved aplay backend instead of hardcoding play", () => {
    const child = createChild();
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => child);
    voice.resolveRealtimePlaybackBackend.mockReturnValue("aplay");
    const player = createProcessRealtimeAudioPlayer(spawnProcess, {
      backend: "aplay",
    });

    player.enqueue(outputAudio(Buffer.from([1, 2, 3, 4])));

    expect(spawnProcess).toHaveBeenCalledWith(
      "aplay",
      ["-q", "-t", "raw", "-f", "S16_LE", "-r", "24000", "-c", "1", "-"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
  });
});
