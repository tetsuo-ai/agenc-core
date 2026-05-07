import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";

import {
  createProcessRealtimeAudioPlayer,
  pcmPeakLevel,
  type RealtimeAudioPlayerSpawn,
} from "./audio.js";

function createChild(): ChildProcess & { stdin: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true) as never;
  return child;
}

describe("AgenC realtime audio helpers", () => {
  test("clamps signed PCM peak values to the realtime meter range", () => {
    expect(pcmPeakLevel(Buffer.from([0x00, 0x00]))).toBe(0);
    expect(pcmPeakLevel(Buffer.from([0xff, 0x7f]))).toBe(65_535);
    expect(pcmPeakLevel(Buffer.from([0x00, 0x80]))).toBe(65_535);
  });

  test("resets process playback after child stdin failures", () => {
    const children = [createChild(), createChild()];
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => {
      const child = children.shift();
      if (child === undefined) throw new Error("missing child");
      return child;
    });
    const player = createProcessRealtimeAudioPlayer(spawnProcess);
    const audio = {
      data: Buffer.from([1, 2, 3, 4]).toString("base64"),
      sampleRate: 24000,
      numChannels: 1,
    };

    player.enqueue(audio);
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    expect(() => {
      spawnProcess.mock.results[0]?.value.stdin.emit(
        "error",
        new Error("EPIPE"),
      );
      player.enqueue(audio);
    }).not.toThrow();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["malformed base64", { data: "not-base64!", sampleRate: 24000, numChannels: 1 }],
    ["oversized base64", { data: "A".repeat(700_000), sampleRate: 24000, numChannels: 1 }],
    ["NaN sample rate", { data: "AAAA", sampleRate: Number.NaN, numChannels: 1 }],
    ["infinite sample rate", { data: "AAAA", sampleRate: Infinity, numChannels: 1 }],
    ["zero sample rate", { data: "AAAA", sampleRate: 0, numChannels: 1 }],
    ["negative sample rate", { data: "AAAA", sampleRate: -24000, numChannels: 1 }],
    ["fractional sample rate", { data: "AAAA", sampleRate: 24000.5, numChannels: 1 }],
    ["zero channels", { data: "AAAA", sampleRate: 24000, numChannels: 0 }],
    ["negative channels", { data: "AAAA", sampleRate: 24000, numChannels: -1 }],
    ["fractional channels", { data: "AAAA", sampleRate: 24000, numChannels: 1.5 }],
    ["too many channels", { data: "AAAA", sampleRate: 24000, numChannels: 16 }],
  ])("drops %s output audio before spawning playback", (_label, audio) => {
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => createChild());
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    player.enqueue(audio);

    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
