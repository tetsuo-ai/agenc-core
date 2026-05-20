import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

type RecordingAvailability = {
  readonly available: boolean;
  readonly reason?: string;
};

type StartRecording = (
  onChunk: (chunk: Buffer) => void,
  onClosed: () => void,
  options: { readonly silenceDetection: boolean },
) => Promise<boolean>;

const voice = vi.hoisted(() => ({
  checkRecordingAvailability: vi.fn<() => Promise<RecordingAvailability>>(),
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

function callbacks(): RealtimeAudioCaptureCallbacks {
  return {
    onAudio: vi.fn(),
    onLevel: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
  };
}

function outputAudio(chunk: Buffer): {
  readonly data: string;
  readonly sampleRate: number;
  readonly numChannels: number;
} {
  return {
    data: chunk.toString("base64"),
    sampleRate: 24_000,
    numChannels: 1,
  };
}

function createChild(
  writeChunk: (chunk: Buffer) => boolean,
): ChildProcess & { stdin: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdin: PassThrough };
  const stdin = new PassThrough();
  stdin.write = vi.fn((chunk: Buffer) => writeChunk(Buffer.from(chunk))) as never;
  child.stdin = stdin;
  child.kill = vi.fn(() => true) as never;
  return child;
}

describe("AgenC realtime audio coverage", () => {
  beforeEach(() => {
    voice.checkRecordingAvailability.mockReset();
    voice.startRecording.mockReset();
    voice.stopRecording.mockReset();
  });

  test("starts default capture, maps PCM frames, stops recording, and reports startup failures", async () => {
    const capturedChunk = Buffer.from([0x00, 0x80, 0x34, 0x12, 0xff]);
    const captureCallbacks = callbacks();
    voice.checkRecordingAvailability.mockResolvedValue({ available: true });
    voice.startRecording.mockImplementation(async (onChunk, onClosed) => {
      onChunk(capturedChunk);
      onClosed();
      return true;
    });

    const session = await startDefaultRealtimeAudioCapture(captureCallbacks);

    expect(voice.startRecording).toHaveBeenCalledWith(
      expect.any(Function),
      captureCallbacks.onClosed,
      { silenceDetection: false },
    );
    expect(captureCallbacks.onAudio).toHaveBeenCalledWith({
      data: capturedChunk.toString("base64"),
      sampleRate: 16_000,
      numChannels: 1,
      samplesPerChannel: 2,
    });
    expect(captureCallbacks.onLevel).toHaveBeenCalledWith(65_535);

    session.stop();

    expect(voice.stopRecording).toHaveBeenCalledTimes(1);

    voice.checkRecordingAvailability.mockResolvedValue({
      available: false,
      reason: "microphone denied",
    });
    await expect(startDefaultRealtimeAudioCapture(callbacks())).rejects.toThrow(
      "microphone denied",
    );

    voice.checkRecordingAvailability.mockResolvedValue({ available: false });
    await expect(startDefaultRealtimeAudioCapture(callbacks())).rejects.toThrow(
      "Audio recording is not available",
    );

    voice.checkRecordingAvailability.mockResolvedValue({ available: true });
    voice.startRecording.mockResolvedValue(false);
    await expect(startDefaultRealtimeAudioCapture(callbacks())).rejects.toThrow(
      "Failed to start audio capture",
    );
  });

  test("does not replay accepted stream chunks after stdin backpressure drains", () => {
    let isDrained = false;
    const writes: Buffer[] = [];
    const child = createChild((chunk) => {
      writes.push(chunk);
      return isDrained;
    });
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => child);
    const player = createProcessRealtimeAudioPlayer(spawnProcess);
    const chunk = Buffer.from([1, 2, 3, 4]);

    player.enqueue(outputAudio(chunk));
    isDrained = true;
    child.stdin.emit("drain");

    expect(writes).toEqual([chunk]);
  });
});
