import * as childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { failingSpawn } from "../helpers/failed-spawn-child.js";

// EMFILE and ENFILE leave a failed child's stdio undefined, and Node reports
// the failure on the next tick. Code that touches stdio before listening for
// that report throws a TypeError and leaves the report uncaught.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { bindWorkspaceDirectoryReadCapability } = await import(
  "../../src/workspace/file-mutation-transaction.js"
);
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-bound-helper-spawn-"));
});

afterEach(async () => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
  await rm(dir, { recursive: true, force: true });
});

describe("directory-binding helper with a failed spawn", () => {
  test("a helper spawn that left no stdio fails the binding with nothing uncaught", async () => {
    // The daemon-side constructor built a readline interface on the missing
    // stdout before its error listener existed. The child is a stand-in.
    const failures = failingSpawn({ code: "EMFILE" });
    spawnMock.mockImplementation(failures.spawn as never);

    await expect(bindWorkspaceDirectoryReadCapability(dir)).rejects.toThrow();
    await Promise.all(failures.children.map((child) => child.reported));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.uncaught).toEqual([]);
    expect(failures.children[0]!.groupSignals).toEqual([]);
  });
});

describe("directory-binding helper whose spawn failed with its pipes open", () => {
  test("reports the spawn error instead of waiting for an exit that never comes", async () => {
    // ENOENT (the anchor directory removed after its identity was captured)
    // still creates the pipes, so the helper is built normally. A failed
    // spawn never emits exit: dispose() waited 2 s, then threw "did not exit
    // after forced termination", which replaced the ENOENT.
    const failures = failingSpawn({ code: "ENOENT", pipes: 5 });
    spawnMock.mockImplementation(failures.spawn as never);

    const binding = bindWorkspaceDirectoryReadCapability(dir);

    await expect(binding).rejects.toThrow(/ENOENT/u);
    await expect(binding).rejects.not.toThrow(/did not exit/u);
    await Promise.all(failures.children.map((child) => child.reported));
    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.uncaught).toEqual([]);
    expect(failures.children[0]!.groupSignals).toEqual([]);
  });
});

/**
 * The helper and read-worker programs run in their own processes, loaded
 * through a digest-checked pipe with a sanitized environment, so a test
 * cannot hand them a failing spawn. Check their source instead.
 */
describe("embedded helper programs", () => {
  const moduleSource = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "workspace", "file-mutation-transaction.ts"),
    "utf8",
  );

  function embedded(name: string): string {
    const start = moduleSource.indexOf(`const ${name} = String.raw\``);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = moduleSource.indexOf("\n`;", start);
    expect(end).toBeGreaterThan(start);
    return moduleSource.slice(start, end);
  }

  const programs = {
    BOUND_READ_WORKER_SOURCE: embedded("BOUND_READ_WORKER_SOURCE"),
    BOUND_DIRECTORY_HELPER_SOURCE: embedded("BOUND_DIRECTORY_HELPER_SOURCE"),
  };

  test.each(Object.entries(programs))(
    "%s listens for a spawn error before it touches the child's stdio",
    (_name, program) => {
      const spawns = [...program.matchAll(/const child = spawn\(/gu)];
      expect(spawns.length).toBeGreaterThan(0);
      for (const spawnCall of spawns) {
        const after = program.slice(spawnCall.index);
        const listener = after.search(/child\.(?:once|on)\("error"/u);
        const stdio = after.search(/child\.(?:stdin|stdout|stderr|stdio)\b/u);
        expect(listener).toBeGreaterThan(0);
        expect(stdio).toBeGreaterThan(0);
        expect(listener).toBeLessThan(stdio);
      }
    },
  );

  test("the directory helper never signals a read worker whose spawn failed", () => {
    // Its handoff failures run in the same microtask drain as the spawn. A
    // kill() there on a child without a pid reaches pid 0: the helper's own
    // process group, which it shares with the daemon. Only a pid above 1 is
    // ever signalled.
    const program = programs.BOUND_DIRECTORY_HELPER_SOURCE;
    const start = program.indexOf("const runBoundReadWorker = async");
    const end = program.indexOf("const [closed, sourceWriteError, stdinWriteError]", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = program.slice(start, end);
    const kills = [...body.matchAll(/child\.kill\(/gu)];
    expect(kills).toHaveLength(1);
    expect(body).toContain(
      "if (Number.isSafeInteger(child.pid) && child.pid > 1) child.kill();",
    );
  });
});
