import { afterEach, describe, expect, test, vi } from "vitest";

import { failingSpawn } from "../helpers/failed-spawn-child.js";

// execFileNoThrow handed its AbortSignal to spawn. Node's own abort handler
// then calls child.kill() even while a failed spawn is still waiting to
// report, and that pid-less handle sends the kill to pid 0: the caller's
// whole process group. The stand-in below handles `signal` as Node does but
// only records the kill.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("cross-spawn", () => ({ default: spawnMock }));

const { execFileNoThrowWithCwd } = await import(
  "../../src/utils/execFileNoThrow.js"
);

afterEach(() => {
  spawnMock.mockReset();
});

describe("execFileNoThrow abort", () => {
  test("an abort in the same tick as a failed spawn never signals the pid-less child", async () => {
    const failures = failingSpawn({ code: "EAGAIN" });
    spawnMock.mockImplementation(failures.spawn);
    const controller = new AbortController();

    const running = execFileNoThrowWithCwd("/usr/bin/true", [], {
      abortSignal: controller.signal,
    });
    controller.abort();
    const result = await running;
    await Promise.all(failures.children.map((child) => child.reported));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.groupSignals).toEqual([]);
    expect(failures.children[0]!.uncaught).toEqual([]);
    expect(result.code).toBe(1);
  });

  test("an already-aborted signal starts nothing", async () => {
    const failures = failingSpawn({ code: "EAGAIN" });
    spawnMock.mockImplementation(failures.spawn);
    const controller = new AbortController();
    controller.abort();

    const result = await execFileNoThrowWithCwd("/usr/bin/true", [], {
      abortSignal: controller.signal,
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      stdout: "",
      stderr: "",
      code: 1,
      error: "The operation was aborted",
    });
  });
});
