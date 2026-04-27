import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __resetRipgrepProbeForTests,
  createGrepTool,
  GREP_TOOL_NAME,
} from "./grep.js";

describe("Grep tool", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-grep-"));
    __resetRipgrepProbeForTests();
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
    __resetRipgrepProbeForTests();
  });

  test("exposes the AgenC-bare tool name and required schema", () => {
    expect(GREP_TOOL_NAME).toBe("Grep");
    const tool = createGrepTool({ allowedPaths: [root] });
    expect(tool.name).toBe("Grep");
    expect(tool.isReadOnly).toBe(true);
    expect(tool.metadata?.mutating).toBe(false);
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["pattern"]);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        "pattern",
        "path",
        "glob",
        "output_mode",
        "-B",
        "-A",
        "-C",
        "-n",
        "-i",
        "type",
        "head_limit",
        "multiline",
      ]),
    );
  });

  test("returns matching content lines for a basic pattern", async () => {
    await writeFile(join(root, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
    await writeFile(join(root, "b.txt"), "delta\nepsilon\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "beta",
      path: root,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("beta");
    expect(result.content).not.toContain("alpha");
  });

  test("accepts a file path as the search target for content mode", async () => {
    const target = join(root, "target.txt");
    await writeFile(target, "alpha\nneedle\ngamma\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: target,
      output_mode: "content",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("2:needle");
  });

  test("accepts a file path as the search target for files_with_matches", async () => {
    const target = join(root, "hit.txt");
    await writeFile(target, "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: target,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content.split("\n").filter(Boolean)).toEqual(["hit.txt"]);
  });

  test("output_mode=files_with_matches returns just paths", async () => {
    await writeFile(join(root, "hit.txt"), "needle\n", "utf8");
    await writeFile(join(root, "miss.txt"), "haystack\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const lines = result.content.split("\n").filter(Boolean);
    expect(lines).toEqual(["hit.txt"]);
  });

  test("output_mode=count emits path:count lines", async () => {
    await writeFile(
      join(root, "a.txt"),
      "needle\nneedle\nother\n",
      "utf8",
    );
    await writeFile(join(root, "b.txt"), "needle\nother\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "count",
    });

    expect(result.isError).toBeUndefined();
    const counts = new Map<string, number>();
    for (const line of result.content.split("\n").filter(Boolean)) {
      const idx = line.lastIndexOf(":");
      counts.set(line.substring(0, idx), Number(line.substring(idx + 1)));
    }
    expect(counts.get("a.txt")).toBe(2);
    expect(counts.get("b.txt")).toBe(1);
  });

  test("-i case-insensitive flag matches mixed casing", async () => {
    await writeFile(join(root, "a.txt"), "HELLO world\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const sensitive = await tool.execute({
      pattern: "hello",
      path: root,
      output_mode: "files_with_matches",
    });
    expect(sensitive.content).toBe("No matches found.");

    const insensitive = await tool.execute({
      pattern: "hello",
      path: root,
      "-i": true,
      output_mode: "files_with_matches",
    });
    expect(insensitive.content.split("\n").filter(Boolean)).toEqual(["a.txt"]);
  });

  test("head_limit truncation appends the polite truncation note", async () => {
    let body = "";
    for (let i = 0; i < 25; i += 1) body += `match-${i}\n`;
    await writeFile(join(root, "many.txt"), body, "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "match-",
      path: root,
      output_mode: "content",
      head_limit: 5,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("(results truncated at 5; refine query)");
    const lines = result.content.split("\n").filter(Boolean);
    // 5 truncated lines + 1 trailing note line
    expect(lines.length).toBe(6);
  });

  test("glob filter restricts the searched files", async () => {
    await writeFile(join(root, "keep.ts"), "needle\n", "utf8");
    await writeFile(join(root, "skip.md"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      glob: "*.ts",
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const matches = result.content.split("\n").filter(Boolean);
    expect(matches).toContain("keep.ts");
    expect(matches).not.toContain("skip.md");
  });

  test("-B and -A return surrounding context lines", async () => {
    await writeFile(
      join(root, "ctx.txt"),
      ["before-2", "before-1", "TARGET", "after-1", "after-2"].join("\n"),
      "utf8",
    );
    const tool = createGrepTool({ allowedPaths: [root] });

    const both = await tool.execute({
      pattern: "TARGET",
      path: root,
      output_mode: "content",
      "-B": 1,
      "-A": 1,
    });
    expect(both.isError).toBeUndefined();
    expect(both.content).toContain("before-1");
    expect(both.content).toContain("TARGET");
    expect(both.content).toContain("after-1");

    const c = await tool.execute({
      pattern: "TARGET",
      path: root,
      output_mode: "content",
      "-C": 2,
    });
    expect(c.isError).toBeUndefined();
    expect(c.content).toContain("before-2");
    expect(c.content).toContain("after-2");
  });

  test("empty results return polite plain text and not isError", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "no-such-thing",
      path: root,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No matches found.");
  });

  test("rejects path outside the allowed paths", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n", "utf8");
    const otherRoot = await mkdtemp(join(tmpdir(), "agenc-grep-other-"));
    try {
      await writeFile(join(otherRoot, "b.txt"), "beta\n", "utf8");
      const tool = createGrepTool({ allowedPaths: [root] });

      const result = await tool.execute({
        pattern: "beta",
        path: otherRoot,
      });

      expect(result.isError).toBe(true);
      expect(result.content.toLowerCase()).toContain("access denied");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("missing pattern returns a plain-text error", async () => {
    const tool = createGrepTool({ allowedPaths: [root] });
    const result = await tool.execute({ path: root });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("pattern must be a non-empty string");
  });

  test("recurses into nested directories", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested/deep.txt"), "needle\n", "utf8");
    const tool = createGrepTool({ allowedPaths: [root] });

    const result = await tool.execute({
      pattern: "needle",
      path: root,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeUndefined();
    const lines = result.content.split("\n").filter(Boolean);
    expect(lines.some((line) => line.endsWith("deep.txt"))).toBe(true);
  });
});
