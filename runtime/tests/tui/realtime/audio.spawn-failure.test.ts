import { describe, expect, test, vi } from "vitest";

import type { ThreadRealtimeAudioChunk } from "../../../src/app-server/protocol/index.js";
import {
  createProcessRealtimeAudioPlayer,
  type RealtimeAudioPlayerSpawn,
} from "../../../src/tui/realtime/audio.js";
import {
  createFailedSpawnChild,
  type FailedSpawnChild,
} from "../../helpers/failed-spawn-child.js";

// Without SoX (stock macOS) the `play` spawn fails with ENOENT. An audio
// chunk and a realtime_error or realtime_closed message can arrive in one
// socket read and are dispatched in one tick, so close() ran before Node
// reported the failure and its kill() reached pid 0: the TUI and its shell
// job got SIGTERM. The failed children are stand-ins that only record it.

const chunk: ThreadRealtimeAudioChunk = {
  data: Buffer.alloc(320).toString("base64"),
  sampleRate: 24_000,
  numChannels: 1,
};

function failingSpawn(code: "ENOENT" | "EAGAIN" | "EMFILE" = "ENOENT") {
  const spawned: FailedSpawnChild[] = [];
  const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => {
    const failed = createFailedSpawnChild({ code, command: "play" });
    spawned.push(failed);
    return failed;
  });
  return { spawnProcess, spawned };
}

describe("realtime audio player with a failed play spawn", () => {
  test("close() in the same tick as the failed spawn signals nothing", async () => {
    const { spawnProcess, spawned } = failingSpawn();
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    player.enqueue(chunk);
    player.close();
    await spawned[0]!.reported;

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawned[0]!.groupSignals).toEqual([]);
    expect(spawned[0]!.uncaught).toEqual([]);
  });

  test("a missing play is spawned once, not again for every chunk", async () => {
    const { spawnProcess, spawned } = failingSpawn();
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    player.enqueue(chunk);
    await spawned[0]!.reported;
    for (let index = 0; index < 3; index += 1) {
      player.enqueue(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    player.close();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawned.flatMap((failed) => failed.groupSignals)).toEqual([]);
  });

  test("a play spawn that left no stdin (EMFILE) does not throw from enqueue", async () => {
    // EMFILE and ENFILE leave stdin undefined, not null; flush() read
    // stdin.destroyed and threw into the socket dispatch.
    const { spawnProcess, spawned } = failingSpawn("EMFILE");
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    expect(() => player.enqueue(chunk)).not.toThrow();
    await spawned[0]!.reported;
    player.close();

    expect(spawned[0]!.uncaught).toEqual([]);
    expect(spawned[0]!.groupSignals).toEqual([]);
  });

  test("a transient spawn failure is retried on the next chunk", async () => {
    const { spawnProcess, spawned } = failingSpawn("EAGAIN");
    const player = createProcessRealtimeAudioPlayer(spawnProcess);

    player.enqueue(chunk);
    await spawned[0]!.reported;
    player.enqueue(chunk);
    await spawned[1]!.reported;
    player.close();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawned.flatMap((failed) => failed.groupSignals)).toEqual([]);
  });
});
