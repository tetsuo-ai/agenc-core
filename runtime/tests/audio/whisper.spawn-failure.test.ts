import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createFailedSpawnChild, createPidStandIn } from "../helpers/failed-spawn-child.js";

// runWhisperProcess touched child.stdout before its error listener. EMFILE and
// ENFILE leave a failed child's stdio undefined: the promise rejected with a
// TypeError and Node's next-tick spawn error was an uncaught exception in the
// daemon. stop() also signalled a child without a pid, which Node routes to
// pid 0 until it reports the failure. The children are stand-ins.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { runWhisperProcess, WhisperError } = await import(
  "../../src/audio/whisper.js"
);
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
});

describe("runWhisperProcess with a failed spawn", () => {
  test("a spawn that left no stdio rejects with the engine error and nothing uncaught", async () => {
    const failed = createFailedSpawnChild({ code: "EMFILE", command: "whisper-cli" });
    spawnMock.mockImplementation(() => failed);

    const running = runWhisperProcess(
      "whisper-cli",
      ["-f", "speech.wav"],
      tmpdir(),
      {},
      new AbortController().signal,
    );

    await expect(running).rejects.toBeInstanceOf(WhisperError);
    await expect(running).rejects.toMatchObject({ code: "WHISPER_ENGINE_FAILED" });
    await failed.reported;
    expect(failed.uncaught).toEqual([]);
  });

  test("a cancel in the same tick as a failed spawn never signals the pid-less child", async () => {
    const failed = createFailedSpawnChild({ code: "EAGAIN", command: "whisper-cli" });
    spawnMock.mockImplementation(() => failed);
    const controller = new AbortController();

    const running = runWhisperProcess(
      "whisper-cli",
      ["-f", "speech.wav"],
      tmpdir(),
      {},
      controller.signal,
    );
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await failed.reported;
    expect(failed.groupSignals).toEqual([]);
    expect(failed.uncaught).toEqual([]);
  });
});

describe("runWhisperProcess with a handle reporting an unsafe pid", () => {
  // Only a pid above 1 is signalled: 0 is this process's group, -1 every
  // process of the user, 1 init.
  test.each([0, -1, 1])("a cancel never signals a child whose pid is %s", async (pid) => {
    const child = createPidStandIn(pid);
    spawnMock.mockImplementation(() => child as never);
    const controller = new AbortController();

    const running = runWhisperProcess(
      "whisper-cli",
      ["-f", "speech.wav"],
      tmpdir(),
      {},
      controller.signal,
    );
    controller.abort();
    child.emit("close", null);

    await expect(running).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(child.signals).toEqual([]);
  });
});
