import * as childProcess from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { UnifiedExecError } from "../../src/unified-exec/types.js";
import {
  createFailedSpawnChild,
  type FailedSpawnChild,
} from "../helpers/failed-spawn-child.js";

// A spawn refused before the command could run must reach exec_command and
// Monitor as a create_process UnifiedExecError, which they settle as no
// effect. A plain Error there is filed as an unknown outcome and blocks every
// later side-effecting call in the session. Failed children are stand-ins:
// a real failed spawn is never signalled inside the test runner.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("../../src/utils/supervisedProcess.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/utils/supervisedProcess.js")
  >();
  return {
    ...actual,
    spawnContainedProcess: vi.fn(actual.spawnContainedProcess),
  };
});

const { UnifiedExecProcessManager } = await import(
  "../../src/unified-exec/process-manager.js"
);
const supervisedProcess = await import("../../src/utils/supervisedProcess.js");
const actualChildProcess = await vi.importActual<
  typeof import("node:child_process")
>("node:child_process");
const actualSupervised = await vi.importActual<
  typeof import("../../src/utils/supervisedProcess.js")
>("../../src/utils/supervisedProcess.js");
const spawnMock = vi.mocked(childProcess.spawn);
const containedMock = vi.mocked(supervisedProcess.spawnContainedProcess);

const posixOnly = process.platform === "win32" ? test.skip : test;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-spawn-refusal-"));
});

afterEach(async () => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualChildProcess.spawn);
  containedMock.mockReset();
  containedMock.mockImplementation(actualSupervised.spawnContainedProcess);
  await rm(root, { recursive: true, force: true });
});

function failingSpawns(code: "ENOENT" | "EAGAIN"): FailedSpawnChild[] {
  const spawned: FailedSpawnChild[] = [];
  spawnMock.mockImplementation(() => {
    const failed = createFailedSpawnChild({ code, command: "/bin/sh" });
    spawned.push(failed);
    return failed;
  });
  return spawned;
}

describe("unified exec refuses a spawn that could not start", () => {
  posixOnly("a deleted session root is a create_process error", async () => {
    const sessionRoot = join(root, "session");
    const manager = new UnifiedExecProcessManager({ cwd: sessionRoot });

    const refusal = manager.execCommand({ cmd: "printf should-not-run" });

    await expect(refusal).rejects.toBeInstanceOf(UnifiedExecError);
    await expect(refusal).rejects.toMatchObject({
      code: "create_process",
      message: `working directory does not exist: ${sessionRoot}`,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  posixOnly(
    "a gate spawn that fails (EAGAIN) is a create_process error and is never signalled",
    async () => {
      const spawned = failingSpawns("EAGAIN");
      const manager = new UnifiedExecProcessManager({ cwd: root });
      const controller = new AbortController();

      await expect(
        manager.execCommand({
          cmd: "printf should-not-run",
          __abortSignal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "create_process" });
      await Promise.all(spawned.map((failed) => failed.reported));

      expect(spawned.length).toBeGreaterThan(0);
      expect(spawned.flatMap((failed) => failed.groupSignals)).toEqual([]);
      expect(spawned.flatMap((failed) => failed.uncaught)).toEqual([]);
      // The upstream abort listener is released with the refused spawn.
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );

  test("a contained child returned without a pid is a create_process error", async () => {
    // The Windows Job Object path returns the raw spawn result; its failure
    // arrives on the next tick. Simulated here on every platform.
    const failed = createFailedSpawnChild({
      code: "ENOENT",
      command: "agenc-process-job-broker.exe",
    });
    containedMock.mockImplementation(() => failed as never);
    const manager = new UnifiedExecProcessManager({ cwd: root });

    await expect(
      manager.execCommand({ cmd: "printf should-not-run" }),
    ).rejects.toMatchObject({
      code: "create_process",
      message: expect.stringContaining("ENOENT"),
    });
    await failed.reported;

    expect(failed.groupSignals).toEqual([]);
    expect(failed.uncaught).toEqual([]);
  });

  test("a detached spawn that fails is a create_process error, not an exit", async () => {
    const spawned = failingSpawns("ENOENT");
    const onBegin = vi.fn(() => {
      throw new Error("observer must not run for a process that never started");
    });
    const manager = new UnifiedExecProcessManager({
      cwd: root,
      sessionTempRoot: root,
    });

    await expect(
      manager.startDetachedProcess({
        cmd: "sleep 30",
        workdir: join(root, "removed-after-check"),
        observer: { onBegin },
      }),
    ).rejects.toMatchObject({
      code: "create_process",
      message: `working directory does not exist: ${join(root, "removed-after-check")}`,
    });
    await spawned[0]!.reported;

    expect(onBegin).not.toHaveBeenCalled();
    expect(spawned[0]!.groupSignals).toEqual([]);
    expect(spawned[0]!.uncaught).toEqual([]);
  });
});
