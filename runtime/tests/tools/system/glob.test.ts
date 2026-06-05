/**
 * Tests for the AgenC-owned `Glob` tool.
 *
 * Coverage:
 *   - simple `*.txt` pattern in a tmp dir
 *   - recursive `**\/*.md` pattern
 *   - results sorted by mtime descending
 *   - `maxResults` truncation appends the donor-compatible truncation note
 *   - empty results return polite plain text and not isError
 *   - rejects search paths outside `allowedPaths`
 *   - returns plain text, not JSON-wrapped
 *   - schema shape: name === "Glob", required === ["pattern"]
 *   - honors explicit `path` arg as the search root
 *   - honors workspace-relative `path` (resolves against allowedPaths[0])
 *   - pattern with no matches returns the polite empty message
 *   - exports `GLOB_TOOL_NAME = "Glob"`
 *   - accepts absolute patterns inside allowed paths
 *   - rejects empty pattern with a plain-text error
 */

import {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { __INTERNAL, createGlobTool, GLOB_TOOL_NAME } from "./glob.js";

describe("Glob tool", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-glob-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("exposes the AgenC-bare tool name and required schema", () => {
    expect(GLOB_TOOL_NAME).toBe("Glob");
    const tool = createGlobTool({ allowedPaths: [root] });
    expect(tool.name).toBe("Glob");
    expect(tool.isReadOnly).toBe(true);
    expect(tool.metadata?.mutating).toBe(false);

    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["pattern"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["pattern", "path"]),
    );
  });

  test("matches a simple `*.txt` pattern in the workspace root", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    await writeFile(join(root, "b.txt"), "beta\n", "utf8");
    await writeFile(join(root, "skip.md"), "no match\n", "utf8");

    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({
      pattern: "*.txt",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("b.txt");
    expect(result.content).not.toContain("skip.md");
  });

  test("matches a recursive `**/*.md` pattern across nested directories", async () => {
    await mkdir(join(root, "nested", "deeper"), { recursive: true });
    await writeFile(join(root, "top.md"), "top\n", "utf8");
    await writeFile(join(root, "nested", "mid.md"), "mid\n", "utf8");
    await writeFile(join(root, "nested", "deeper", "low.md"), "low\n", "utf8");
    await writeFile(join(root, "nested", "skip.txt"), "ignore\n", "utf8");

    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({
      pattern: "**/*.md",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("top.md");
    expect(result.content).toContain("mid.md");
    expect(result.content).toContain("low.md");
    expect(result.content).not.toContain("skip.txt");
  });

  test("returns paths sorted by mtime descending (newest first)", async () => {
    const oldFile = join(root, "old.log");
    const midFile = join(root, "mid.log");
    const newFile = join(root, "new.log");
    await writeFile(oldFile, "o\n", "utf8");
    await writeFile(midFile, "m\n", "utf8");
    await writeFile(newFile, "n\n", "utf8");

    // Force mtimes so the ordering is deterministic regardless of FS
    // resolution (some filesystems collapse rapid writes to the same
    // mtimeMs).
    const now = Date.now() / 1000;
    await utimes(oldFile, now - 300, now - 300);
    await utimes(midFile, now - 150, now - 150);
    await utimes(newFile, now, now);

    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({
      pattern: "*.log",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    const lines = result.content.split("\n").filter(Boolean);
    const entries = lines;
    const newIdx = entries.findIndex((l) => l.endsWith("new.log"));
    const midIdx = entries.findIndex((l) => l.endsWith("mid.log"));
    const oldIdx = entries.findIndex((l) => l.endsWith("old.log"));
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(midIdx).toBeGreaterThan(newIdx);
    expect(oldIdx).toBeGreaterThan(midIdx);
  });

  test("truncates at `maxResults` with a polite note", async () => {
    for (let i = 0; i < 8; i += 1) {
      await writeFile(join(root, `f${i}.txt`), `${i}\n`, "utf8");
    }
    const tool = createGlobTool({ allowedPaths: [root], maxResults: 3 });
    const result = await tool.execute({
      pattern: "*.txt",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(
      "(Results are truncated. Consider using a more specific path or pattern.)",
    );
    // 3 entries + truncation note = 4 lines.
    const lines = result.content.split("\n").filter(Boolean);
    expect(lines.length).toBe(4);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.numFiles).toBe(3);
  });

  test("missing ripgrep returns a dependency error instead of a divergent fallback", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const tool = createGlobTool({
      allowedPaths: [root],
      ripgrepCommand: "agenc-missing-rg-for-test",
    });

    const result = await tool.execute({
      pattern: "*.txt",
      path: root,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Glob requires ripgrep");
    expect(result.content).toContain("hidden and ignored-file parity");
    // No rg binary is bundled, so the only fix is a system install — the error
    // must name a concrete install command per platform, not just say it's
    // required. (Revert-sensitive: drops the appended hint without the fix.)
    expect(result.content).toContain(__INTERNAL.ripgrepInstallHint());
    expect(result.content).toMatch(
      /winget install BurntSushi\.ripgrep\.MSVC|brew install ripgrep|apt install ripgrep/,
    );
  });

  test("ripgrepInstallHint names the install command for each platform", () => {
    expect(__INTERNAL.ripgrepInstallHint("darwin")).toContain(
      "brew install ripgrep",
    );
    expect(__INTERNAL.ripgrepInstallHint("win32")).toContain(
      "winget install BurntSushi.ripgrep.MSVC",
    );
    expect(__INTERNAL.ripgrepInstallHint("linux")).toContain(
      "apt install ripgrep",
    );
  });

  test("empty results return polite plain text and not isError", async () => {
    await writeFile(join(root, "only.txt"), "x\n", "utf8");
    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({
      pattern: "*.never-matches",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No files found");
    expect(result.metadata?.numFiles).toBe(0);
    expect(result.metadata?.truncated).toBe(false);
  });

  test("rejects a search path outside the allowed paths", async () => {
    await writeFile(join(root, "in.txt"), "in\n", "utf8");
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-glob-other-"));
    try {
      await writeFile(join(otherRoot, "leak.txt"), "leak\n", "utf8");
      const tool = createGlobTool({ allowedPaths: [root] });

      const result = await tool.execute({
        pattern: "*.txt",
        path: otherRoot,
      });

      expect(result.isError).toBe(true);
      expect(result.content.toLowerCase()).toContain("access denied");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("returns plain text, not a JSON-wrapped envelope", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const tool = createGlobTool({ allowedPaths: [root] });

    const ok = await tool.execute({ pattern: "*.txt", path: root });
    expect(ok.isError).toBeUndefined();
    expect(typeof ok.content).toBe("string");
    expect(ok.content.startsWith("{")).toBe(false);
    expect(() => JSON.parse(ok.content)).toThrow();

    const empty = await tool.execute({ pattern: "*.never", path: root });
    expect(empty.isError).toBeUndefined();
    expect(empty.content.startsWith("{")).toBe(false);
    expect(() => JSON.parse(empty.content)).toThrow();
  });

  test("honors explicit `path` arg as the search root", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "outer.txt"), "outer\n", "utf8");
    await writeFile(join(root, "sub", "inner.txt"), "inner\n", "utf8");

    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({
      pattern: "*.txt",
      path: join(root, "sub"),
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("inner.txt");
    expect(result.content).not.toContain("outer.txt");
  });

  test("defaults the search root to the first allowed path when `path` is omitted", async () => {
    await writeFile(join(root, "default.txt"), "d\n", "utf8");
    const tool = createGlobTool({ allowedPaths: [root] });

    const result = await tool.execute({ pattern: "*.txt" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("default.txt");
    expect(result.metadata?.searchRoot).toBeDefined();
  });

  test("missing pattern returns a plain-text error", async () => {
    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({ path: root });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("pattern must be a non-empty string");
  });

  test("accepts an absolute pattern inside the allowed path", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({
      pattern: join(root, "*.txt"),
      path: root,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("a.txt");
  });

  test("primary search includes hidden and ignored files", async () => {
    await mkdir(join(root, ".hidden-dir"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "ignored\n", "utf8");
    await writeFile(join(root, ".hidden.txt"), "hidden\n", "utf8");
    await writeFile(join(root, ".hidden-dir", "nested.txt"), "nested\n", "utf8");

    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({
      pattern: "*.txt",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    const lines = result.content.split("\n").filter(Boolean);
    expect(lines).toEqual(
      expect.arrayContaining([
        "ignored.txt",
        ".hidden.txt",
        ".hidden-dir/nested.txt",
      ]),
    );
  });

  test("returns relative paths under allowed root", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "x.txt"), "x\n", "utf8");
    await writeFile(join(root, "a", "y.txt"), "y\n", "utf8");
    await writeFile(join(root, "a", "b", "z.txt"), "z\n", "utf8");

    const tool = createGlobTool({ allowedPaths: [root] });
    const result = await tool.execute({
      pattern: "**/*.txt",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    const lines = result.content.split("\n").filter(Boolean);
    for (const line of lines) {
      expect(line.startsWith(root)).toBe(false);
    }
    expect(lines).toEqual(expect.arrayContaining(["x.txt", "a/y.txt", "a/b/z.txt"]));
  });
});
