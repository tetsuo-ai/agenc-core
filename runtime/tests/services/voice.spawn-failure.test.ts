import * as childProcess from "child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createPidStandIn, failingSpawn } from "../helpers/failed-spawn-child.js";

// stopRecording() signalled the SoX recorder unconditionally. A recorder
// whose spawn failed (no `rec` on PATH) has no pid, and until Node reports
// that on the next tick its open handle sends kill() to pid 0: the TUI's
// whole process group. The recorder here is a stand-in that only records it.

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    // No arecord, so every platform takes the SoX `rec` fallback.
    spawnSync: vi.fn((command: string, ...rest: unknown[]) =>
      command === "arecord"
        ? {
            error: Object.assign(new Error("spawnSync arecord ENOENT"), {
              code: "ENOENT",
            }),
            status: null,
            signal: null,
            output: [],
            pid: 0,
            stdout: null,
            stderr: null,
          }
        : (actual.spawnSync as (...args: unknown[]) => unknown)(command, ...rest),
    ),
  };
});
vi.mock("audio-capture-napi", () => ({
  isNativeAudioAvailable: () => false,
  isNativeRecordingActive: () => false,
  startNativeRecording: () => false,
  stopNativeRecording: () => {},
}));

const voice = await import("../../src/services/voice.js");
const actualSpawn = (await vi.importActual<typeof import("child_process")>("child_process"))
  .spawn;
const spawnMock = vi.mocked(childProcess.spawn);

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
});

describe("voice recording with a failed recorder spawn", () => {
  test.skipIf(process.platform === "win32")(
    "stopRecording in the same tick as the failed spawn signals nothing",
    async () => {
      const failures = failingSpawn({ code: "ENOENT" });
      spawnMock.mockImplementation(failures.spawn as never);
      const onEnd = vi.fn();

      const started = await voice.startRecording(() => {}, onEnd, {
        silenceDetection: false,
      });
      // Still inside the microtask drain that spawned `rec`: Node has not
      // reported the failure yet.
      voice.stopRecording();
      await Promise.all(failures.children.map((child) => child.reported));

      expect(started).toBe(true);
      expect(failures.children).toHaveLength(1);
      expect(failures.children[0]!.spawnfile).toBe("rec");
      expect(failures.children[0]!.groupSignals).toEqual([]);
      expect(failures.children[0]!.uncaught).toEqual([]);
    },
  );
});

describe("voice recording with a recorder reporting an unsafe pid", () => {
  // Only a pid above 1 is signalled: 0 is this process's group, -1 every
  // process of the user, 1 init.
  test.skipIf(process.platform === "win32").each([0, -1, 1])(
    "stopRecording never signals a recorder whose pid is %s",
    async (pid) => {
      const child = createPidStandIn(pid);
      spawnMock.mockImplementation(() => child as never);

      await voice.startRecording(() => {}, () => {}, { silenceDetection: false });
      voice.stopRecording();

      expect(child.signals).toEqual([]);
    },
  );
});
