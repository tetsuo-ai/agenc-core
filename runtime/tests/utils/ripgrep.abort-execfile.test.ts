import * as childProcess from "child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { failingExecFile, failingSpawn } from "../helpers/failed-spawn-child.js";

// A packaged or system ripgrep runs through execFile, which hands its
// `signal` to spawn. Node's own abort handler then calls child.kill() even
// while a failed spawn is still waiting to report, and that pid-less handle
// sends the kill to pid 0: the caller's whole process group. The stand-ins
// handle `signal` as Node does, but only record the kill.

const { crossSpawnMock } = vi.hoisted(() => ({ crossSpawnMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
// A packaged rg path that exists, so the execFile path is taken.
vi.mock("../../src/tools/system/pinned-ripgrep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/system/pinned-ripgrep.js")>()),
  resolvePinnedRipgrepPath: () => process.execPath,
}));
// The codesign check and the first-use probe run through execFileNoThrow;
// they get failing stand-ins too, so no real process starts.
vi.mock("cross-spawn", () => ({ default: crossSpawnMock }));

const { ripGrep } = await import("../../src/utils/ripgrep.js");
const actualExecFile = (
  await vi.importActual<typeof import("child_process")>("child_process")
).execFile;
const execFileMock = vi.mocked(childProcess.execFile);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-rg-abort-exec-"));
  crossSpawnMock.mockImplementation(failingSpawn({ code: "ENOENT" }).spawn);
});

afterEach(async () => {
  execFileMock.mockReset();
  execFileMock.mockImplementation(actualExecFile);
  crossSpawnMock.mockReset();
  await rm(dir, { recursive: true, force: true });
});

describe("ripgrep through execFile, abort with a failed spawn", () => {
  test("an abort in the same tick as the failed spawn signals nothing", async () => {
    const controller = new AbortController();
    const failures = failingExecFile({
      code: "EAGAIN",
      onSpawn: () => controller.abort(),
    });
    execFileMock.mockImplementation(failures.execFile as never);

    await ripGrep(["-e", "needle"], dir, controller.signal).catch(() => undefined);
    await Promise.all(failures.children.map((child) => child.reported));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.spawnfile).toBe(process.execPath);
    expect(failures.children[0]!.groupSignals).toEqual([]);
    expect(failures.children[0]!.uncaught).toEqual([]);
  });

  test("an already-aborted signal starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();

    await ripGrep(["-e", "needle"], dir, controller.signal).catch(() => undefined);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
