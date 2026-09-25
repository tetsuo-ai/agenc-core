import * as childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Session } from "../../src/session/session.js";
import {
  createFailedSpawnChild,
  failingSpawn,
} from "../helpers/failed-spawn-child.js";

// /status and /diff run git through small helpers that touched child.stdout
// before their error listener. EMFILE and ENFILE leave a failed child's stdio
// undefined: the helper threw a TypeError and Node's next-tick spawn error
// was an uncaught exception. The children are stand-ins.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("../../src/commands/status-menu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/commands/status-menu.js")>()),
  openStatusDashboard: vi.fn(() => true),
}));

const { statusCommand } = await import("../../src/commands/status.js");
const { runGit } = await import("../../src/commands/diff.js");
const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-git-spawn-failure-"));
});

afterEach(async () => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
  await rm(dir, { recursive: true, force: true });
});

describe("git helpers with a failed spawn", () => {
  test("/status reports git as unavailable with nothing uncaught", async () => {
    const failures = failingSpawn({ code: "EMFILE" });
    spawnMock.mockImplementation(failures.spawn as never);

    const result = await statusCommand.execute({
      session: { conversationId: "status-emfile", services: {}, createdAtMs: 0 } as Session,
      cwd: dir,
      home: dir,
      argsRaw: "",
    });
    await Promise.all(failures.children.map((child) => child.reported));

    expect(result.kind).toBe("skip");
    expect(failures.children.length).toBeGreaterThan(0);
    expect(failures.children.flatMap((child) => child.uncaught)).toEqual([]);
  });

  test("/diff's git runner resolves with the spawn error and nothing uncaught", async () => {
    const failed = createFailedSpawnChild({ code: "EMFILE", command: "git" });
    spawnMock.mockImplementation(() => failed);

    const result = await runGit(["status", "--porcelain"], dir);
    await failed.reported;

    expect(result).toMatchObject({ code: -1, timedOut: false });
    expect(result.stderr).toContain("EMFILE");
    expect(failed.uncaught).toEqual([]);
  });
});
