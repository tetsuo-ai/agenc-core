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

import type { JsonObject } from "../../../src/app-server/protocol/index.js";
import {
  createProcessRealtimeAudioPlayer,
  startDefaultRealtimeAudioCapture,
  type RealtimeAudioCaptureCallbacks,
  type RealtimeAudioPlayerSpawn,
} from "./audio.js";
import { createRealtimeTuiControls } from "./controller.js";
import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
} from "../../../src/app-server/protocol/index.js";

function captureCallbacks(): RealtimeAudioCaptureCallbacks {
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

function createChild(): ChildProcess & { stdin: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true) as never;
  return child;
}

function createClient(): {
  readonly requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }>;
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
  ): Promise<AgenCDaemonResultByMethod[Method]>;
} {
  const requests: Array<{
    readonly method: AgenCDaemonMethod;
    readonly params?: JsonObject;
  }> = [];
  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      return {} as AgenCDaemonResultByMethod[typeof method];
    },
  };
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
      resolveBackend: () => "aplay",
    });

    player.enqueue(outputAudio(Buffer.from([1, 2, 3, 4])));

    expect(spawnProcess).toHaveBeenCalledWith(
      "aplay",
      ["-q", "-t", "raw", "-f", "S16_LE", "-r", "24000", "-c", "1", "-"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
  });

  test("surfaces runtime playback failures through controller state", async () => {
    const client = createClient();
    const emitted: JsonObject[] = [];
    const stop = vi.fn();
    const audioPlayer = {
      enqueue: vi.fn(() => {
        throw new Error("play: command not found");
      }),
      close: vi.fn(),
    };
    const controls = createRealtimeTuiControls({
      threadId: "agent_1",
      client,
      emitEvent: (event) => emitted.push(event),
      startAudioCapture: async () => ({ stop }),
      audioPlayer,
    });

    await controls.start({ transport: "websocket" });
    controls.handleTranscriptEvent({
      type: "realtime_started",
      payload: { realtimeSessionId: "rt_1" },
    });
    controls.handleTranscriptEvent({
      type: "realtime_output_audio_delta",
      payload: {
        audio: {
          data: "AAAA",
          sampleRate: 24000,
          numChannels: 1,
        },
      },
    });

    await waitFor(
      () =>
        controls.getState().errorBanner === "play: command not found" &&
        client.requests.some(
          (request) => request.method === "thread/realtime/stop",
        ),
      "playback failure surfaced on controller",
    );

    expect(stop).toHaveBeenCalledTimes(1);
    expect(audioPlayer.close).toHaveBeenCalledTimes(1);
    expect(emitted.at(-1)).toMatchObject({
      type: "realtime_error",
      payload: {
        threadId: "agent_1",
        message: "play: command not found",
      },
    });
  });
});
