import * as childProcess from "child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { failingSpawn } from "../helpers/failed-spawn-child.js";

// ripGrepStream and the embedded ripgrep path spawned rg with spawn's
// `signal` option. Node's own abort handler then calls child.kill() even
// while a failed spawn is still waiting to report, and that pid-less handle
// sends the kill to pid 0: the caller's whole process group. The stand-ins
// handle `signal` as Node does, but only record the kill.

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
// The embedded (bundled) ripgrep runs through spawn with argv0.
vi.mock("../../src/utils/bundledMode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/bundledMode.js")>()),
  isInBundledMode: () => true,
}));

const { ripGrep, ripGrepStream } = await import("../../src/utils/ripgrep.js");
const actualSpawn = (await vi.importActual<typeof import("child_process")>("child_process"))
  .spawn;
const spawnMock = vi.mocked(childProcess.spawn);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-rg-abort-"));
});

afterEach(async () => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
  await rm(dir, { recursive: true, force: true });
});

describe("ripgrep abort with a failed spawn", () => {
  test("ripGrepStream: an abort in the same tick as the failed spawn signals nothing", async () => {
    const controller = new AbortController();
    const failures = failingSpawn({
      code: "EAGAIN",
      onSpawn: () => controller.abort(),
    });
    spawnMock.mockImplementation(failures.spawn as never);

    await expect(
      ripGrepStream(["-e", "needle"], dir, controller.signal, () => {}),
    ).rejects.toThrow();
    await Promise.all(failures.children.map((child) => child.reported));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.groupSignals).toEqual([]);
    expect(failures.children[0]!.uncaught).toEqual([]);
  });

  test("ripGrepStream: an already-aborted signal starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      ripGrepStream(["-e", "needle"], dir, controller.signal, () => {}),
    ).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("ripGrep (embedded rg): an abort in the same tick as the failed spawn signals nothing", async () => {
    const controller = new AbortController();
    const failures = failingSpawn({
      code: "EAGAIN",
      onSpawn: () => controller.abort(),
    });
    spawnMock.mockImplementation(failures.spawn as never);

    await ripGrep(["-e", "needle"], dir, controller.signal).catch(() => undefined);
    await Promise.all(failures.children.map((child) => child.reported));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.spawnargs).toContain("--no-config");
    expect(failures.children[0]!.groupSignals).toEqual([]);
    expect(failures.children[0]!.uncaught).toEqual([]);
  });

  test("ripGrep (embedded rg): an already-aborted signal starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();

    await ripGrep(["-e", "needle"], dir, controller.signal).catch(() => undefined);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
