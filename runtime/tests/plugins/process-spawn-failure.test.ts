import * as childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { failingSpawn } from "../helpers/failed-spawn-child.js";

// The plugin resolver's and the marketplace's process runners touched
// child.stdout before their error listener. EMFILE and ENFILE leave a failed
// child's stdio undefined: the runner threw a TypeError and Node's next-tick
// spawn error was an uncaught exception in the daemon. The children are
// stand-ins; nothing is spawned or signalled.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const { resolvePluginSource } = await import("../../src/plugins/resolution.js");
const { defaultRunProcess } = await import(
  "../../src/plugins/marketplace/marketplace.js"
);
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-plugin-spawn-failure-"));
});

afterEach(async () => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
  await rm(dir, { recursive: true, force: true });
});

describe("plugin process runners with a failed spawn", () => {
  test("the resolver reports the spawn error with nothing uncaught", async () => {
    const failures = failingSpawn({ code: "EMFILE" });
    spawnMock.mockImplementation(failures.spawn as never);

    await expect(
      resolvePluginSource("https://github.com/agenc-test/plugin.git", {
        agencHome: dir,
        pluginStorageRoot: join(dir, "plugins"),
        sessionTempRoot: join(dir, "session-temp"),
        workspaceRoot: dir,
        cache: false,
      }),
    ).rejects.toThrow(/EMFILE/u);
    await Promise.all(failures.children.map((child) => child.reported));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.spawnfile).toBe("git");
    expect(failures.children[0]!.uncaught).toEqual([]);
  });

  test("the marketplace runner reports the spawn error with nothing uncaught", async () => {
    const failures = failingSpawn({ code: "ENFILE" });
    spawnMock.mockImplementation(failures.spawn as never);

    await expect(
      defaultRunProcess("git", ["ls-remote", "origin"], {
        cwd: dir,
        environment: {},
      }),
    ).rejects.toThrow(/ENFILE/u);
    await Promise.all(failures.children.map((child) => child.reported));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.uncaught).toEqual([]);
  });
});
