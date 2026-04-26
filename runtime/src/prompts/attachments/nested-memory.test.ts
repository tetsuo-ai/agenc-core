/**
 * Tests for the nested-memory attachment producer.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearSessionReadState } from "../../tools/system/filesystem.js";
import {
  getDirectoriesToProcess,
  nestedMemoryProducer,
} from "./nested-memory.js";
import type { GetAttachmentsOptions } from "./orchestrator.js";

let tmpDir: string;
let sessionId: string;
let sessionKey: { sessionId: string };

beforeEach(() => {
  // realpathSync to avoid macOS /private/var vs /var divergence and any
  // symlinks the tmpdir() implementation might insert.
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "agenc-nested-mem-")));
  sessionId = `session-${Math.random().toString(36).slice(2)}`;
  sessionKey = { sessionId };
});

afterEach(() => {
  clearSessionReadState(sessionId);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeOpts(
  userInput: string | null,
  cwd: string = tmpDir,
): GetAttachmentsOptions {
  return {
    sessionKey,
    userInput,
    loadedTools: [],
    messages: [],
    permissionContext: { mode: "default" } as never,
    cwd,
    subagentDepth: 0,
    signal: new AbortController().signal,
  };
}

describe("getDirectoriesToProcess", () => {
  test("collects nestedDirs in cwd→target order", () => {
    const cwd = "/home/x";
    const file = "/home/x/a/b/c.txt";
    const { nestedDirs } = getDirectoriesToProcess(file, cwd);
    expect(nestedDirs).toEqual(["/home/x/a", "/home/x/a/b"]);
  });

  test("returns empty nestedDirs when file is at cwd", () => {
    const cwd = "/home/x";
    const file = "/home/x/c.txt";
    const { nestedDirs } = getDirectoriesToProcess(file, cwd);
    expect(nestedDirs).toEqual([]);
  });

  test("returns empty nestedDirs when file lives outside cwd", () => {
    const cwd = "/home/x";
    const file = "/etc/passwd";
    const { nestedDirs } = getDirectoriesToProcess(file, cwd);
    expect(nestedDirs).toEqual([]);
  });
});

describe("nestedMemoryProducer", () => {
  test("returns [] when userInput is null", async () => {
    const out = await nestedMemoryProducer(makeOpts(null), {} as never);
    expect(out).toEqual([]);
  });

  test("returns [] when userInput has no @ mentions", async () => {
    const out = await nestedMemoryProducer(
      makeOpts("just regular prose without mentions"),
      {} as never,
    );
    expect(out).toEqual([]);
  });

  test("mention with no AGENC.md in any walked dir: returns []", async () => {
    const subdir = join(tmpDir, "sub");
    mkdirSync(subdir);
    const file = join(subdir, "leaf.ts");
    writeFileSync(file, "export const x = 1;\n");
    const out = await nestedMemoryProducer(
      makeOpts(`look at @sub/leaf.ts please`),
      {} as never,
    );
    expect(out).toEqual([]);
  });

  test("mention triggers AGENC.md walk → emits NestedMemoryAttachment", async () => {
    const subdir = join(tmpDir, "sub");
    mkdirSync(subdir);
    const file = join(subdir, "leaf.ts");
    writeFileSync(file, "export const x = 1;\n");
    // AGENC.md inside the nested dir between cwd and the file.
    const agencMd = join(subdir, "AGENC.md");
    writeFileSync(agencMd, "# Sub-directory rules\n\nFollow these.\n");

    const out = await nestedMemoryProducer(
      makeOpts(`@sub/leaf.ts`),
      {} as never,
    );
    expect(out).toHaveLength(1);
    if (out[0]?.kind !== "nested_memory") throw new Error("kind");
    expect(out[0].path).toBe(agencMd);
    expect(out[0].displayPath).toBe("sub/AGENC.md");
    expect(out[0].memoryType).toBe("Project");
    expect(out[0].content).toContain("Sub-directory rules");
    expect(out[0].mtimeMs).toBeGreaterThan(0);
  });

  test("dedupes against prior session reads", async () => {
    const subdir = join(tmpDir, "sub");
    mkdirSync(subdir);
    const file = join(subdir, "leaf.ts");
    writeFileSync(file, "x");
    writeFileSync(join(subdir, "AGENC.md"), "# rules\n");

    const first = await nestedMemoryProducer(
      makeOpts("@sub/leaf.ts"),
      {} as never,
    );
    expect(first).toHaveLength(1);
    // Second invocation should not re-emit the same memory file.
    const second = await nestedMemoryProducer(
      makeOpts("@sub/leaf.ts"),
      {} as never,
    );
    expect(second).toEqual([]);
  });

  test("emits Local tier when AGENC.local.md exists alongside AGENC.md", async () => {
    const subdir = join(tmpDir, "sub");
    mkdirSync(subdir);
    const file = join(subdir, "leaf.ts");
    writeFileSync(file, "x");
    writeFileSync(join(subdir, "AGENC.md"), "# project tier\n");
    writeFileSync(join(subdir, "AGENC.local.md"), "# local tier\n");

    const out = await nestedMemoryProducer(makeOpts("@sub/leaf.ts"), {} as never);
    expect(out).toHaveLength(2);
    const types = out.map((a) => (a.kind === "nested_memory" ? a.memoryType : null));
    expect(types).toEqual(expect.arrayContaining(["Project", "Local"]));
  });
});
