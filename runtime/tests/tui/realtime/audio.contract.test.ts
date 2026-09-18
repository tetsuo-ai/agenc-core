import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";

import {
  createProcessRealtimeAudioPlayer,
  pcmPeakLevel,
  type RealtimeAudioPlayerSpawn,
} from "./audio.js";

const MAX_OUTPUT_QUEUE_BYTES = 512 * 1024;
const BACKPRESSURE_CHUNK_BYTES = 64 * 1024;

function outputAudio(
  chunk: Buffer,
  sampleRate = 24_000,
  numChannels = 1,
): {
  readonly data: string;
  readonly sampleRate: number;
  readonly numChannels: number;
} {
  return {
    data: chunk.toString("base64"),
    sampleRate,
    numChannels,
  };
}

function createChild(): ChildProcess & { stdin: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true) as never;
  return child;
}

function createControlledChild(writeChunk: (chunk: Buffer) => boolean): {
  readonly child: ChildProcess & { stdin: PassThrough };
  readonly writes: Buffer[];
} {
  const child = createChild();
  const writes: Buffer[] = [];
  child.stdin.write = vi.fn((chunk: Buffer) => {
    const buffer = Buffer.from(chunk);
    writes.push(buffer);
    return writeChunk(buffer);
  }) as never;
  return { child, writes };
}

function writtenBytes(writes: readonly Buffer[]): number {
  return writes.reduce((total, chunk) => total + chunk.length, 0);
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

  test("does not write more stdin chunks while waiting for drain", () => {
    const { child, writes } = createControlledChild(() => false);
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => child);
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    for (let index = 0; index < 20; index += 1) {
      const chunk = Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, index + 1);
      player.enqueue(outputAudio(chunk));
    }

    expect(writes).toHaveLength(1);
    expect(writtenBytes(writes)).toBe(BACKPRESSURE_CHUNK_BYTES);
    expect(writes[0]?.[0]).toBe(1);
  });

  test("keeps newest queued audio and drops oldest when the 512 KiB cap is exceeded", () => {
    let acceptWrites = false;
    const { child, writes } = createControlledChild(() => acceptWrites);
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => child);
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    for (let index = 0; index < 20; index += 1) {
      const chunk = Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, index + 1);
      player.enqueue(outputAudio(chunk));
    }

    expect(writtenBytes(writes)).toBe(BACKPRESSURE_CHUNK_BYTES);

    acceptWrites = true;
    child.stdin.emit("drain");

    const flushedAfterDrain = writes.slice(1);
    expect(writtenBytes(flushedAfterDrain)).toBe(MAX_OUTPUT_QUEUE_BYTES);
    expect(flushedAfterDrain.map((chunk) => chunk[0])).toEqual([
      13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(writtenBytes(writes)).toBe(
      BACKPRESSURE_CHUNK_BYTES + MAX_OUTPUT_QUEUE_BYTES,
    );
  });

  test("resumes writing only from the drain handler", () => {
    let acceptWrites = false;
    const { child, writes } = createControlledChild(() => acceptWrites);
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => child);
    const player = createProcessRealtimeAudioPlayer(spawnProcess);
    const first = Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, 1);
    const second = Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, 2);

    player.enqueue(outputAudio(first));
    player.enqueue(outputAudio(second));
    expect(writes).toHaveLength(1);

    acceptWrites = true;
    child.stdin.emit("drain");

    expect(writes).toHaveLength(2);
    expect(writes[1]?.[0]).toBe(2);
  });

  test("clears the drain listener and queue after stdin errors", () => {
    const first = createControlledChild(() => false);
    const second = createControlledChild(() => true);
    const spawnProcess = vi
      .fn<RealtimeAudioPlayerSpawn>()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    player.enqueue(outputAudio(Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, 1)));
    player.enqueue(outputAudio(Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, 2)));
    expect(first.writes).toHaveLength(1);

    first.child.stdin.emit("error", new Error("EPIPE"));
    player.enqueue(outputAudio(Buffer.alloc(4, 3)));
    first.child.stdin.emit("drain");

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(first.writes).toHaveLength(1);
    expect(second.writes).toEqual([Buffer.from([3, 3, 3, 3])]);
    expect(first.child.stdin.listenerCount("drain")).toBe(0);
  });

  test("clears the drain listener and queue on close", () => {
    const { child, writes } = createControlledChild(() => false);
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => child);
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    player.enqueue(outputAudio(Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, 1)));
    player.enqueue(outputAudio(Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, 2)));
    player.close();
    child.stdin.emit("drain");

    expect(writes).toHaveLength(1);
    expect(child.stdin.listenerCount("drain")).toBe(0);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("clears the previous drain listener when playback format changes", () => {
    const first = createControlledChild(() => false);
    const second = createControlledChild(() => true);
    const spawnProcess = vi
      .fn<RealtimeAudioPlayerSpawn>()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child);
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    player.enqueue(outputAudio(Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, 1), 24_000, 1));
    player.enqueue(outputAudio(Buffer.alloc(BACKPRESSURE_CHUNK_BYTES, 2), 24_000, 1));
    player.enqueue(outputAudio(Buffer.from([9, 8, 7, 6]), 48_000, 2));
    first.child.stdin.emit("drain");

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(first.writes).toHaveLength(1);
    expect(second.writes).toEqual([Buffer.from([9, 8, 7, 6])]);
    expect(first.child.stdin.listenerCount("drain")).toBe(0);
  });
});
