import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { updateLatestDebugLogSymlink } from "../../src/utils/debug.js";

// utils/debug.ts:409 minor (core-todo.md): updateLatestDebugLogSymlink was memoized on
// its empty arg list, so it ran once per process. The debug log path is session-scoped
// and /resume switches the session, so the `latest` symlink stayed pointed at the
// pre-resume file. Fixed by re-linking whenever the resolved target changes.

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agenc-debug-symlink-"));
  for (const k of ["AGENC_DEBUG_LOGS_DIR", "AGENC_DEBUG_FILE", "AGENC_DEBUG"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("updateLatestDebugLogSymlink retargets after the path changes", () => {
  it("re-points `latest` when the resolved debug log path changes (e.g. /resume)", async () => {
    const a = join(dir, "session-a.txt");
    const b = join(dir, "session-b.txt");

    process.env.AGENC_DEBUG_LOGS_DIR = a;
    await updateLatestDebugLogSymlink();
    expect(readlinkSync(join(dir, "latest"))).toBe(a);

    // Simulate the session switch: the resolved log path is now a different file.
    process.env.AGENC_DEBUG_LOGS_DIR = b;
    await updateLatestDebugLogSymlink();
    expect(readlinkSync(join(dir, "latest"))).toBe(b);
  });
});
